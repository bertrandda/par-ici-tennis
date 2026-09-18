import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { withTransferSession } from '../lib/transfer-session.js'
import { readReservationsPage, RESERVATIONS_URL } from '../lib/reservations.js'
import { runTransfer } from '../lib/transfer.js'
import { resolveBookingProfile } from '../lib/config.js'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser.close() })
const config = { bookingAccounts: [
  { name: 'Roger Federer', email: 'roger@example.test', password: 'fixture', priceType: ['Gratuité'] },
  { name: 'Rafael Nadal', email: 'rafael@example.test', password: 'fixture', priceType: ['Tarif plein'], defaultPlayers: [{ firstName: 'Roger', lastName: 'Federer' }] },
] }
const catalog = { features: [{ properties: { general: { _id: 1, _nomSrtm: 'Valeyre', _arrondissement: 9 }, courts: [{ _airId: 123, _airNom: 'Court n°01', _formattedAirNum: 1, _airCvt: 'V' }] } }] }
const empty = '<div id="booking"><div class="none">Vous n’avez pas de réservation en cours.</div></div>'
const booked = `<div id="booking">Valeyre, Court n°01, 21/09/2099 à 20h <button id="annuler" onclick="document.querySelector('#cancelModal').style.display='block'">Annuler</button></div>
<div id="cancelModal" style="display:none"><form id="annul" method="POST" action="${RESERVATIONS_URL}"><button id="confirmer">Confirmer</button></form></div>`

const runBrowser = async (t, { hours = 5, busy = false } = {}) => {
  const calls = []
  const logins = []
  let cancelled = false
  let confirmed = false
  const original = chromium.launch
  let launched = 0
  chromium.launch = async () => {
    const role = launched++ === 0 ? 'source' : 'target'
    const context = await browser.newContext()
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      let html
      const view = url.searchParams.get('view')
      if (view === 'start') html = '<button id="button_suivi_inscription">Login</button><form id="form-login" action="/connected"><input id="username" name="username"><input id="password"><button>Connect</button></form>'
      else if (url.pathname === '/connected') {
        logins.push({ role, username: url.searchParams.get('username') })
        html = '<div class="main-informations">Connected</div>'
      } else if (view === 'ma_reservation') {
        if (request.method() === 'POST') { assert.equal(role, 'source'); calls.push('cancel'); cancelled = true }
        html = role === 'source' ? (cancelled ? empty : booked) : (confirmed || busy ? booked : empty)
      } else if (view === 'carnet_reservation') html = `<div id="bookingBook"><div class="title">Etat des carnets</div><div id="reservationAccordion"><div class="panel"><div class="panel-heading">Tarif plein - Court couvert : ${hours} h</div><div class="panel-body">1 h - recrédit<br>4 h - achat</div></div></div></div>`
      else if (url.searchParams.get('page') === 'recherche') html = `<script>var tennis = ${JSON.stringify(catalog)};</script>
        <form action="/results"><input class="tokens-input-text"><div class="tokens-suggestions-list-element"><button type="button">Valeyre</button></div>
        <button type="button" id="when" onclick="document.querySelector('.date-picker').style.display='block'">Date</button>
        <div class="date-picker" style="display:none"><button type="button" dateiso="21/09/2099" onclick="this.parentElement.style.display='none'">21</button></div><button id="rechercher">Search</button></form>`
      else if (url.pathname === '/results') {
        calls.push(cancelled ? 'search-after' : 'search-before')
        html = cancelled ? '<div class="row tennis-court"><div class="price-description">Tarif plein<br>Couvert</div><a courtid="123" datedeb="2099/09/21 20:00:00" href="/hold">Book</a><a courtid="123" datedeb="2099/09/21 21:00:00" href="/wrong">Wrong hour</a><a courtid="456" datedeb="2099/09/21 20:00:00" href="/wrong">Wrong court</a></div>' : '<div class="no-result">No slots</div>'
      } else if (url.pathname === '/hold') {
        calls.push('hold')
        html = '<div class="order-steps-infos"><h2>1 / 3 - Validation du court</h2></div><form action="/payment"><input name="player1"><input name="player1"><button>Continue</button></form>'
      } else if (url.pathname === '/payment') {
        assert.deepEqual(url.searchParams.getAll('player1'), ['Federer', 'Roger'])
        html = '<div class="order-steps-infos"><h2>2 / 3 - Mode de paiement</h2></div><div class="priceTable"><button class="price-item" paymentMode="existingTicket" onclick="document.querySelector(\'#submit\').disabled=false">Utiliser 1 h</button></div><div class="step-two"><form action="/confirm"><button id="submit" disabled>Etape suivante</button></form></div>'
      } else if (url.pathname === '/confirm') {
        calls.push('submit')
        confirmed = true
        html = '<div class="confirmReservation">Confirmed</div>'
      } else throw new Error(`Unexpected route ${url.pathname}`)
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    })
    return { newPage: () => context.newPage(), close: () => context.close() }
  }
  t.after(() => { chromium.launch = original })
  const page = await browser.newPage()
  await page.setContent(booked)
  const [source] = await readReservationsPage(page)
  await page.close()
  const execute = () => withTransferSession({ config, from: resolveBookingProfile(config, 'Roger Federer'), to: resolveBookingProfile(config, 'Rafael Nadal') }, async session => {
    const preview = await session.preflight(source.id)
    assert.deepEqual(calls, ['search-before'])
    assert.equal(preview.balances[0].hours, 5)
    return runTransfer({ ...preview, reservationId: source.id, history: [], status: 'prepared' }, session, () => {})
  })
  if (hours < 1 || busy) {
    await assert.rejects(execute(), /no compatible one-hour credit|already has a reservation/)
    assert.equal(cancelled, false)
    assert.equal(confirmed, false)
    assert.ok(!calls.includes('hold'))
    return
  }
  const result = await execute()
  assert.equal(result.status, 'transferred')
  assert.equal(launched, 2)
  assert.deepEqual(logins, [{ role: 'source', username: 'roger@example.test' }, { role: 'target', username: 'rafael@example.test' }])
  assert.deepEqual(calls, ['search-before', 'search-before', 'cancel', 'search-after', 'hold', 'submit'])
  assert.ok(result.destinationReservation.id)
}

test('two authenticated browsers release once and rebook only the exact slot using the target carnet', async t => runBrowser(t))
test('live page preflight refuses a destination with no credit before source cancellation', async t => runBrowser(t, { hours: 0 }))
test('live page preflight refuses a destination already booked before source cancellation', async t => runBrowser(t, { busy: true }))
