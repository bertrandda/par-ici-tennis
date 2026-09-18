import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { chromium } from 'playwright'
import { cancelOnPage, readReservationsPage, RESERVATIONS_URL } from '../lib/reservations.js'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser.close() })
const empty = '<div id="booking"><div class="none">Vous n’avez pas de réservation en cours.</div></div>'
const booked = `<div id="booking"><div class="creditAbsence">Crédit 5</div>
<div>Max Rousié, Court 1, 21/09/2026 à 18h</div><button id="annuler">Annuler</button></div>
<div id="cancelModal" style="display:none"><button id="confirmer">Confirmer</button>
<form id="annul" action="?page=profil&view=ma_reservation" method="post"><input name="token" value="fixture"><input name="annulation" value="true"></form></div>
<script>document.querySelector('#annuler').onclick=()=>document.querySelector('#cancelModal').style.display='block';
document.querySelector('#confirmer').onclick=()=>document.querySelector('#annul').submit()</script>`

const fixture = async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  let cancelled = false
  let posts = 0
  await page.route('**/*', async route => {
    if (route.request().method() === 'POST') { posts++; cancelled = true }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: cancelled ? empty : booked })
  })
  await page.goto(RESERVATIONS_URL)
  return { page, posts: () => posts }
}
test('empty account is recognized but unknown markup is an error', async t => {
  const { page } = await fixture(t)
  await page.setContent(empty)
  assert.deepEqual(await readReservationsPage(page), [])
  await page.setContent('<h1>Error 500</h1>')
  await assert.rejects(readReservationsPage(page), /unavailable/)
})
test('preview and mismatched reservation IDs never submit cancellation', async t => {
  const { page, posts } = await fixture(t)
  const [reservation] = await readReservationsPage(page)
  assert.equal((await cancelOnPage(page, reservation.id)).status, 'preview')
  await assert.rejects(cancelOnPage(page, 'wrong', { confirm: true }), /not found/)
  assert.equal(posts(), 0)
})
test('cancellation uses the native form once and verifies the empty account', async t => {
  const { page, posts } = await fixture(t)
  const [reservation] = await readReservationsPage(page)
  const result = await cancelOnPage(page, reservation.id, { confirm: true })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.verified, true)
  assert.equal(posts(), 1)
})
test('disabled cancellation is respected', async t => {
  const { page, posts } = await fixture(t)
  await page.locator('#annuler').evaluate(el => el.classList.add('disabled'))
  const [reservation] = await readReservationsPage(page)
  assert.equal(reservation.cancellable, false)
  await assert.rejects(cancelOnPage(page, reservation.id, { confirm: true }), /does not currently allow/)
  assert.equal(posts(), 0)
})

test('an unchanged reservation after submission never reports cancellation success', async t => {
  const { page } = await fixture(t)
  await page.unroute('**/*')
  let posts = 0
  await page.route('**/*', async route => {
    if (route.request().method() === 'POST') posts++
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: booked })
  })
  const [reservation] = await readReservationsPage(page)
  await assert.rejects(cancelOnPage(page, reservation.id, { confirm: true }), /not verified/)
  assert.equal(posts, 1)
})
