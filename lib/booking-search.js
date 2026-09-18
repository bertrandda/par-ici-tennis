import { parseClubCatalog, resolveClub } from './clubs.js'
import { selectClubCourts } from './sport.js'
import { selectBookingDate, submitBookingSearch, setSearchTimeout, readPriceDescription, waitForSearchPage, assertSearchSession } from './booking-page.js'
import { rememberOpeningAgenda, refreshOpeningAgenda } from './opening-agenda.js'
import { firstBookingCandidate } from './first-candidate.js'

const targetKey = target => JSON.stringify([target.sport, target.location, target.courtId || null, target.courtNumbers || [], target.hours])
let preparationSequence = 0

const markPreparedForm = async page => {
  const marker = `${Date.now()}-${++preparationSequence}`
  await page.evaluate(value => {
    const form = globalThis.document.querySelector('#rechercher')?.form
    if (form) form.dataset.bookingPreparation = value
  }, marker)
  return marker
}

const isPreparedFormCurrent = async (page, marker) => {
  try {
    return await page.evaluate(value => globalThis.document.querySelector('#rechercher')?.form?.dataset.bookingPreparation === value, marker)
  } catch {
    return false
  }
}

const prepareSearchForm = async (page, { target, date, deadline, polling, captchaOptions, searchUrl }) => {
  const remaining = () => deadline ? Math.max(1, deadline - Date.now()) : 90000
  page.setDefaultTimeout(Math.min(90000, remaining()))
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' })
  await waitForSearchPage(page, { ...captchaOptions, timeoutMs: Math.min(captchaOptions.headed ? 300000 : 90000, remaining()) })
  const catalog = parseClubCatalog(await page.content())
  const location = resolveClub(catalog, target.location).name
  const courtIds = selectClubCourts(catalog, location, { sport: target.sport, courtNumbers: target.courtNumbers })
  setSearchTimeout(page, deadline)
  await page.locator('.tokens-input-text').pressSequentially(`${location} `)
  setSearchTimeout(page, deadline)
  await page.locator('.tokens-suggestions-list-element').getByText(location, { exact: true }).click()
  const dateSelected = await selectBookingDate(page, date.format('DD/MM/YYYY'), { allowUnavailable: !!polling, deadline })
  const formMarker = await markPreparedForm(page)
  return { location, courtIds, dateSelected, targetKey: targetKey(target), dateKey: date.format('DD/MM/YYYY'), searchDateKey: date.format('DD/MM/YYYY'), formMarker }
}

// Warm up the authenticated booking page without triggering a search or holding a slot.
export const prepareBookingTarget = async (page, options) => prepareSearchForm(page, {
  ...options,
  // Before opening, the requested date may legitimately not be exposed yet.
  polling: options.polling || true,
})

// Warm up results before opening. If Jour J is absent, select the latest exposed
// date natively to reach the club agenda, without clicking any booking button.
const selectWarmupDate = async (page, form) => {
  if (!form.dateSelected) {
    const dates = await page.locator('.date-picker:visible [dateiso]:visible').evaluateAll(elements => elements.map(element => element.getAttribute('dateiso')))
    const iso = value => value.split('/').reverse().join('-')
    const previous = dates.filter(value => iso(value) < iso(form.dateKey)).sort((a, b) => iso(a).localeCompare(iso(b))).at(-1)
    if (!previous) throw new Error('No earlier date is exposed for agenda warmup')
    await page.locator(`.date-picker:visible [dateiso="${previous}"]:visible`).click()
    await page.locator('.date-picker').waitFor({ state: 'hidden' })
    form.searchDateKey = previous
  }
}

export const prepareOpeningAgenda = async (page, options) => {
  const form = await prepareBookingTarget(page, options)
  await selectWarmupDate(page, form)
  await submitBookingSearch(page, options)
  const prepared = await rememberOpeningAgenda(page, form)
  if (!form.dateSelected) {
    // Same authenticated context, read-only form, no slot selection or submit.
    // Keep the original agenda idle; browser shutdown closes both tabs.
    const sparePage = await page.context().newPage()
    try {
      const spareForm = await prepareBookingTarget(sparePage, options)
      await selectWarmupDate(sparePage, spareForm)
      prepared.spare = { page: sparePage, form: spareForm }
    } catch (error) {
      await sparePage.close()
      throw error
    }
  }
  return prepared
}

