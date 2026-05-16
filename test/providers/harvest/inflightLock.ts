// (c) Copyright 2026, SAP SE and ClearlyDefined contributors. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

import assert from 'node:assert'
import sinon from 'sinon'
import inflightLockFactory, { InflightLock } from '../../../providers/harvest/inflightLock.ts'
import { createMockLogger } from '../../helpers/mockLogger.ts'

const inflightKey = (coordinates: string): string => `hrv_inflight_${coordinates.toLowerCase()}`

function createCacheMock() {
  return {
    store: {},
    locks: new Set<string>(),
    async get(key) {
      return this.store[key] || []
    },
    async set(key, value) {
      this.store[key] = value
    },
    async setIfAbsentBatch(keys: string[], value: string) {
      const acquired: string[] = []
      for (const key of keys) {
        if (this.locks.has(key)) {
          for (const k of acquired) {
            this.locks.delete(k)
            delete this.store[k]
          }
          return false
        }
        this.locks.add(key)
        this.store[key] = value
        acquired.push(key)
      }
      return true
    },
    async delete(key) {
      this.locks.delete(key)
      delete this.store[key]
    }
  }
}

describe('InflightLock', () => {
  const foo = { coordinates: 'pkg/npm/foo/1.0.0' }
  const bar = { coordinates: 'pkg/npm/bar/2.0.0' }

  const loggerMock = createMockLogger()

  let cacheMock
  let lock: InflightLock

  const noop = async () => {}

  const createLock = (overrides = {}) =>
    inflightLockFactory({
      cachingService: cacheMock,
      logger: loggerMock as any,
      lockRetryDelayMinMs: 1,
      lockRetryDelayMaxMs: 2,
      lockAcquireTimeoutMs: 100,
      localLockRetryDelayMs: 1,
      localLockTimeoutBufferMs: 0,
      ...overrides
    })

  beforeEach(() => {
    cacheMock = createCacheMock()
    sinon.spy(cacheMock, 'delete')
    lock = createLock()
  })

  describe('withLock', () => {
    it('serializes concurrent requests for same coordinate', async () => {
      let callCount = 0
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        callCount++
      }

      await Promise.all([lock.withLock([foo.coordinates], fn), lock.withLock([foo.coordinates], fn)])

      assert.strictEqual(callCount, 2, 'Expected only one harvest call for same coordinate')
    })

    it('does not deadlock for opposite coordinate order requests', async () => {
      let callCount = 0
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        callCount++
      }

      await Promise.all([lock.withLock([foo.coordinates, bar.coordinates], fn), lock.withLock([bar.coordinates, foo.coordinates], fn)])

      assert.strictEqual(
        callCount,
        2,
        'Expected one effective harvest due tracked dedup after lock'
      )
    })

    it('acquires inflight locks in sorted key order', async () => {
      sinon.spy(cacheMock, 'setIfAbsentBatch')

      await lock.withLock([bar.coordinates, foo.coordinates], noop)

      const sortedKeys = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()
      assert.deepStrictEqual(
        cacheMock.setIfAbsentBatch.getCall(0).args[0],
        sortedKeys,
        'setIfAbsentBatch should be called with keys in sorted order'
      )
    })

    it('normalizes inflight key casing', async () => {
      const mixedCase = 'NPM/npmjs/-/LODASH/4.0.0'
      sinon.spy(cacheMock, 'setIfAbsentBatch')

      await lock.withLock([mixedCase], noop)

      assert.deepStrictEqual(cacheMock.setIfAbsentBatch.getCall(0).args[0], ['hrv_inflight_npm/npmjs/-/lodash/4.0.0'])
    })

    it('releases partially acquired locks before retrying', async () => {
      const [firstKey, secondKey] = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()

      cacheMock.locks.add(secondKey)
      setTimeout(() => {
        cacheMock.locks.delete(secondKey)
      }, 10)

      await lock.withLock([foo.coordinates, bar.coordinates], noop)

      assert.ok(cacheMock.delete.calledWith(firstKey), 'Expected first lock to be released after initial miss')
      assert.ok(!cacheMock.locks.has(firstKey), 'Expected first lock to be released at end of harvest')
      assert.ok(!cacheMock.locks.has(secondKey), 'Expected second lock to be released at end of harvest')
    })

    it('throws when lock acquisition exceeds timeout', async () => {
      const keyFoo = inflightKey(foo.coordinates)
      cacheMock.locks.add(keyFoo)

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates], noop)
      }, /Timed out acquiring inflight harvest coordinate locks/)

      assert.strictEqual(
        cacheMock.locks.size,
        1,
        'Only the seeded key should remain in Redis — no locks leaked by harvest'
      )
      // Local lock was released — a subsequent call can acquire without hanging
      cacheMock.locks.delete(keyFoo)
      await assert.doesNotReject(() => lock.withLock([foo.coordinates], noop), 'Expected local lock to be fully released')
    })

    it('times out cleanly when one key is held throughout, leaving no leaked locks', async () => {
      const [firstKey, secondKey] = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()
      cacheMock.locks.add(secondKey)

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates, bar.coordinates], noop)
      }, /Timed out acquiring inflight harvest coordinate locks/)

      assert.ok(!cacheMock.locks.has(firstKey), 'No lock should remain for first key after timeout')
      assert.ok(cacheMock.locks.has(secondKey), 'Seeded second key should remain (held by another requester)')
      // Local locks were released — acquiring only firstKey's coordinate succeeds without hanging
      cacheMock.locks.delete(secondKey)
      await assert.doesNotReject(() => lock.withLock([foo.coordinates], noop), 'Local locks should be fully released after timeout')
    })

    it('emits a warn log when lock acquisition times out', async () => {
      loggerMock.warn.resetHistory()
      const keyFoo = inflightKey(foo.coordinates)
      cacheMock.locks.add(keyFoo)

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates], noop)
      }, /Timed out acquiring inflight harvest coordinate locks/)

      assert.ok(loggerMock.warn.calledOnce, 'Expected exactly one warn log on timeout')
      assert.ok(
        loggerMock.warn.firstCall.args[0].includes('Timed out acquiring'),
        'Expected warn message to mention timeout'
      )
    })

    it('uses fixed retry delay when min equals max', async () => {
      const fixedDelayMs = 7
      const keyFoo = inflightKey(foo.coordinates)
      cacheMock.locks.add(keyFoo)

      const lockWithFixedDelay = createLock({
        lockRetryDelayMinMs: fixedDelayMs,
        lockRetryDelayMaxMs: fixedDelayMs,
        lockAcquireTimeoutMs: 40
      })

      sinon.spy(cacheMock, 'setIfAbsentBatch')
      const clock = sinon.useFakeTimers()
      try {
        const pending = lockWithFixedDelay.withLock([foo.coordinates], noop)
        const rejection = assert.rejects(pending, /Timed out acquiring inflight harvest coordinate locks/)
        await clock.tickAsync(100)
        await rejection

        assert.ok(
          cacheMock.setIfAbsentBatch.callCount >= 2,
          'Expected multiple lock attempts while retrying with fixed delay before timing out'
        )
      } finally {
        clock.restore()
      }
    })

    it('releases all keys when setIfAbsentBatch throws', async () => {
      const [firstKey, secondKey] = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()

      cacheMock.setIfAbsentBatch = sinon.stub().callsFake(async (_keys: string[]) => {
        // Simulate: script acquired some keys server-side before throwing
        cacheMock.locks.add(firstKey)
        throw new Error('Redis unavailable')
      })

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates, bar.coordinates], noop)
      }, /Redis unavailable/)

      assert.ok(cacheMock.delete.calledWith(firstKey), 'Expected all keys to be released on error')
      assert.ok(cacheMock.delete.calledWith(secondKey), 'Expected all keys to be released on error')
    })

    it('releases all keys as safety net when setIfAbsentBatch throws without acquiring any', async () => {
      const [firstKey, secondKey] = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()

      cacheMock.setIfAbsentBatch = sinon.stub().callsFake(async () => {
        throw new Error('Redis unavailable')
      })

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates, bar.coordinates], noop)
      }, /Redis unavailable/)

      assert.ok(
        cacheMock.delete.calledWith(firstKey),
        'Expected safety release of first key even with no keys acquired'
      )
      assert.ok(
        cacheMock.delete.calledWith(secondKey),
        'Expected safety release of second key even with no keys acquired'
      )
    })

    it('rethrows setIfAbsentBatch error even when safety release also fails', async () => {
      const [firstKey] = [inflightKey(foo.coordinates), inflightKey(bar.coordinates)].sort()

      cacheMock.setIfAbsentBatch = sinon.stub().callsFake(async () => {
        throw new Error('Redis unavailable')
      })

      cacheMock.delete = sinon.stub().callsFake(async key => {
        if (key === firstKey) {
          throw new Error('Release failed')
        }
        cacheMock.locks.delete(key)
      })

      await assert.rejects(async () => {
        await lock.withLock([foo.coordinates, bar.coordinates], noop)
      }, /Redis unavailable/)
    })

    it('local gate prevents simultaneous Redis acquire attempts for same-instance concurrent requests', async () => {
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      sinon.spy(cacheMock, 'setIfAbsentBatch')

      await Promise.all([lock.withLock([foo.coordinates], fn), lock.withLock([foo.coordinates], noop)])

      assert.strictEqual(
        cacheMock.setIfAbsentBatch.callCount,
        2,
        'Each request hits Redis exactly once — local gate prevents simultaneous Redis contention'
      )
    })

    it('throws when local lock acquisition exceeds timeout', async () => {
      // Hold the local lock for the duration by never resolving within the timeout window
      const holdLock = lock.withLock([foo.coordinates], () => new Promise(resolve => setTimeout(resolve, 200)))
      // Give the holder time to acquire before the second caller tries
      await new Promise(resolve => setTimeout(resolve, 5))
      sinon.spy(cacheMock, 'setIfAbsentBatch')

      await assert.rejects(
        () => lock.withLock([foo.coordinates], noop),
        /Timed out acquiring local inflight harvest coordinate locks/
      )

      assert.ok(
        cacheMock.setIfAbsentBatch.notCalled,
        'Redis setIfAbsentBatch should not be called when local times out'
      )

      await holdLock
    })
  })

  describe('withLock release failures', () => {
    it('logs delete failures and does not throw', async () => {
      const deleteError = new Error('Delete failed')
      const keyFoo = inflightKey(foo.coordinates)

      loggerMock.error.resetHistory()
      cacheMock.delete = sinon.stub().callsFake(async key => {
        if (key === keyFoo) {
          throw deleteError
        }
      })

      await assert.doesNotReject(() => lock.withLock([foo.coordinates, bar.coordinates], noop))
      assert.ok(
        loggerMock.error.calledWith('Error releasing inflight lock', deleteError),
        'Expected release failure to be logged'
      )
    })
  })
})
