// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const throat = require('throat')
const { get, sortedUniq, omit, isEqual, uniqWith, flatten, intersectionWith, concat } = require('lodash')
const EntityCoordinates = require('../lib/entityCoordinates')
const logger = require('../providers/logging/logger')
const computeLock = require('../providers/caching/memory')({ defaultTtlSeconds: 60 * 5 /* 5 mins */ })

class DefinitionService {
  constructor(harvestStore, harvestService, computeService, curation, store, search, cache, upgradeHandler) {
    this.harvestStore = harvestStore
    this.harvestService = harvestService
    this.computeService = computeService
    this.curationService = curation
    this.definitionStore = store
    this.search = search
    this.cache = cache
    this.upgradeHandler = upgradeHandler
    if (this.upgradeHandler) this.upgradeHandler.currentSchema = this.computeService.currentSchema
    this.logger = logger()
  }

  get currentSchema() {
    return this.computeService.currentSchema
  }
  /**
   * Get the final representation of the specified definition and optionally apply the indicated
   * curation.
   *
   * @param {EntityCoordinates} coordinates - The entity for which we are looking for a curation
   * @param {(number | string | Summary)} [curationSpec] - A PR number (string or number) for a proposed
   * curation or an actual curation object.
   * @param {bool} force - whether or not to force re-computation of the requested definition
   * @param {string} expand - hints for parts to include/exclude; e.g. "-files"
   * @returns {Definition} The fully rendered definition
   */
  async get(coordinates, pr = null, force = false, expand = null) {
    if (pr) {
      const curation = this.curationService.get(coordinates, pr)
      return this.compute(coordinates, curation)
    }
    const existing = await this._cacheExistingAside(coordinates, force)
    let result = await this.upgradeHandler.validate(existing)
    if (result) {
      // Log line used for /status page insights
      this.logger.info('computed definition available', { coordinates: coordinates.toString() })
    } else result = await this._computeDefinitionOnGet(force, coordinates)
    return this._trimDefinition(this._cast(result), expand)
  }

  async _computeDefinitionOnGet(force, coordinates) {
    if (force) return await this.computeAndStore(coordinates)
    if (await this.harvestService.isTracked(coordinates)) {
      this.logger.info('definition harvest in progress', { coordinates: coordinates.toString() })
      return this._computePlaceHolder(coordinates)
    }
    return await this.computeStoreAndCurate(coordinates)
  }

