// (c) Copyright 2026, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

import type { ICache, ISyncCache } from '../caching/index.js'
import memoryCache from '../caching/memory.ts'
import type { Logger } from '../logging/index.js'
import logger from '../logging/logger.ts'

export interface InflightLockOptions {
  logger?: Logger
  cachingService: ICache
  localLockCache?: ISyncCache<string>
  inflightTTLInSeconds?: number
  lockRetryDelayMinMs?: number
  lockRetryDelayMaxMs?: number
  lockAcquireTimeoutMs?: number
  localLockRetryDelayMs?: number
  localLockTimeoutBufferMs?: number
}

/** Default lock TTL: 1 minute in seconds */
const inflightTTLInSeconds = 60
/** Default lock retry jitter range in milliseconds */
const lockRetryDelayMinMs = 300
const lockRetryDelayMaxMs = 500
/** Default local lock retry delay in milliseconds — short since contention is in-process */
const localLockRetryDelayMs = 5
/**
 * Default maximum lock acquire wait in milliseconds for the Redis layer.
 * The local layer uses lockAcquireTimeoutMs + localLockTimeoutBufferMs to cover
 * the full time a holder can spend inside the local lock: up to lockAcquireTimeoutMs
 * waiting for Redis, plus localLockTimeoutBufferMs for work inside the Redis lock.
 * Worst-case total blocking per harvest call: 2 × lockAcquireTimeoutMs + localLockTimeoutBufferMs.
 * Keep lockAcquireTimeoutMs below upstream request timeouts so callers receive a structured error.
 */
const lockAcquireTimeoutMs = 25 * 1000
/** Buffer added to the local lock waiter timeout to cover dispatch work done inside the Redis lock. */
const localLockTimeoutBufferMs = 10 * 1000

/**
 * Two-layer inflight lock for harvest deduplication.
 *
 * Acquires keys in sorted order to prevent deadlocks. The local ISyncCache layer
 * eliminates intra-process Redis contention; the Redis ICache layer provides
 * cross-instance coordination.
 */
export class InflightLock {
  declare logger: Logger
  declare _cache: ICache
  declare _localInflightKeys: ISyncCache<string>
  declare inflightTTLInSeconds: number
  declare lockRetryDelayMinMs: number
  declare lockRetryDelayMaxMs: number
  declare lockAcquireTimeoutMs: number
  declare localLockRetryDelayMs: number
  declare localLockTimeoutBufferMs: number
  declare localLockTTLSeconds: number

  constructor(options: InflightLockOptions) {
    this.logger = options.logger || logger()
    this._cache = options.cachingService
    this.inflightTTLInSeconds = options.inflightTTLInSeconds ?? inflightTTLInSeconds
    this.lockRetryDelayMinMs = options.lockRetryDelayMinMs ?? lockRetryDelayMinMs
    this.lockRetryDelayMaxMs = options.lockRetryDelayMaxMs ?? lockRetryDelayMaxMs
    this.lockAcquireTimeoutMs = options.lockAcquireTimeoutMs ?? lockAcquireTimeoutMs
    this.localLockRetryDelayMs = options.localLockRetryDelayMs ?? localLockRetryDelayMs
    this.localLockTimeoutBufferMs = options.localLockTimeoutBufferMs ?? localLockTimeoutBufferMs
    this.localLockTTLSeconds = Math.ceil((this.lockAcquireTimeoutMs + this.localLockTimeoutBufferMs) / 1000)
    this._localInflightKeys = options.localLockCache ?? memoryCache({ defaultTtlSeconds: this.localLockTTLSeconds })
  }

  async withLock(coordinates: string[], fn: () => Promise<void>): Promise<void> {
    const sortedKeys = coordinates.map(c => this._getKey(c)).sort()
    await this._acquireLocal(sortedKeys)
    try {
      await this._acquireGlobal(sortedKeys)
      try {
        await fn()
      } finally {
        await this._releaseGlobal(sortedKeys)
      }
    } finally {
      this._releaseLocal(sortedKeys)
    }
  }

