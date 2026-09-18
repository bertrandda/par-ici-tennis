import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { mkdirSync, writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'
import { waitForStep } from './lib/captcha.js'
import { reportBookingResult } from './lib/booking-result.js'
import { bookingJobOptions } from './lib/booking-job.js'
import { acquireOperationLock } from './lib/operation-lock.js'
import { getBookingTargets, buildBookingConfig } from './lib/booking-request.js'
import { normalizePolling, parseSearchStart, searchAttempts } from './lib/search-window.js'
import { resolveBookingProfile, VARIABLE_CONFIG_KEYS } from './lib/config.js'
import { authenticatePage } from './lib/site-session.js'
import { prepareBookingTarget, prepareOpeningAgenda, searchBookingTarget, clickBookingCandidate } from './lib/booking-search.js'
import { preparePayment } from './lib/payment.js'
import { consecutiveLegTargets, runConsecutiveLegs } from './lib/consecutive.js'

dayjs.extend(customParseFormat)

const bookTennis = async (config, { leg = 0, targetsOverride, searchStartOverride } = {}) => {
  const targets = targetsOverride || getBookingTargets(config)
  let outcome
  const planned = targetsOverride?.[0]
  let selection = planned ? { sport: planned.sport, location: planned.location, courtId: planned.courtId, hour: planned.hours[0], courtType: planned.courtType[0], date: config.date } : undefined
  const report = status => {
    outcome = status
    reportBookingResult(status, { leg, accountId: config.bookingAccount || 'main', accountName: config.account.name || config.bookingAccount || 'main', selection })
  }
  if (config.consecutiveRun) report('started')
  const polling = normalizePolling(config.polling)
  const searchStart = searchStartOverride ?? parseSearchStart(process.env.TENNIS_SEARCH_START_AT)
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  const HEADED_MODE = process.argv.includes('--headed')
  const DEBUG_MODE = process.argv.includes('--debug')
  const captchaOptions = { headed: HEADED_MODE, debug: DEBUG_MODE, ai: config.ai }
  const debugLog = (message) => {
    if (DEBUG_MODE) console.log(`${dayjs().format()} - [debug][booking] ${message}`)
  }
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching ${[...new Set(targets.map(target => target.sport))].join(' → ')}`)
  let browser
  debugLog(`mode=${DRY_RUN_MODE ? 'dry-run' : 'real'} browser=${HEADED_MODE ? 'headed' : 'headless'} captchaAI=${config.ai?.enable === false ? 'disabled' : 'enabled'}`)
  let page
  let context
  const openSession = async () => {
    if (context) await context.close()
    // One isolated account context, with room for a read-only spare search tab.
    context = await browser.newContext()
    page = await context.newPage()
    page.setDefaultTimeout(90000)

    if (DEBUG_MODE) page.on('pageerror', error => debugLog(`page-error role=booking message=${JSON.stringify(error.message)}`))
    const account = {
      email: config.account?.email || process.env.ACCOUNT_EMAIL,
      password: config.account?.password || process.env.ACCOUNT_PASSWORD,
    }
    await authenticatePage(page, account, captchaOptions, 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
    console.log(`${dayjs().format()} - User connected (booking account)`)
  }

  let canAbortBooking = false
  let finished = false
  let failed = false
  let windowExpired = false
  const reportWindowExpired = () => {
    if (windowExpired) return
    windowExpired = true
    console.log(`${dayjs().format()} - Search window expired; review opening time and availability using the search log`)
    if (process.send && process.connected) process.send({ type: 'tennis-search-expired' })
  }
  try {
    browser = await chromium.launch({ headless: !HEADED_MODE, slowMo: HEADED_MODE ? 250 : 0, timeout: 90000 })
    console.log(`${dayjs().format()} - Browser started`)
    await openSession()

    const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
    const searchUrl = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!'
    const warmup = searchStart > Date.now() ? prepareOpeningAgenda : prepareBookingTarget
    let prepared = await warmup(page, {
      target: targets[0],
      date, polling, captchaOptions, searchUrl,
    })
    console.log(`${dayjs().format()} - Primary ${prepared.agenda ? 'agenda' : 'search form'} ready with booking account; waiting for opening`)
    if (prepared.agenda && Date.now() > searchStart - 60000) console.warn(`${dayjs().format()} - Agenda warmup finished less than one minute before opening; check startup/login latency`)

    console.log(`${dayjs().format()} - Connected; search starts at ${new Date(searchStart).toISOString()}${polling ? `, interval ${polling.intervalSeconds}s, window ${polling.durationSeconds}s` : ''}`)
    locationsLoop:
    for await (const { target, attempt, deadline, finalFallback } of searchAttempts(targets, polling, searchStart)) {
      if (finalFallback) reportWindowExpired()
      const { sport, location: requestedLocation, priority } = target
      const logLocation = process.env.GITHUB_ACTIONS ? `priority ${priority + 1}` : requestedLocation
      console.log(`${dayjs().format()} - Search ${sport} at ${logLocation} (priority ${priority + 1}, attempt ${attempt})`)
      const search = (searchDeadline, priceTypes) => searchBookingTarget(page, {
        target, date, deadline: searchDeadline, polling, priceTypes, captchaOptions, debugLog,
        searchUrl, prepared,
      })
      let result
      try { result = await search(deadline, config.priceType) } catch (error) {
        if (deadline && Date.now() >= deadline && error.name === 'TimeoutError') {
          debugLog('search-deadline-reached during loading')
          continue
        }
        throw error
      }
      page = prepared?.activePage ?? page
      if (!prepared?.agenda) prepared = undefined
      if (deadline && Date.now() >= deadline) continue
      if (!result.dateSelectable) {
        console.log(`${dayjs().format()} - Requested date not yet selectable for ${logLocation}`)
        continue
      }
      const candidate = result.candidates[0]
      if (!candidate) {
        console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
        continue
      }

      selection = { sport, location: result.location, courtId: candidate.courtId, hour: candidate.hour, courtType: candidate.courtType, date: date.format('DD/MM/YYYY') }
      const selectedHour = candidate.hour
      debugLog(`slot-selected role=booking date=${date.format('YYYY-MM-DD')} hour=${candidate.hour} courtId=${candidate.courtId} priceType=${candidate.priceType}`)
      canAbortBooking = true
      await clickBookingCandidate(page, result.location, candidate)

      page.setDefaultTimeout(90000)
      await waitForStep(page, '.order-steps-infos h2 >> text="1 / 3 - Validation du court"', captchaOptions)

      for (const [i, player] of config.players.entries()) {
        if (i > 0) {
          await page.click('.addPlayer')
        }
        await page.waitForSelector(`[name="player${i + 1}"]`)
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
        debugLog(`player-filled index=${i + 1}`)
      }

      await page.keyboard.press('Enter')
      debugLog('player-step-submitted')

      await waitForStep(page, '.order-steps-infos h2 >> text="2 / 3 - Mode de paiement"', captchaOptions)
      await page.waitForSelector('.priceTable')

      const paymentSummary = await page.locator('.priceTable').innerText()
      const isFreeBooking = paymentSummary.includes('Gratuité')
      debugLog(`payment-step-ready free=${isFreeBooking} summary=${JSON.stringify(paymentSummary.replace(/\s+/g, ' ').trim())}`)

      if (isFreeBooking) console.log(`${dayjs().format()} - Free price detected`)
      const paymentSubmit = await preparePayment(page, { free: isFreeBooking })
      debugLog(`payment-card-selected mode=${isFreeBooking ? 'free' : 'existingTicket'} next-step-enabled=true`)

      if (DRY_RUN_MODE) {
        console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
        if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
        console.log('----- DRY RUN END -----')
        console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

        await page.click('#previous')
        const [cancelResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/tennis/rest/abortBooking') && response.request().method() === 'POST'),
          page.click('#btnCancelBooking'),
        ])
        if (!cancelResponse.ok()) throw new Error('Dry-run cancellation failed')
        canAbortBooking = false
        debugLog(`dry-run-cancelled status=${cancelResponse.status()}`)
        finished = true
        report('dry-run-cancelled')

        break locationsLoop
      }

      report('submitted')
      canAbortBooking = false
      await paymentSubmit.click()
      debugLog('payment-step-submitted')

      await page.waitForSelector('.confirmReservation')
      debugLog('reservation-confirmation-visible')
      finished = true
      report('confirmed')

      // Extract reservation details
      const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
      const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
      const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

      if (!process.env.GITHUB_ACTIONS) {
        console.log(`${dayjs().format()} - Réservation faite : ${address}`)
        console.log(`pour le ${dateStr}`)
        console.log(`sur le ${court}`)
      } else {
        console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
      }

      const [day, month, year] = [date.date(), date.month() + 1, date.year()]
      const hourMatch = dateStr.match(/(\d{2})h/)
      const hour = hourMatch ? Number(hourMatch[1]) : 12
      const start = [year, month, day, hour, 0]
      const duration = { hours: 1, minutes: 0 }
      const event = {
        start,
        duration,
        title: sport === 'padel' ? 'Réservation Padel' : 'Réservation Tennis',
        description: `Court: ${court}\nAdresse: ${address}`,
        location: address,
        status: 'CONFIRMED',
      }

      const createdEvent = createEvent(event)
      if (createdEvent.error) {
        console.log('ICS creation error:', createdEvent.error)
        process.exitCode = 1

        break
      }

      const { value } = createdEvent
      if (!process.env.GITHUB_ACTIONS) {
        writeFileSync(config.consecutiveRun ? `event-${leg + 1}.ics` : 'event.ics', value)
      }
      if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(Buffer.from(value, 'utf8'), 'event.ics',
          `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
            domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
            topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
          })
      }

      break
    }
    if (polling && !finished) reportWindowExpired()
  } catch (e) {
    console.log(e)
    failed = true
    process.exitCode = 1
    // Release only this run's temporary hold, never a submitted reservation.
    if (canAbortBooking) {
      try {
        if (!page || page.isClosed()) throw new Error('Booking session is closed', { cause: e })
        const response = await page.request.post('https://tennis.paris.fr/tennis/rest/abortBooking', { timeout: 10000 })
        if (!response.ok()) report('cleanup-unverified')
        console.log(response.ok() ? 'Pending booking abandoned after failure' : 'Could not abandon the pending booking; check your account')
      } catch {
        report('cleanup-unverified')
        console.log('Could not abandon the pending booking; check your account')
      }
    }
    if (page && !page.isClosed()) {
      // Diagnostics must not prevent cleanup, or overwrite another leg's screenshot.
      try {
        mkdirSync('img', { recursive: true })
        const path = config.consecutiveRun ? `img/failure-${leg + 1}.png` : 'img/failure.png'
        const screenshot = await page.screenshot({ path })
        debugLog(`failure-screenshot=${path} title=${JSON.stringify(await page.title())}`)
        if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
          domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
          topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
        })
      } catch (error) { console.log('Failure diagnostics unavailable:', error.message) }
    }
  } finally {
    try { await browser?.close() } catch (error) {
      failed = true
      process.exitCode = 1
      console.log('Browser cleanup failed:', error.message)
    }
  }
  if (outcome === 'started') report(failed ? 'failed' : 'unavailable')
  return { status: outcome || (failed ? 'failed' : 'unavailable'), selection }
}

