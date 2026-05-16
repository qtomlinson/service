// (c) Copyright 2025, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

import lodash from 'lodash'
import throat from 'throat'
import type EntityCoordinates from '../../lib/entityCoordinates.ts'
import type { ICache } from '../caching/index.js'
import type { Logger } from '../logging/index.js'
import logger from '../logging/logger.ts'
import { InflightLock } from './inflightLock.ts'

const { uniqBy, isEqual } = lodash

export interface HarvestPolicy {
  fetch?: string
  freshness?: string
  map?: { name: string; path: string }
}

export interface HarvestEntry {
  coordinates: EntityCoordinates | string
  tool?: string
  policy?: HarvestPolicy
}

export interface HarvestCallItem {
  type: string
  url: string
  policy?: HarvestPolicy
}

export interface CacheEntry {
  key: string
  harvests: HarvestCallItem[]
}

export interface Harvester {
  harvest(entries: HarvestEntry | HarvestEntry[], turbo?: boolean): Promise<void>
  toHarvestItem(entry: HarvestEntry): HarvestCallItem
}

export interface Options {
  logger?: Logger
  cachingService: ICache
  harvester: Harvester
  cacheTTLInSeconds?: number
  concurrencyLimit?: number
  lock?: InflightLock
}

/** Default cache TTL: 1 day in seconds */
const cacheTTLInSeconds = 60 * 60 * 24
/** Default max concurrent cache reads during pre-filter. */
const concurrencyLimit = 10

/**
 * Cache-based harvester that tracks and filters harvest operations to avoid duplicates. This class provides efficient
 * harvesting by caching previously processed entries and filtering out duplicates before sending them to the underlying
 * harvester.
 */
export class CacheBasedHarvester {
  declare logger: Logger
  declare _cache: ICache
  declare _harvester: Harvester
  declare _lock: InflightLock
  declare cacheTTLInSeconds: number
  declare concurrencyLimit: number

  constructor(options: Options) {
    this.logger = options.logger || logger()
    this._cache = options.cachingService
    this._harvester = options.harvester
    this.cacheTTLInSeconds = options.cacheTTLInSeconds ?? cacheTTLInSeconds
    this.concurrencyLimit = options.concurrencyLimit ?? concurrencyLimit
    this._lock = options.lock ?? new InflightLock({ cachingService: options.cachingService, logger: this.logger })
  }

  async harvest(spec: HarvestEntry | HarvestEntry[], turbo?: boolean): Promise<void> {
    const entries = Array.isArray(spec) ? spec : [spec]
    // _filterOutDuplicatedCoordinates removes falsy coordinates and deduplicates keys.
    const uniqueEntries = this._filterOutDuplicatedCoordinates(entries)
    if (!uniqueEntries.length) {
      this.logger.debug('No new harvests to process.')
      return
    }

    // Pre-filter: read tracking cache without holding any locks.
    // Best-effort optimisation — the recheck under the lock is the authoritative
    // guard against the TOCTOU window between here and lock acquisition.
    const candidateEntries = await this._filterOutTracked(uniqueEntries, this.concurrencyLimit)
    if (!candidateEntries.length) {
      this.logger.debug('No new harvests to process.')
      return
    }

    // Compute keys only for candidates so the lock batch is as small as possible.
    const candidateCoordinates = candidateEntries.map(entry => entry.coordinates.toString())

    await this._lock.withLock(candidateCoordinates, async () => {
      // Recheck under lock: guards the TOCTOU window between pre-filter and lock acquisition.
      const harvests = await this._filterOutTracked(candidateEntries)
      if (!harvests.length) {
        this.logger.debug('No new harvests to process.')
        return
      }
      this.logger.debug(`Starting harvest for ${harvests.length} entries.`)
      await this._harvester.harvest(harvests, turbo)
      await this._trackHarvests(harvests)
    })
  }

  _filterOutDuplicatedCoordinates(entries: HarvestEntry[]): HarvestEntry[] {
    const validEntries = entries.filter(entry => entry?.coordinates)
    return uniqBy(validEntries, entry => this._getCacheKey(entry.coordinates))
  }

  async _filterOutTracked(entries: HarvestEntry[], concurrency?: number): Promise<HarvestEntry[]> {
    // Skip throat when entries are already at/below the limit to avoid unnecessary wrapping.
    const isConcurrencyValid = concurrency !== undefined && concurrency > 0 && concurrency < entries.length
    const mapper = async (entry: HarvestEntry) => ((await this._isTrackedHarvest(entry)) ? null : entry)
    const filteredEntries = await Promise.all(entries.map(isConcurrencyValid ? throat(concurrency!, mapper) : mapper))

    return filteredEntries.filter((entry): entry is HarvestEntry => entry !== null)
  }

  async _isTrackedHarvest(entry: HarvestEntry): Promise<boolean> {
    const newHarvest = this._getHarvest(entry)
    const { harvests: trackedHarvests } = await this._getTrackedForCoordinates(entry.coordinates)
    const isTracked = trackedHarvests.some(harvest => isEqual(harvest, newHarvest))
    if (isTracked) {
      this.logger.debug(`Entry with coordinates ${entry.coordinates.toString()} is already tracked.`)
    }
    return isTracked
  }

  async isTracked(coordinates: EntityCoordinates): Promise<boolean> {
    const { harvests: trackedHarvests } = await this._getTrackedForCoordinates(coordinates)
    return trackedHarvests.length > 0
  }

  async _getTrackedForCoordinates(coordinates: EntityCoordinates | string): Promise<CacheEntry> {
    const key = this._getCacheKey(coordinates)
    const harvests = await this._getCached(key)
    return { key, harvests }
  }

  async _trackHarvests(harvestEntries: HarvestEntry[]): Promise<void> {
    const results = await Promise.allSettled(harvestEntries.map(entry => this._track(entry)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(result.reason)
      }
    }
  }

  async _getCached(key: string): Promise<HarvestCallItem[]> {
    if (!key) {
      return []
    }
    try {
      const harvests = await this._cache.get(key)
      return harvests || []
    } catch (error) {
      this.logger.error(`Error checking tracked harvests for ${key}:`, error)
      return []
    }
  }

  async _track(entry: HarvestEntry): Promise<void> {
    const newHarvest = this._getHarvest(entry)
    const { key, harvests } = await this._getTrackedForCoordinates(entry.coordinates)
    try {
      harvests.push(newHarvest)
      await this._cache.set(key, harvests, this.cacheTTLInSeconds)
      this.logger.debug(`Cached ${key} with ${harvests.length} harvests.`)
    } catch (error) {
      this.logger.error(`Error caching ${key}:`, error)
    }
  }

  async done(coordinates: EntityCoordinates): Promise<void> {
    const cacheKey = this._getCacheKey(coordinates)
    if (!cacheKey) {
      return
    }
    try {
      await this._cache.delete(cacheKey)
      this.logger.debug(`Removed cache for ${cacheKey}.`)
    } catch (error) {
      this.logger.error(`Error removing cache for ${cacheKey}:`, error)
    }
  }

  _getCacheKey(coordinates: EntityCoordinates | string): string {
    //Cache key is generated from the coordinates, same as in definition service.
    return coordinates && `hrv_${coordinates.toString().toLowerCase()}`
  }

  _getHarvest(entry: HarvestEntry): HarvestCallItem {
    return entry && this._harvester.toHarvestItem(entry)
  }
}

export default (options: Options): CacheBasedHarvester => new CacheBasedHarvester(options)
