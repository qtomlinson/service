// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const sinon = require('sinon')
const DefinitionService = require('../../business/definitionService')
const EntityCoordinates = require('../../lib/entityCoordinates')
const { set } = require('lodash')
const deepEqualInAnyOrder = require('deep-equal-in-any-order')
const chai = require('chai')
chai.use(deepEqualInAnyOrder)
const expect = chai.expect
const DefinitionQueueUpgrader = require('../../providers/upgrade/defUpgradeQueue')
const memoryQueue = require('../../providers/upgrade/memoryQueueConfig')
const { DefinitionVersionChecker } = require('../../providers/upgrade/defVersionCheck')
const ComputeService = require('../../business/computeService')

describe('Definition Service', () => {
  it('invalidates single coordinate', async () => {
    const { service, coordinates } = setup()
    await service.invalidate(coordinates)
    expect(service.definitionStore.delete.calledOnce).to.be.true
    expect(service.definitionStore.delete.getCall(0).args[0].name).to.be.eq('test')
    expect(service.cache.delete.calledOnce).to.be.true
    expect(service.cache.delete.getCall(0).args[0]).to.be.eq('def_npm/npmjs/-/test/1.0')
  })

  it('invalidates array of coordinates', async () => {
    const { service } = setup()
    const coordinates = [
      EntityCoordinates.fromString('npm/npmjs/-/test0/2.3'),
      EntityCoordinates.fromString('npm/npmjs/-/test1/2.3')
    ]
    await service.invalidate(coordinates)
    expect(service.definitionStore.delete.calledTwice).to.be.true
    expect(service.cache.delete.calledTwice).to.be.true
    expect(service.definitionStore.delete.getCall(0).args[0].name).to.be.eq('test0')
    expect(service.definitionStore.delete.getCall(1).args[0].name).to.be.eq('test1')
    expect(service.cache.delete.getCall(0).args[0]).to.be.eq('def_npm/npmjs/-/test0/2.3')
    expect(service.cache.delete.getCall(1).args[0]).to.be.eq('def_npm/npmjs/-/test1/2.3')
  })

  it('does not store empty definitions', async () => {
    const { service, coordinates } = setup(createDefinition())
    await service.get(coordinates)
    expect(service.definitionStore.store.notCalled).to.be.true
    expect(service.search.store.notCalled).to.be.true
  })

  it('stores new definitions', async () => {
    const { service, coordinates } = setup(createDefinition(null, null, ['foo']))
    await service.get(coordinates)
    expect(service.definitionStore.store.calledOnce).to.be.true
    expect(service.search.store.notCalled).to.be.true
  })

  it('trims files from definitions', async () => {
    const { service, coordinates } = setup(createDefinition(null, [{ path: 'path/to/file' }], ['foo']))
    const definition = await service.get(coordinates, null, null, '-files')
    expect(definition.files).to.be.undefined
    const fullDefinition = await service.get(coordinates)
    expect(fullDefinition.files).to.deep.eq([{ path: 'path/to/file' }])
  })

  it('logs and harvest new definitions with empty tools', async () => {
    const { service, coordinates } = setup(createDefinition(null, null, []))
    await service.get(coordinates)
    // expect(service.logger.info.calledOnce).to.be.true
    // expect(service.logger.info.getCall(0).args[0]).to.eq('definition not available')
    expect(service._harvest.calledOnce).to.be.true
    expect(service._harvest.getCall(0).args[0]).to.eq(coordinates)
  })

  it('logs and harvests new definitions with undefined tools', async () => {
    const { service, coordinates } = setup(createDefinition(null, null, undefined))
    await service.get(coordinates)
    // expect(service.logger.info.calledOnce).to.be.true
    // expect(service.logger.info.getCall(0).args[0]).to.eq('definition not available')
    expect(service._harvest.calledOnce).to.be.true
    expect(service._harvest.getCall(0).args[0]).to.eq(coordinates)
  })

  it('lists all coordinates found', async () => {
    const { service } = setup()
    service.definitionStore.list = coordinates => {
      coordinates.revision = '2.3'
      if (coordinates.name === 'missing') return Promise.resolve([])
      return Promise.resolve([coordinates.toString().toLowerCase()])
    }
    const coordinates = [
      EntityCoordinates.fromString('npm/npmjs/-/test0/2.3'),
      EntityCoordinates.fromString('npm/npmjs/-/test1/2.3'),
      EntityCoordinates.fromString('npm/npmjs/-/testUpperCase/2.3'),
      EntityCoordinates.fromString('npm/npmjs/-/missing/2.3')
    ]
    const result = await service.listAll(coordinates)
    expect(result.length).to.eq(3)
    expect(result.map(x => x.name)).to.have.members(['test0', 'test1', 'testUpperCase'])
  })
})

