import assert from 'node:assert/strict'
import { test } from 'node:test'
import dayjs from 'dayjs'
import { prepareBookingTarget, searchBookingTarget } from '../lib/booking-search.js'

const target = { sport: 'tennis', location: 'Example Club', courtNumbers: [], courtType: ['Couvert'], hours: ['18'], priority: 0 }
const date = dayjs('2026-09-21')

const fakePage = ({ dateSelectable = true, timeoutFirstSubmission = false } = {}) => {
  const calls = []
  let documentId = 0
  let marker
  let submissions = 0
  const locator = selector => ({
    locator: child => locator(`${selector} ${child}`),
    pressSequentially: async value => calls.push(['type', selector, value]),
    getByText: value => ({ click: async () => calls.push(['club', value]) }),
    click: async () => calls.push(['locator-click', selector]),
    waitFor: async () => {},
    first: () => locator(selector),
    count: async () => selector.includes('dateiso') ? Number(dateSelectable) : 0,
    isVisible: async () => true,
    all: async () => [],
  })
  return {
    calls,
    changeDocument: () => { documentId++; marker = undefined },
    url: () => 'https://example.test/search',
    isClosed: () => false,
    setDefaultTimeout: () => {},
    goto: async url => calls.push(['goto', url]),
    content: async () => '<script>var tennis = {"features":[{"properties":{"general":{"_id":293,"_nomSrtm":"Example Club","_arrondissement":1},"courts":[{"_airId":42,"_airNom":"Court n° 1","_airCvt":"V","_formattedAirNum":1}]}}]};</script>',
    locator,
    click: async selector => calls.push(['click', selector]),
    waitForSelector: async () => {},
    waitForNavigation: async () => {
      submissions++
      if (timeoutFirstSubmission && submissions === 1) {
        const error = new Error('Search timed out')
        error.name = 'TimeoutError'
        throw error
      }
      return { ok: () => true }
    },
    evaluate: async (callback, value) => {
      if (!String(callback).includes('=== value')) marker = value
      return marker === value && documentId === 0
    },
  }
}

const options = () => ({
  target,
  date,
  polling: { intervalSeconds: 2 },
  priceTypes: ['Gratuité'],
  captchaOptions: { headed: false },
  searchUrl: 'https://example.test/search',
})

test('warmup prepares the primary club and date without submitting or selecting a slot', async () => {
  const page = fakePage()
  const prepared = await prepareBookingTarget(page, options(page))

  assert.equal(prepared.location, 'Example Club')
  assert.equal(prepared.dateSelected, true)
  assert.deepEqual(page.calls.slice(0, 3), [
    ['goto', 'https://example.test/search'],
    ['type', '.tokens-input-text', 'Example Club '],
    ['club', 'Example Club'],
  ])
  assert.ok(page.calls.some(call => call[0] === 'click' && call[1] === '#when'))
  assert.ok(!page.calls.some(call => call.includes('#rechercher')))
  assert.ok(!page.calls.some(call => String(call[1]).includes('[courtid]')))
})

test('the opening search submits the already prepared form in the same page without navigating again', async () => {
  const page = fakePage()
  const prepared = await prepareBookingTarget(page, options(page))
  page.calls.length = 0

  await searchBookingTarget(page, { ...options(page), prepared })

  assert.ok(page.calls.some(call => call[0] === 'click' && call[1] === '#rechercher'))
  assert.ok(!page.calls.some(call => call[0] === 'goto'))
  assert.ok(!page.calls.some(call => call[0] === 'type'))
})

test('when the date cannot be selected during warmup, opening falls back to a fresh complete search', async () => {
  const page = fakePage({ dateSelectable: false })
  const prepared = await prepareBookingTarget(page, options(page))
  assert.equal(prepared.dateSelected, false)
  page.calls.length = 0

  await searchBookingTarget(page, { ...options(page), prepared })

  assert.ok(page.calls.some(call => call[0] === 'goto'))
  assert.ok(page.calls.some(call => call[0] === 'type'))
})

test('a timed-out prepared submission is consumed so the next attempt prepares a fresh form', async () => {
  const page = fakePage({ timeoutFirstSubmission: true })
  const prepared = await prepareBookingTarget(page, options(page))
  page.calls.length = 0

  await assert.rejects(searchBookingTarget(page, { ...options(page), prepared }), { name: 'TimeoutError' })
  page.calls.length = 0
  await searchBookingTarget(page, { ...options(page), prepared })

  assert.ok(page.calls.some(call => call[0] === 'goto'))
  assert.ok(page.calls.some(call => call[0] === 'type'))
})

test('a changed page after warmup triggers fresh preparation instead of submitting the stale form', async () => {
  const page = fakePage()
  const prepared = await prepareBookingTarget(page, options(page))
  page.changeDocument()
  page.calls.length = 0

  await searchBookingTarget(page, { ...options(page), prepared })

  assert.ok(page.calls.some(call => call[0] === 'goto'))
  assert.ok(page.calls.some(call => call[0] === 'type'))
})
