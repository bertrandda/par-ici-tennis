import { withSitePage, siteUrl } from './site-session.js'
import { loadAccountConfig, describeBookingAccounts, resolveBookingProfile, assertBookingCredentials } from './config.js'

export const CREDITS_URL = siteUrl('page=profil&view=carnet_reservation')
const normalize = text => text.replace(/\s+/g, ' ').trim()

export const readCreditsPage = async page => {
  const book = page.locator('#bookingBook')
  const accordion = book.locator('#reservationAccordion')
  if (await book.count() !== 1 || !await book.isVisible() || await accordion.count() !== 1
    || await book.locator(':scope > .title').count() !== 1
    || normalize(await book.locator(':scope > .title').innerText()) !== 'Etat des carnets') {
    throw new Error('Credit balance page unavailable or unrecognized')
  }
  const panels = accordion.locator(':scope > .panel')
  const count = await panels.count()
  const empty = /Vous n[’']avez pas de carnets de réservation/.test(await accordion.innerText())
  if (!count) {
    if (empty) return []
    throw new Error('Credit balance page has no recognizable balance or empty state')
  }
  if (empty) throw new Error('Conflicting credit balance states')
  const balances = []
  const labels = new Set()
  for (const panel of await panels.all()) {
    // Only the panel heading contains the total. Purchase/recredit entries are its breakdown.
    const heading = panel.locator(':scope > .panel-heading')
    if (await heading.count() !== 1) throw new Error('Unrecognized credit balance heading')
    const match = normalize(await heading.innerText()).match(/^(Tarif plein|Tarif réduit)\s*-\s*Court (couvert|découvert)\s*:\s*(\d+(?:[,.]\d+)?)\s*h$/i)
    if (!match) throw new Error('Unrecognized credit balance heading')
    const priceType = /plein/i.test(match[1]) ? 'Tarif plein' : 'Tarif réduit'
    const courtType = /découvert/i.test(match[2]) ? 'Découvert' : 'Couvert'
    const hours = Number(match[3].replace(',', '.'))
    const label = `${priceType} - Court ${courtType.toLocaleLowerCase('fr')}`
    if (!Number.isFinite(hours) || labels.has(label)) throw new Error('Invalid or duplicate credit balance')
    labels.add(label)
    balances.push({ label, priceType, courtType, hours })
  }
  return balances
}

export const readProfileCredits = options => withSitePage(async page => {
  await page.goto(CREDITS_URL)
  return readCreditsPage(page)
}, { ...options, authenticate: true })

export const listCredits = async ({ config = loadAccountConfig(), account, all = false, headed = false } = {}, readProfile = readProfileCredits) => {
  if (all && account !== undefined) throw new Error('--all and --account are mutually exclusive')
  const profiles = all
    ? describeBookingAccounts(config).map(item => resolveBookingProfile(config, item.id))
    : [resolveBookingProfile(config, account)]
  const accounts = []
  // Fresh authenticated sessions, sequentially, so each balance belongs to its selected profile.
  for (const profile of profiles) {
    const result = { id: profile.id, name: profile.name, priceType: profile.priceType }
    try {
      assertBookingCredentials(profile)
      const balances = await readProfile({ headed, config: { ...config, bookingAccount: profile.id, account: profile.account, priceType: profile.priceType } })
      accounts.push({ ...result, status: 'ok', fetchedAt: new Date().toISOString(), requiresCredits: !profile.priceType.includes('Gratuité'), balances })
    } catch {
      // Authentication errors may contain page contents; never expose these through account JSON.
      accounts.push({ ...result, status: 'error', error: 'Unable to read credits: check credentials, CAPTCHA or the credit page layout. No balance was inferred.' })
    }
  }
  return { source: 'Paris Tennis', accounts }
}
