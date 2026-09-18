import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { chromium } from 'playwright'
import dayjs from 'dayjs'
import { prepareOpeningAgenda, searchBookingTarget } from '../lib/booking-search.js'
import { searchAttempts } from '../lib/search-window.js'

const location = 'Example Club'
const dateKey = '21/09/2026'
const target = { sport: 'tennis', location, hours: ['20'], courtType: ['Couvert'], courtNumbers: [], priority: 0 }
const catalog = { features: [{ properties: { general: { _id: 1, _nomSrtm: location, _arrondissement: 1 }, courts: [{ _airId: 42, _airNom: 'Court n°01', _formattedAirNum: 1 }] } }] }

const fixture = async (t, { full = false, exposed = false, noHour = false, delay = 30, contradictoryCounts = false } = {}) => {
  const observed = { forms: 0, searches: [], selections: [], holds: 0 }
  const state = { exposed, full, noHour, login: false, error: false }
  const slot = date => `<div class="row tennis-court"><div class="price-description">Gratuité<br>Couvert</div><a href="/hold" courtid="42" datedeb="${date} 20:00:00">Book</a></div>`
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    let body = ''
    for await (const chunk of req) body += chunk
    const data = new URLSearchParams(body)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/hold') { observed.holds++; res.end('Hold'); return }
    if (url.pathname === '/calendar') { res.end(['20/09/2026', ...(state.exposed && !state.calendarLag ? [dateKey] : [])].map(date => `<button type="button" dateiso="${date}" onclick="document.querySelector('#date').value='${date}';this.parentElement.style.display='none'">${date}</button>`).join('')); return }
    if (url.searchParams.get('action') === 'ajax_rechercher_creneau') {
      observed.selections.push(Object.fromEntries(data))
      setTimeout(() => res.end(state.noHour ? '<div class="no-result">Complet</div>' : slot('2026/09/21')), delay)
      return
    }
    if (url.searchParams.get('action') !== 'rechercher_creneau') {
      observed.forms++
      res.end(`<script>var tennis = ${JSON.stringify(catalog)};</script>
        <form method="post" action="/?page=recherche&action=rechercher_creneau">
        <input class="tokens-input-text"><input name="selWhereTennisName" value="${location}"><input name="when" id="date" value="20/09/2026">
        <div class="tokens-suggestions-list-element"><button type="button">${location}</button></div>
        <button type="button" id="when" onclick="const cal=document.querySelector('.date-picker');cal.style.display='block';cal.innerHTML='&lt;div id=loadingComponent&gt;Loading&lt;/div&gt;';fetch('/calendar').then(r=>r.text()).then(html=>{cal.innerHTML=html})">Calendar</button>
        <div class="date-picker" style="display:none">${['20/09/2026', ...(state.exposed ? [dateKey] : [])].map(date => `<button type="button" dateiso="${date}" onclick="document.querySelector('#date').value='${date}';this.parentElement.style.display='none'">${date}</button>`).join('')}</div>
        <button id="rechercher">Search</button></form>`)
      return
    }
    observed.searches.push({ method: req.method, body, at: Date.now() })
    if (state.error) { res.statusCode = 500; res.end('Server error'); return }
    if (state.login) { res.end('<form id="form-login">Login</form>'); return }
    const selected = data.get('when') === dateKey
    res.end(`<div class="date-picker" style="display:none"><div dateiso="${dateKey}">Hidden duplicate</div></div>
      <div id="OtherClub"><div class="date-picker refresh"><div dateiso="${dateKey}">Wrong club</div></div></div>
      <div id="ExampleClub"><div class="date-picker refresh">
      <div class="date-item ${selected ? '' : 'selected'}"><div dateiso="20/09/2026">20</div></div>
      ${state.exposed ? `<div class="date-item ${selected ? 'selected' : ''} ${state.full ? 'item-full' : ''}"><div dateiso="${dateKey}">21</div>${state.full ? '<div class="message">Complet — Pas de disponibilité</div>' : ''}</div>` : ''}
      </div><div id="results">${state.full && !contradictoryCounts ? '' : selected ? state.noHour ? '<div class="no-result">No matching hour</div>' : slot('2026/09/21') : slot('2026/09/20')}</div></div>
      <script>
      document.querySelector('#ExampleClub .date-picker.refresh').onclick = async event => {
        const item = event.target.closest('.date-item'); if(!item || item.classList.contains('item-full')) return;
        document.querySelector('#results').innerHTML = '<div id="loadingComponent">Loading</div>';
        const response = await fetch('/?page=recherche&action=ajax_rechercher_creneau', {method:'POST', body:new URLSearchParams({when:event.target.getAttribute('dateiso'),selWhereTennisName:'${location}'})});
        document.querySelector('#results').innerHTML = await response.text();
        document.querySelectorAll('#ExampleClub .selected').forEach(el=>el.classList.remove('selected'));
        item.classList.add('selected');
      };
      </script>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); server.closeAllConnections(); server.close() })
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(2000)
  const options = { target, date: dayjs('2026-09-21'), polling: true, priceTypes: ['Gratuité'], captchaOptions: { ai: { enable: false } }, searchUrl: `http://127.0.0.1:${server.address().port}/?page=recherche&view=search` }
  const prepared = await prepareOpeningAgenda(page, options)
  const search = () => searchBookingTarget(page, { ...options, prepared, deadline: Date.now() + 2500 })
  return { page, prepared, options, search, state, observed }
}

test('warmup reaches results on J-1; timed refresh waits for exact visible Jour J and native slot response', async t => {
  const f = await fixture(t, { delay: 150 })
  assert.equal(f.observed.forms, 2)
  assert.equal(f.observed.searches.length, 1)
  assert.equal(f.observed.holds, 0)
  const opening = Date.now() + 150
  let attempt = 0
  for await (const tick of searchAttempts([target], { intervalSeconds: 1, durationSeconds: 5, fallbackMode: 'after-window' }, opening)) {
    if (++attempt === 2) f.state.exposed = true
    const result = await searchBookingTarget(f.page, { ...f.options, prepared: f.prepared, deadline: tick.deadline })
    if (attempt === 1) { assert.equal(result.dateSelectable, false); assert.deepEqual(result.candidates, []) }
    else {
      assert.equal(result.candidates.length, 1)
      assert.match(result.candidates[0].selector, /2026\/09\/21 20:00:00/)
      break
    }
  }
  assert.equal(attempt, 2)
  assert.equal(f.observed.forms, 2)
  assert.equal(f.observed.searches[1].method, 'POST')
  assert.equal(f.observed.searches[1].body, f.observed.searches[0].body)
  assert.ok(f.observed.searches[1].at >= opening)
  assert.ok(f.observed.searches[2].at - f.observed.searches[1].at >= 950)
  assert.deepEqual(f.observed.selections, [{ when: dateKey, selWhereTennisName: location }])
  assert.equal(f.observed.holds, 0)
})

test('already exposed target is refreshed before candidates are read', async t => {
  const f = await fixture(t, { exposed: true })
  const result = await f.search()
  assert.equal(result.candidates.length, 1)
  assert.equal(f.observed.searches.length, 2)
  assert.deepEqual(f.observed.selections, [])
})

test('a full target day with no slot selector returns promptly and is retried later', async t => {
  const f = await fixture(t, { exposed: true, full: true })
  assert.deepEqual(await f.search(), { location, dateSelectable: true, candidates: [] })
  f.state.full = false
  assert.equal((await f.search()).candidates.length, 1)
})

test('visible target date without the requested hour does not book another date', async t => {
  const f = await fixture(t, { noHour: true })
  f.state.exposed = true
  assert.deepEqual(await f.search(), { location, dateSelectable: true, candidates: [] })
  assert.equal(f.observed.holds, 0)
})

test('replaced document, even at the same URL, cannot be replayed', async t => {
  const f = await fixture(t)
  await f.page.reload()
  const count = f.observed.searches.length
  await assert.rejects(f.search(), /Prepared agenda changed/)
  assert.equal(f.observed.searches.length, count)
})

test('checkout navigation cannot be reloaded as an agenda', async t => {
  const f = await fixture(t)
  await f.page.goto(new URL('/payment', f.page.url()).href)
  await assert.rejects(f.search(), /Prepared agenda changed/)
  assert.equal(f.observed.searches.length, 1)
  assert.equal(f.observed.holds, 0)
})

test('HTTP failure invalidates the prepared agenda; no uncertain refresh is replayed', async t => {
  const f = await fixture(t)
  f.state.error = true
  await assert.rejects(f.search(), /HTTP 500/)
  await assert.rejects(f.search(), /Prepared agenda changed/)
  assert.equal(f.observed.searches.length, 2)
})

test('expired authentication is an error, never an empty availability result', async t => {
  const f = await fixture(t)
  f.state.login = true
  await assert.rejects(f.search(), /Search session is no longer ready/)
})

test('bookable exact-date slots take precedence over a contradictory full header', async t => {
  const f = await fixture(t, { exposed: true, full: true, contradictoryCounts: true })
  assert.equal((await f.search()).candidates.length, 1)
  assert.equal(f.observed.forms, 1)
})

test('a disabled new day submits the warm spare, without reopening the form, then reloads its POST', async t => {
  const f = await fixture(t, { full: true, contradictoryCounts: true })
  const spare = f.prepared.spare.page
  assert.equal(f.observed.forms, 2)
  f.state.exposed = true
  assert.equal((await f.search()).candidates.length, 1)
  assert.equal(f.observed.forms, 2)
  assert.equal((await f.search()).candidates.length, 1)
  assert.equal(f.observed.forms, 2)
  assert.match(f.observed.searches.at(-1).body, /when=21%2F09%2F2026/)
  assert.equal(f.prepared.activePage, spare)
  assert.equal(f.prepared.spare, undefined)
  assert.equal(f.observed.holds, 0)
})

test('a replaced spare is never submitted; the original tab performs a fresh search', async t => {
  const f = await fixture(t, { full: true, contradictoryCounts: true })
  const spare = f.prepared.spare.page
  await spare.goto(f.options.searchUrl)
  f.state.exposed = true
  assert.equal((await f.search()).candidates.length, 1)
  assert.equal(f.prepared.activePage, undefined)
  assert.equal(f.observed.forms, 4)
  assert.equal(f.observed.holds, 0)
})

test('a lagging spare calendar cannot submit the earlier date as the requested date', async t => {
  const f = await fixture(t, { full: true, contradictoryCounts: true })
  f.state.exposed = true
  f.state.calendarLag = true
  assert.deepEqual(await f.search(), { location, dateSelectable: false, candidates: [] })
  assert.equal(f.observed.searches.length, 2)
  assert.equal(f.prepared.spare, undefined)
  assert.equal(f.observed.holds, 0)
})
