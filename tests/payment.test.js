/* global document */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { preparePayment } from '../lib/payment.js'

for (const free of [false, true]) test(`native ${free ? 'free' : 'credit'} card enables checkout without submitting`, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const mode = free ? 'free' : 'existingTicket'
  await page.setContent(`<div class="priceTable"><button class="price-item" paymentMode="${mode}">Choice</button></div>
    <div class="step-two"><button id="submit" disabled class="disabled">Etape suivante</button></div>`)
  await page.evaluate(() => {
    document.querySelector('.price-item').onclick = () => {
      document.body.dataset.selected = 'true'
      setTimeout(() => { const button = document.querySelector('#submit'); button.disabled = false; button.classList.remove('disabled') }, 100)
    }
    document.querySelector('#submit').onclick = () => { document.body.dataset.submitted = 'true' }
  })
  const submit = await preparePayment(page, { free })
  assert.equal(await submit.isEnabled(), true)
  assert.equal(await page.locator('body').getAttribute('data-selected'), 'true')
  assert.equal(await page.locator('body').getAttribute('data-submitted'), null)
  assert.equal(await page.locator('#paymentMode,#envoyer').count(), 0)
})

test('missing credit never chooses a new card payment or forces a disabled button', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<div class="priceTable"><button class="price-item" paymentMode="newTicket">Pay by card</button></div><div class="step-two"><button id="submit" class="disabled" disabled>Next</button></div>')
  await assert.rejects(preparePayment(page), /No compatible existing credit/)
  assert.equal(await page.locator('#submit').isDisabled(), true)
})

test('reloads the native payment page once and reselects the credit when its first click is ignored', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  let visits = 0
  await page.route('https://payment.test/**', route => {
    visits += 1
    const enablesCheckout = visits > 1
    return route.fulfill({ contentType: 'text/html', body: `<div class="priceTable"><button class="price-item" paymentMode="existingTicket">Choice</button></div>
      <div class="step-two"><button id="submit" disabled class="disabled">Etape suivante</button></div>
      <script>document.querySelector('.price-item').onclick = () => { ${enablesCheckout ? 'const button = document.querySelector(\'#submit\'); button.disabled = false; button.classList.remove(\'disabled\')' : ''} }</script>` })
  })
  await page.goto('https://payment.test/checkout')

  const submit = await preparePayment(page)

  assert.equal(visits, 2)
  assert.equal(await submit.isEnabled(), true)
})
