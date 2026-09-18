import { createHash } from 'node:crypto'
import { withSitePage, siteUrl } from './site-session.js'
import { bookingJobOptions } from './booking-job.js'
import { acquireOperationLock } from './operation-lock.js'

export const RESERVATIONS_URL = siteUrl('page=profil&view=ma_reservation')

export const readReservationsPage = async page => {
  const booking = page.locator('#booking')
  if (await booking.count() !== 1) throw new Error('Reservations page unavailable or session expired')
  const emptyNode = booking.locator('.none')
  const empty = await emptyNode.count() === 1 ? await emptyNode.innerText() : ''
  if (/pas de réservation en cours/i.test(empty)) return []
  const details = await booking.evaluate(element => {
    const copy = element.cloneNode(true)
    copy.querySelectorAll('.creditAbsence, button, script, .modal, #annuler').forEach(item => item.remove())
    return copy.textContent.replace(/\s+/g, ' ').trim()
  })
  if (!details || !/court|\d{1,2}[/:]\d{2}|\d{1,2}\s*h/i.test(details)) throw new Error('Unknown reservation page layout; refusing to assume no reservations')
  const cancel = page.locator('#annuler')
  const count = await cancel.count()
  if (count > 1) throw new Error('Multiple cancellation controls found; refusing an ambiguous reservation')
  const cancellable = count === 1 && await cancel.isVisible() && await cancel.isEnabled()
    && !await cancel.evaluate(el => el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true')
  // The live page exposes a single current reservation and a session-bound cancel
  // form, not a public booking ID. Bind cancellation to its displayed details.
  const id = `reservation-${createHash('sha256').update(details).digest('hex').slice(0, 24)}`
  return [{ id, details, cancellable }]
}

export const listReservations = (options = {}) => withSitePage(async page => {
  await page.goto(RESERVATIONS_URL)
  return readReservationsPage(page)
}, { ...options, authenticate: true })

export const cancelOnPage = async (page, id, { confirm = false } = {}) => {
  const reservations = await readReservationsPage(page)
  const reservation = reservations.find(item => item.id === id)
  if (!reservation) throw new Error('Reservation not found or changed. List reservations again before cancelling.')
  if (!reservation.cancellable) throw new Error('The site does not currently allow cancellation of this reservation')
  if (!confirm) return { status: 'preview', reservation }
  const form = page.locator('#annul')
  if (await form.count() !== 1) throw new Error('Cancellation form not found')
  const action = new URL(await form.getAttribute('action'), page.url())
  if (action.origin !== new URL(RESERVATIONS_URL).origin || action.searchParams.get('page') !== 'profil' || action.searchParams.get('view') !== 'ma_reservation') throw new Error('Unexpected cancellation form action')
  await page.locator('#annuler').click()
  await page.locator('#cancelModal').waitFor({ state: 'visible' })
  // Submit the site's form once, retaining its token and native validation.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator('#cancelModal #confirmer').click(),
  ])
  await page.goto(RESERVATIONS_URL)
  const remaining = await readReservationsPage(page)
  if (remaining.length) throw new Error('Cancellation not verified. Check the account before retrying.')
  return { status: 'cancelled', reservation, verified: true }
}

export const cancelReservation = async (id, options = {}) => {
  if (!/^reservation-[a-f0-9]{24}$/.test(id || '')) throw new Error('Use the reservation ID returned by reservations list')
  const release = options.confirm ? acquireOperationLock(bookingJobOptions().stateDirectory) : () => {}
  try {
    return await withSitePage(async page => {
      await page.goto(RESERVATIONS_URL)
      return cancelOnPage(page, id, options)
    }, { ...options, authenticate: true })
  } finally { release() }
}