  /**
   * Get directly from cache or store without any side effect, like compute
   * @param {} coordinates
   * @returns { Definition } The definition in store.
   */
  async getStored(coordinates) {
    const cacheKey = this._getCacheKey(coordinates)
    this.logger.debug('1:Redis:start', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    const cached = await this.cache.get(cacheKey)
    if (cached) return cached
    this.logger.debug('2:blob+mongoDB:start', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    const stored = await this.definitionStore.get(coordinates)
    if (stored) this._setDefinitionInCache(cacheKey, stored)
    return stored
  }

  async _cacheExistingAside(coordinates, force) {
    if (force) return null
    return await this.getStored(coordinates)
  }

  async _setDefinitionInCache(cacheKey, itemToStore) {
    // 1000 is a magic number here -- we don't want to cache very large definitions, as it can impact redis ops
    if (itemToStore.files && itemToStore.files.length > 1000) {
      this.logger.debug('Skipping caching for key', { coordinates: itemToStore.coordinates.toString() })
      return
    }

    // TTL for two days, in seconds
    await this.cache.set(cacheKey, itemToStore, 60 * 60 * 24 * 2)
  }

  _trimDefinition(definition, expand) {
    if (expand === '-files') return omit(definition, 'files')
    return definition
  }

  // ensure the definition is a properly classed object
  _cast(definition) {
    definition.coordinates = EntityCoordinates.fromObject(definition.coordinates)
    return definition
  }

  /**
   * Get all of the definition entries available for the given coordinates. The coordinates must be
   * specified down to the revision. The result will have an entry per discovered definition.
   *
   * @param {*} coordinatesList - an array of coordinate paths to list
   * @param {bool} force - whether or not to force re-computation of the requested definitions
   * @returns A list of all components that have definitions and the definitions that are available
   */
  async getAll(coordinatesList, force = false, expand = null) {
    const result = {}
    const promises = coordinatesList.map(
      throat(10, async coordinates => {
        this.logger.debug(`1:1:notice_generate:get_single_start:${coordinates}`, { ts: new Date().toISOString() })
        const definition = await this.get(coordinates, null, force, expand)
        this.logger.debug(`1:1:notice_generate:get_single_end:${coordinates}`, { ts: new Date().toISOString() })
        if (!definition) return
        const key = definition.coordinates.toString()
        result[key] = definition
      })
    )
    await Promise.all(promises)
    return result
  }

  /** Get a list of coordinates for all known definitions that match the given coordinates
   * @param {EntityCoordinates} coordinates - the coordinates to query
   * @returns {String[]} the list of all coordinates for all discovered definitions
   */
  async list(coordinates, recompute = false) {
    if (!recompute) return this.definitionStore.list(coordinates)
    const curated = (await this.curationService.list(coordinates)).map(c => c.toString())
    const tools = await this.harvestStore.list(coordinates)
    const harvest = tools.map(tool => EntityCoordinates.fromString(tool).toString())
    return sortedUniq([...harvest, ...curated])
  }

  /**
   * Get a list of all the definitions that exist in the store matching the given coordinates
   * @param {EntityCoordinates[]} coordinatesList
   * @returns {Object[]} A list of all components that have definitions that are available
   */
  async listAll(coordinatesList) {
    //Take the array of coordinates, strip out the revision and only return uniques
    const searchCoordinates = uniqWith(
      coordinatesList.map(coordinates => coordinates.asRevisionless()),
      isEqual
    )
    const promises = searchCoordinates.map(
      throat(10, async coordinates => {
        try {
          return await this.list(coordinates)
        } catch (error) {
          return null
        }
      })
    )
    const foundDefinitions = flatten(await Promise.all(concat(promises)))
    // Filter only the revisions matching the found definitions
    return intersectionWith(
      coordinatesList,
      foundDefinitions,
      (a, b) => a && b && a.toString().toLowerCase() === b.toString().toLowerCase()
    )
  }

  /**
   * Get the definitions that exist in the store matching the given query
   * @param {object} query
   * @returns The data and continuationToken if there is more results
   */
  find(query) {
    return this.definitionStore.find(query, query.continuationToken)
  }

  /**
   * Invalidate the definition for the identified component. This flushes any caches and pre-computed
   * results. The definition will be recomputed on or before the next use.
   *
   * @param {Coordinates} coordinates - individual or array of coordinates to invalidate
   */
  invalidate(coordinates) {
    const coordinateList = Array.isArray(coordinates) ? coordinates : [coordinates]
    return Promise.all(
      coordinateList.map(
        throat(10, async coordinates => {
          await this.definitionStore.delete(coordinates)
          await this.cache.delete(this._getCacheKey(coordinates))
        })
      )
    )
  }

  async computeStoreAndCurate(coordinates) {
    // one coordinate a time through this method so no duplicate auto curation will be created.
    this.logger.debug('3:memory_lock:start', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    while (computeLock.get(coordinates.toString())) await new Promise(resolve => setTimeout(resolve, 500))
    try {
      computeLock.set(coordinates.toString(), true)
      const definition = await this._computeAndStore(coordinates)
      await this.curationService.autoCurate(definition)
      return definition
    } finally {
      computeLock.delete(coordinates.toString())
    }
  }

  async computeAndStore(coordinates) {
    while (computeLock.get(coordinates.toString())) await new Promise(resolve => setTimeout(resolve, 500)) // one coordinate a time through this method so we always get latest
    try {
      computeLock.set(coordinates.toString(), true)
      return await this._computeAndStore(coordinates)
    } finally {
      computeLock.delete(coordinates.toString())
    }
  }

  async _computeAndStore(coordinates) {
    const definition = await this.compute(coordinates)
    // If no tools participated in the creation of the definition then don't bother storing.
    // Note that curation is a tool so no tools really means there the definition is effectively empty.
    const tools = get(definition, 'described.tools')
    if (!tools || tools.length === 0) {
      // Log line used for /status page insights
      this.logger.info('definition not available', { coordinates: coordinates.toString() })
      this._harvest(coordinates) // fire and forget
      return definition
    }
    // Log line used for /status page insights
    this.logger.info('recomputed definition available', { coordinates: coordinates.toString() })
    await this._store(definition)
    return definition
  }

  async _harvest(coordinates) {
    try {
      this.logger.debug('trigger_harvest:start', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
      await this.harvestService.harvest({ tool: 'component', coordinates }, true)
      this.logger.debug('trigger_harvest:end', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    } catch (error) {
      this.logger.info('failed to harvest from definition service', {
        crawlerError: error,
        coordinates: coordinates.toString()
      })
    }
  }

  async _store(definition) {
    await this.definitionStore.store(definition)
    await this._setDefinitionInCache(this._getCacheKey(definition.coordinates), definition)
    await this.harvestService.done(definition.coordinates)
  }

  /**
   * Compute the final representation of the specified definition and optionally apply the indicated
   * curation.
   *
   * @param {EntitySpec} coordinates - The entity for which we are looking for a curation
   * @param {(number | string | Summary)} [curationSpec] - A PR number (string or number) for a proposed
   * curation or an actual curation object.
   * @returns {Definition} The fully rendered definition
   */
  async compute(coordinates, curationSpec) {
    return this.computeService.compute(coordinates, curationSpec)
  }

  _computePlaceHolder(givenCoordinates) {
    return this.computeService.computePlaceHolder(givenCoordinates)
  }

  /**
   * Suggest a set of definition coordinates that match the given pattern. Only existing definitions are searched.
   * @param {String} pattern - A pattern to look for in the coordinates of a definition
   * @returns {String[]} The list of suggested coordinates found
   */
  suggestCoordinates(pattern) {
    return this.search.suggestCoordinates(pattern)
  }

  // helper method to prime the search store while get the system up and running. Should not be
  // needed in general.
  // mode can be definitions or index [default]
  async reload(mode, coordinatesList = null) {
    const recompute = mode === 'definitions'
    const baseList = coordinatesList || (await this.list(new EntityCoordinates(), recompute))
    const list = baseList.map(entry => EntityCoordinates.fromString(entry))
    return await Promise.all(
      list.map(
        throat(10, async coordinates => {
          try {
            const definition = await this.get(coordinates, null, recompute)
            if (recompute) return Promise.resolve(null)
            if (this.search.store) return this.search.store(definition)
          } catch (error) {
            this.logger.info('failed to reload in definition service', {
              error,
              coordinates: coordinates.toString()
            })
          }
        })
      )
    )
  }

  _getCacheKey(coordinates) {
    return `def_${EntityCoordinates.fromObject(coordinates).toString().toLowerCase()}`
  }
}

module.exports = (harvestStore, harvestService, computeService, curation, store, search, cache, versionHandler) =>
  new DefinitionService(harvestStore, harvestService, computeService, curation, store, search, cache, versionHandler)