export const searchBookingTarget = async (page, { target, date, deadline, polling, priceTypes, captchaOptions, searchUrl, prepared, debugLog = () => {} }) => {
  page = prepared?.activePage ?? page
  const matchesAgenda = prepared?.agenda && prepared.targetKey === targetKey(target) && prepared.dateKey === date.format('DD/MM/YYYY')
  let form
  if (matchesAgenda) {
    form = prepared
    const state = await refreshOpeningAgenda(page, prepared, { deadline, debugLog })
    if (state.requiresSearch) {
      // Some native agendas mark every day full even when bookable slots exist.
      // Reuse the spare form if it is still the original read-only document.
      // Consume it before interaction; a failure must never resubmit it.
      const spare = prepared.spare
      prepared.spare = undefined
      prepared.agenda = undefined
      prepared.consumed = true
      let fresh
      if (spare && !spare.page.isClosed() && await isPreparedFormCurrent(spare.page, spare.form.formMarker)) {
        page = spare.page
        prepared.activePage = page
        await assertSearchSession(page)
        fresh = spare.form
        fresh.dateSelected = await selectBookingDate(page, fresh.dateKey, { allowUnavailable: true, deadline })
        fresh.searchDateKey = fresh.dateKey
        debugLog('using-warm-spare-search-form')
      } else {
        fresh = await prepareSearchForm(page, { target, date, deadline, polling, captchaOptions, searchUrl })
      }
      if (!fresh.dateSelected) return { location: form.location, dateSelectable: false, candidates: [] }
      await submitBookingSearch(page, { deadline })
      Object.assign(prepared, await rememberOpeningAgenda(page, fresh))
    } else if (!state.hasResults) return { location: form.location, dateSelectable: state.dateSelectable, candidates: [] }
  } else {
    // Switching club/date navigates away from the warm agenda permanently.
    if (prepared?.agenda) {
      prepared.agenda = undefined
      prepared.consumed = true
      if (prepared.spare && !prepared.spare.page.isClosed()) await prepared.spare.page.close()
      prepared.spare = undefined
    }
    const matchesPrepared = prepared
    && !prepared.consumed
    && prepared.targetKey === targetKey(target)
    && prepared.dateKey === date.format('DD/MM/YYYY')
    && prepared.dateSelected
    // A prepared form is single-use once handed to a search, including failed submissions.
    if (matchesPrepared) prepared.consumed = true
    const canSubmitPrepared = matchesPrepared && await isPreparedFormCurrent(page, prepared.formMarker)
    form = canSubmitPrepared
      ? prepared
      : await prepareSearchForm(page, { target, date, deadline, polling, captchaOptions, searchUrl })
    if (!form.dateSelected) return { location: form.location, dateSelectable: false, candidates: [] }
    await submitBookingSearch(page, { deadline })
  }
  const { location, courtIds } = form
  if (deadline && Date.now() >= deadline) return { location, dateSelectable: true, candidates: [] }
  if (target.courtSelection === 'first') {
    const candidate = await firstBookingCandidate(page, { target, date, courtIds, priceTypes })
    return { location, dateSelectable: true, candidates: candidate ? [candidate] : [] }
  }
  debugLog(`search-results-ready slots=${await page.locator('[courtid][datedeb]').count()}`)
  const candidates = []
  for (const hour of target.hours) {
    const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
    for (const slot of await page.locator(dateDeb).all()) {
      const courtId = await slot.getAttribute('courtid')
      if (!courtIds.has(courtId) || (target.courtId && courtId !== target.courtId)) continue
      const selector = `[courtid="${courtId}"]${dateDeb}`
      const { priceType, courtType } = await readPriceDescription(page.locator(`.row.tennis-court:has(${selector}) .price-description`))
      if (!target.courtType.includes(courtType) || (priceTypes && !priceTypes.includes(priceType))) continue
      candidates.push({ courtId, hour, selector, priceType, courtType, key: `${courtId}/${date.format('YYYY-MM-DD')}/${hour}` })
    }
  }
  return { location, dateSelectable: true, candidates }
}

export const clickBookingCandidate = async (page, location, candidate) => {
  if (await page.locator(candidate.selector).isHidden()) await page.locator(`#head${location.replaceAll(' ', '')}${candidate.hour}h .panel-title`).click()
  await page.locator(candidate.selector).click()
}
