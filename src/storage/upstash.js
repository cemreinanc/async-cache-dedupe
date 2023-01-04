'use strict'

const stringify = require('safe-stable-stringify')
const nullLogger = require('abstract-logging')
const StorageInterface = require('./interface')
const { findNotMatching, randomSubset } = require('../util')

const GC_DEFAULT_CHUNK = 64
const GC_DEFAULT_LAZY_CHUNK = 64
const REFERENCES_DEFAULT_TTL = 60

/**
 * @typedef StorageUpstashOptions
 * @property {!store} client
 * @property {?Logger} log
 * @property {?Object|boolean} [invalidation=false]
 * @property {?number} [invalidation.referencesTTL=60]
 */

class StorageUpstash extends StorageInterface {
  /**
   * @param {?StorageUpstashOptions} options
   */
  constructor (options = {}) {
    if (!options.client || typeof options.client !== 'object') {
      throw new Error('Upstash client is required')
    }

    super(options)

    if (options.invalidation && options.invalidation.referencesTTL &&
      (typeof options.invalidation.referencesTTL !== 'number' || options.invalidation.referencesTTL < 1)) {
      throw new Error('invalidation.referencesTTL must be a positive integer greater than 1')
    }

    this.log = options.log || nullLogger
    this.store = options.client
    this.invalidation = !!options.invalidation
    this.referencesTTL = (options.invalidation && options.invalidation.referencesTTL) || REFERENCES_DEFAULT_TTL
  }

  getReferenceKeyLabel (reference) {
    return `r:${reference}`
  }

  getKeyReferenceLabel (key) {
    return `k:${key}`
  }

  /**
   * @param {string} key
   * @returns {undefined|*} undefined if key not found
   */
  async get (key) {
    this.log.debug({ msg: 'acd/storage/upstash.get', key })

    try {
      const value = await this.store.get(key)
      if (!value) {
        if (!this.invalidation) {
          return undefined
        }

        // clear references because the key could be expired (or evicted)
        // note: no await
        this.clearReferences(key)
        return undefined
      }
      return JSON.parse(value)
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.get error', err, key })
    }
  }

  /**
   * set value by key
   * @param {string} key
   * @param {*} value
   * @param {number} ttl - ttl in seconds; zero means key will not be stored
   * @param {?string[]} references
   */
  async set (key, value, ttl, references) {
    // TODO validate keys, can't contain * or other special chars
    this.log.debug({ msg: 'acd/storage/upstash.set key', key, value, ttl, references })

    ttl = Number(ttl)
    if (!ttl || ttl < 0) {
      return
    }

    try {
      await this.store.set(key, stringify(value), { ex: ttl })

      if (!references || references.length < 1) {
        return
      }

      if (!this.invalidation) {
        this.log.warn({ msg: 'acd/storage/upstash.set, invalidation is disabled, references are useless', key, references })
        return
      }

      const p = this.store.pipeline()

      // clear old references
      const currentReferences = await this.store.smembers(this.getKeyReferenceLabel(key))
      this.log.debug({ msg: 'acd/storage/upstash.set current references', key, currentReferences })
      if (currentReferences.length > 1) {
        currentReferences.sort()
        references.sort()
        const referencesToRemove = findNotMatching(references, currentReferences)

        // remove key in current references
        for (const reference of referencesToRemove) {
          p.srem(this.getReferenceKeyLabel(reference), key)
        }
        p.del(this.getKeyReferenceLabel(key))
      }

      // TODO we can probably get referencesToAdd and referencesToRemove in a single loop
      const referencesToAdd = currentReferences.length > 1 ? findNotMatching(currentReferences, references) : references
      this.log.debug({ msg: 'acd/storage/redis.set references to add', key, referencesToAdd })

      for (let i = 0; i < referencesToAdd.length; i++) {
        const reference = referencesToAdd[i]
        const referenceKeyLabel = this.getReferenceKeyLabel(reference)
        // reference->keys
        p.sadd(referenceKeyLabel, key)
        // reset reference->keys ttl to max
        p.expire(referenceKeyLabel, this.referencesTTL)
      }
      const keyReferenceLabel = this.getKeyReferenceLabel(key)
      // key-references
      p.sadd(keyReferenceLabel, references)
      // key-references has the same ttl of key
      p.expire(keyReferenceLabel, ttl)

      this.log.debug({ msg: 'acd/storage/upstash.set references writes' })

      await p.exec()
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.set error', err, key, ttl, references })
    }
  }

  /**
   * remove an entry by key
   * @param {string} key
   * @returns {boolean} indicates if key was removed
   */
  async remove (key) {
    this.log.debug({ msg: 'acd/storage/upstash.remove', key })
    try {
      const removed = await this.store.del(key) > 0
      if (removed && this.invalidation) { await this.clearReferences(key) }
      return removed
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.remove error', err, key })
    }
  }

