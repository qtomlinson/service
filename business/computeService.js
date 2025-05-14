// (c) Copyright 2025, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const { get, set, remove, pullAllWith, isEqual, intersection } = require('lodash')
const EntityCoordinates = require('../lib/entityCoordinates')
const {
  setIfValue,
  setToArray,
  addArrayToSet,
  buildSourceUrl,
  isDeclaredLicense,
  simplifyAttributions,
  updateSourceLocation
} = require('../lib/utils')
const minimatch = require('minimatch')
const extend = require('extend')
const loggerFactory = require('../providers/logging/logger')
const validator = require('../schemas/validator')
const SPDX = require('@clearlydefined/spdx')
const parse = require('spdx-expression-parse')

const currentSchema = '1.7.0'

const weights = { declared: 30, discovered: 25, consistency: 15, spdx: 15, texts: 15, date: 30, source: 70 }

class ComputeService {
  constructor(harvestStore, summaryService, aggregationService, curationService, logger) {
    this.harvestStore = harvestStore
    this.summaryService = summaryService
    this.aggregationService = aggregationService
    this.curationService = curationService
    this.logger = logger || loggerFactory()
  }

  get currentSchema() {
    return currentSchema
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
    this.logger.debug('4:compute:blob:start', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    const raw = await this.harvestStore.getAllLatest(coordinates)
    this.logger.debug('4:compute:blob:end', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    coordinates = this._getCasedCoordinates(raw, coordinates)
    this.logger.debug('5:compute:summarize:start', {
      ts: new Date().toISOString(),
      coordinates: coordinates.toString()
    })
    const summaries = await this.summaryService.summarizeAll(coordinates, raw)
    this.logger.debug('6:compute:aggregate:start', {
      ts: new Date().toISOString(),
      coordinates: coordinates.toString()
    })
    const aggregatedDefinition = (await this.aggregationService.process(summaries, coordinates)) || {}
    this.logger.debug('6:compute:aggregate:end', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
    aggregatedDefinition.coordinates = coordinates
    this._ensureToolScores(coordinates, aggregatedDefinition)
    const definition = await this.curationService.apply(coordinates, curationSpec, aggregatedDefinition)
    this._calculateValidate(coordinates, definition)
    return definition
  }

  _calculateValidate(coordinates, definition) {
    this.logger.debug('9:compute:calculate:start', {
      ts: new Date().toISOString(),
      coordinates: coordinates.toString()
    })
    this._finalizeDefinition(coordinates, definition)
    this._ensureCuratedScores(definition)
    this._ensureFinalScores(definition)
    // protect against any element of the compute producing an invalid definition
    this._ensureNoNulls(definition)
    this._validate(definition)
    this.logger.debug('9:compute:calculate:end', { ts: new Date().toISOString(), coordinates: coordinates.toString() })
  }

  _validate(definition) {
    if (!validator.validate('definition', definition)) throw new Error(validator.errorsText())
  }

  computePlaceHolder(givenCoordinates) {
    const coordinates = this._getCasedCoordinates({}, givenCoordinates)
    const definition = { coordinates }
    this._ensureToolScores(coordinates, definition)
    this._calculateValidate(coordinates, definition)
    return definition
  }

  _getCasedCoordinates(raw, coordinates) {
    if (!raw || !Object.keys(raw).length) return coordinates
    for (const tool in raw) {
      for (const version in raw[tool]) {
        const cased = get(raw[tool][version], '_metadata.links.self.href')
        if (cased) return EntityCoordinates.fromUrn(cased)
      }
    }
    throw new Error('unable to find self link')
  }

  // Ensure that the given object (e.g., a definition) does not have any null properties.
  _ensureNoNulls(object) {
    Object.keys(object).forEach(key => {
      if (object[key] && typeof object[key] === 'object') this._ensureNoNulls(object[key])
      else if (object[key] == null) delete object[key]
    })
  }

  // Compute and store the scored for the given definition but do it in a way that does not affect the
  // definition so that further curations can be done.
  _ensureToolScores(coordinates, definition) {
    const rawDefinition = extend(true, {}, definition)
    this._finalizeDefinition(coordinates, rawDefinition)
    const { describedScore, licensedScore } = this._computeScores(rawDefinition)
    set(definition, 'described.toolScore', describedScore)
    set(definition, 'licensed.toolScore', licensedScore)
  }

  _ensureCuratedScores(definition) {
    const { describedScore, licensedScore } = this._computeScores(definition)
    set(definition, 'described.score', describedScore)
    set(definition, 'licensed.score', licensedScore)
  }

  _ensureFinalScores(definition) {
    const { described, licensed } = definition
    set(definition, 'scores.effective', Math.floor((described.score.total + licensed.score.total) / 2))
    set(definition, 'scores.tool', Math.floor((described.toolScore.total + licensed.toolScore.total) / 2))
  }

  _finalizeDefinition(coordinates, definition) {
    this._ensureFacets(definition)
    this._ensureSourceLocation(coordinates, definition)
    set(definition, '_meta.schemaVersion', currentSchema)
    set(definition, '_meta.updated', new Date().toISOString())
  }

  // Given a definition, calculate the scores for the definition and return an object with a score per dimension
  _computeScores(definition) {
    return {
      licensedScore: this._computeLicensedScore(definition),
      describedScore: this._computeDescribedScore(definition)
    }
  }

  // Given a definition, calculate and return the score for the described dimension
  _computeDescribedScore(definition) {
    const date = get(definition, 'described.releaseDate') ? weights.date : 0
    const source = get(definition, 'described.sourceLocation.url') ? weights.source : 0
    const total = date + source
    return { total, date, source }
  }

  // Given a definition, calculate and return the score for the licensed dimension
  _computeLicensedScore(definition) {
    const declared = this._computeDeclaredScore(definition)
    const discovered = this._computeDiscoveredScore(definition)
    const consistency = this._computeConsistencyScore(definition)
    const spdx = this._computeSPDXScore(definition)
    const texts = this._computeTextsScore(definition)
    const total = declared + discovered + consistency + spdx + texts
    return { total, declared, discovered, consistency, spdx, texts }
  }

  _computeDeclaredScore(definition) {
    const declared = get(definition, 'licensed.declared')
    return isDeclaredLicense(declared) ? weights.declared : 0
  }

  _computeDiscoveredScore(definition) {
    if (!definition.files) return 0
    const coreFiles = definition.files.filter(ComputeService._isInCoreFacet)
    if (!coreFiles.length) return 0
    const completeFiles = coreFiles.filter(file => file.license && file.attributions && file.attributions.length)
    return Math.round((completeFiles.length / coreFiles.length) * weights.discovered)
  }

  _computeConsistencyScore(definition) {
    const declared = get(definition, 'licensed.declared')
    // Note here that we are saying that every discovered license is satisfied by the declared
    // license. If there are no discovered licenses then all is good.
    const discovered = get(definition, 'licensed.facets.core.discovered.expressions') || []
    if (!declared || !discovered) return 0
    return discovered.every(expression => SPDX.satisfies(expression, declared)) ? weights.consistency : 0
  }

  _computeSPDXScore(definition) {
    try {
      parse(get(definition, 'licensed.declared')) // use strict spdx-expression-parse
      return weights.spdx
    } catch (e) {
      return 0
    }
  }

  _computeTextsScore(definition) {
    if (!definition.files || !definition.files.length) return 0
    const includedTexts = this._collectLicenseTexts(definition)
    if (!includedTexts.length) return 0
    const referencedLicenses = this._collectReferencedLicenses(definition)
    if (!referencedLicenses.length) return 0

    // check that all the referenced licenses have texts
    const found = intersection(referencedLicenses, includedTexts)
    return found.length === referencedLicenses.length ? weights.texts : 0
  }

  // get all the licenses that have been referenced anywhere in the definition (declared and core)
  _collectReferencedLicenses(definition) {
    const referencedExpressions = new Set(get(definition, 'licensed.facets.core.discovered.expressions') || [])
    const declared = get(definition, 'licensed.declared')
    if (declared) referencedExpressions.add(declared)
    const result = new Set()
    referencedExpressions.forEach(expression => this._extractLicensesFromExpression(expression, result))
    return Array.from(result)
  }

  // Get the full set of license texts captured in the definition
  _collectLicenseTexts(definition) {
    const result = new Set()
    definition.files
      .filter(ComputeService._isLicenseFile)
      .forEach(file => this._extractLicensesFromExpression(file.license, result))
    return Array.from(result)
  }

  // recursively add all licenses mentioned in the given expression to the given set
  _extractLicensesFromExpression(expression, seen) {
    if (!expression) return null
    if (typeof expression === 'string') expression = SPDX.parse(expression)
    if (expression.license) return seen.add(expression.license)
    this._extractLicensesFromExpression(expression.left, seen)
    this._extractLicensesFromExpression(expression.right, seen)
  }

  static _isInCoreFacet(file) {
    return !file.facets || file.facets.includes('core')
  }

  // Answer whether or not the given file is a license text file
  static _isLicenseFile(file) {
    return file.token && ComputeService._isInCoreFacet(file) && (file.natures || []).includes('license')
  }
  // ensure all the right facet information has been computed and added to the given definition
  _ensureFacets(definition) {
    if (!definition.files) return
    const facetFiles = this._computeFacetFiles([...definition.files], get(definition, 'described.facets'))
    for (const facet in facetFiles)
      setIfValue(definition, `licensed.facets.${facet}`, this._summarizeFacetInfo(facet, facetFiles[facet]))
  }

  // figure out which files are in which facets
  _computeFacetFiles(files, facets = {}) {
    const facetList = Object.getOwnPropertyNames(facets)
    remove(facetList, 'core')
    if (facetList.length === 0) return { core: files }
    const result = { core: [...files] }
    for (const facet in facetList) {
      const facetKey = facetList[facet]
      const filters = facets[facetKey]
      if (!filters || filters.length === 0) break
      result[facetKey] = files.filter(file => filters.some(filter => minimatch(file.path, filter)))
      pullAllWith(result.core, result[facetKey], isEqual)
    }
    return result
  }

  // create the data object for the identified facet containing the given files. Also destructively brand
  // the individual file objects with the facet
  _summarizeFacetInfo(facet, facetFiles) {
    if (!facetFiles || facetFiles.length === 0) return null
    const attributions = new Set()
    const licenseExpressions = new Set()
    let unknownParties = 0
    let unknownLicenses = 0
    // accumulate all the licenses and attributions, and count anything that's missing
    for (let file of facetFiles) {
      file.license ? licenseExpressions.add(file.license) : unknownLicenses++
      const statements = simplifyAttributions(file.attributions)
      setIfValue(file, 'attributions', statements)
      statements ? addArrayToSet(statements, attributions) : unknownParties++
      if (facet !== 'core') {
        // tag the file with the current facet if not core
        file.facets = file.facets || []
        file.facets.push(facet)
      }
    }
    const result = {
      attribution: {
        unknown: unknownParties
      },
      discovered: {
        unknown: unknownLicenses
      },
      files: facetFiles.length
    }
    setIfValue(result, 'attribution.parties', simplifyAttributions(setToArray(attributions)))
    // TODO need a function to reduce/simplify sets of expressions
    setIfValue(result, 'discovered.expressions', setToArray(licenseExpressions))
    return result
  }

  _ensureDescribed(definition) {
    definition.described = definition.described || {}
  }

  _ensureSourceLocation(coordinates, definition) {
    if (get(definition, 'described.sourceLocation')) return updateSourceLocation(definition.described.sourceLocation)
    // For source components there may not be an explicit harvested source location (it is self-evident)
    // Make it explicit in the definition
    switch (coordinates.type) {
      case 'go':
      case 'git':
      case 'sourcearchive':
      case 'pypi': {
        const url = buildSourceUrl(coordinates)
        if (!url) return
        this._ensureDescribed(definition)
        definition.described.sourceLocation = { ...coordinates, url }
        break
      }
      default:
        return
    }
  }
}

module.exports = (harvestStore, summaryService, aggregationService, curationService, logger) =>
  new ComputeService(harvestStore, summaryService, aggregationService, curationService, logger)