describe('Integration test', () => {
  describe('Handle schema version upgrade', () => {
    const coordinates = EntityCoordinates.fromString('npm/npmjs/-/test/1.0')
    const definition = { _meta: { schemaVersion: '1.7.0' }, coordinates }
    const logger = {
      debug: () => {},
      error: () => {},
      info: () => {}
    }

    let upgradeHandler

    const handleVersionedDefinition = function () {
      describe('verify schema version', () => {
        it('logs and harvests new definitions with empty tools', async () => {
          const { service } = setupServiceForUpgrade(null, upgradeHandler)
          service._harvest = sinon.stub()
          await service.get(coordinates)
          expect(service._harvest.calledOnce).to.be.true
          expect(service._harvest.getCall(0).args[0]).to.eq(coordinates)
        })

        it('computes if definition does not exist', async () => {
          const { service } = setupServiceForUpgrade(null, upgradeHandler)
          service.computeStoreAndCurate = sinon.stub().resolves(definition)
          await service.get(coordinates)
          expect(service.computeStoreAndCurate.calledOnce).to.be.true
          expect(service.computeStoreAndCurate.getCall(0).args[0]).to.eq(coordinates)
        })

        it('returns the up-to-date definition', async () => {
          const { service } = setupServiceForUpgrade(definition, upgradeHandler)
          service.computeStoreAndCurate = sinon.stub()
          const result = await service.get(coordinates)
          expect(service.computeStoreAndCurate.called).to.be.false
          expect(result).to.deep.equal(definition)
        })
      })
    }

    describe('schema version check', () => {
      beforeEach(async () => {
        upgradeHandler = new DefinitionVersionChecker({ logger })
        await upgradeHandler.initialize()
      })

      handleVersionedDefinition()

      context('with stale definitions', () => {
        it('recomputes a definition with the updated schema version', async () => {
          const staleDef = { ...createDefinition(null, null, ['foo']), _meta: { schemaVersion: '1.0.0' }, coordinates }
          const { service, store } = setupServiceForUpgrade(staleDef, upgradeHandler)
          const result = await service.get(coordinates)
          expect(result._meta.schemaVersion).to.eq('1.7.0')
          expect(result.coordinates).to.deep.equal(coordinates)
          expect(store.store.calledOnce).to.be.true
        })
      })
    })

    describe('queueing schema version updates', () => {
      let queue, staleDef
      beforeEach(async () => {
        queue = memoryQueue()
        const queueFactory = sinon.stub().returns(queue)
        upgradeHandler = new DefinitionQueueUpgrader({ logger, queue: queueFactory })
        await upgradeHandler.initialize()
        staleDef = { ...createDefinition(null, null, ['foo']), _meta: { schemaVersion: '1.0.0' }, coordinates }
      })

      handleVersionedDefinition()

      context('with stale definitions', () => {
        it('returns a stale definition, queues update, recomputes and retrieves the updated definition', async () => {
          const { service, store } = setupServiceForUpgrade(staleDef, upgradeHandler)
          const result = await service.get(coordinates)
          expect(result).to.deep.equal(staleDef)
          expect(queue.data.length).to.eq(1)
          await upgradeHandler.setupProcessing(service, logger, true)
          const newResult = await service.get(coordinates)
          expect(newResult._meta.schemaVersion).to.eq('1.7.0')
          expect(store.store.calledOnce).to.be.true
          expect(queue.data.length).to.eq(0)
        })

        it('computes once when the same coordinates is queued twice', async () => {
          const { service, store } = setupServiceForUpgrade(staleDef, upgradeHandler)
          await service.get(coordinates)
          const result = await service.get(coordinates)
          expect(result).to.deep.equal(staleDef)
          expect(queue.data.length).to.eq(2)
          await upgradeHandler.setupProcessing(service, logger, true)
          expect(queue.data.length).to.eq(1)
          await upgradeHandler.setupProcessing(service, logger, true)
          const newResult = await service.get(coordinates)
          expect(newResult._meta.schemaVersion).to.eq('1.7.0')
          expect(store.store.calledOnce).to.be.true
          expect(queue.data.length).to.eq(0)
        })

        it('computes once when the same coordinates is queued twice within one dequeue batch ', async () => {
          const { service, store } = setupServiceForUpgrade(staleDef, upgradeHandler)
          await service.get(coordinates)
          await service.get(coordinates)
          queue.dequeueMultiple = sinon.stub().callsFake(async () => {
            const message1 = await queue.dequeue()
            const message2 = await queue.dequeue()
            return Promise.resolve([message1, message2])
          })
          await upgradeHandler.setupProcessing(service, logger, true)
          const newResult = await service.get(coordinates)
          expect(newResult._meta.schemaVersion).to.eq('1.7.0')
          expect(store.store.calledOnce).to.be.true
        })
      })
    })
  })

  describe('Placeholder definition and Cache', () => {
    let service, coordinates, harvestService

    describe('placeholder definition', () => {
      beforeEach(() => {
        ;({ service, coordinates, harvestService } = setup(createDefinition(null, null, null)))
        sinon.spy(service, 'compute')
        sinon.spy(service, '_computePlaceHolder')
        sinon.spy(harvestService, 'isTracked')
      })

      it('triggers a harvest for a new component', async () => {
        harvestService.isTracked = sinon.stub().resolves(false)
        await service.get(coordinates)
        expect(service.compute.called).to.be.true
        expect(service._harvest.called).to.be.true
        expect(service._computePlaceHolder.calledOnce).to.be.false
        expect(harvestService.isTracked.calledOnce).to.be.true
        expect(harvestService.isTracked.args[0][0]).to.be.deep.equal(coordinates)
      })

      it('returns a placeholder definition with a tracked harvest', async () => {
        harvestService.isTracked = sinon.stub().resolves(true)
        await service.get(coordinates)
        expect(service._computePlaceHolder.calledOnce).to.be.true
        expect(service.compute.called).to.be.false
        expect(service._harvest.called).to.be.false
        expect(harvestService.isTracked.calledOnce).to.be.true
        expect(harvestService.isTracked.args[0][0]).to.be.deep.equal(coordinates)
      })
    })

    it('deletes the tracked in progress harvest after definition is computed', async () => {
      ;({ service, coordinates, harvestService } = setup(createDefinition(null, null, ['foo'])))
      harvestService.done = sinon.stub().resolves(true)
      await service.computeAndStore(coordinates)
      expect(harvestService.done.calledOnce).to.be.true
      expect(harvestService.done.args[0][0]).to.be.deep.equal(coordinates)
    })
  })
})

