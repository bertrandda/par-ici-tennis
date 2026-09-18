import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Refuse ambiguous layouts instead of guessing which hour would be released.
export const reservationSelection = (reservation, catalog, now = Date.now()) => {
  let text = reservation.details.replace(/\s+/g, ' ')
  const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
  for (const [i, month] of months.entries()) text = text.replace(new RegExp(`(\\d{1,2}) ${month} (\\d{4})`, 'gi'), (_, d, y) => `${d}/${i + 1}/${y}`)
  const dates = [...text.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:à|de|,|-)?\s*(\d{1,2})\s*h(?:\s*([0-5]\d))?/gi)]
  if (dates.length !== 1 || (dates[0][3] && dates[0][3] !== '00')) throw new Error('Cannot identify a unique whole-hour reservation date; source preserved')
  const [, rawDate, rawHour] = dates[0]
  const date = dayjs(rawDate, ['D/M/YYYY', 'DD/MM/YYYY'], true)
  const hour = rawHour.padStart(2, '0')
  if (!date.isValid() || Number(hour) > 23) throw new Error('Invalid reservation date/hour')
  const end = text.slice(dates[0].index + dates[0][0].length).match(/^\s*(?:à|-)\s*(\d{1,2})\s*h(?:\s*([0-5]\d))?/i)
  if (end && (Number(end[1]) !== (Number(hour) + 1) % 24 || (end[2] && end[2] !== '00'))) throw new Error('Only a one-hour reservation can be replaced')
  if (dayjs.tz(`${date.format('YYYY-MM-DD')} ${hour}:00`, 'Europe/Paris').valueOf() <= now) throw new Error('Reservation must be in the future')
  const normalized = ` ${normalize(text)} `
  const names = [...new Set(catalog.filter(club => normalized.includes(` ${normalize(club.name)} `)).map(club => club.name))]
  const numbers = [...text.matchAll(/\b(court|padel|terrain)\s*(?:n[°ºo]\s*)?0*(\d+)\b/gi)]
  if (names.length !== 1 || numbers.length !== 1) throw new Error('Cannot identify an unambiguous club and court; source preserved')
  const location = names[0]
  const sport = /^padel\b/i.test(location) || /^padel$/i.test(numbers[0][1]) ? 'padel' : 'tennis'
  const courts = catalog.filter(club => club.name === location).flatMap(club => club.courts)
    .filter(court => court.number === Number(numbers[0][2]) && court.sport === sport)
  if (courts.length !== 1 || typeof courts[0].covered !== 'boolean') throw new Error('Cannot resolve the exact official court; source preserved')
  return { location, sport, courtId: courts[0].id, courtNumber: courts[0].number, courtType: courts[0].covered ? 'Couvert' : 'Découvert', date: date.format('DD/MM/YYYY'), hour }
}

export const assertTransferCredits = (profile, selection, balances) => {
  if (profile.priceType.includes('Gratuité')) return
  if (!balances.some(balance => profile.priceType.includes(balance.priceType) && balance.courtType === selection.courtType && balance.hours >= 1)) {
    throw new Error('Destination has no compatible one-hour credit; source preserved')
  }
}
