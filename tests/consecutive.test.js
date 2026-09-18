import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consecutiveLegTargets, runConsecutiveLegs } from '../lib/consecutive.js'

const target = { sport: 'padel', location: 'Padel Jules Ladoumègue', hours: ['20', '19'] }

test('each consecutive leg searches only its own fixed hour while preserving every fallback', () => {
  const targets = [target, { ...target, sport: 'tennis', location: 'Fallback', hours: ['18', '17'] }]
  assert.deepEqual(consecutiveLegTargets(targets, 0).map(item => item.hours), [['20'], ['20']])
  assert.deepEqual(consecutiveLegTargets(targets, 1).map(item => item.hours), [['21'], ['21']])
})

test('both independent legs start immediately and one rejection does not block the other', async () => {
  const pending = []
  const starts = []
  const run = leg => {
    starts.push(leg)
    return new Promise((resolve, reject) => pending[leg] = leg ? resolve : reject)
  }
  const resultsPromise = runConsecutiveLegs(run)
  assert.deepEqual(starts, [0, 1])
  pending[0](new Error('first failed'))
  pending[1]({ status: 'confirmed' })
  const results = await resultsPromise
  assert.equal(results[0].status, 'rejected')
  assert.deepEqual(results[1], { status: 'fulfilled', value: { status: 'confirmed' } })
})
