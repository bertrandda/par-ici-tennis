import { setTimeout as sleep } from 'node:timers/promises'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { parseClubCatalog, resolveClub } from './clubs.js'
import { selectClubCourts } from './sport.js'
import { selectBookingDate, submitBookingSearch, setSearchTimeout, waitForSearchPage } from './booking-page.js'
import { siteUrl } from './site-session.js'
import { waitForSearchStart } from './search-window.js'

dayjs.extend(customParseFormat)

export const validateMonitorOptions = ({ date, club, sport = 'padel', start, end, intervalSeconds = 2 }) => {
  const target = dayjs(date, ['D/M/YYYY', 'DD/MM/YYYY'], true)
  if (!target.isValid()) throw new Error('Invalid monitor target date')
  if (typeof club !== 'string' || !club.trim()) throw new Error('Monitor club is required')
  if (!['padel', 'tennis'].includes(sport)) throw new Error('Invalid monitor sport')
  if (![start, end].every(value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))) throw new Error('Monitor timestamps require an explicit timezone')
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 3600000) throw new Error('Monitor duration must be positive and at most one hour')
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 2 || intervalSeconds > 60) throw new Error('Monitor interval must be between 2 and 60 seconds')
  return { date: target.format('DD/MM/YYYY'), club: club.trim(), sport, start, end, intervalSeconds }
}

export const guardMonitorPage = async page => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const mutation = url.searchParams.get('page') === 'reservation'
      || /(?:cancel|abort|book)/i.test(url.searchParams.get('action') || '')
      || /\/rest\/.*(?:booking|reservation)/i.test(url.pathname)
    return mutation ? route.abort('blockedbyclient') : route.continue()
  })
}

export const observeAvailability = async (page, options, captchaOptions = {}) => {
  const deadline = Date.parse(options.end)
  const timestamp = () => new Date().toISOString()
  const startedAt = timestamp()
  setSearchTimeout(page, deadline)
  await page.goto(siteUrl('page=recherche&view=recherche_creneau'))
  await waitForSearchPage(page, { ...captchaOptions, timeoutMs: Math.min(30000, Math.max(1, deadline - Date.now())) })
  const catalog = parseClubCatalog(await page.content())
  const club = resolveClub(catalog, options.club)
  const courtIds = selectClubCourts(catalog, club.name, { sport: options.sport })
  setSearchTimeout(page, deadline)
  await page.locator('.tokens-input-text').pressSequentially(`${club.name} `)
  await page.locator('.tokens-suggestions-list-element').getByText(club.name, { exact: true }).click()
  if (!(await selectBookingDate(page, options.date, { allowUnavailable: true, deadline }))) {
    return { startedAt, observedAt: timestamp(), status: 'date_not_selectable', slots: [] }
  }
  const queryStartedAt = timestamp()
  await submitBookingSearch(page, { deadline })
  // Read attributes even for collapsed hour groups; never click a slot.
  const buttons = await page.locator('[courtid][datedeb]').evaluateAll(elements => elements.map(element => ({
    courtId: element.getAttribute('courtid'), start: element.getAttribute('datedeb'), end: element.getAttribute('datefin'),
    priceType: element.getAttribute('typeprice'), price: element.getAttribute('price'),
    bookable: element.classList.contains('buttonAllOk') && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
  })))
  const datePrefix = dayjs(options.date, 'DD/MM/YYYY').format('YYYY/MM/DD') + ' '
  const unique = new Map()
  for (const slot of buttons.filter(slot => courtIds.has(slot.courtId) && slot.start?.startsWith(datePrefix))) {
    const key = `${slot.courtId}:${slot.start}`
    if (!unique.has(key) || slot.bookable) unique.set(key, slot)
  }
  const slots = [...unique.values()].sort((a, b) => a.start.localeCompare(b.start) || a.courtId.localeCompare(b.courtId))
  return { startedAt, queryStartedAt, observedAt: timestamp(), status: slots.length ? 'slots_visible' : 'empty', slots }
}

export const summarizeObservations = observations => {
  const successful = observations.filter(item => item.status !== 'error')
  const firstVisible = successful.find(item => item.slots.length)
  const firstBookable = successful.find(item => item.slots.some(slot => slot.bookable))
  const previousEmpty = firstVisible ? successful.filter(item => item.observedAt < firstVisible.observedAt && !item.slots.length).at(-1) : undefined
  return {
    samples: observations.length,
    errors: observations.filter(item => item.status === 'error').length,
    result: !successful.length ? 'no_successful_observation' : !firstVisible ? 'not_observed' : previousEmpty ? 'appearance_observed' : 'already_visible_at_first_successful_sample',
    firstVisibleAt: firstVisible?.observedAt || null,
    firstBookableAt: firstBookable?.observedAt || null,
    // Search initiation is the conservative lower bound; rendering may lag the server snapshot.
    possibleAppearanceAfter: previousEmpty?.queryStartedAt || previousEmpty?.startedAt || null,
    lastEmptyObservedAt: previousEmpty?.observedAt || null,
    firstSlots: firstVisible?.slots || [],
    firstObservationAt: observations[0]?.startedAt || null,
    lastObservationAt: observations.at(-1)?.observedAt || null,
  }
}

export const monitorWindow = async (options, sample, record, { now = Date.now, wait = sleep } = {}) => {
  const start = Date.parse(options.start)
  const end = Date.parse(options.end)
  await waitForSearchStart(start, { now, wait })
  const observations = []
  let failures = 0
  while (now() < end) {
    const started = now()
    let observation
    try { observation = await sample() } catch (error) {
      observation = { startedAt: new Date(started).toISOString(), observedAt: new Date(now()).toISOString(), status: 'error', error: error.message.slice(0, 500), slots: [] }
    }
    observations.push(observation)
    await record(observation)
    failures = observation.status === 'error' ? failures + 1 : 0
    if (failures >= 3) return { ...summarizeObservations(observations), stoppedReason: 'three_consecutive_errors' }
    const next = Math.min(end, started + options.intervalSeconds * 1000)
    if (now() < next) await wait(next - now())
  }
  return { ...summarizeObservations(observations), stoppedReason: 'window_complete' }
}
