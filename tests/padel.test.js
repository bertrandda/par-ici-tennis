import assert from 'node:assert/strict'
import { test } from 'node:test'
import dayjs from 'dayjs'
import { parseClubCatalog } from '../lib/clubs.js'
import { normalizeBookingRequest, buildBookingConfig } from '../lib/booking-request.js'
import { selectClubCourts, normalizeSport, validateSportPlayers } from '../lib/sport.js'
import { chromium } from 'playwright'
import { selectBookingDate, readPriceDescription } from '../lib/booking-page.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareBookingJob, editBookingJob } from '../lib/booking-job.js'

const name = 'Padel Jules Ladoumègue'
const catalog = parseClubCatalog(`var tennis = ${JSON.stringify({ features: [{ properties: {
  general: { _id: 606, _nomSrtm: name, _arrondissement: 19 },
  courts: [
    { _airId: 4830, _airNom: 'Padel n°01', _formattedAirNum: 1, _airCvt: 'V' },
    { _airId: 4831, _airNom: 'Padel n°02', _formattedAirNum: 2, _airCvt: 'V' },
    { _airId: 4387, _airNom: 'Court n° 04', _formattedAirNum: 4, _airCvt: 'V' },
    { _airId: 4388, _airNom: 'Supprimé - Court n° 01', _formattedAirNum: 1 },
  ],
} }] })};`)
const players = ['One', 'Two', 'Three'].map(firstName => ({ firstName, lastName: 'Test' }))
const request = { sport: 'padel', date: '21/09/2026', locations: [name], hours: ['18'], courtType: ['Couvert'], players }
const options = { now: dayjs('2026-09-13T12:00:00+02:00') }

test('padel selection excludes tennis and deleted courts at the same club', () => {
  assert.deepEqual([...selectClubCourts(catalog, name, { sport: 'padel' })], ['4830', '4831'])
  assert.deepEqual([...selectClubCourts(catalog, name, { sport: 'padel', courtNumbers: [2] })], ['4831'])
  assert.throws(() => selectClubCourts(catalog, name, { sport: 'padel', courtNumbers: [4] }), /No padel courts/)
  assert.throws(() => selectClubCourts(catalog, name), /Set sport to padel/)
})
test('padel requests accept one to three partners and preserve sport through config merge', () => {
  const normalized = normalizeBookingRequest(request, options)
  assert.equal(normalized.sport, 'padel')
  const config = buildBookingConfig({ account: { email: 'example@test.invalid', password: 'fixture' }, priceType: ['Gratuité'] }, normalized)
  assert.equal(config.sport, 'padel')
  assert.deepEqual(config.priceType, ['Gratuité'])
  for (const count of [1, 2, 3]) {
    const selectedPlayers = players.slice(0, count)
    assert.doesNotThrow(() => validateSportPlayers('padel', selectedPlayers))
    assert.deepEqual(normalizeBookingRequest({ ...request, players: selectedPlayers }, options).players, selectedPlayers)
  }
  for (const invalidPlayers of [undefined, [], [...players, { firstName: 'Four', lastName: 'Test' }]]) {
    assert.throws(() => validateSportPlayers('padel', invalidPlayers), /between one and three partners/)
    assert.throws(() => normalizeBookingRequest({ ...request, players: invalidPlayers }, options), /between one and three partners/)
  }
  assert.throws(() => normalizeSport('squash'), /sport must/)
})
test('legacy requests default to tennis and retain TEP and gymnasium courts', () => {
  const normalized = normalizeBookingRequest({ ...request, sport: undefined, locations: ['Valeyre'], players: players.slice(0, 1) }, options)
  assert.equal(normalized.sport, 'tennis')
  assert.deepEqual([...selectClubCourts([{ name: 'Valeyre', courts: [{ id: '1', name: 'TEP/Court n° 01', number: 1 }] }], 'Valeyre')], ['1'])
  assert.deepEqual([...selectClubCourts([{ name: 'NEUVE SAINT PIERRE', courts: [{ id: '4582', name: 'Gymnase Type B', number: 1 }] }], 'NEUVE SAINT PIERRE')], ['4582'])
})
test('Hermes preparation and edits preserve padel and reject tennis-only court numbers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tenibotty-padel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixedConfigPath = join(root, 'fixed.json')
  writeFileSync(fixedConfigPath, JSON.stringify({ account: { email: 'test@example.invalid', password: 'fixture' }, priceType: ['Gratuité'] }))
  const settings = { ...options, catalog, fixedConfigPath, stateDirectory: join(root, 'state'), hermesScriptsDirectory: join(root, 'scripts'), repositoryDirectory: root }
  const singlePartnerRequest = { ...request, players: players.slice(0, 1) }
  const prepared = await prepareBookingJob({ ...singlePartnerRequest, locations: ['padel jules'] }, settings)
  assert.match(prepared.cronName, /^Padel /)
  const stored = JSON.parse(readFileSync(join(settings.stateDirectory, `${prepared.requestId}.json`), 'utf8'))
  assert.equal(stored.request.sport, 'padel')
  assert.deepEqual(stored.request.players, singlePartnerRequest.players)
  assert.deepEqual(stored.request.locations, [name])
  await assert.rejects(() => editBookingJob(prepared.requestId, { ...request, locations: { [name]: [4] } }, settings), /No padel courts/)
  const edited = await editBookingJob(prepared.requestId, { ...singlePartnerRequest, locations: { [name]: [2] } }, settings)
  assert.equal(edited.request.sport, 'padel')
  assert.deepEqual(edited.request.players, singlePartnerRequest.players)
  assert.deepEqual(edited.request.locations, { [name]: [2] })
})
test('date selection uses the visible picker despite duplicate hidden dates', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<button id="when" onclick="document.querySelector('.date-picker').style.display='block'">Date</button>
      <div style="display:none"><div dateiso="19/09/2026">hidden duplicate</div></div>
      <div class="date-picker" style="display:none"><button dateiso="19/09/2026" onclick="document.body.dataset.selected='19/09/2026';this.parentElement.style.display='none'">date</button></div>`)
    await selectBookingDate(page, '19/09/2026')
    assert.equal(await page.locator('body').getAttribute('data-selected'), '19/09/2026')
    for (const priceType of ['Gratuité', 'Tarif plein', 'Tarif réduit']) {
      await page.setContent(`<div class="price-description" style="text-transform:uppercase">${priceType}<br><span>Couvert</span></div>`)
      assert.deepEqual(await readPriceDescription(page.locator('.price-description')), { priceType, courtType: 'Couvert' })
    }
  } finally { await browser.close() }
})
