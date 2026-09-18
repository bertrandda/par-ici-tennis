import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { readCreditsPage, readProfileCredits, listCredits, CREDITS_URL } from '../lib/credits.js'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser.close() })
const book = contents => `<div id="bookingBook"><div class="title">Etat des carnets</div><div id="reservationAccordion">${contents}</div></div>`
const panel = (heading, details = '') => `<div class="panel"><div class="panel-heading"><h4><a><h4>${heading}</h4></a></h4></div><div class="panel-body">${details}</div></div>`
const empty = book('<div class="title">Vous n’avez pas de carnets de réservation</div>')
const full = book(panel('Tarif plein - Court couvert : <span>5 h</span>', '<div>1 h - solde recrédit</div><div>4 h - solde achat</div>'))
const accounts = { bookingAccounts: [
  { name: 'Roger Federer', email: 'roger@example.test', password: 'private', priceType: ['Gratuité'] },
  { name: 'Rafael Nadal', email: 'rafael@example.test', password: 'private', priceType: ['Tarif plein'] },
], monitoringAccount: { email: 'monitor@example.test', password: 'private' } }
const fixture = async (t, html) => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setContent(html)
  return page
}

test('credit total is read once, excluding purchase and recredit breakdown', async t => {
  const page = await fixture(t, full)
  assert.deepEqual(await readCreditsPage(page), [{ label: 'Tarif plein - Court couvert', priceType: 'Tarif plein', courtType: 'Couvert', hours: 5 }])
})

test('tariffs and court types remain separate, including decimal and zero balances', async t => {
  const page = await fixture(t, book(panel('Tarif réduit - Court découvert : 2,5\u00a0h') + panel('Tarif plein - Court couvert : 0 h')))
  const balances = await readCreditsPage(page)
  assert.deepEqual(balances.map(({ priceType, courtType, hours }) => ({ priceType, courtType, hours })), [
    { priceType: 'Tarif réduit', courtType: 'Découvert', hours: 2.5 },
    { priceType: 'Tarif plein', courtType: 'Couvert', hours: 0 },
  ])
})

test('only an explicit empty carnet state means no credits', async t => {
  const page = await fixture(t, empty)
  assert.deepEqual(await readCreditsPage(page), [])
  for (const html of ['<h1>Connexion</h1>', '<input id="li-antibot-answer">', book(''), book(panel('Tarif plein - Court couvert : ? h')), full + full, book(panel('Tarif plein - Court couvert : 5 h') + panel('Tarif plein - Court couvert : 3 h'))]) {
    await page.setContent(html)
    await assert.rejects(readCreditsPage(page))
  }
})

test('all profiles are isolated from monitoring, and an error never becomes zero', async () => {
  const seen = []
  const result = await listCredits({ config: accounts, all: true }, async ({ config }) => {
    seen.push(config.bookingAccount)
    assert.equal(config.account.email, accounts.bookingAccounts[seen.length - 1].email)
    if (seen.length === 1) throw new Error('sensitive private authentication details')
    return [{ hours: 5 }]
  })
  assert.deepEqual(seen, ['Roger Federer', 'Rafael Nadal'])
  assert.equal(result.accounts[0].status, 'error')
  assert.equal(Object.hasOwn(result.accounts[0], 'balances'), false)
  assert.equal(result.accounts[1].balances[0].hours, 5)
  assert.doesNotMatch(JSON.stringify(result), /private|@example|password|defaultPlayers/)
})

test('named/default/legacy accounts work; free accounts do not require credits', async () => {
  const result = await listCredits({ config: accounts }, async () => [])
  assert.equal(result.accounts[0].requiresCredits, false)
  await listCredits({ config: accounts, account: 'rafael nadal' }, async ({ config }) => {
    assert.equal(config.bookingAccount, 'Rafael Nadal')
    return []
  })
  await listCredits({ config: { account: accounts.bookingAccounts[0], bookingAccounts: { second: accounts.bookingAccounts[1] } }, account: 'second' }, async ({ config }) => {
    assert.equal(config.account.email, 'rafael@example.test')
    return []
  })
  await assert.rejects(listCredits({ config: accounts, all: true, account: 'Rafael Nadal' }), /mutually exclusive/)
  await assert.rejects(listCredits({ config: accounts, account: 'missing' }), /Unknown/)
})

test('credit page extraction performs only a GET and no payment or reservation submission', async () => {
  const requests = []
  // Intercept the new session at the browser context boundary, retaining the production reader.
  const original = chromium.launch
  chromium.launch = async () => {
    const context = await browser.newContext()
    await context.route('**/*', async route => {
      requests.push({ url: route.request().url(), method: route.request().method() })
      const url = route.request().url()
      await route.fulfill({ contentType: 'text/html', body: url === CREDITS_URL ? full : '<button id="button_suivi_inscription">Login</button><input id="username"><input id="password"><div id="form-login"><button>Login</button></div><div class="main-informations">Connected</div>' })
    })
    return { newContext: async () => context, close: () => context.close() }
  }
  try {
    const result = await readProfileCredits({ config: { ...accounts, bookingAccount: 'Rafael Nadal' } })
    assert.equal(result[0].hours, 5)
    assert.equal(requests.length, 2)
    assert.ok(requests.every(request => request.method === 'GET'))
    assert.equal(requests[1].url, CREDITS_URL)
  } finally { chromium.launch = original }
})

test('CLI rejects reservation mutation flags for credits', () => {
  for (const flag of ['--confirm', '--id', '--query']) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/tennis.js', 'credits', 'list', flag], { stdio: 'pipe' }), error => /Unexpected/.test(error.stderr.toString()))
  }
})
