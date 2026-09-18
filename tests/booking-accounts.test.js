import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBookingConfig, normalizeBookingRequest } from '../lib/booking-request.js'
import { mergeConfig, describeBookingAccounts } from '../lib/config.js'
import { classifyConsecutiveResult } from '../lib/booking-result.js'

const firstGuest = [{ firstName: 'Second', lastName: 'Player' }]
const secondGuest = [{ firstName: 'First', lastName: 'Player' }]
const fixed = {
  account: { name: 'First player', email: 'first@example.test', password: 'first-secret', defaultPlayers: firstGuest }, priceType: ['Gratuité'],
  monitoringAccount: { name: 'Monitor', email: 'monitor@example.test', password: 'monitor-secret' },
  bookingAccounts: { second: { name: 'Second player', email: 'monitor@example.test', password: 'monitor-secret', priceType: ['Tarif plein'], defaultPlayers: secondGuest } },
}
const request = { date: '21/09/2026', sport: 'padel', locations: ['Padel Jules Ladoumègue'], hours: ['20'], courtType: ['Couvert'], consecutive: { bookingAccount: 'second' } }
const normalize = input => normalizeBookingRequest(input, { fixedConfig: fixed, allowPastOpening: true })

test('account defaults are resolved and snapshotted when preparing a request', () => {
  const result = normalize(request)
  assert.deepEqual(result.players, firstGuest)
  assert.deepEqual(result.consecutive.players, secondGuest)
  assert.equal(buildBookingConfig(fixed, result).consecutive.bookingAccount, 'second')
  const explicit = normalize({ ...request, players: secondGuest, consecutive: { bookingAccount: 'second', players: firstGuest } })
  assert.deepEqual(explicit.players, secondGuest)
  assert.deepEqual(explicit.consecutive.players, firstGuest)
  assert.deepEqual(normalize({ ...request, consecutive: undefined, bookingAccount: 'second' }).players, secondGuest)
})
test('invalid consecutive requests fail before any booking can start', () => {
  for (const override of [
    { consecutive: true }, { consecutive: { bookingAccount: 'main' } }, { consecutive: { bookingAccount: 'unknown' } },
    { consecutive: { bookingAccount: 'second', priceType: ['Gratuité'] } }, { consecutive: { bookingAccount: 'second', players: [] } },
    { hours: ['23'] }, { bookingAccount: 'unknown' }, { players: [] },
  ]) assert.throws(() => normalize({ ...request, ...override }))
  const bad = structuredClone(fixed)
  bad.bookingAccounts.second.email = fixed.account.email.toUpperCase()
  assert.throws(() => buildBookingConfig(bad, request), /different booking accounts/)
  bad.bookingAccounts.second.email = 'second@example.test'
  bad.bookingAccounts.second.password = ''
  assert.throws(() => buildBookingConfig(bad, request), /requires email and password/)
})
test('credentials and per-account tariffs cannot be changed by a variable request', () => {
  const merged = mergeConfig(fixed, { bookingAccounts: {}, account: {}, priceType: ['Tarif plein'], monitoringAccount: {} })
  assert.deepEqual(merged, fixed)
  assert.throws(() => normalize({ ...request, bookingAccounts: {} }), /Unsupported booking request fields/)
})
test('Hermes account discovery exposes names, tariffs and guests but no credentials', () => {
  const accounts = describeBookingAccounts(fixed)
  assert.deepEqual(accounts.map(({id, name}) => ({id, name})), [{id: 'main', name: 'First player'}, {id: 'second', name: 'Second player'}])
  assert.deepEqual(accounts[1].priceType, ['Tarif plein'])
  assert.doesNotMatch(JSON.stringify(accounts), /secret|password|@example/)
})
test('consecutive outcome preserves partial success and uncertain second submissions', () => {
  const classify = (statuses, dryRun = false, exitCode = 0) => classifyConsecutiveResult({legs: statuses.map(status => ({status})), dryRun, exitCode})
  assert.equal(classify(['confirmed', 'confirmed']), 'succeeded')
  assert.equal(classify(['confirmed', 'confirmed'], false, 1), 'succeeded_with_warnings')
  assert.equal(classify(['confirmed']), 'partially_succeeded')
  assert.equal(classify(['confirmed', 'submitted'], false, 1), 'needs_reconciliation')
  assert.equal(classify(['confirmed', 'cleanup-unverified'], false, 1), 'needs_reconciliation')
  assert.equal(classify(['dry-run-cancelled', 'dry-run-cancelled'], true), 'dry_run_succeeded')
  assert.equal(classify(['dry-run-cancelled'], true), 'dry_run_partial')
  assert.equal(classify([]), 'unavailable')
  assert.equal(classify([], false, 1), 'failed')
})
