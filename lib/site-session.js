import { chromium } from 'playwright'
import { loadAccountConfig, resolveBookingProfile } from './config.js'
import { waitForStep } from './captcha.js'

export const SITE_ROOT = 'https://tennis.paris.fr/tennis/'
export const siteUrl = query => `${SITE_ROOT}jsp/site/Portal.jsp?${query}`

export const authenticatePage = async (page, account, options = {}, startUrl = siteUrl('page=tennis&view=start&full=1')) => {
  if (!account?.email || !account?.password) throw new Error('Account credentials are required')
  await page.goto(startUrl)
  await page.click('#button_suivi_inscription')
  await page.fill('#username', account.email)
  await page.fill('#password', account.password)
  await page.click('#form-login >> button')
  await waitForStep(page, '.main-informations', options)
}

export const withSitePage = async (operation, { headed = false, authenticate = false, config, ...options } = {}) => {
  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 250 : 0, timeout: 90000 })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    if (authenticate) {
      const accountConfig = config || loadAccountConfig()
      const account = Array.isArray(accountConfig.bookingAccounts) ? resolveBookingProfile(accountConfig, accountConfig.bookingAccount).account : accountConfig.account
      await authenticatePage(page, { email: account?.email || process.env.ACCOUNT_EMAIL, password: account?.password || process.env.ACCOUNT_PASSWORD }, { ...options, headed, ai: accountConfig.ai })
    }
    return await operation(page)
  } finally {
    await browser.close()
  }
}