  /**
   * @param {string|string[]} references
   * @returns {string[]} removed keys
   */
  async invalidate (references) {
    if (!this.invalidation) {
      this.log.warn({ msg: 'acd/storage/upstash.invalidate, exit due invalidation is disabled' })
      return []
    }

    this.log.debug({ msg: 'acd/storage/upstash.invalidate', references })

    try {
      if (Array.isArray(references)) {
        return await this._invalidateReferences(references)
      }
      return await this._invalidateReference(references)
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.invalidate error', err, references })
      return []
    }
  }

  /**
   * @param {string[]} references
   * @param {[bool=true]} mapReferences
   * @returns {string[]} removed keys
   */
  async _invalidateReferences (references, mapReferences = true) {
    const pRead = this.store.pipeline()
    references.forEach(reference => pRead.smembers(mapReferences ? this.getReferenceKeyLabel(reference) : reference))
    const keys = await pRead.exec()

    this.log.debug({ msg: 'acd/storage/upstash._invalidateReferences keys', keys })

    const pWrite = this.store.pipeline()
    const removed = []
    for (let i = 0; i < keys.length; i++) {
      const key0 = keys[i][1]
      this.log.debug({ msg: 'acd/storage/upstash._invalidateReferences got keys to be invalidated', keys: key0 })
      for (let j = 0; j < key0.length; j++) {
        const key1 = key0[j]
        this.log.debug({ msg: 'acd/storage/upstash._invalidateReferences del key' + key1 })
        removed.push(key1)
        pWrite.del(key1)
      }
    }

    await pWrite.exec()
    await this.clearReferences(removed)
    return removed
  }

  /**
   * @param {string} reference
   * @returns {string[]} removed keys
   */
  async _invalidateReference (reference) {
    let keys
    if (reference.includes('*')) {
      const references = await this.store.keys(this.getReferenceKeyLabel(reference))
      return this._invalidateReferences(references, false)
    } else {
      keys = await this.store.smembers(this.getReferenceKeyLabel(reference))
    }

    this.log.debug({ msg: 'acd/storage/upstash._invalidateReference keys', keys })

    const pWrite = this.store.pipeline()
    const removed = []
    for (let i = 0; i < keys.length; i++) {
      const key0 = keys[i]
      this.log.debug({ msg: 'acd/storage/upstash._invalidateReference del key' + key0 })
      removed.push(key0)
      pWrite.del(key0)
    }

    await pWrite.exec()
    await this.clearReferences(removed)
    return removed
  }

  /**
   * @param {string} name
   */
  async clear (name) {
    this.log.debug({ msg: 'acd/storage/upstash.clear', name })

    try {
      if (!name) {
        await this.store.flushall()
        return
      }

      const keys = await this.store.keys(`${name}*`)
      this.log.debug({ msg: 'acd/storage/upstash.clear keys', keys })

      const pRemove = this.store.pipeline()
      keys.forEach(key => pRemove.del(key))
      await pRemove.exec()

      if (!this.invalidation) { return }
      await this.clearReferences(keys)
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.clear error', err, name })
    }
  }

  async refresh () {
    try {
      await this.store.flushall()
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.refresh error', err })
    }
  }

  /**
   * note: does not throw on error
   * @param {string|string[]} keys
   */
  async clearReferences (keys) {
    try {
      if (!keys) {
        this.log.warn({ msg: 'acd/storage/upstash.clearReferences invalid call due to empty key' })
        return
      }

      if (!Array.isArray(keys)) { keys = [keys] }

      const pRead = this.store.pipeline()
      keys.forEach(key => pRead.smembers(this.getKeyReferenceLabel(key)))
      const referencesKeys = await pRead.exec()

      this.log.debug({ msg: 'acd/storage/upstash.clearReferences references', keys, referencesKeys })

      const writes = {}
      for (let i = 0; i < keys.length; i++) {
        for (let j = 0; j < referencesKeys[i][1].length; j++) {
          const reference = this.getReferenceKeyLabel(referencesKeys[i][1][j])
          if (writes[reference]) { continue }
          writes[reference] = ['srem', reference, keys]
        }
        const key = this.getKeyReferenceLabel(keys[i])
        writes[key] = ['del', key]
      }

      this.log.debug({ msg: 'acd/storage/upstash.clearReferences writes pipeline', writes })
      const pWrite = this.store.pipeline()
      Object.values(writes).forEach(([cmd, ...args]) => {
        pWrite[cmd](...args)
      })
      await pWrite.exec()
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.clearReferences error', err })
    }
  }

