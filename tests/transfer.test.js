import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reservationSelection, assertTransferCredits } from '../lib/transfer-selection.js'
import { runTransfer, prepareTransfer, executeTransfer, readTransfer } from '../lib/transfer.js'

const catalog = [{ name: 'Valeyre', courts: [{ id: '123', number: 1, sport: 'tennis', covered: true }] }]
const reservation = { id: `reservation-${'a'.repeat(24)}`, details: 'Valeyre, Court n°01, le 21 septembre 2099 à 20h', cancellable: true }
const selection = reservationSelection(reservation, catalog)
const players = [{ firstName: 'Roger', lastName: 'Federer' }]
const config = { bookingAccounts: [
  { name: 'Roger Federer', email: 'a@example.test', password: 'secret', priceType: ['Gratuité'], defaultPlayers: players },
  { name: 'Rafael Nadal', email: 'b@example.test', password: 'secret', priceType: ['Tarif plein'], defaultPlayers: players },
] }

const fixture = (overrides = {}) => {
  let time = 0
  const calls = []
  const record = { reservationId: reservation.id, selection, players, status: 'prepared', history: [] }
  const base = {
    preflight: async () => ({ selection, players }),
    cancel: async () => ({ status: 'cancelled', verified: true }),
    find: async () => true,
    hold: async () => 'button',
    submit: async () => {},
    verify: async () => ({ ...reservation, id: 'new-reservation' }),
    cleanup: async () => {},
    ...overrides,
  }
  const session = Object.fromEntries(Object.entries(base).map(([key, operation]) => [key, async (...args) => { calls.push(key); return operation(...args) }]))
  const persisted = []
  return { record, calls, persisted, run: () => runTransfer(record, session, state => persisted.push(structuredClone(state)), { now: () => time, pause: async ms => { time += ms }, windowMs: 6000 }) }
}

test('source tuple is derived from unique source details and official court data', () => {
  assert.deepEqual(selection, { location: 'Valeyre', sport: 'tennis', courtId: '123', courtNumber: 1, courtType: 'Couvert', date: '21/09/2099', hour: '20' })
  for (const details of ['Valeyre, Court 1', `${reservation.details}, autre court 2`, `${reservation.details}, annulation le 20/09/2099 à 20h`, 'Valeyre Court 1 21/09/2099 à 20h30', 'Valeyre Court 1 21/09/2000 à 20h', 'Valeyre Court 1 21/09/2099 à 20h à 22h']) {
    assert.throws(() => reservationSelection({ details }, catalog))
  }
  assert.throws(() => reservationSelection(reservation, [...catalog, { ...catalog[0], name: 'Court' }]))
})

test('matching one-hour credits required; wrong tariff, type or insufficient balance fails', () => {
  const profile = { priceType: ['Tarif plein'] }
  for (const balance of [[], [{ priceType: 'Tarif réduit', courtType: 'Couvert', hours: 5 }], [{ priceType: 'Tarif plein', courtType: 'Découvert', hours: 5 }], [{ priceType: 'Tarif plein', courtType: 'Couvert', hours: 0.5 }]]) assert.throws(() => assertTransferCredits(profile, selection, balance))
  assertTransferCredits(profile, selection, [{ priceType: 'Tarif plein', courtType: 'Couvert', hours: 1 }])
  assertTransferCredits({ priceType: ['Gratuité'] }, selection, [])
})

test('successful replacement persists cancellation and submission before each mutation', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.status, 'transferred')
  assert.equal(result.sourceCancelled, true)
  assert.deepEqual(f.calls, ['preflight', 'cancel', 'find', 'hold', 'submit', 'verify'])
  assert.deepEqual(f.persisted.map(item => item.status), ['prechecking', 'cancellation_started', 'source_cancelled', 'holding', 'submitted', 'verifying', 'transferred'])
})

test('preflight failure or changed court preserves source', async () => {
  for (const preflight of [async () => { throw new Error('no credit') }, async () => ({ selection: { ...selection, courtId: '456' }, players })]) {
    const f = fixture({ preflight })
    assert.equal((await f.run()).status, 'blocked')
    assert.deepEqual(f.calls, ['preflight'])
  }
})

