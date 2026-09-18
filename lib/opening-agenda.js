import { randomUUID } from 'node:crypto'
import { assertSearchSession, setSearchTimeout, waitForBookingResults } from './booking-page.js'

const clubSelector = location => `[id=${JSON.stringify(location.replaceAll(' ', ''))}]`
const agendaSelector = location => `${clubSelector(location)} .date-picker.refresh`

const markAgenda = async page => {
  const marker = randomUUID()
  await page.evaluate(value => { globalThis.document.documentElement.dataset.bookingAgenda = value }, marker)
  return marker
}

// Only a native, read-only results document may be reloaded (including its POST).
export const rememberOpeningAgenda = async (page, form) => {
  await assertSearchSession(page)
  await page.locator(`${agendaSelector(form.location)} [dateiso]:visible`).first().waitFor()
  const url = page.url()
  const query = new URL(url).searchParams
  if (query.get('page') !== 'recherche' || query.get('action') !== 'rechercher_creneau') {
    throw new Error('Warmup did not reach the native search results page')
  }
  return { ...form, agenda: { url, marker: await markAgenda(page) } }
}

export const refreshOpeningAgenda = async (page, prepared, { deadline, debugLog = () => {} } = {}) => {
  setSearchTimeout(page, deadline)
  const { agenda, location, dateKey } = prepared
  const current = agenda.marker && page.url() === agenda.url
    && await page.evaluate(value => globalThis.document.documentElement.dataset.bookingAgenda === value, agenda.marker)
  if (!current) throw new Error('Prepared agenda changed; refusing to reload an unknown page')
  await assertSearchSession(page)
  // Invalidate before navigation: a failed reload cannot be replayed later.
  agenda.marker = undefined
  const response = await page.reload({ waitUntil: 'domcontentloaded' })
  if (!response?.ok()) throw new Error(`Agenda refresh failed (HTTP ${response?.status() ?? 'unknown'})`)
  if (page.url() !== agenda.url) throw new Error('Agenda refresh redirected away from search')
  await waitForBookingResults(page, { deadline })
  const calendar = page.locator(agendaSelector(location))
  setSearchTimeout(page, deadline)
  await calendar.locator('[dateiso]:visible').first().waitFor()
  agenda.marker = await markAgenda(page)
  const day = calendar.locator(`[dateiso=${JSON.stringify(dateKey)}]:visible`)
  if (!(await day.count())) return { dateSelectable: false, hasResults: false }
  const state = await day.evaluate(element => ({
    selected: element.closest('.date-item')?.classList.contains('selected'),
    full: element.closest('.date-item')?.classList.contains('item-full'),
  }))
  debugLog(`requested-day-visible date=${dateKey} full=${!!state.full}`)
  const [dayNumber, month, year] = dateKey.split('/')
  const matchingSlots = await page.locator(`${clubSelector(location)} [courtid][datedeb^="${year}/${month}/${dayNumber} "]`).count()
  // The live site can mark the header "Complet" while rendering bookable slots.
  if (matchingSlots) return { dateSelectable: true, hasResults: true }
  if (state.full) return { dateSelectable: true, hasResults: false, requiresSearch: prepared.searchDateKey !== dateKey }
  if (!state.selected) {
    setSearchTimeout(page, deadline)
    // The site's day click refreshes both counts and slots. Wait for the slot
    // response for this exact date/club, not the independent counts response.
    const [slots] = await Promise.all([
      page.waitForResponse(response => {
        if (new URL(response.url()).searchParams.get('action') !== 'ajax_rechercher_creneau') return false
        const data = new URLSearchParams(response.request().postData() || '')
        return data.get('when') === dateKey && data.get('selWhereTennisName') === location
      }),
      day.click(),
    ])
    if (!slots.ok()) throw new Error(`Day selection failed (HTTP ${slots.status()})`)
    await slots.finished()
    await waitForBookingResults(page, { deadline })
    setSearchTimeout(page, deadline)
    await calendar.locator(`.date-item.selected [dateiso=${JSON.stringify(dateKey)}]:visible`).waitFor()
  }
  return { dateSelectable: true, hasResults: true }
}