const release = process.send ? () => {} : acquireOperationLock(bookingJobOptions().stateDirectory)
try {
  if (!Array.isArray(config.bookingAccounts)) config.account = { ...config.account, email: config.account?.email || process.env.ACCOUNT_EMAIL, password: config.account?.password || process.env.ACCOUNT_PASSWORD }
  const request = Object.fromEntries(VARIABLE_CONFIG_KEYS.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]))
  request.date ||= dayjs().add(6, 'days').format('DD/MM/YYYY')
  const fullConfig = buildBookingConfig(config, request)

  const settings = (id, players) => {
    const profile = resolveBookingProfile(config, id)
    return { ...fullConfig, account: profile.account, priceType: profile.priceType, bookingAccount: id, players, consecutiveRun: !!fullConfig.consecutive }
  }
  if (!fullConfig.consecutive) await bookTennis(settings(fullConfig.bookingAccount || 'main', fullConfig.players))
  else {
    const next = fullConfig.consecutive
    const profiles = [[fullConfig.bookingAccount || 'main', fullConfig.players], [next.bookingAccount, next.players]]
    const targets = getBookingTargets(fullConfig)
    console.log(`Parallel consecutive booking: independent sessions for ${targets[0].hours[0]}h and ${consecutiveLegTargets(targets, 1)[0].hours[0]}h`)
    const results = await runConsecutiveLegs(leg => {
      const [id, players] = profiles[leg]
      return bookTennis(settings(id, players), { leg, targetsOverride: consecutiveLegTargets(targets, leg) })
    })
    const statuses = results.map(result => result.status === 'fulfilled' ? result.value.status : 'interrupted')
    if (statuses.every(status => ['confirmed', 'dry-run-cancelled'].includes(status))) console.log('Both consecutive hours completed successfully')
    else {
      console.log(`Consecutive booking incomplete: first hour ${statuses[0]}; second hour ${statuses[1]}. Every confirmed hour is retained; do not replay this request.`)
      if (statuses.some(status => status !== 'unavailable')) process.exitCode = 1
    }
  }
} finally { release() }