test('uncertain cancellation never starts target booking', async () => {
  for (const cancel of [async () => { throw new Error('timeout') }, async () => ({ status: 'cancelled', verified: false })]) {
    const f = fixture({ cancel })
    assert.equal((await f.run()).status, 'needs_reconciliation')
    assert.deepEqual(f.calls, ['preflight', 'cancel'])
  }
})

test('lost slot gets bounded searches with no hold, fallback or restoration', async () => {
  const f = fixture({ find: async () => false })
  assert.equal((await f.run()).status, 'released_unrecovered')
  assert.deepEqual(f.calls, ['preflight', 'cancel', 'find'])
})

test('pre-submission failure cleans only destination hold; uncertain submit never aborts', async () => {
  const failed = fixture({ hold: async () => { throw new Error('CAPTCHA') } })
  assert.equal((await failed.run()).status, 'released_unrecovered')
  assert.ok(failed.calls.includes('cleanup'))
  for (const method of ['submit', 'verify']) {
    const f = fixture({ [method]: async () => { throw new Error('uncertain') } })
    assert.equal((await f.run()).status, 'needs_reconciliation')
    assert.ok(!f.calls.includes('cleanup'))
  }
  const failedCleanup = fixture({ hold: async () => { throw new Error('hold') }, cleanup: async () => { throw new Error('cleanup') } })
  assert.equal((await failedCleanup.run()).status, 'needs_reconciliation')
})

test('prepared plans contain no credentials, require risk acceptance, and cannot replay', async t => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'tennis-transfer-'))
  t.after(() => rmSync(stateDirectory, { recursive: true, force: true }))
  const options = { stateDirectory, config, session: async (_options, operation) => operation({
    preflight: async () => ({ reservation, selection, players, balances: [] }),
    cancel: async () => ({ status: 'cancelled', verified: true }), find: async () => true, hold: async () => ({}), submit: async () => {}, verify: async () => reservation,
  }) }
  const input = { fromAccount: 'Roger Federer', toAccount: 'Rafael Nadal', reservationId: reservation.id }
  const plan = await prepareTransfer(input, options)
  assert.doesNotMatch(JSON.stringify(plan), /secret|@example|password/)
  assert.equal(statSync(join(stateDirectory, 'transfers', `${plan.id}.json`)).mode & 0o777, 0o600)
  await assert.rejects(executeTransfer(plan.id, options), /requires/)
  await assert.rejects(executeTransfer(plan.id, { ...options, confirm: true }), /requires/)
  const result = await executeTransfer(plan.id, { ...options, confirm: true, acceptReleaseRisk: true })
  assert.equal(result.status, 'transferred')
  assert.equal(readTransfer(plan.id, options).status, 'transferred')
  await assert.rejects(executeTransfer(plan.id, { ...options, confirm: true, acceptReleaseRisk: true }), /already started/)
  await assert.rejects(prepareTransfer({ ...input, toAccount: 'Roger Federer' }, options), /different/)
  await assert.rejects(prepareTransfer(input, { ...options, config: { bookingAccounts: [config.bookingAccounts[0], { ...config.bookingAccounts[1], email: config.bookingAccounts[0].email }] } }), /different/)
})

test('uncertain execution retains operation lock and its durable reconciliation state', async t => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'tennis-transfer-'))
  t.after(() => rmSync(stateDirectory, { recursive: true, force: true }))
  const options = { stateDirectory, config, session: async (_options, operation) => operation({ preflight: async () => ({ reservation, selection, players }), cancel: async () => { throw new Error('unknown') } }) }
  const plan = await prepareTransfer({ fromAccount: 'Roger Federer', toAccount: 'Rafael Nadal', reservationId: reservation.id }, options)
  assert.equal((await executeTransfer(plan.id, { ...options, confirm: true, acceptReleaseRisk: true })).status, 'needs_reconciliation')
  assert.ok(existsSync(join(stateDirectory, '.operation-lock')))
  assert.equal(readTransfer(plan.id, options).status, 'needs_reconciliation')
})
