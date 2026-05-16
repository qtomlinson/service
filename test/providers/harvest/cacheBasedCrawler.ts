// (c) Copyright 2025, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

import assert from 'node:assert'
import sinon from 'sinon'
import cacheBasedHarvester from '../../../providers/harvest/cacheBasedCrawler.ts'
import { createMockLogger } from '../../helpers/mockLogger.ts'

function createCacheMock() {
  return {
    store: {},
    async get(key) {
      return this.store[key] || []
    },
    async set(key, value) {
      this.store[key] = value
    },
    async setIfAbsentBatch(_keys: string[]) {
      return true
    },
    async delete(key) {
      delete this.store[key]
    }
  }
}

function createLockMock() {
  return {
    withLock: sinon.stub().callsFake(async (_coords: string[], fn: () => Promise<void>) => fn())
  }
}

describe('CacheBasedHarvester', () => {
  const cacheKeyFoo = 'hrv_pkg/npm/foo/1.0.0'
  const cacheKeyBar = 'hrv_pkg/npm/bar/2.0.0'
  const foo = { coordinates: 'pkg/npm/foo/1.0.0' }
  const bar = { coordinates: 'pkg/npm/bar/2.0.0' }

  const loggerMock = createMockLogger()

  let cacheMock
  let lockMock
  let crawler
  let harvesterMock

  const createCrawler = (overrides = {}) =>
    cacheBasedHarvester({
      cachingService: cacheMock,
      harvester: harvesterMock,
      logger: loggerMock as any,
      lock: lockMock,
      ...overrides
    })

  beforeEach(() => {
    harvesterMock = {
      harvest: sinon.stub(),
      toHarvestItem: sinon.stub().callsFake(entry => entry)
    }

    cacheMock = createCacheMock()
    sinon.spy(cacheMock, 'get')
    sinon.spy(cacheMock, 'set')
    sinon.spy(cacheMock, 'delete')

    lockMock = createLockMock()
    crawler = createCrawler()
  })

  describe('harvest', () => {
    const spec = [foo, bar]

    it('calls harvester with correct parameters', async () => {
      await crawler.harvest(spec, false)
      assert.strictEqual(cacheMock.set.callCount, 2, 'set should be called twice')
      assert.ok(harvesterMock.harvest.calledOnce, 'harvest should be called once')
      assert.deepStrictEqual(
        harvesterMock.harvest.args[0][0],
        [foo, bar],
        'Expected harvester to be called with the correct entries'
      )
    })

    it('adds to cache after harvest', async () => {
      await crawler.harvest(spec, false)
      const isFooTracked = await crawler.isTracked(foo.coordinates)
      assert.ok(isFooTracked, 'Expected cache to be set for foo')
      const isBarTracked = await crawler.isTracked(bar.coordinates)
      assert.ok(isBarTracked, 'Expected cache to be set for bar')
    })

    it('removes duplicates before harvest', async () => {
      await crawler.harvest([foo, foo], false)
      assert.strictEqual(cacheMock.set.callCount, 1, 'set should be called once')
      assert.ok(harvesterMock.harvest.calledOnce, 'harvest should be called once')
      assert.deepStrictEqual(
        harvesterMock.harvest.args[0][0],
        [foo],
        'Expected harvester to be called with the correct entries'
      )
    })

    it('ignores tracked entries and calls harvester', async () => {
      cacheMock.store[cacheKeyFoo] = [foo]
      await crawler.harvest(spec, false)
      assert.deepStrictEqual(
        harvesterMock.harvest.args[0][0],
        [bar],
        'Expected harvester to be called with the correct entries'
      )
    })

    it('skips lock acquisition entirely when pre-filter removes all entries', async () => {
      cacheMock.store[cacheKeyFoo] = [foo]
      cacheMock.store[cacheKeyBar] = [bar]
      await crawler.harvest(spec, false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called')
      assert.ok(lockMock.withLock.notCalled, 'Expected no lock acquisition when pre-filter removes all entries')
    })

    it('acquires locks only for untracked entries after pre-filter', async () => {
      cacheMock.store[cacheKeyFoo] = [foo]
      await crawler.harvest(spec, false)
      assert.ok(lockMock.withLock.calledOnce, 'Expected lock to be acquired once')
      assert.deepStrictEqual(
        lockMock.withLock.getCall(0).args[0],
        [bar.coordinates],
        'Expected lock to be acquired only for the untracked entry'
      )
      assert.deepStrictEqual(
        harvesterMock.harvest.args[0][0],
        [bar],
        'Expected harvester to be called with only the untracked entry'
      )
    })

    it('uses configured concurrency for outer pre-filter and leaves in-lock recheck unthrottled', async () => {
      crawler = createCrawler({ concurrencyLimit: 7 })
      const filterSpy = sinon.spy(crawler, '_filterOutTracked')
      cacheMock.store[cacheKeyFoo] = [foo]

      await crawler.harvest(spec, false)

      // Fixture expectation: foo is pre-tracked, so pre-filter returns [bar] and in-lock recheck still runs.
      assert.strictEqual(filterSpy.callCount, 2, 'Expected pre-filter and in-lock recheck calls')
      assert.deepStrictEqual(filterSpy.getCall(0).args[0], spec, 'Expected outer pre-filter call with original spec')
      assert.deepStrictEqual(
        filterSpy.getCall(1).args[0],
        [bar],
        'Expected in-lock recheck call with candidate entries'
      )
      assert.strictEqual(filterSpy.getCall(0).args[1], 7, 'Expected outer pre-filter to use configured concurrency')
      assert.strictEqual(filterSpy.getCall(1).args[1], undefined, 'Expected in-lock recheck to remain unthrottled')
    })

    it('proceeds through pre-filter and dispatches harvest when cache.get throws', async () => {
      cacheMock.get = sinon.stub().rejects(new Error('Cache read error'))
      await assert.doesNotReject(() => crawler.harvest([foo], false))
      assert.ok(harvesterMock.harvest.calledOnce, 'Expected harvest to proceed when pre-filter cache reads fail')
    })

    it('does not call harvester if no entries are provided', async () => {
      await crawler.harvest([], false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called')
    })

    it('throws error if harvester throws', async () => {
      harvesterMock.harvest.rejects(new Error('Harvester error'))
      await assert.rejects(async () => {
        await crawler.harvest([foo], false)
      }, 'Expected harvest to throw the harvest errors')
    })

    it('handles errors in cache gracefully', async () => {
      cacheMock.get = sinon.stub().rejects(new Error('Cache error'))
      await assert.doesNotReject(async () => {
        await crawler.isTracked(foo.coordinates)
      }, 'Expected isTracked to handle cache errors gracefully')
    })

    it('processes independent coordinates concurrently without blocking each other', async () => {
      await Promise.all([crawler.harvest([foo], false), crawler.harvest([bar], false)])

      assert.strictEqual(harvesterMock.harvest.callCount, 2, 'Both independent coordinates should be harvested')
      const harvested = harvesterMock.harvest.args.map(([entries]) => entries[0].coordinates)
      assert.ok(harvested.includes(foo.coordinates), 'Expected foo to be harvested')
      assert.ok(harvested.includes(bar.coordinates), 'Expected bar to be harvested')
    })

    it('resolves normally when tracking fails', async () => {
      cacheMock.set = sinon.stub().rejects(new Error('Cache write error'))

      await assert.doesNotReject(() => crawler.harvest([foo], false))
    })
  })

  describe('isTracked', () => {
    it('calls cache with the correct parameter', async () => {
      await crawler.isTracked(foo.coordinates)
      assert.ok(cacheMock.get.calledWith(cacheKeyFoo), 'Expected cache get to be called with the correct key')
    })

    it('returns true if the entry is tracked', async () => {
      cacheMock.store[cacheKeyFoo] = [foo]
      const result = await crawler.isTracked(foo.coordinates)
      assert.strictEqual(result, true, 'Expected entry to be tracked')
    })

    it('returns false if the entry is not tracked', async () => {
      const result = await crawler.isTracked(foo.coordinates)
      assert.strictEqual(result, false)
    })

    it('returns false for null', async () => {
      const result = await crawler.isTracked(null)
      assert.strictEqual(result, false)
      assert.ok(cacheMock.get.notCalled, 'Expected cache get not to be called')
    })

    it('returns false for undefined', async () => {
      const result = await crawler.isTracked(undefined)
      assert.strictEqual(result, false)
      assert.ok(cacheMock.get.notCalled, 'Expected cache get not to be called')
    })

    it('returns false for empty string', async () => {
      const result = await crawler.isTracked('')
      assert.strictEqual(result, false)
      assert.ok(cacheMock.get.notCalled, 'Expected cache get not to be called')
    })
  })

  describe('_filterOutTracked', () => {
    it('caps parallel tracking checks when concurrency is provided', async () => {
      const entries = Array.from({ length: 6 }, (_, index) => ({ coordinates: `pkg/npm/item/${index}` }))
      let inFlight = 0
      let maxInFlight = 0

      sinon.stub(crawler, '_isTrackedHarvest').callsFake(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        return false
      })

      const result = await crawler._filterOutTracked(entries, 2)

      assert.strictEqual(result.length, entries.length, 'Expected all entries to pass through when none are tracked')
      assert.ok(maxInFlight <= 2, `Expected max concurrent checks <= 2, got ${maxInFlight}`)
    })

    it('bypasses throat when concurrency is greater than or equal to entry count', async () => {
      const entries = Array.from({ length: 6 }, (_, index) => ({ coordinates: `pkg/npm/item/${index}` }))
      let inFlight = 0
      let maxInFlight = 0

      sinon.stub(crawler, '_isTrackedHarvest').callsFake(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        return false
      })

      const result = await crawler._filterOutTracked(entries, 10)

      assert.strictEqual(result.length, entries.length, 'Expected all entries to pass through when none are tracked')
      assert.strictEqual(
        maxInFlight,
        entries.length,
        `Expected unthrottled execution when limit >= entries, got ${maxInFlight}`
      )
    })
  })

  describe('_trackHarvests', () => {
    it('runs tracking writes unthrottled', async () => {
      const entries = Array.from({ length: 6 }, (_, index) => ({ coordinates: `pkg/npm/item/${index}` }))
      let inFlight = 0
      let maxInFlight = 0

      sinon.stub(crawler, '_track').callsFake(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
      })

      await assert.doesNotReject(() => crawler._trackHarvests(entries))

      assert.strictEqual(
        maxInFlight,
        entries.length,
        `Expected unthrottled tracking writes, got max concurrency ${maxInFlight}`
      )
    })

    it('logs individual tracking failures and resolves', async () => {
      const entries = [foo, bar]
      const trackError = new Error('Track write failed')

      loggerMock.error.resetHistory()
      sinon.stub(crawler, '_track').callsFake(async (entry: any) => {
        if (entry.coordinates === foo.coordinates) {
          throw trackError
        }
      })

      await assert.doesNotReject(() => crawler._trackHarvests(entries))
      assert.ok(loggerMock.error.calledWith(trackError), 'Expected rejected track operation to be logged')
    })
  })

  describe('done', () => {
    beforeEach(() => {
      cacheMock.store[cacheKeyFoo] = [foo]
    })

    it('call delete with the correct parameters', async () => {
      await crawler.done(foo.coordinates)
      assert.ok(cacheMock.delete.calledWith(cacheKeyFoo))
    })

    it('deletes the cache for the given coordinates', async () => {
      let isFooTracked = await crawler.isTracked(foo.coordinates)
      assert.ok(isFooTracked, 'Expected cache to be set for foo')
      await crawler.done(foo.coordinates)
      isFooTracked = await crawler.isTracked(foo.coordinates)
      assert.ok(!isFooTracked, 'Expected cache to be deleted for foo')
    })

    it('does not delete the cache for null', async () => {
      await crawler.done(null)
      assert.ok(cacheMock.delete.notCalled, 'Expected cache delete not to be called')
      assert.deepStrictEqual(cacheMock.store[cacheKeyFoo], [foo])
    })

    it('has no effect when deleting a non-existing coordinates', async () => {
      let isBarTracked = await crawler.isTracked(bar.coordinates)
      assert.ok(!isBarTracked, 'Expected cache to not be set for bar')
      await crawler.done(bar.coordinates)
      assert.ok(cacheMock.delete.calledOnce, 'Expected cache delete to be called')
      isBarTracked = await crawler.isTracked(bar.coordinates)
      assert.ok(!isBarTracked, 'Expected cache to not be set for bar')
    })

    it('resolves and logs when cache.delete throws', async () => {
      cacheMock.delete = sinon.stub().rejects(new Error('Cache error'))

      await assert.doesNotReject(() => crawler.done(foo.coordinates))
      assert.ok(loggerMock.error.called, 'Expected error to be logged')
    })
  })

  describe('Edge Cases', () => {
    it('handles non-string coordinates in isTracked', async () => {
      const result = await crawler.isTracked(12345)
      assert.strictEqual(result, false, 'Expected isTracked to return false for non-string coordinates')
    })

    it('handles null spec in harvest', async () => {
      await crawler.harvest(null, false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called for null coordinates')
    })

    it('handles empty objects in harvest', async () => {
      await crawler.harvest([{}], false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called for empty objects')
    })

    it('handles null coordinates in harvest', async () => {
      await crawler.harvest([null], false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called for null coordinates')
    })

    it('handles undefined coordinates in harvest', async () => {
      await crawler.harvest([undefined], false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called for undefined coordinates')
    })

    it('handles empty array in harvest', async () => {
      await crawler.harvest([], false)
      assert.ok(harvesterMock.harvest.notCalled, 'Expected harvester not to be called for empty array')
    })
  })
})
