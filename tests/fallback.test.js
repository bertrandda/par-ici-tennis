import assert from 'node:assert/strict'
import { test } from 'node:test'
import dayjs from 'dayjs'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeBookingRequest, getBookingTargets, buildBookingConfig } from '../lib/booking-request.js'
import { prepareBookingJob, editBookingJob } from '../lib/booking-job.js'

const request = {
  sport: 'padel', date: '21/09/2026', locations: ['Padel Jules Ladoumègue'], hours: ['20'], courtType: ['Couvert'],
  players: [{ firstName: 'Test', lastName: 'Partner' }],
  fallbacks: [{ sport: 'tennis', locations: ['Edouard Pailleron'] }],
}
const now = dayjs('2026-09-13T12:00:00+02:00')
const fixed = { account: { email: 'test@example.invalid', password: 'fixture' }, priceType: ['Gratuité'] }
const catalog = [
  { name: 'Padel Jules Ladoumègue', id: '606', courts: [{ id: '4830', name: 'Padel n°01', number: 1 }] },
  { name: 'Edouard Pailleron', id: '240', courts: [{ id: '4400', name: 'Court n°01', number: 1 }] },
]

test('cross-sport fallbacks keep priority, share settings and survive runtime config merge', () => {
  const normalized = normalizeBookingRequest(request, { now })
  const config = buildBookingConfig(fixed, normalized)
  assert.deepEqual(getBookingTargets(config).map(({ sport, location, hours, courtType }) => ({ sport, location, hours, courtType })), [
    { sport: 'padel', location: 'Padel Jules Ladoumègue', hours: ['20'], courtType: ['Couvert'] },
    { sport: 'tennis', location: 'Edouard Pailleron', hours: ['20'], courtType: ['Couvert'] },
  ])
  assert.deepEqual(config.players, request.players)
  assert.deepEqual(config.priceType, ['Gratuité'])
  const changed = getBookingTargets({ ...request, fallbacks: [{ sport: 'tennis', locations: { 'Edouard Pailleron': [2] }, hours: [21], courtType: ['Découvert'] }] })
  assert.deepEqual(changed[1].hours, ['21'])
  assert.deepEqual(changed[1].courtNumbers, [2])
  assert.deepEqual(changed[1].courtType, ['Découvert'])
  assert.deepEqual(changed[0].hours, ['20'])
})

test('fallbacks reject invalid sports, empty choices and overrides of shared or fixed data', () => {
  for (const fallbacks of [null, {}, [null], [{ locations: ['Edouard Pailleron'] }], [{ sport: 'squash', locations: ['Edouard Pailleron'] }], [{ sport: 'tennis', locations: [] }]]) {
    assert.throws(() => normalizeBookingRequest({ ...request, fallbacks }, { now }))
  }
  for (const key of ['date', 'players', 'account', 'priceType', 'dryRun', 'fallbacks']) {
    assert.throws(() => normalizeBookingRequest({ ...request, fallbacks: [{ ...request.fallbacks[0], [key]: [] }] }, { now }), /Unsupported fallback fields/)
  }
})

test('Hermes validates every fallback club and can edit the existing request without moving its opening', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tennis-fallback-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const fixedConfigPath = join(root, 'fixed.json')
  writeFileSync(fixedConfigPath, JSON.stringify(fixed))
  const options = { now, catalog, fixedConfigPath, stateDirectory: join(root, 'state'), hermesScriptsDirectory: join(root, 'scripts'), repositoryDirectory: root }
  await assert.rejects(() => prepareBookingJob({ ...request, fallbacks: [{ sport: 'tennis', locations: ['Unknown'] }] }, options))
  const prepared = await prepareBookingJob({ ...request, fallbacks: [{ sport: 'tennis', locations: ['pailleron'] }] }, options)
  assert.match(prepared.cronName, /padel.*→ tennis.*Edouard Pailleron/)
  assert.equal(prepared.clubs.length, 2)
  const before = JSON.parse(readFileSync(join(options.stateDirectory, `${prepared.requestId}.json`)))
  assert.equal(before.request.fallbacks[0].locations[0], 'Edouard Pailleron')
  const edited = await editBookingJob(prepared.requestId, { ...request, fallbacks: [{ ...request.fallbacks[0], hours: ['21'] }] }, options)
  assert.equal(edited.bookingOpensAt, before.bookingOpensAt)
  assert.equal(edited.scheduleAt, before.scheduleAt)
  assert.deepEqual(edited.request.fallbacks[0].hours, ['21'])
  assert.deepEqual(edited.request.players, request.players)
  const removed = await editBookingJob(prepared.requestId, { ...request, fallbacks: [] }, options)
  assert.equal(removed.request.fallbacks, undefined)
})
