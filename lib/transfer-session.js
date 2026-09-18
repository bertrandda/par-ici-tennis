import { chromium } from 'playwright'
import dayjs from 'dayjs'
import { authenticatePage, siteUrl, SITE_ROOT } from './site-session.js'
import { RESERVATIONS_URL, readReservationsPage, cancelOnPage } from './reservations.js'
import { parseClubCatalog } from './clubs.js'
import { CREDITS_URL, readCreditsPage } from './credits.js'
import { reservationSelection, assertTransferCredits } from './transfer-selection.js'
import { searchBookingTarget, clickBookingCandidate } from './booking-search.js'
import { waitForSearchPage } from './booking-page.js'
import { waitForStep } from './captcha.js'
import { preparePayment } from './payment.js'
import { buildBookingConfig } from './booking-request.js'
import { scanPublicPlanning } from './public-planning.js'

const searchUrl = siteUrl('page=recherche&view=recherche_creneau')

export const withTransferSession = async ({ config, from, to, headed = false }, operation) => {
  const browsers = []
  const options = { headed, ai: config.ai, timeoutMs: headed ? 300000 : 30000 }
  try {
    // Separate browsers keep both authenticated sessions ready before release.
    for (let i = 0; i < 2; i++) browsers.push(await chromium.launch({ headless: !headed, timeout: 90000 }))
    const source = await browsers[0].newPage()
    const target = await browsers[1].newPage()
    for (const page of [source, target]) page.setDefaultTimeout(30000)
    await authenticatePage(source, from.account, options)
    await authenticatePage(target, to.account, options)
    let selection
    let candidate
    let players
    let catalog
    const search = deadline => searchBookingTarget(target, {
      target: { ...selection, hours: [selection.hour], courtType: [selection.courtType], courtNumbers: [selection.courtNumber] },
      date: dayjs(selection.date, 'DD/MM/YYYY'), deadline, polling: true, priceTypes: to.priceType, captchaOptions: options, searchUrl,
    })
    return await operation({
      async preflight(reservationId, requestedPlayers) {
        await source.goto(RESERVATIONS_URL)
        const reservations = await readReservationsPage(source)
        const reservation = reservations.find(item => item.id === reservationId)
        if (!reservation || !reservation.cancellable) throw new Error('Source reservation changed or cancellation unavailable')
        await target.goto(RESERVATIONS_URL)
        if ((await readReservationsPage(target)).length) throw new Error('Destination already has a reservation; source preserved')
        await target.goto(searchUrl)
        await waitForSearchPage(target, options)
        catalog = parseClubCatalog(await target.content())
        selection = reservationSelection(reservation, catalog)
        players = buildBookingConfig(config, { bookingAccount: to.id, sport: selection.sport, locations: [selection.location], date: selection.date, hours: [selection.hour], courtType: [selection.courtType], players: requestedPlayers }).players
        let balances = []
        if (!to.priceType.includes('Gratuité')) {
          await target.goto(CREDITS_URL)
          balances = await readCreditsPage(target)
          assertTransferCredits(to, selection, balances)
        }
        const readiness = await search(Date.now() + 30000)
        if (!readiness.dateSelectable) throw new Error('Destination cannot search the requested date; source preserved')
        if (readiness.candidates.length) throw new Error('Source slot appears free before cancellation; reconcile its identity first')
        return { reservation, selection, players, balances, quotaVerified: false }
      },
      async cancel(reservationId) {
        // Re-read immediately before submitting the native cancellation once.
        await source.goto(RESERVATIONS_URL)
        return cancelOnPage(source, reservationId, { confirm: true })
      },
      async find(deadline) {
        const result = await search(deadline)
        candidate = result.candidates[0]
        return !!candidate
      },
      async publicSignal() {
        const report = await scanPublicPlanning({ club: selection.location, dates: [selection.date], hours: [selection.hour] })
        const matching = report.slots.find(slot => slot.hour === selection.hour && slot.court.replace(/\D/g, '') === String(selection.courtNumber))
        return { source: 'public_planning', state: matching?.state || 'not_listed', court: matching?.court || null }
      },
      async hold() {
        await clickBookingCandidate(target, selection.location, candidate)
        await waitForStep(target, '.order-steps-infos h2 >> text="1 / 3 - Validation du court"', options)
        for (const [i, player] of players.entries()) {
          if (i) await target.click('.addPlayer')
          const fields = target.locator(`[name="player${i + 1}"]`)
          await fields.nth(0).fill(player.lastName)
          await fields.nth(1).fill(player.firstName)
        }
        await target.keyboard.press('Enter')
        await waitForStep(target, '.order-steps-infos h2 >> text="2 / 3 - Mode de paiement"', options)
        // Use the tariff observed on this account, never the source's tariff.
        return preparePayment(target, { free: candidate.priceType === 'Gratuité' })
      },
      async submit(button) {
        await button.click()
        await target.locator('.confirmReservation').waitFor({ state: 'visible' })
      },
      async verify() {
        await target.goto(RESERVATIONS_URL)
        const reservations = await readReservationsPage(target)
        if (reservations.length !== 1) throw new Error('Destination confirmation cannot be reconciled')
        const actual = reservationSelection(reservations[0], catalog)
        if (JSON.stringify(actual) !== JSON.stringify(selection)) throw new Error('Destination reservation does not match the released slot')
        return reservations[0]
      },
      async cleanup() {
        const response = await target.request.post(`${SITE_ROOT}rest/abortBooking`, { timeout: 10000 })
        if (!response.ok()) throw new Error('Destination hold cleanup unverified')
      },
    })
  } finally {
    await Promise.allSettled(browsers.map(browser => browser.close()))
  }
}