const mockLogger = { debug: () => {}, error: () => {}, info: () => {} }

function mockCurator() {
  return {
    get: () => Promise.resolve(),
    apply: (_coordinates, _curationSpec, definition) => Promise.resolve(definition),
    autoCurate: () => {}
  }
}

function mockHarvestService() {
  return {
    harvest: () => sinon.stub(),
    done: () => Promise.resolve(),
    isTracked: () => Promise.resolve(false)
  }
}

function setupServiceForUpgrade(definition, upgradeHandler) {
  let storedDef = definition && { ...definition }
  const store = {
    get: sinon.stub().resolves(storedDef),
    store: sinon.stub().callsFake(def => (storedDef = def))
  }
  const harvestStore = { getAllLatest: () => Promise.resolve(null) }
  const summary = { summarizeAll: () => Promise.resolve(null) }
  const aggregator = { process: () => Promise.resolve(definition) }
  const curator = mockCurator()
  const computeService = ComputeService(harvestStore, summary, aggregator, curator, mockLogger)
  const { service } = setupWithDelegates(curator, harvestStore, computeService, store, upgradeHandler)
  return { service, store }
}

function setupWithDelegates(
  curator,
  harvestStore,
  computeService,
  store = { delete: sinon.stub(), get: sinon.stub(), store: sinon.stub() },
  upgradeHandler = { validate: def => Promise.resolve(def) }
) {
  const search = { delete: sinon.stub(), store: sinon.stub() }
  const cache = { delete: sinon.stub(), get: sinon.stub(), set: sinon.stub() }
  const harvestService = mockHarvestService()
  const service = DefinitionService(
    harvestStore,
    harvestService,
    computeService,
    curator,
    store,
    search,
    cache,
    upgradeHandler
  )
  service.logger = mockLogger
  return { service, harvestService }
}

function createDefinition(facets, files, tools) {
  const result = { coordinates: EntityCoordinates.fromString('npm/npmjs/-/test/1.0') }
  if (facets) set(result, 'described.facets', facets)
  if (files) result.files = files
  if (tools) set(result, 'described.tools', tools)
  return result
}

function setup(definition) {
  const curator = mockCurator()
  const harvestStore = { getAllLatest: () => Promise.resolve(null) }
  const computeService = {
    compute: () => Promise.resolve(definition),
    computePlaceHolder: () => Promise.resolve(definition)
  }
  const { service, harvestService } = setupWithDelegates(curator, harvestStore, computeService)
  service._harvest = sinon.stub()
  const coordinates = EntityCoordinates.fromString('npm/npmjs/-/test/1.0')
  return { coordinates, service, harvestService }
}
