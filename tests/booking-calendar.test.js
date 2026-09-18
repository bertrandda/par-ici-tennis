/* global document */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { selectBookingDate, waitForSearchPage } from '../lib/booking-page.js'

test('calendar refresh must finish before classifying a date as unavailable', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const render = async date => {
    await page.setContent(`<button id="when">Date</button>
      <div class="date-picker" style="display:none"><div id="loadingComponent">Loading</div></div>`)
    await page.evaluate(date => {
      document.querySelector('#when').onclick = () => {
        const calendar = document.querySelector('.date-picker')
        calendar.style.display = 'block'
        setTimeout(() => {
          calendar.innerHTML = `<button dateiso="${date}">Date</button>`
          calendar.firstChild.onclick = () => {
            document.body.dataset.selected = date
            calendar.style.display = 'none'
          }
        }, 300)
      }
    }, date)
  }
  await render('19/09/2026')
  assert.equal(await selectBookingDate(page, '19/09/2026', { allowUnavailable: true }), true)
  assert.equal(await page.locator('body').getAttribute('data-selected'), '19/09/2026')
  await render('19/09/2026')
  assert.equal(await selectBookingDate(page, '20/09/2026', { allowUnavailable: true }), false)
})

test('a stalled calendar load is an error rather than evidence of unavailable dates', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<button id="when" onclick="document.querySelector('.date-picker').style.display='block'">Date</button>
    <div class="date-picker" style="display:none"><div id="loadingComponent">Loading</div></div>`)
  await assert.rejects(selectBookingDate(page, '20/09/2026', {
    allowUnavailable: true, deadline: Date.now() + 500,
  }), { name: 'TimeoutError' })
})

test('a leftover reservation is reported immediately instead of a misleading CAPTCHA timeout', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<div class="order-steps-infos"><h2>1 / 3 - Validation du court</h2></div><button id="btnCancelBooking">Cancel</button>')
  await page.evaluate(() => { document.querySelector('#btnCancelBooking').onclick = () => { document.body.dataset.cancelled = 'true' } })
  await assert.rejects(waitForSearchPage(page, { ai: { enable: false }, timeoutMs: 500 }), /unfinished reservation/)
  assert.equal(await page.locator('body').getAttribute('data-cancelled'), null)
})
