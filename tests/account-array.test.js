import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeBookingAccounts, resolveBookingProfile, loadMonitoringConfig } from '../lib/config.js'
import { normalizeBookingRequest, buildBookingConfig } from '../lib/booking-request.js'
import { migrateBookingAccounts, migrateAccountReferences } from '../lib/account-migration.js'

const guest = [{ firstName: 'Rafael', lastName: 'Nadal' }]
const account = (name, email, priceType = 'Tarif plein') => ({ name, email, password: 'PRIVATE_PASSWORD', priceType: [priceType], defaultPlayers: guest })
const config = { bookingAccounts: [account('Roger Federer', 'roger@example.test', 'Gratuité'), account('Rafael Nadal', 'rafael@example.test'), account('Joueur invité', 'invite@example.test', 'Tarif réduit')] }
const request = { date: '21/09/2026', locations: ['Edouard Pailleron'], hours: ['20'], courtType: ['Couvert'], consecutive: { bookingAccount: 'Rafael Nadal' } }
const normalize = (value, fixedConfig = config) => normalizeBookingRequest(value, { fixedConfig, allowPastOpening: true })

test('names replace positional keys, including spaces and accents; metadata stays non-secret', () => {
  assert.equal(resolveBookingProfile(config).id, 'Roger Federer')
  assert.equal(resolveBookingProfile(config, '  joueur invité ').id, 'Joueur invité')
  assert.deepEqual(resolveBookingProfile(config, 'Joueur invité').priceType, ['Tarif réduit'])
  assert.throws(() => resolveBookingProfile(config, 'second'), /Unknown booking account/)
  assert.throws(() => resolveBookingProfile(config, 1), /Invalid bookingAccount/)
  assert.doesNotMatch(JSON.stringify(describeBookingAccounts(config)), /PRIVATE_PASSWORD|@example|password/)
})
test('default account is saved by name and survives a reordered array', () => {
  const prepared = normalize(request)
  assert.equal(prepared.bookingAccount, 'Roger Federer')
  assert.equal(prepared.consecutive.bookingAccount, 'Rafael Nadal')
  assert.deepEqual(prepared.players, guest)
  const reordered = { bookingAccounts: [...config.bookingAccounts].reverse() }
  assert.equal(buildBookingConfig(reordered, prepared).bookingAccount, 'Roger Federer')
  assert.equal(resolveBookingProfile(reordered, prepared.bookingAccount).account.email, config.bookingAccounts[0].email)
  assert.throws(() => buildBookingConfig({ bookingAccounts: config.bookingAccounts.slice(1) }, prepared), /Unknown booking account/)
})
test('any two named accounts can book and aliases cannot select the same account twice', () => {
  const chosen = normalize({ ...request, bookingAccount: 'Joueur invité' })
  assert.equal(chosen.bookingAccount, 'Joueur invité')
  assert.deepEqual(chosen.players, guest)
  assert.throws(() => normalize({ ...request, bookingAccount: 'rafael nadal' }), /different booking/)
  const duplicates = structuredClone(config)
  duplicates.bookingAccounts[1].email = duplicates.bookingAccounts[0].email.toUpperCase()
  assert.throws(() => normalize(request, duplicates), /different booking/)
})
test('empty, duplicate and malformed names fail without falling back to a different account', () => {
  for (const bookingAccounts of [[], [account('', 'a')], [account('Roger', 'a'), account(' ROGER ', 'b')], [account('Invité', 'a'), account('Invite\u0301', 'b')], [null]]) {
    assert.throws(() => resolveBookingProfile({ bookingAccounts }))
  }
  const noTariff = structuredClone(config)
  delete noTariff.bookingAccounts[0].priceType
  noTariff.priceType = ['Gratuité']
  assert.throws(() => resolveBookingProfile(noTariff), /requires a valid priceType/)
})
test('array monitoring uses selected booking account by default and allows a shared named account', () => {
  const selected = { ...config, bookingAccount: 'Rafael Nadal' }
  assert.equal(loadMonitoringConfig({ bookingConfig: selected }).account.email, 'rafael@example.test')
  const shared = loadMonitoringConfig({ bookingConfig: { ...selected, monitoringAccount: config.bookingAccounts[1] } })
  assert.equal(shared.dedicated, false)
  const dedicated = loadMonitoringConfig({ bookingConfig: { ...config, monitoringAccount: config.bookingAccounts[1] } })
  assert.equal(dedicated.dedicated, true)
})
test('migration preserves all credentials and settings and resolves legacy job keys before removal', () => {
  const legacy = { account: { ...config.bookingAccounts[0] }, bookingAccounts: { second: config.bookingAccounts[1], third: config.bookingAccounts[2] }, priceType: ['Gratuité'], monitoringAccount: config.bookingAccounts[1], ntfy: { enable: false }, ai: { enable: false } }
  delete legacy.account.priceType
  const original = structuredClone(legacy)
  const migrated = migrateBookingAccounts(legacy)
  assert.deepEqual(migrated.bookingAccounts, config.bookingAccounts)
  assert.ok(!Object.hasOwn(migrated, 'account') && !Object.hasOwn(migrated, 'priceType'))
  assert.deepEqual(migrated.monitoringAccount, original.monitoringAccount)
  assert.deepEqual(migrated.ntfy, original.ntfy)
  assert.deepEqual(migrated.ai, original.ai)
  const converted = migrateAccountReferences({ ...request, consecutive: { bookingAccount: 'third', players: guest } }, legacy, migrated)
  assert.equal(converted.bookingAccount, 'Roger Federer')
  assert.equal(converted.consecutive.bookingAccount, 'Joueur invité')
  assert.deepEqual(converted.consecutive.players, guest)
  assert.equal(converted.date, request.date)
  assert.deepEqual(legacy, original)
  assert.deepEqual(migrateBookingAccounts(migrated), migrated)
  assert.deepEqual(migrateAccountReferences(converted, migrated, migrated), converted)
})
