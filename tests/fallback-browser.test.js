import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const names = { padel: 'Padel Jules Ladoumègue', tennis: 'Edouard Pailleron' }
const ids = { padel: 4830, tennis: 4400 }
const catalog = { features: Object.entries(names).map(([sport, name], i) => ({ properties: {
  general: { _id: i + 1, _nomSrtm: name, _arrondissement: 19 },
  courts: [{ _airId: ids[sport], _airNom: sport === 'padel' ? 'Padel n°01' : 'Court n°01', _formattedAirNum: 1 }, { _airId: 9999, _airNom: sport === 'padel' ? 'Padel n°02' : 'Court n°02', _formattedAirNum: 2 }],
} })) }

// Exercise the real entry point against a local site, with no account or network service.
const runFixture = async (t, { padel = true, tennis = true, dryRun = false, brokenHold = false, uncertainSubmit = false, padelPrice = 'Gratuité', polling, padelAfter = 0, searchDelay = 0, renderDelay = 0, startDelay = 0, dualAccount = false, bookingPadel = true, consecutive = false, secondAvailable = true, secondUncertain = false, secondBrokenHold = false, explicitPlayers, secondMatchesMonitoring = false, secondOtherCourt = false, secondPrice = 'Tarif plein', firstAvailable = true, firstBrokenHold = false, firstUncertain = false, overlap = false, firstBookingLoginFailure = false, failedAbort = false, accountArray = false, courtSelection, courtType = ['Couvert'], lateAgenda = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'tennis-browser-fallback-'))
  const observed = { searches: [], holds: [], holdTimes: [], submissions: [], aborts: 0, searchTimes: [], loginAt: null, logins: [], loginCookies: [], searchAccounts: [], holdAccounts: [], submissionAccounts: [], holdHours: [], partners: [], paymentModes: [], abortAccounts: [], submissionHours: [], firstPaymentWaitedForSecond: false }
  let releaseFirstPayment
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const sport = url.searchParams.get('sport') || 'padel'
    const hour = url.searchParams.get('hour') || '20'
    const account = req.headers.cookie?.includes('account=monitoring') ? 'monitoring' : req.headers.cookie?.includes('account=second') ? 'second' : 'booking'
    let html = ''
    if (url.pathname.endsWith('abortBooking')) { observed.aborts++; observed.abortAccounts.push(account); if (failedAbort) res.statusCode = 500; res.end('ok'); return }
    if (url.pathname === '/calendar') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(['20/09/2026', ...(Date.now() >= searchStart ? ['21/09/2026'] : [])].map(date => `<button type="button" dateiso="${date}" onclick="document.querySelector('#searchDate').value='${date}';this.parentElement.style.display='none'">${date}</button>`).join('')); return }
    if (url.pathname === '/login') {
      const loggedIn = url.searchParams.get('username') === 'monitor@example.invalid' ? 'monitoring' : url.searchParams.get('username') === 'second@example.invalid' ? 'second' : 'booking'
      observed.logins.push(loggedIn)
      observed.loginCookies.push(req.headers.cookie || '')
      res.setHeader('Set-Cookie', `account=${loggedIn}; Path=/; HttpOnly`)
      observed.loginAt = Date.now(); html = firstBookingLoginFailure && loggedIn === 'booking' ? '<div>Login failed</div>' : '<div class="main-informations">Connected</div>'
    }
    else if (url.searchParams.get('view') === 'start') html = '<button id="button_suivi_inscription">Login</button><form id="form-login" action="/login"><input id="username" name="username"><input id="password"><button>Connect</button></form>'
    else if (url.searchParams.get('page') === 'recherche' && url.pathname !== '/results') html = `<script>var tennis = ${JSON.stringify(catalog)};</script>
      <form action="/results"><input type="hidden" name="page" value="recherche"><input type="hidden" name="action" value="rechercher_creneau"><input class="tokens-input-text"><input type="hidden" name="sport" id="sport"><input id="searchDate" name="when" type="hidden" value="${lateAgenda ? '20/09/2026' : '21/09/2026'}">
      <div class="tokens-suggestions-list-element">${Object.entries(names).map(([kind, name]) => `<button type="button" onclick="document.querySelector('#sport').value='${kind}'">${name}</button>`).join('')}</div>
      <button type="button" id="when" onclick="document.querySelector('.date-picker').style.display='block';${lateAgenda ? 'document.querySelector(\'.date-picker\').innerHTML=\'&lt;div id=loadingComponent&gt;Loading&lt;/div&gt;\';fetch(\'/calendar\').then(r=>r.text()).then(html=>{document.querySelector(\'.date-picker\').innerHTML=html})' : ''}">Date</button>
      <div class="date-picker" style="display:none"><button type="button" dateiso="21/09/2026" onclick="this.parentElement.style.display='none'">21</button></div>
      <button id="rechercher">Search</button></form>`
    else if (url.pathname === '/results') {
      observed.searches.push(sport)
      observed.searchAccounts.push(account)
      observed.searchTimes.push(Date.now())
      html = (sport === 'padel' ? padel && (account !== 'booking' || bookingPadel) && observed.searches.filter(value => value === 'padel').length > padelAfter : tennis)
        ? `<div class="row tennis-court"><div class="price-description">${account !== 'booking' ? secondPrice : sport === 'padel' ? padelPrice : 'Gratuité'}<br>Couvert</div>${firstAvailable ? `<a courtid="${ids[sport]}" datedeb="2026/09/21 20:00:00" href="/hold?sport=${sport}&hour=20">Book</a>` : ''}${consecutive && secondAvailable ? `<a courtid="${ids[sport]}" datedeb="2026/09/21 21:00:00" href="/hold?sport=${sport}&hour=21">Book next hour</a>` : ''}</div>`
        : '<div class="no-result">No slots</div>'
    } else if (url.pathname === '/hold' || url.pathname === '/partners') {
      if (url.pathname === '/hold') { observed.holds.push(sport); observed.holdTimes.push(Date.now()); observed.holdAccounts.push(account); observed.holdHours.push(hour) }
      html = brokenHold || (firstBrokenHold && hour === '20') || (secondBrokenHold && hour === '21') ? '<div>Hold failed</div>' : `<div class="order-steps-infos"><h2>1 / 3 - Validation du court</h2></div>
        <form action="/payment"><input type="hidden" name="hour" value="${hour}"><input type="hidden" name="sport" value="${sport}"><input name="player1"><input name="player1"><button>Continue</button></form>
        <button id="btnCancelBooking" onclick="fetch('/tennis/rest/abortBooking',{method:'POST'})">Cancel</button>`
    } else if (url.pathname === '/payment') {
      observed.partners.push({account, hour, players: url.searchParams.getAll('player1')})
      html = `<div class="order-steps-infos"><h2>2 / 3 - Mode de paiement</h2></div>
      <div class="priceTable"><button type="button" class="price-item" paymentMode="${account === 'booking' ? 'free' : 'existingTicket'}" onclick="document.querySelector('#submit').classList.remove('disabled');document.querySelector('#submit').disabled=false">${account === 'booking' ? 'Gratuité' : 'J’utilise 1 heure de mon carnet en ligne — Tarif plein'}</button></div>
      <a id="previous" href="/partners?sport=${sport}&hour=${hour}">Previous</a>
      <div class="step-two"><form action="/confirm"><input type="hidden" name="sport" value="${sport}"><input type="hidden" name="hour" value="${hour}">${account === 'booking' ? '' : '<input type="hidden" name="paymentMode" value="existingTicket">'}<button id="submit" class="disabled" disabled>Etape suivante</button></form></div>`
    } else if (url.pathname === '/confirm') {
      observed.paymentModes.push(url.searchParams.get('paymentMode'))
      observed.submissions.push(sport)
      observed.submissionHours.push(hour)
      if (hour === '21' && releaseFirstPayment) { observed.firstPaymentWaitedForSecond = true; releaseFirstPayment() }
      observed.submissionAccounts.push(account)
      html = uncertainSubmit || (firstUncertain && hour === '20') || (secondUncertain && hour === '21') ? '<div>No confirmation received</div>' : `<div class="confirmReservation">Confirmed</div><div class="address">${names[sport]}</div><div class="date">21/09/2026 à ${hour}h</div><div class="court">${sport} 1</div>`
    }
    if (url.pathname === '/results' && secondOtherCourt) html += `<div class="row tennis-court"><div class="price-description">Tarif plein<br>Couvert</div><a courtid="9999" datedeb="2026/09/21 21:00:00" href="/hold?sport=${sport}&hour=21">Other court</a></div>`
    if (url.pathname === '/results' && lateAgenda && url.searchParams.get('when') !== '21/09/2026') html = html.replaceAll('2026/09/21', '2026/09/20')
    if (url.pathname === '/results' && startDelay && !lateAgenda) html += `<div id="${names[sport].replaceAll(' ', '')}"><div class="date-picker refresh"><div class="date-item selected"><div dateiso="21/09/2026">21</div></div></div></div>`
    if (url.pathname === '/results' && lateAgenda) html += `<div id="${names[sport].replaceAll(' ', '')}"><div class="date-picker refresh"><div class="date-item selected"><div dateiso="20/09/2026">20</div></div>${Date.now() >= searchStart ? '<div class="date-item item-full"><div dateiso="21/09/2026">21</div></div>' : ''}</div></div>`
    if (url.pathname === '/results' && renderDelay) html = `<div id="loadingComponent">Loading</div><script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(html)} }, ${renderDelay})</script>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/payment' && hour === '20' && overlap && !observed.submissionHours.includes('21')) { releaseFirstPayment = () => res.end(html); return }
    if (url.pathname === '/results' && searchDelay) setTimeout(() => res.end(html), searchDelay)
    else res.end(html)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  // Only URLs and timeouts change; the selection, checkout, IPC and cancellation code stays intact.
  const source = readFileSync('index.js', 'utf8')
    .replaceAll('https://tennis.paris.fr', origin)
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${pathToFileURL(resolve(path)).href}'`)
    .replace('headed: HEADED_MODE, debug:', 'timeoutMs: 1000, headed: HEADED_MODE, debug:')
    .replaceAll('page.setDefaultTimeout(90000)', 'page.setDefaultTimeout(2000)')
  writeFileSync(join(root, 'index.mjs'), source)
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'))
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    account: { name: 'First', email: 'fixture@example.invalid', password: 'fixture', defaultPlayers: [{ firstName: 'Second', lastName: 'Player' }] },
    bookingAccounts: { second: { name: 'Second', email: secondMatchesMonitoring ? 'monitor@example.invalid' : 'second@example.invalid', password: 'second-fixture', priceType: ['Tarif plein'], defaultPlayers: [{ firstName: 'First', lastName: 'Player' }] } },
    consecutive: consecutive ? { bookingAccount: 'second' } : undefined, monitoringAccount: dualAccount ? { email: 'monitor@example.invalid', password: 'monitor-fixture' } : undefined, ai: { enable: false }, ntfy: { enable: false },
    sport: 'padel', date: '21/09/2026', locations: [names.padel], hours: ['20'], courtType, courtSelection, priceType: ['Gratuité'],
    players: explicitPlayers || (consecutive ? undefined : [{ firstName: 'Test', lastName: 'Partner' }]), polling, fallbacks: [{ sport: 'tennis', locations: [names.tennis] }],
  }))
  if (accountArray) {
    const stored = JSON.parse(readFileSync(configPath, 'utf8'))
    stored.bookingAccounts = [
      { ...stored.account, name: 'Roger Federer', priceType: stored.priceType },
      { ...stored.bookingAccounts.second, name: 'Rafael Nadal' },
      { name: 'Joueur invité', email: '', password: '', priceType: ['Tarif réduit'], defaultPlayers: [] },
    ]
    delete stored.account
    delete stored.priceType
    if (stored.consecutive) stored.consecutive.bookingAccount = 'Rafael Nadal'
    writeFileSync(configPath, JSON.stringify(stored))
  }
  const searchStart = Date.now() + startDelay
  const child = fork(join(root, 'index.mjs'), dryRun ? ['--dry-run'] : [], {
    cwd: root, silent: true, env: { ...process.env, TENNIS_CONFIG_PATH: configPath, NTFY_TOPIC: '', GITHUB_ACTIONS: '', TENNIS_SEARCH_START_AT: new Date(searchStart).toISOString() },
  })
  t.after(() => child.kill())
  let output = ''
  const outcomes = []
  const legOutcomes = []
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  child.on('message', message => { if (message.type === 'tennis-result' && !['started', 'failed', 'unavailable'].includes(message.status)) { outcomes.push(message.status); legOutcomes.push(message) } })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000)
  const [code] = await once(child, 'exit')
  clearTimeout(watchdog)
  return { ...observed, searchStart, outcomes, legOutcomes, consecutiveIcs: [1, 2].map(n => existsSync(join(root, `event-${n}.ics`)) ? readFileSync(join(root, `event-${n}.ics`), 'utf8') : ''), code, output, ics: existsSync(join(root, 'event.ics')) ? readFileSync(join(root, 'event.ics'), 'utf8') : '' }
}

