import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'tennis-account-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'state')
  mkdirSync(state)
  const guest = [{ firstName: 'Rafael', lastName: 'Nadal' }]
  const fixed = { account: { name: 'Roger Federer', email: 'roger@example.test', password: 'PRIVATE_SECRET', defaultPlayers: guest }, priceType: ['Gratuité'], bookingAccounts: { second: { name: 'Rafael Nadal', email: 'rafael@example.test', password: 'PRIVATE_SECRET_2', priceType: ['Tarif plein'], defaultPlayers: guest } }, monitoringAccount: { email: 'monitor@example.test', password: 'MONITOR_SECRET' } }
  const preferences = { locations: ['Edouard Pailleron'], hours: ['20'], courtType: ['Couvert'], consecutive: { bookingAccount: 'second' } }
  const job = { id: 'test', status: 'scheduled', cronJobId: 'keep-cron', bookingOpensAt: '2026-09-15T08:00:00+02:00', request: { ...preferences, date: '21/09/2026', dryRun: true } }
  const files = { fixed: join(root, 'config.fixed.json'), preferences: join(root, 'config.request.json'), job: join(state, 'test.json') }
  for (const [key, value] of Object.entries({ fixed, preferences, job })) writeFileSync(files[key], JSON.stringify(value), { mode: 0o600 })
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/migrate-booking-accounts.js'), '--fixed', files.fixed, '--state-dir', state, ...args], { encoding: 'utf8' })
  const read = key => JSON.parse(readFileSync(files[key]))
  return { fixed, preferences, job, files, state, run, read }
}

test('migration previews without writes, then preserves private data, pending schedules and permissions', t => {
  const f = fixture(t)
  const preview = f.run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(f.read('fixed'), f.fixed)
  const result = f.run('--apply')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SECRET|MONITOR_SECRET|@example/)
  assert.equal(f.read('fixed').bookingAccounts.length, 2)
  assert.equal(f.read('fixed').bookingAccounts[0].password, f.fixed.account.password)
  assert.deepEqual(f.read('fixed').monitoringAccount, f.fixed.monitoringAccount)
  assert.deepEqual(f.read('preferences'), { ...f.preferences, bookingAccount: 'Roger Federer', consecutive: { bookingAccount: 'Rafael Nadal' } })
  assert.deepEqual(f.read('job'), { ...f.job, request: { ...f.job.request, bookingAccount: 'Roger Federer', consecutive: { bookingAccount: 'Rafael Nadal' } } })
  for (const path of Object.values(f.files)) assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(readdirSync(join(f.state, '.account-migrations')).length, 1)
  const again = f.run('--apply')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /files updated: 0/)
})
test('migration validates every reference before writing any file', t => {
  const f = fixture(t)
  writeFileSync(f.files.job, JSON.stringify({ ...f.job, request: { ...f.job.request, bookingAccount: 'unknown' } }))
  const result = f.run('--apply')
  assert.equal(result.status, 1)
  assert.deepEqual(f.read('fixed'), f.fixed)
  assert.deepEqual(f.read('preferences'), f.preferences)
  assert.ok(!readdirSync(f.state).includes('.operation-lock'))
})
test('a running job prevents account migration without changing its status', t => {
  const f = fixture(t)
  writeFileSync(f.files.job, JSON.stringify({ ...f.job, status: 'running' }))
  const result = f.run('--apply')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /job is running/)
  assert.deepEqual(f.read('fixed'), f.fixed)
  assert.equal(f.read('job').status, 'running')
})
