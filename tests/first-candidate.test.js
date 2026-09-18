import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import dayjs from 'dayjs'
import { firstBookingCandidate } from '../lib/first-candidate.js'
import { getBookingChoices, normalizeBookingRequest, buildBookingConfig } from '../lib/booking-request.js'
import { mergeConfig } from '../lib/config.js'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser.close() })
const request = { date: '21/09/2026', sport: 'tennis', locations: ['Example Club'], hours: ['20'], courtType: ['Couvert'], players: [{ firstName: 'Roger', lastName: 'Federer' }] }

test('first is optional, validated, inherited by choices and preserved through scheduled config', () => {
  const primary = normalizeBookingRequest(request, { allowPastOpening: true })
  assert.equal(primary.courtSelection, undefined)
  const input = { ...request, courtSelection: 'first', courtType: 'any', fallbacks: [{ sport: 'tennis', locations: ['Other Club'], courtType: 'outdoor' }, { sport: 'tennis', locations: ['Third Club'], courtSelection: 'all', courtType: 'indoor' }] }
  const choices = getBookingChoices(input)
  assert.deepEqual(choices.map(c => [c.courtSelection, c.courtType]), [['first', ['Couvert', 'Découvert']], ['first', ['Découvert']], ['all', ['Couvert']]])
  const normalized = normalizeBookingRequest(input, { allowPastOpening: true })
  const fixed = { bookingAccounts: [{ name: 'Roger Federer', email: 'example@invalid.test', password: 'fixture', priceType: ['Gratuité'] }] }
  assert.equal(buildBookingConfig(fixed, normalized).courtSelection, 'first')
  assert.equal(mergeConfig(fixed, normalized).courtSelection, 'first')
  for (const value of [true, null, 'random']) assert.throws(() => getBookingChoices({ ...request, courtSelection: value }), /courtSelection/)
  assert.throws(() => getBookingChoices({ ...input, fallbacks: [{ sport: 'tennis', locations: ['Other'], courtSelection: null }] }), /courtSelection/)
  assert.throws(() => getBookingChoices({ ...request, courtType: 'unknown' }), /courtType/)
})

const search = async (t, { types = ['Couvert'], hours = ['20'], courtIds = ['1', '2', '3', '4', '5'], courtId, breakLast = false } = {}) => {
  const page = await browser.newPage()
  t.after(() => page.close())
  const row = (id, type, price = 'Gratuité', hour = '20', disabled = false) => `<div class="row tennis-court"><div class="price-description">${price}<br>${type}</div><button ${disabled ? 'disabled' : ''} courtid="${id}" datedeb="2026/09/21 ${hour}:00:00">Book</button></div>`
  await page.setContent(row('9', 'Couvert') + row('1', 'Couvert', 'Tarif plein') + row('2', 'Découvert') + row('3', 'Couvert') + row('4', 'Couvert', 'Gratuité', '19') + row('5', 'Couvert', 'Gratuité', '20', true))
  if (breakLast) await page.locator('[courtid="5"]').evaluate(slot => { slot.getAttribute = () => { throw new Error('Unnecessary later candidate read') } })
  return firstBookingCandidate(page, { date: dayjs('2026-09-21'), target: { hours, courtType: types, courtId }, courtIds: new Set(courtIds), priceTypes: ['Gratuité'] })
}

test('indoor skips wrong club, incompatible price and outdoor courts, then stops reading', async t => {
  assert.equal((await search(t, { breakLast: true })).courtId, '3')
})
test('outdoor and any choose the first compatible outdoor court in page order', async t => {
  assert.equal((await search(t, { types: ['Découvert'] })).courtId, '2')
  assert.equal((await search(t, { types: ['Couvert', 'Découvert'] })).courtId, '2')
})
test('first preserves hour priority and explicit court restrictions', async t => {
  assert.equal((await search(t, { hours: ['19', '20'] })).courtId, '4')
  assert.equal((await search(t, { courtId: '3', types: ['Couvert', 'Découvert'] })).courtId, '3')
  assert.equal(await search(t, { courtIds: ['1', '5'] }), null)
})