test('available padel stops before the tennis fallback and produces a padel ICS', async t => {
  const result = await runFixture(t)
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel'])
  assert.deepEqual(result.submissions, ['padel'])
  assert.deepEqual(result.outcomes, ['submitted', 'confirmed'])
  assert.match(result.ics, /SUMMARY:Réservation Padel/)
})
test('missing padel falls back to tennis exactly once and produces a tennis ICS', async t => {
  const result = await runFixture(t, { padel: false })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'tennis'])
  assert.deepEqual(result.holds, ['tennis'])
  assert.deepEqual(result.submissions, ['tennis'])
  assert.match(result.ics, /SUMMARY:Réservation Tennis/)
})
test('incompatible padel price falls back and dry-run cancels tennis without submitting', async t => {
  const result = await runFixture(t, { padelPrice: 'Tarif plein', dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'tennis'])
  assert.deepEqual(result.holds, ['tennis'])
  assert.deepEqual(result.submissions, [])
  assert.equal(result.aborts, 1)
  assert.deepEqual(result.outcomes, ['dry-run-cancelled'])
})
test('no availability exhausts the choices without holding or submitting', async t => {
  const result = await runFixture(t, { padel: false, tennis: false })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'tennis'])
  assert.deepEqual(result.holds, [])
  assert.deepEqual(result.submissions, [])
  assert.deepEqual(result.outcomes, [])
})
test('an error after holding padel releases it and never attempts tennis', async t => {
  const result = await runFixture(t, { brokenHold: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.searches, ['padel'])
  assert.deepEqual(result.submissions, [])
  assert.equal(result.aborts, 1)
})
test('an uncertain padel confirmation never falls back or aborts the submitted booking', async t => {
  const result = await runFixture(t, { uncertainSubmit: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.searches, ['padel'])
  assert.deepEqual(result.submissions, ['padel'])
  assert.deepEqual(result.outcomes, ['submitted'])
  assert.equal(result.aborts, 0)
})


test('polling waits for delayed result rendering and finds padel on a later attempt', async t => {
  const result = await runFixture(t, { polling: { intervalSeconds: 2, durationSeconds: 8 }, padelAfter: 1, renderDelay: 250, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'padel'])
  assert.deepEqual(result.holds, ['padel'])
  assert.deepEqual(result.outcomes, ['dry-run-cancelled'])
  assert.ok(result.searchTimes[1] - result.searchTimes[0] >= 1800)
})
test('primary polling expires before a single tennis fallback sweep', async t => {
  const result = await runFixture(t, { polling: { intervalSeconds: 2, durationSeconds: 4 }, padel: false, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.searches.filter(value => value === 'tennis').length, 1)
  assert.ok(result.searches.slice(0, -1).every(value => value === 'padel'))
  assert.ok(result.searchTimes.at(-1) >= result.searchStart + 4000)
  assert.match(result.output, /Search window expired/)
  assert.deepEqual(result.outcomes, ['dry-run-cancelled'])
})
test('warmup loads the agenda before opening, then refreshes it at opening', async t => {
  const result = await runFixture(t, { startDelay: 2000, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.ok(result.loginAt < result.searchStart)
  assert.ok(result.searchTimes[0] < result.searchStart)
  assert.ok(result.searchTimes[1] >= result.searchStart)
  assert.equal(result.searches.length, 2)
  assert.ok(result.holdTimes.every(at => at >= result.searchStart))
})
test('a slow search finishes before another request starts', async t => {
  const result = await runFixture(t, { polling: { intervalSeconds: 2, durationSeconds: 10 }, padelAfter: 1, searchDelay: 2200, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'padel'])
  assert.ok(result.searchTimes[1] - result.searchTimes[0] >= 2200)
  assert.deepEqual(result.outcomes, ['dry-run-cancelled'])
})


test('a configured monitoring account is ignored by booking and one booking session performs the search and checkout', async t => {
  const result = await runFixture(t, { dualAccount: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.logins, ['booking'])
  assert.deepEqual(result.loginCookies, [''])
  assert.deepEqual(result.searchAccounts, ['booking'])
  assert.deepEqual(result.holdAccounts, ['booking'])
  assert.deepEqual(result.submissionAccounts, ['booking'])
  assert.deepEqual(result.outcomes, ['submitted', 'confirmed'])
})
test('dual-account dry-run holds and cancels only with the booking account', async t => {
  const result = await runFixture(t, { dualAccount: true, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.holdAccounts, ['booking'])
  assert.deepEqual(result.submissions, [])
  assert.equal(result.aborts, 1)
  assert.deepEqual(result.outcomes, ['dry-run-cancelled'])
})
test('a missing padel slot falls back to tennis in the same booking session', async t => {
  const result = await runFixture(t, { dualAccount: true, bookingPadel: false, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.searches, ['padel', 'tennis'])
  assert.deepEqual(result.searchAccounts, ['booking', 'booking'])
  assert.deepEqual(result.holds, ['tennis'])
  assert.deepEqual(result.holdAccounts, ['booking'])
  assert.deepEqual(result.loginCookies, [''])
})
test('unavailable courts are searched by the booking account without a hold', async t => {
  const result = await runFixture(t, { dualAccount: true, padel: false, tennis: false })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.logins, ['booking'])
  assert.deepEqual(result.holds, [])
})
test('a tariff mismatch keeps polling in the original booking session', async t => {
  const result = await runFixture(t, { dualAccount: true, padelPrice: 'Tarif plein', tennis: false, polling: { intervalSeconds: 2, durationSeconds: 6 } })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.logins, ['booking'])
  assert.ok(result.searchAccounts.length > 1)
  assert.ok(result.searchAccounts.every(account => account === 'booking'))
  assert.deepEqual(result.holds, [])
  assert.deepEqual(result.outcomes, [])
})


test('two consecutive hours use each account tariff and its default guest, with separate ICS files', async t => {
  const result = await runFixture(t, { consecutive: true, overlap: true })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.firstPaymentWaitedForSecond, true)
  assert.deepEqual(result.submissionHours, ['21', '20'])
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.deepEqual([...result.holdAccounts].sort(), ['booking', 'second'])
  assert.deepEqual(result.loginCookies, ['', ''])
  assert.deepEqual(result.partners.toSorted((a, b) => a.hour.localeCompare(b.hour)).map(row => row.players), [['Player', 'Second'], ['Player', 'First']])
  assert.deepEqual(result.paymentModes, ['existingTicket', null])
  assert.deepEqual(result.legOutcomes.toSorted((a, b) => a.leg - b.leg).map(row => [row.leg, row.status]), [[0, 'submitted'], [0, 'confirmed'], [1, 'submitted'], [1, 'confirmed']])
  for (const [i, ics] of result.consecutiveIcs.entries()) {
    const expected = new Date(2026, 8, 21, 20 + i).toISOString().replace(/[-:]/g, '').replace('.000', '')
    assert.ok(ics.includes(`DTSTART:${expected}`), ics)
  }
})
test('second booking can share monitoring credentials without a shared discovery session', async t => {
  const result = await runFixture(t, { consecutive: true, dualAccount: true, secondMatchesMonitoring: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual([...result.logins].sort(), ['booking', 'monitoring'])
  assert.deepEqual(result.loginCookies, ['', ''])
  assert.deepEqual([...result.submissionAccounts].sort(), ['booking', 'monitoring'])
})
test('a consecutive dry-run cancels both holds without submitting either payment', async t => {
  const result = await runFixture(t, { consecutive: true, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.equal(result.aborts, 2)
  assert.deepEqual(result.submissions, [])
  assert.deepEqual(result.outcomes, ['dry-run-cancelled', 'dry-run-cancelled'])
})
test('missing next hour preserves the first reservation while its independent leg may try fallback', async t => {
  const result = await runFixture(t, { consecutive: true, secondAvailable: false })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['booking'])
  assert.deepEqual(result.holdHours, ['20'])
  assert.equal(result.searches.filter(sport => sport === 'padel').length, 2)
  assert.equal(result.searches.filter(sport => sport === 'tennis').length, 1)
  assert.equal(result.aborts, 0)
  assert.match(result.output, /Consecutive booking incomplete/)
})
test('an uncertain second confirmation never cancels or retries the confirmed first hour', async t => {
  const result = await runFixture(t, { consecutive: true, secondUncertain: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.deepEqual(result.legOutcomes.toSorted((a, b) => a.leg - b.leg).map(row => [row.leg, row.status]), [[0, 'submitted'], [0, 'confirmed'], [1, 'submitted']])
  assert.equal(result.aborts, 0)
})
test('second checkout failure releases only its hold and keeps the confirmed first hour', async t => {
  const result = await runFixture(t, { consecutive: true, secondBrokenHold: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['booking'])
  assert.equal(result.aborts, 1)
})
test('consecutive fallback binds the second hour to the tennis court actually selected', async t => {
  const result = await runFixture(t, { consecutive: true, padel: false })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.submissions, ['tennis', 'tennis'])
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
})
test('an explicit guest overrides only the first account default for this request', async t => {
  const result = await runFixture(t, { consecutive: true, explicitPlayers: [{firstName: 'Other', lastName: 'Guest'}] })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.partners.toSorted((a, b) => a.hour.localeCompare(b.hour)).map(row => row.players), [['Guest', 'Other'], ['Player', 'First']])
})


test('the independent second leg may reserve its requested hour on another court', async t => {
  const result = await runFixture(t, { consecutive: true, secondAvailable: false, secondOtherCourt: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.deepEqual([...result.submissionAccounts].sort(), ['booking', 'second'])
})
test('the second account cannot use the first account free tariff', async t => {
  const result = await runFixture(t, { consecutive: true, secondPrice: 'Gratuité' })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['booking'])
})
test('no availability still warms both independent booking sessions without holds', async t => {
  const result = await runFixture(t, { consecutive: true, padel: false, tennis: false })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual([...result.logins].sort(), ['booking', 'second'])
  assert.deepEqual(result.holds, [])
})


test('only the second hour is available while the first leg exhausts its fallback', async t => {
  const result = await runFixture(t, { consecutive: true, firstAvailable: false })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.holdHours, ['21'])
  assert.deepEqual(result.submissionAccounts, ['second'])
  assert.equal(result.searches.filter(sport => sport === 'padel').length, 2)
  assert.equal(result.searches.filter(sport => sport === 'tennis').length, 1)
  assert.equal(result.aborts, 0)
  assert.equal(result.consecutiveIcs[0], '')
  assert.match(result.consecutiveIcs[1], /SUMMARY:Réservation Padel/)
})
test('first checkout failure releases only its hold while the second confirms independently', async t => {
  const result = await runFixture(t, { consecutive: true, firstBrokenHold: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['second'])
  assert.deepEqual(result.abortAccounts, ['booking'])
  assert.match(result.consecutiveIcs[1], /SUMMARY:Réservation Padel/)
})
test('an uncertain first confirmation never cancels or blocks the confirmed second hour', async t => {
  const result = await runFixture(t, { consecutive: true, firstUncertain: true, overlap: true })
  assert.equal(result.code, 1, result.output)
  assert.equal(result.firstPaymentWaitedForSecond, true)
  assert.deepEqual(result.submissionHours, ['21', '20'])
  assert.equal(result.aborts, 0)
  assert.deepEqual(result.legOutcomes.toSorted((a, b) => a.leg - b.leg).map(row => [row.leg, row.status]), [[0, 'submitted'], [1, 'submitted'], [1, 'confirmed']])
})
test('a parallel dry-run with a first-leg failure still cancels the successful second hold', async t => {
  const result = await runFixture(t, { consecutive: true, dryRun: true, firstBrokenHold: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissions, [])
  assert.deepEqual([...result.abortAccounts].sort(), ['booking', 'second'])
  assert.deepEqual(result.legOutcomes.map(row => [row.leg, row.status]), [[1, 'dry-run-cancelled']])
})


test('first booking login failure does not block the independently connected second account', async t => {
  const result = await runFixture(t, { consecutive: true, firstBookingLoginFailure: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['second'])
  assert.deepEqual(result.holdHours, ['21'])
  assert.equal(result.aborts, 0)
  assert.match(result.consecutiveIcs[1], /SUMMARY:Réservation Padel/)
})
test('unverified cleanup on one account cannot erase the other account confirmation', async t => {
  const result = await runFixture(t, { consecutive: true, firstBrokenHold: true, failedAbort: true })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.submissionAccounts, ['second'])
  assert.deepEqual(result.abortAccounts, ['booking'])
  assert.deepEqual(result.legOutcomes.toSorted((a, b) => a.leg - b.leg).map(row => [row.leg, row.status]), [[0, 'cleanup-unverified'], [1, 'submitted'], [1, 'confirmed']])
})
test('parallel bookings each own a polling window before their tennis fallback', async t => {
  const result = await runFixture(t, { consecutive: true, dualAccount: true, padel: false, dryRun: true, polling: { intervalSeconds: 2, durationSeconds: 4 } })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.searches.filter(sport => sport === 'tennis').length, 2)
  assert.ok(result.searchTimes[result.searches.indexOf('tennis')] >= result.searchStart + 4000)
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.equal(result.aborts, 2)
  assert.deepEqual(result.submissions, [])
})


test('array accounts book in parallel by name with the implicit first account snapshotted', async t => {
  const result = await runFixture(t, { accountArray: true, consecutive: true, overlap: true, dualAccount: true })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.firstPaymentWaitedForSecond, true)
  assert.deepEqual([...new Set(result.legOutcomes.map(row => row.accountId))].sort(), ['Rafael Nadal', 'Roger Federer'])
  assert.deepEqual(result.submissionHours, ['21', '20'])
  assert.equal(result.aborts, 0)
})
test('array accounts preserve second-only success and independent dry-run cleanup', async t => {
  const result = await runFixture(t, { accountArray: true, consecutive: true, dryRun: true, firstAvailable: false })
  assert.equal(result.code, 1, result.output)
  assert.deepEqual(result.holdHours, ['21'])
  assert.deepEqual(result.submissions, [])
  assert.deepEqual(result.abortAccounts, ['second'])
  assert.deepEqual(result.legOutcomes.map(row => [row.accountId, row.status]), [['Rafael Nadal', 'dry-run-cancelled']])
})
test('array accounts also work for a single booking with no legacy root account', async t => {
  const result = await runFixture(t, { accountArray: true, dryRun: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.holdAccounts, ['booking'])
  assert.equal(result.aborts, 1)
})

test('both booking accounts preload agendas and wait for opening before holding slots', async t => {
  const result = await runFixture(t, { startDelay: 3000, consecutive: true, dryRun: true })
  assert.equal(result.code, 0, result.output)
  const before = result.searchTimes.flatMap((at, i) => at < result.searchStart ? [result.searchAccounts[i]] : [])
  const after = result.searchTimes.flatMap((at, i) => at >= result.searchStart ? [result.searchAccounts[i]] : [])
  assert.deepEqual(before.sort(), ['booking', 'second'])
  assert.deepEqual(after.sort(), ['booking', 'second'])
  assert.ok(result.holdTimes.every(at => at >= result.searchStart))
  assert.equal(result.aborts, 2)
  assert.deepEqual(result.submissions, [])
})

test('fast any mode hands checkout to both warm spare tabs when the new date appears disabled', async t => {
  const result = await runFixture(t, { startDelay: 4000, consecutive: true, dryRun: true, lateAgenda: true, courtSelection: 'first', courtType: 'any' })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual([...result.holdHours].sort(), ['20', '21'])
  assert.deepEqual([...result.holdAccounts].sort(), ['booking', 'second'])
  assert.ok(result.holdTimes.every(at => at >= result.searchStart))
  assert.equal(result.aborts, 2)
  assert.deepEqual(result.submissions, [])
  assert.equal(result.searches.length, 6)
})
