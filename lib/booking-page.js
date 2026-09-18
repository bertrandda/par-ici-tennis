import { waitForStep } from './captcha.js'

export const waitForSearchPage = async (page, options) => {
  await waitForStep(page, '.tokens-input-text, .order-steps-infos h2', options)
  if (!(await page.locator('.tokens-input-text').isVisible())) throw new Error('An unfinished reservation redirects this account away from search. Finish or cancel that reservation before searching; no automatic cancellation was performed.')
}

export const setSearchTimeout = (page, deadline) => {
  if (!deadline) return
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    const error = new Error('Search window expired')
    error.name = 'TimeoutError'
    throw error
  }
  page.setDefaultTimeout(Math.min(90000, remaining))
}

export const selectBookingDate = async (page, date, { allowUnavailable = false, deadline } = {}) => {
  setSearchTimeout(page, deadline)
  await page.click('#when')
  setSearchTimeout(page, deadline)
  await page.locator('.date-picker:visible').waitFor()
  // Opening the calendar starts an AJAX refresh after selecting a club.
  // An absent date is meaningful only once that refresh has completed.
  const calendar = page.locator('.date-picker:visible')
  setSearchTimeout(page, deadline)
  await calendar.locator('#loadingComponent').waitFor({ state: 'hidden' })
  setSearchTimeout(page, deadline)
  await calendar.locator('[dateiso]:visible').first().waitFor()
  const requestedDate = page.locator(`.date-picker [dateiso="${date}"]:visible`)
  if (allowUnavailable && !(await requestedDate.count())) return false
  // Search results contain a second, hidden calendar with the same dates.
  setSearchTimeout(page, deadline)
  await requestedDate.click()
  setSearchTimeout(page, deadline)
  await page.waitForSelector('.date-picker', { state: 'hidden' })
  return true
}

export const readPriceDescription = async locator => {
  // textContent preserves the exact tariff label despite CSS text-transform.
  const text = await locator.evaluate(element => {
    const copy = element.cloneNode(true)
    copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
    return copy.textContent
  })
  const [priceType, courtType] = text.split('\n').map(value => value.trim()).filter(Boolean)
  return { priceType, courtType }
}

export const assertSearchSession = async page => {
  if (await page.locator('#form-login, .order-steps-infos h2, .confirmReservation, .row.tennis-court [data-target="#pasDeCompte"]').count()) {
    throw new Error('Search session is no longer ready: login or reservation state changed. No slot was selected.')
  }
}

// The search form submits a new document. Arm the navigation wait before clicking,
// then wait for rendered slots or an explicit empty result, including AJAX loaders.
export const waitForBookingResults = async (page, { deadline } = {}) => {
  setSearchTimeout(page, deadline)
  // A loaded agenda can have no slots at all. Its day headers still establish
  // that the response rendered; they do not establish target-hour availability.
  await page.locator('[courtid][datedeb], .no-result, .date-picker.refresh [dateiso]:visible, #form-login, .order-steps-infos h2').first().waitFor({ state: 'attached' })
  setSearchTimeout(page, deadline)
  await page.locator('#loadingComponent').waitFor({ state: 'hidden' })
  await assertSearchSession(page)
}

export const submitBookingSearch = async (page, { deadline } = {}) => {
  setSearchTimeout(page, deadline)
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('#rechercher'),
  ])
  if (!response?.ok()) throw new Error(`Search failed (HTTP ${response?.status() ?? 'unknown'})`)
  await waitForBookingResults(page, { deadline })
}
