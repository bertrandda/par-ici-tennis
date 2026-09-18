import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { withSitePage, siteUrl } from './site-session.js'
import { loadMonitoringConfig } from './config.js'
import { guardMonitorPage, observeAvailability } from './availability-monitor.js'

dayjs.extend(customParseFormat)

const normalizeDate = value => {
  const date = dayjs(value, ['D/M/YYYY', 'DD/MM/YYYY'], true)
  if (!date.isValid()) throw new Error('Invalid planning date')
  return date.format('DD/MM/YYYY')
}

const normalizeHours = hours => {
  if (!Array.isArray(hours) || !hours.length || hours.some(hour => !/^(?:[89]|1\d|2[0-2])$/.test(String(hour)))) throw new Error('Planning hours must contain whole hours from 8 to 22')
  return [...new Set(hours.map(String))]
}

export const validatePlanningOptions = ({ club, dates, hours }) => {
  if (typeof club !== 'string' || !club.trim()) throw new Error('Planning club is required')
  if (!Array.isArray(dates) || !dates.length) throw new Error('Planning dates are required')
  return { club: club.trim(), dates: [...new Set(dates.map(normalizeDate))], hours: normalizeHours(hours) }
}

const compact = value => value.replace(/\s+/g, ' ').trim()
const hourFromLabel = value => compact(value).match(/^(\d{1,2})h?\s*-\s*\d{1,2}h?$/i)?.[1]
const stateFor = value => {
  const text = compact(value)
  const reservedAt = text.match(/Réservé le\s+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i)?.[1] || null
  return { state: /^LIBRE$/i.test(text) ? 'free' : 'occupied', label: text, reservedAt }
}

// The public endpoint has no stable court IDs. Keep court labels as evidence and
// never use this result to select a booking button by itself.
export const parsePublicPlanningTable = (table, { date, hours }) => {
  const courts = [...table.querySelectorAll('thead tr:last-child th, thead tr:last-child td')]
    .slice(1).map(cell => compact(cell.textContent || ''))
  const slots = []
  for (const row of table.querySelectorAll('tbody tr')) {
    const cells = [...row.querySelectorAll('td')]
    const hour = hourFromLabel(cells[0]?.textContent || '')
    if (!hour || !hours.includes(hour)) continue
    for (const [index, cell] of cells.slice(1).entries()) {
      const value = stateFor(cell.textContent || '')
      slots.push({ date, hour, court: courts[index] || `Court ${index + 1}`, ...value })
    }
  }
  return slots
}

const visiblePlanningDates = async page => page.locator('.date-picker .date[dateiso]').evaluateAll(elements => elements.map(element => element.getAttribute('dateiso')).filter(Boolean))

export const scanPublicPlanning = async (input, { pageOperation = withSitePage } = {}) => {
  const options = validatePlanningOptions(input)
  return pageOperation(async page => {
    await page.goto(siteUrl(`page=recherche&view=planning&name_tennis=${encodeURIComponent(options.club)}`), { waitUntil: 'domcontentloaded' })
    const exposedDates = await visiblePlanningDates(page)
    const unavailable = options.dates.filter(date => !exposedDates.includes(date))
    if (unavailable.length) throw new Error(`Planning dates not exposed by the public week: ${unavailable.join(', ')}`)
    const scans = []
    for (const date of options.dates) {
      const selected = page.locator(`.date-picker .date-item.selected .date[dateiso="${date}"]`)
      if (!await selected.count()) {
        await page.locator(`.date-picker .date-item:not(.item-full) .date[dateiso="${date}"]`).click()
        await page.locator('.date-picker .date-item.selected .date').getAttribute('dateiso')
        await page.locator('#tableauPlanning table').waitFor({ state: 'visible' })
      }
      const table = page.locator('#tableauPlanning table').first()
      scans.push(...await table.evaluate((element, args) => {
        const compactText = value => value.replace(/\s+/g, ' ').trim()
        const hour = value => compactText(value).match(/^(\d{1,2})h?\s*-\s*\d{1,2}h?$/i)?.[1]
        const courts = [...element.querySelectorAll('thead tr:last-child th, thead tr:last-child td')].slice(1).map(cell => compactText(cell.textContent || ''))
        const slots = []
        for (const row of element.querySelectorAll('tbody tr')) {
          const cells = [...row.querySelectorAll('td')]
          const start = hour(cells[0]?.textContent || '')
          if (!start || !args.hours.includes(start)) continue
          for (const [index, cell] of cells.slice(1).entries()) {
            const label = compactText(cell.textContent || '')
            slots.push({ date: args.date, hour: start, court: courts[index] || `Court ${index + 1}`, state: /^LIBRE$/i.test(label) ? 'free' : 'occupied', label, reservedAt: label.match(/Réservé le\s+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i)?.[1] || null })
          }
        }
        return slots
      }, { date, hours: options.hours }))
    }
    return { source: 'Paris Tennis public planning', observedAt: new Date().toISOString(), club: options.club, exposedDates, slots: scans }
  }, { authenticate: false })
}

export const detectPlanningTransitions = (previous = [], current = []) => {
  const before = new Map(previous.map(slot => [`${slot.date}/${slot.hour}/${slot.court}`, slot]))
  return current.map(slot => {
    const prior = before.get(`${slot.date}/${slot.hour}/${slot.court}`)
    return {
      ...slot,
      signal: slot.state !== 'free' ? 'occupied' : prior?.state === 'occupied' ? 'became_free' : 'free_unknown_age',
    }
  })
}

// This deliberately reuses the guarded, read-only search path. It is a second
// observation source, not a booking attempt and never clicks a slot.
export const scanConnectedAvailability = async (input, { pageOperation = withSitePage, config } = {}) => {
  const options = validatePlanningOptions(input)
  const sport = input.sport || 'tennis'
  if (!['tennis', 'padel'].includes(sport)) throw new Error('Invalid planning sport')
  config ||= loadMonitoringConfig()
  return pageOperation(async page => {
    await guardMonitorPage(page)
    const slots = []
    for (const date of options.dates) {
      const result = await observeAvailability(page, { date, club: options.club, sport, end: new Date(Date.now() + 90000).toISOString() }, { ai: config.ai })
      slots.push(...result.slots.filter(slot => options.hours.includes(slot.start.slice(11, 13))).map(slot => ({ date, hour: slot.start.slice(11, 13), courtId: slot.courtId, bookable: slot.bookable, priceType: slot.priceType || null })))
    }
    return { source: 'Paris Tennis connected search', observedAt: new Date().toISOString(), club: options.club, sport, slots }
  }, { authenticate: true, config })
}