  async _acquireLocal(sortedKeys: string[]): Promise<void> {
    await this._acquireLocksWithRetry(
      sortedKeys,
      keys => this._acquireSortedLocalInflightKeys(keys),
      keys => this._releaseLocal(keys),
      () => this.localLockRetryDelayMs,
      this.lockAcquireTimeoutMs + this.localLockTimeoutBufferMs,
      'local inflight'
    )
  }

  _acquireSortedLocalInflightKeys(sortedKeys: string[]): string[] {
    const acquired: string[] = []
    for (const key of sortedKeys) {
      if (this._localInflightKeys.get(key) !== null) {
        break
      }
      this._localInflightKeys.set(key, '1', this.localLockTTLSeconds)
      acquired.push(key)
    }
    return acquired
  }

  _releaseLocal(keys: string[]): void {
    for (const key of keys) {
      this._localInflightKeys.delete(key)
    }
  }

  async _acquireGlobal(sortedKeys: string[]): Promise<void> {
    await this._acquireLocksWithRetry(
      sortedKeys,
      keys => this._acquireSortedGlobalKeys(keys),
      keys => this._releaseGlobal(keys),
      () => this._getLockRetryDelayMs(),
      this.lockAcquireTimeoutMs,
      'inflight'
    )
  }

  async _releaseGlobal(keys: string[]): Promise<void> {
    const results = await Promise.allSettled(keys.map(key => this._cache.delete(key)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error('Error releasing inflight lock', result.reason)
      }
    }
  }

  async _acquireSortedGlobalKeys(sortedKeys: string[]): Promise<string[]> {
    try {
      const allAcquired = await this._cache.setIfAbsentBatch(sortedKeys, '1', this.inflightTTLInSeconds)
      return allAcquired ? sortedKeys : []
    } catch (error) {
      // Lua may have acquired some keys before throwing — release all to be safe (DEL is idempotent).
      await this._releaseGlobal(sortedKeys)
      throw error
    }
  }

  async _acquireLocksWithRetry(
    sortedKeys: string[],
    tryAcquire: (keys: string[]) => Promise<string[]> | string[],
    release: (keys: string[]) => Promise<void> | void,
    retryDelayMs: () => number,
    timeoutMs: number,
    label: string
  ): Promise<void> {
    const started = Date.now()
    let attempts = 0

    while (true) {
      attempts += 1
      const acquired = await tryAcquire(sortedKeys)
      if (acquired.length === sortedKeys.length) {
        this.logger.debug(
          `Acquired ${acquired.length}/${sortedKeys.length} ${label} lock(s) after ${attempts} attempt(s) in ${Date.now() - started}ms.`
        )
        return
      }

      const missedKey = sortedKeys[acquired.length] ?? 'unknown'
      this.logger.debug(
        `${label} lock miss on attempt ${attempts}: acquired ${acquired.length}/${sortedKeys.length}; first missed key ${missedKey}; releasing partial locks.`
      )
      await release(acquired)

      if (Date.now() - started >= timeoutMs) {
        const msg = `Timed out acquiring ${label} harvest coordinate locks after ${attempts} attempt(s) in ${Date.now() - started}ms (timeout: ${timeoutMs}ms)`
        this.logger.warn(msg)
        throw new Error(msg)
      }
      const delay = retryDelayMs()
      this.logger.debug(
        `Retrying ${label} lock acquisition in ${delay}ms (attempt ${attempts + 1}, elapsed ${Date.now() - started}ms).`
      )
      await this._sleep(delay)
    }
  }

  _getKey(coordinates: string): string {
    if (!coordinates) {
      return ''
    }
    return `hrv_inflight_${coordinates.toLowerCase()}`
  }

  _getLockRetryDelayMs(): number {
    if (this.lockRetryDelayMaxMs <= this.lockRetryDelayMinMs) {
      return this.lockRetryDelayMinMs
    }
    return this.lockRetryDelayMinMs + Math.floor(Math.random() * (this.lockRetryDelayMaxMs - this.lockRetryDelayMinMs))
  }

  _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export default (options: InflightLockOptions): InflightLock => new InflightLock(options)
