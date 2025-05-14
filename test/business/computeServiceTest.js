// (c) Copyright 2025, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const sinon = require('sinon')
const validator = require('../../schemas/validator')
const EntityCoordinates = require('../../lib/entityCoordinates')
const { setIfValue } = require('../../lib/utils')
const Curation = require('../../lib/curation')
const { set } = require('lodash')
const deepEqualInAnyOrder = require('deep-equal-in-any-order')
const chai = require('chai')
chai.use(deepEqualInAnyOrder)
const expect = chai.expect
const FileHarvestStore = require('../../providers/stores/fileHarvestStore')
const SummaryService = require('../../business/summarizer')
const AggregatorService = require('../../business/aggregator')
const ComputeService = require('../../business/computeService')

describe('Compute Service', () => {
  it('higher score than tool score with a curation', async () => {
    const files = [buildFile('bar.txt', 'MIT')]
    const raw = createDefinition(undefined, files)
    const curation = {
      licensed: { declared: 'MIT' },
      files: [{ path: 'bar.txt', attributions: ['Copyright Bob'] }],
      described: { releaseDate: '2018-08-09' }
    }
    const { service, coordinates } = setup(raw, null, curation)
    const definition = await service.compute(coordinates)
    expect(definition.described.score.total).to.eq(30)
    expect(definition.described.toolScore.total).to.eq(0)
    expect(definition.licensed.score.total).to.eq(85)
    expect(definition.licensed.toolScore.total).to.eq(0)
    expect(definition.scores.effective).to.eq(57) // floor(85+30/2)
    expect(definition.scores.tool).to.eq(0)
  })

  describe('Definition Service Facet management', () => {
    it('merges complex attributions across files', async () => {
      const files = [
        buildFile('foo.txt', null, ['&#60;Bob&gt;', 'Jane   Inc.', 'Jane Inc']),
        buildFile('bar.txt', null, ['<Bob>.', 'Jane Inc'])
      ]
      const { service, coordinates } = setup(createDefinition(undefined, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      const core = definition.licensed.facets.core
      expect(core.attribution.parties).to.deep.equalInAnyOrder(['Copyright <Bob>.', 'Copyright Jane Inc.'])
      expect(definition.files).to.deep.equalInAnyOrder([
        { path: 'foo.txt', attributions: ['Copyright <Bob>', 'Copyright Jane Inc.'] },
        { path: 'bar.txt', attributions: ['Copyright <Bob>.', 'Copyright Jane Inc'] }
      ])
    })

    it('handles files with no data', async () => {
      const files = [buildFile('foo.txt', null, null), buildFile('bar.txt', null, null)]
      const { service, coordinates } = setup(createDefinition(undefined, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(2)
      expect(definition.licensed.declared).to.be.undefined
      const core = definition.licensed.facets.core
      expect(core.files).to.eq(2)
      expect(core.attribution.parties).to.be.undefined
      expect(core.attribution.unknown).to.eq(2)
      expect(core.discovered.expressions).to.be.undefined
      expect(core.discovered.unknown).to.eq(2)
    })

    it('handles no files', async () => {
      const files = []
      const { service, coordinates } = setup(createDefinition(undefined, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(0)
      expect(definition.licensed.score.total).to.eq(0)
      expect(definition.licensed.toolScore.total).to.eq(0)
      expect(Object.keys(definition.licensed).length).to.eq(2)
    })

    it('gets all the attribution parties', async () => {
      const files = [buildFile('foo.txt', 'MIT', ['Bob', 'Fred']), buildFile('bar.txt', 'MIT', ['Jane', 'Fred'])]
      const { service, coordinates } = setup(createDefinition(undefined, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      const core = definition.licensed.facets.core
      expect(core.files).to.eq(2)
      expect(core.attribution.parties.length).to.eq(3)
      expect(core.attribution.parties).to.deep.equalInAnyOrder(['Copyright Bob', 'Copyright Jane', 'Copyright Fred'])
      expect(core.attribution.unknown).to.eq(0)
    })

    it('summarizes with basic facets', async () => {
      const files = [buildFile('package.json', 'MIT', []), buildFile('LICENSE.foo', 'GPL-2.0', [])]
      const facets = { tests: ['*.json'] }
      const { service, coordinates } = setup(createDefinition(facets, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(2)
      const core = definition.licensed.facets.core
      expect(core.files).to.eq(1)
      expect(core.discovered.expressions).to.deep.eq(['GPL-2.0'])
      expect(core.discovered.unknown).to.eq(0)
      const tests = definition.licensed.facets.tests
      expect(tests.files).to.eq(1)
      expect(tests.discovered.expressions).to.deep.eq(['MIT'])
      expect(tests.discovered.unknown).to.eq(0)
    })

    it('summarizes with no core filters', async () => {
      const files = [buildFile('package.json', 'MIT', []), buildFile('LICENSE.foo', 'GPL-2.0', [])]
      const facets = { tests: ['*.json'] }
      const { service, coordinates } = setup(createDefinition(facets, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(2)
      const core = definition.licensed.facets.core
      expect(core.files).to.eq(1)
      expect(core.discovered.expressions).to.deep.eq(['GPL-2.0'])
      expect(core.discovered.unknown).to.eq(0)
      const tests = definition.licensed.facets.tests
      expect(tests.files).to.eq(1)
      expect(tests.discovered.expressions).to.deep.eq(['MIT'])
      expect(tests.discovered.unknown).to.eq(0)
    })

    it('summarizes with everything grouped into non-core facet', async () => {
      const files = [buildFile('package.json', 'MIT', []), buildFile('LICENSE.foo', 'GPL-2.0', [])]
      const facets = { tests: ['*.json'], dev: ['*.foo'] }
      const { service, coordinates } = setup(createDefinition(facets, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(2)
      expect(definition.licensed.facets.core).to.be.undefined
      const dev = definition.licensed.facets.dev
      expect(dev.files).to.eq(1)
      expect(dev.discovered.expressions).to.deep.eq(['GPL-2.0'])
      expect(dev.discovered.unknown).to.eq(0)
      const tests = definition.licensed.facets.tests
      expect(tests.files).to.eq(1)
      expect(tests.discovered.expressions).to.deep.eq(['MIT'])
      expect(tests.discovered.unknown).to.eq(0)
    })

    it('summarizes files in multiple facets', async () => {
      const files = [buildFile('LICENSE.json', 'GPL-2.0', []), buildFile('Test.json', 'MIT', [])]
      const facets = { tests: ['*.json'], dev: ['*.json'] }
      const { service, coordinates } = setup(createDefinition(facets, files))
      const definition = await service.compute(coordinates)
      validate(definition)
      expect(definition.files.length).to.eq(2)
      expect(definition.files[0].facets).to.deep.equalInAnyOrder(['tests', 'dev'])
      expect(definition.files[1].facets).to.deep.equalInAnyOrder(['tests', 'dev'])
      expect(definition.licensed.facets.core).to.be.undefined
      const dev = definition.licensed.facets.dev
      expect(dev.files).to.eq(2)
      expect(dev.discovered.expressions).to.deep.equalInAnyOrder(['GPL-2.0', 'MIT'])
      expect(dev.discovered.unknown).to.eq(0)
      const tests = definition.licensed.facets.tests
      expect(tests.files).to.eq(2)
      expect(tests.discovered.expressions).to.deep.equalInAnyOrder(['MIT', 'GPL-2.0'])
      expect(tests.discovered.unknown).to.eq(0)
    })
  })

  describe('Build source location', () => {
    const data = new Map([
      [
        'pypi/pypi/-/platformdirs/4.2.0',
        {
          type: 'pypi',
          provider: 'pypi',
          name: 'platformdirs',
          revision: '4.2.0',
          url: 'https://pypi.org/project/platformdirs/4.2.0/'
        }
      ],
      [
        'go/golang/rsc.io/quote/v1.3.0',
        {
          type: 'go',
          provider: 'golang',
          namespace: 'rsc.io',
          name: 'quote',
          revision: 'v1.3.0',
          url: 'https://pkg.go.dev/rsc.io/quote@v1.3.0'
        }
      ],
      [
        'git/github/ratatui-org/ratatui/bcf43688ec4a13825307aef88f3cdcd007b32641',
        {
          type: 'git',
          provider: 'github',
          namespace: 'ratatui-org',
          name: 'ratatui',
          revision: 'bcf43688ec4a13825307aef88f3cdcd007b32641',
          url: 'https://github.com/ratatui-org/ratatui/tree/bcf43688ec4a13825307aef88f3cdcd007b32641'
        }
      ],
      [
        'git/gitlab/cznic/sqlite/282bdb12f8ce48a34b4b768863c4e44c310c4bd8',
        {
          type: 'git',
          provider: 'gitlab',
          namespace: 'cznic',
          name: 'sqlite',
          revision: '282bdb12f8ce48a34b4b768863c4e44c310c4bd8',
          url: 'https://gitlab.com/cznic/sqlite/-/tree/282bdb12f8ce48a34b4b768863c4e44c310c4bd8'
        }
      ],
      [
        'sourcearchive/mavencentral/com.azure/azure-storage-blob/12.20.0',
        {
          type: 'sourcearchive',
          provider: 'mavencentral',
          namespace: 'com.azure',
          name: 'azure-storage-blob',
          revision: '12.20.0',
          url: 'https://search.maven.org/remotecontent?filepath=com/azure/azure-storage-blob/12.20.0/azure-storage-blob-12.20.0-sources.jar'
        }
      ]
    ])

    data.forEach((expected, coordinatesString) => {
      it(`should have source location for ${coordinatesString} package`, async () => {
        const { service, coordinates } = setup(createDefinition(null, null, []), coordinatesString)
        const definition = await service.compute(coordinates)
        expect(definition.described.sourceLocation).to.be.deep.equal(expected)
      })
    })
  })

  describe('Integration test', () => {
    describe('compute', () => {
      const coordinates = EntityCoordinates.fromString('npm/npmjs/-/debug/3.1.0')
      let fileHarvestStore
      beforeEach(() => {
        fileHarvestStore = createFileHarvestStore()
      })

      it('computes the same definition with latest harvest data', async () => {
        const allHarvestData = await fileHarvestStore.getAll(coordinates)
        delete allHarvestData['scancode']['2.9.0+b1'] //remove invalid scancode version
        let service = setupForCompute(allHarvestData)
        const baseline_def = await service.compute(coordinates)

        const latestHarvestData = await fileHarvestStore.getAllLatest(coordinates)
        service = setupForCompute(latestHarvestData)
        const comparison_def = await service.compute(coordinates)

        //updated timestamp is not deterministic
        expect(comparison_def._meta.updated).to.not.equal(baseline_def._meta.updated)
        comparison_def._meta.updated = baseline_def._meta.updated
        expect(comparison_def).to.deep.equal(baseline_def)
      })

      it('returns a placeholder definition same as computed', async () => {
        const service = setupForCompute({})
        const computed = await service.compute(coordinates)
        const placeholder = service.computePlaceHolder(coordinates)
        placeholder._meta.updated = 'ignore_time_stamp'
        computed._meta.updated = 'ignore_time_stamp'
        expect(placeholder).to.deep.equal(computed)
      })
    })
  })
})

const logger = { info: sinon.stub(), debug: sinon.stub(), error: sinon.stub(), warn: sinon.stub() }

function setup(definition, coordinateSpec, curation) {
  const curator = {
    get: () => Promise.resolve(curation),
    apply: (_coordinates, _curationSpec, definition) => Promise.resolve(Curation.apply(definition, curation)),
    autoCurate: () => {}
  }
  const harvestStore = { getAllLatest: () => Promise.resolve(null) }
  const summary = { summarizeAll: () => Promise.resolve(null) }
  const aggregator = { process: () => Promise.resolve(definition) }
  const service = ComputeService(harvestStore, summary, aggregator, curator, logger)
  const coordinates = EntityCoordinates.fromString(coordinateSpec || 'npm/npmjs/-/test/1.0')
  return { coordinates, service }
}

function setupForCompute(rawHarvestData) {
  const harvestStore = { getAllLatest: () => Promise.resolve(rawHarvestData) }
  const summary = SummaryService({})
  const tools = [['clearlydefined', 'reuse', 'licensee', 'scancode', 'fossology', 'cdsource']]
  const aggregator = AggregatorService({ precedence: tools })
  aggregator.logger = logger
  const curator = {
    get: () => Promise.resolve(),
    apply: (_coordinates, _curationSpec, definition) => Promise.resolve(definition),
    autoCurate: () => {}
  }
  return ComputeService(harvestStore, summary, aggregator, curator, logger)
}
function createFileHarvestStore() {
  const options = {
    location: 'test/fixtures/store',
    logger
  }
  return FileHarvestStore(options)
}

function buildFile(path, license, holders) {
  const result = { path }
  setIfValue(result, 'license', license)
  setIfValue(result, 'attributions', holders ? holders.map(entry => `Copyright ${entry}`) : null)
  return result
}

function createDefinition(facets, files, tools) {
  const result = {}
  if (facets) set(result, 'described.facets', facets)
  if (files) result.files = files
  if (tools) set(result, 'described.tools', tools)
  return result
}

function validate(definition) {
  // Tack on a dummy coordinates to keep the schema happy. Tool summarizations do not have to include coordinates
  definition.coordinates = { type: 'npm', provider: 'npmjs', namespace: null, name: 'foo', revision: '1.0' }
  if (!validator.validate('definition', definition)) throw new Error(validator.errorsText())
}
