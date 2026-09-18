import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchAttempts, normalizePolling, waitForSearchStart, parseSearchStart } from '../lib/search-window.js'
import { normalizeBookingRequest, buildBookingConfig } from '../lib/booking-request.js'
import dayjs from 'dayjs'

const targets = [{ sport: 'padel', priority: 0 }, { sport: 'tennis', priority: 1 }]
const clock = (initial = 0) => {
  let time = initial
  return { now: () => time, wait: async ms => { time += ms }, advance: ms => { time += ms } }
}

test('an opening delayed by 30 seconds is found with one-second polling without tennis', async () => {
  const timer = clock()
  const seen = []
  for await (const attempt of searchAttempts(targets, normalizePolling({}), 0, timer)) {
    seen.push({ sport: attempt.target.sport, time: timer.now() })
    if (timer.now() >= 30000) break
    timer.advance(100)
  }
  assert.equal(seen.length, 31)
  assert.equal(seen.at(-1).time, 30000)
  assert.ok(seen.every(item => item.sport === 'padel'))
})
test('primary polling stops at two minutes then yields one fallback without a second window', async () => {
  const timer = clock()
  const seen = []
  for await (const item of searchAttempts(targets, normalizePolling({}), 0, timer)) seen.push({ ...item, time: timer.now() })
  assert.equal(seen.length, 121)
  assert.equal(seen[119].time, 119000)
  assert.equal(seen[120].time, 120000)
  assert.equal(seen[120].target.sport, 'tennis')
  assert.equal(seen[120].finalFallback, true)
})
test('late startup uses the original deadline, and slow searches are never overlapped', async () => {
  const timer = clock(114000)
  const starts = []
  for await (const item of searchAttempts(targets, normalizePolling({}), 0, timer)) {
    starts.push([item.target.sport, timer.now()])
    timer.advance(3000)
  }
  assert.deepEqual(starts, [['padel', 114000], ['padel', 117000], ['tennis', 120000]])
})
test('no polling preserves a single pass and each-cycle mode preserves per-cycle priority', async () => {
  const timer = clock()
  const seen = []
  for await (const item of searchAttempts(targets, undefined, 2000, timer)) seen.push(item.target.sport)
  assert.deepEqual(seen, ['padel', 'tennis'])
  assert.equal(timer.now(), 2000)
  seen.length = 0
  for await (const item of searchAttempts(targets, normalizePolling({ durationSeconds: 6, fallbackMode: 'each-cycle' }), 2000, timer)) seen.push(item.target.sport)
  assert.deepEqual(seen, ['padel', 'tennis', 'padel', 'tennis', 'padel', 'tennis'])
})
test('warmup waits for the exact opening and polling options cannot extend past two minutes', async () => {
  const timer = clock(0)
  await waitForSearchStart(300000, timer)
  assert.equal(timer.now(), 300000)
  assert.equal(normalizePolling({ intervalSeconds: 1 }).intervalSeconds, 1)
  for (const invalid of [null, true, { intervalSeconds: 0 }, { durationSeconds: 121 }, { durationSeconds: 0 }, { fallbackMode: 'all' }, { date: 'other' }]) assert.throws(() => normalizePolling(invalid))
  assert.throws(() => parseSearchStart('invalid'))
  assert.equal(parseSearchStart('2026-09-15T08:00:00+02:00'), Date.parse('2026-09-15T06:00:00Z'))
})
test('polling survives normalization and the fixed/variable config split', () => {
  const request = normalizeBookingRequest({ date: '21/09/2026', sport: 'padel', locations: ['Padel Jules Ladoumègue'], hours: ['20'], courtType: ['Couvert'], players: [{ firstName: 'Test', lastName: 'Partner' }], polling: {} }, { now: dayjs('2026-09-13') })
  const config = buildBookingConfig({ account: { email: 'test@example.invalid', password: 'fixture' }, priceType: ['Gratuité'] }, request)
  assert.deepEqual(config.polling, { intervalSeconds: 1, durationSeconds: 120, fallbackMode: 'after-window' })
})