  /**
   * scan references and clean expired/evicted keys
   * @param {?string} [mode=lazy] lazy or strict
   * - in lazy mode, only `options.max` references are scanned every time, picking keys to check randomly
   *   so this operation is lighter while does not ensure references full clean up
   * - in strict mode, all references and keys are checked
   *   this operation scan the whole db and is slow
   * @param {?object} options
   * @param {number} [options.chunk=64] number of references to retrieve at once
   * @param {number|undefined} [options.lazy.cursor] cursor to start the scan; should be last cursor returned by scan; default start from the beginning
   * @param {number} [lazyChunk=64] number of references to check per gc cycle
   * @return {Object} report information of the operation
   *   references scanned/removed, keys scanned/removed, loops, cursor, error if any
   */
  async gc (mode = 'lazy', options = {}) {
    this.log.debug({ msg: 'acd/storage/upstash.gc', mode, options })

    if (!this.invalidation) {
      this.log.warn({ msg: 'acd/storage/upstash.gc does not run due to invalidation is disabled' })
      return
    }

    if (mode !== 'strict' && mode !== 'lazy') { mode = 'lazy' }
    const report = {
      references: { scanned: [], removed: [] },
      keys: { scanned: new Set(), removed: new Set() },
      loops: 0,
      cursor: 0,
      error: null
    }

    try {
      let cursor = 0
      let lazyChunk = GC_DEFAULT_LAZY_CHUNK

      if (options.chunk && (typeof options.chunk !== 'number' || options.chunk < 1)) {
        report.error = new Error('chunk must be a positive integer greater than 1')
        return report
      }

      if (options.lazy) {
        if (options.lazy.chunk) {
          if (typeof options.lazy.chunk !== 'number' || options.lazy.chunk < 1) {
            report.error = new Error('lazy.chunk must be a positive integer greater than 1')
            return report
          }
          lazyChunk = options.lazy.chunk
        }
        if (options.lazy.cursor) {
          if (typeof options.lazy.cursor !== 'number' || options.lazy.cursor < 0) {
            report.error = new Error('lazy.cursor must be a positive integer greater than 0')
            return report
          }
          cursor = options.lazy.cursor
        }
      }

      const chunk = options.chunk || GC_DEFAULT_CHUNK
      const scanCount = Math.min(lazyChunk, chunk)
      const startingCursor = cursor

      let lastScanLength = -1
      let lastRemoved = -1
      do {
        report.loops++

        const scan = await this.store.scan(cursor, 'match', 'r:*', 'count', scanCount)
        cursor = Number(scan[0])
        lastScanLength = scan[1].length

        const references = mode === 'lazy'
          ? randomSubset(scan[1], lazyChunk)
          : scan[1]

        report.references.scanned = report.references.scanned.concat(references)

        const pRead = this.store.pipeline()
        for (let i = 0; i < references.length; i++) {
          const reference = references[i]
          pRead.smembers(reference)
        }
        const referencesKeys = await pRead.exec()

        const keysMap = {}
        const referencesKeysMap = {}
        for (let i = 0; i < referencesKeys.length; i++) {
          const keys = referencesKeys[i]
          const reference = references[i]
          referencesKeysMap[reference] = keys[1]
          for (let j = 0; j < keys[1].length; j++) {
            const key = keys[1][j]
            if (!keysMap[key]) {
              keysMap[key] = [reference]
            } else {
              keysMap[key].push(reference)
            }

            report.keys.scanned.add(key)
          }
        }

        const keys = Object.keys(keysMap)
        const pRead2 = this.store.pipeline()
        keys.forEach(key => pRead2.exists(key))
        const existingKeys = await pRead2.exec()

        const removingKeys = {}
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          if (existingKeys[i][1] === 1) { continue }

          for (let j = 0; j < keysMap[key].length; j++) {
            const reference = keysMap[key][j]
            if (!removingKeys[reference]) {
              removingKeys[reference] = [key]
            } else {
              removingKeys[reference].push(key)
            }

            report.keys.removed.add(key)
          }
        }

        const writeReferences = Object.keys(removingKeys)
        const pWrite = this.store.pipeline()
        for (let i = 0; i < writeReferences.length; i++) {
          const reference = writeReferences[i]
          if (referencesKeysMap[reference].length === removingKeys[reference].length) {
            pWrite.del(reference)
            report.references.removed.push(reference)
          } else {
            pWrite.srem(reference, removingKeys[reference])
          }
        }
        await pWrite.exec()
        lastRemoved = writeReferences.length

        if (mode === 'lazy' && report.references.scanned.length >= lazyChunk) {
          break
        }
      } while (startingCursor !== cursor && lastScanLength > 0 && lastRemoved > 0)

      report.cursor = cursor
      report.keys.scanned = Array.from(report.keys.scanned)
      report.keys.removed = Array.from(report.keys.removed)
    } catch (err) {
      this.log.error({ msg: 'acd/storage/upstash.gc error', err })
      report.error = err
    }
    return report
  }
}

module.exports = StorageUpstash
