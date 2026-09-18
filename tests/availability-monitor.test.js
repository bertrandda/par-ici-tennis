import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { validateMonitorOptions, summarizeObservations, monitorWindow, observeAvailability, guardMonitorPage } from '../lib/availability-monitor.js'

const iso = seconds => new Date(seconds * 1000).toISOString()
const slot = { courtId: '4830', start: '2026/09/20 08:00:00', bookable: true }
const observation = (second, slots = [], status = slots.length ? 'slots_visible' : 'empty') => ({ startedAt: iso(second), queryStartedAt: iso(second), observedAt: iso(second + 1), status, slots })

test('opening evidence distinguishes a measured transition, already-visible slots and failed sampling', () => {
  const result = summarizeObservations([observation(0), observation(2, [], 'error'), observation(4, [slot])])
  assert.equal(result.result, 'appearance_observed')
  assert.equal(result.possibleAppearanceAfter, iso(0))
  assert.equal(result.firstVisibleAt, iso(5))
  assert.equal(result.firstBookableAt, iso(5))
  assert.equal(result.errors, 1)
  assert.equal(summarizeObservations([observation(0, [slot])]).result, 'already_visible_at_first_successful_sample')
  assert.equal(summarizeObservations([observation(0, [], 'error')]).result, 'no_successful_observation')
  assert.equal(summarizeObservations([observation(0)]).result, 'not_observed')
  assert.equal(summarizeObservations([observation(0, [{ ...slot, bookable: false }])]).firstBookableAt, null)
})
test('monitor samples through the whole window after availability appears and never overlaps searches', async () => {
  let time = 0
  let count = 0
  const records = []
  const options = { start: iso(0), end: iso(10), intervalSeconds: 2 }
  const result = await monitorWindow(options, async () => {
    const sample = observation(time / 1000, count++ ? [slot] : [])
    time += 3000
    return sample
  }, row => records.push(row), { now: () => time, wait: async ms => { time += ms } })
  assert.equal(result.samples, 4)
  assert.equal(result.stoppedReason, 'window_complete')
  assert.deepEqual(records.map(row => row.startedAt), [iso(0), iso(3), iso(6), iso(9)])
})
test('three consecutive errors stop monitoring without inferring an opening', async () => {
  let time = 0
  const result = await monitorWindow({ start: iso(0), end: iso(20), intervalSeconds: 2 }, async () => { throw new Error('Captcha unavailable') }, () => {}, { now: () => time, wait: async ms => { time += ms } })
  assert.equal(result.samples, 3)
  assert.equal(result.errors, 3)
  assert.equal(result.result, 'no_successful_observation')
  assert.equal(result.stoppedReason, 'three_consecutive_errors')
})
test('monitor windows require explicit timezone and bounded duration and frequency', () => {
  const options = { date: '20/9/2026', club: 'Padel Jules Ladoumègue', start: '2026-09-14T07:55:00+02:00', end: '2026-09-14T08:10:00+02:00' }
  assert.equal(validateMonitorOptions(options).date, '20/09/2026')
  for (const bad of [{ date: '31/09/2026' }, { start: '2026-09-14T07:55:00' }, { end: options.start }, { intervalSeconds: 1 }, { end: '2026-09-14T10:00:00+02:00' }]) assert.throws(() => validateMonitorOptions({ ...options, ...bad }))
})
test('browser observation reads every padel hour and cannot submit reservation endpoints', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const club = 'Padel Jules Ladoumègue'
  const catalog = { features: [{ properties: { general: { _id: 606, _nomSrtm: club, _arrondissement: 19 }, courts: [{ _airId: 4830, _airNom: 'Padel n°01', _formattedAirNum: 1 }, { _airId: 4382, _airNom: 'Court n°01', _formattedAirNum: 1 }] } }] }
  let reservationRequests = 0
  let hideDate = false
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('page') === 'reservation') { reservationRequests++; return route.fulfill({ body: 'Unexpected reservation' }) }
    const results = url.pathname === '/results'
    const html = results ? `<div class="no-result" style="display:none"></div>${[
      ['4830', '2026/09/20 08:00:00', 'buttonAllOk'], ['4830', '2026/09/20 20:00:00', 'buttonAllOk'], ['4382', '2026/09/20 20:00:00', 'buttonAllOk'], ['4830', '2026/09/19 20:00:00', 'buttonAllOk'],
    ].map(([id, date, cls]) => `<button courtid="${id}" datedeb="${date}" class="${cls}" onclick="location.href='?page=reservation'">Book</button>`).join('')}` : `<script>var tennis = ${JSON.stringify(catalog)};</script>
      <input class="tokens-input-text"><div class="tokens-suggestions-list-element"><button>${club}</button></div>
      <button id="when" onclick="document.querySelector('.date-picker').style.display='block'">Date</button>
      <div class="date-picker" style="display:none">${hideDate ? '<button dateiso="19/09/2026">19</button>' : '<button dateiso="20/09/2026" onclick="this.parentElement.style.display=\'none\'">20</button>'}</div>
      <form action="/results" method="post"><button id="rechercher">Search</button></form>`
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
  })
  const options = { date: '20/09/2026', club, sport: 'padel', end: new Date(Date.now() + 30000).toISOString() }
  const result = await observeAvailability(page, options, { ai: { enable: false } })
  assert.equal(result.status, 'slots_visible')
  assert.deepEqual(result.slots.map(value => value.start), ['2026/09/20 08:00:00', '2026/09/20 20:00:00'])
  assert.equal(reservationRequests, 0)
  hideDate = true
  assert.equal((await observeAvailability(page, options, { ai: { enable: false } })).status, 'date_not_selectable')
  await guardMonitorPage(page)
  await assert.rejects(() => page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=reservation'))
  assert.equal(reservationRequests, 0)
})
