import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { detectPlanningTransitions, validatePlanningOptions } from '../lib/public-planning.js'

test('public planning parsing preserves evidence and filters target evening hours', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<table><thead><tr><th></th><th>Court 01</th><th>Court 02</th></tr></thead><tbody>
    <tr><td>19h - 20h</td><td>LIBRE</td><td>PUBLIC Réservé le 18.09.2026 08:01</td></tr>
    <tr><td>20h - 21h</td><td>PUBLIC</td><td>LIBRE</td></tr></tbody></table>`)
  const slots = await page.locator('table').evaluate((table, options) => {
    const compact = value => value.replace(/\s+/g, ' ').trim()
    const courts = [...table.querySelectorAll('thead tr:last-child th')].slice(1).map(cell => compact(cell.textContent || ''))
    return [...table.querySelectorAll('tbody tr')].flatMap(row => {
      const cells = [...row.querySelectorAll('td')]
      const hour = compact(cells[0].textContent || '').match(/^(\d+)h/)?.[1]
      return !options.hours.includes(hour) ? [] : cells.slice(1).map((cell, index) => {
        const label = compact(cell.textContent || '')
        return { date: options.date, hour, court: courts[index], state: /^LIBRE$/i.test(label) ? 'free' : 'occupied', label, reservedAt: label.match(/Réservé le\s+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i)?.[1] || null }
      })
    })
  }, { date: '21/09/2026', hours: ['19', '20'] })
  assert.deepEqual(slots, [
    { date: '21/09/2026', hour: '19', court: 'Court 01', state: 'free', label: 'LIBRE', reservedAt: null },
    { date: '21/09/2026', hour: '19', court: 'Court 02', state: 'occupied', label: 'PUBLIC Réservé le 18.09.2026 08:01', reservedAt: '18.09.2026 08:01' },
    { date: '21/09/2026', hour: '20', court: 'Court 01', state: 'occupied', label: 'PUBLIC', reservedAt: null },
    { date: '21/09/2026', hour: '20', court: 'Court 02', state: 'free', label: 'LIBRE', reservedAt: null },
  ])
})

test('only an occupied-to-free transition is called a recent cancellation signal', () => {
  const prior = [{ date: '21/09/2026', hour: '19', court: 'Court 01', state: 'occupied' }]
  const now = [
    { ...prior[0], state: 'free' },
    { date: '21/09/2026', hour: '20', court: 'Court 02', state: 'free' },
  ]
  assert.deepEqual(detectPlanningTransitions(prior, now).map(slot => slot.signal), ['became_free', 'free_unknown_age'])
  assert.throws(() => validatePlanningOptions({ club: 'x', dates: ['31/09/2026'], hours: ['19'] }))
})
