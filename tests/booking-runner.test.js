import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'tennis-runner-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['lib', 'scripts', 'state', 'hermes/scripts']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['lib/search-window.js', 'lib/sport.js', 'lib/booking-request.js', 'lib/config.js', 'lib/booking-job.js', 'lib/linux-cron-preflight.js', 'lib/clubs.js', 'lib/site-session.js', 'lib/captcha.js', 'lib/huggingface.js', 'lib/operation-lock.js', 'lib/booking-result.js', 'scripts/run-booking-request.js']) copyFileSync(file, join(root, file))
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, 'config.fixed.json'), JSON.stringify({ account: { email: 'test@example.test', password: 'fixture-only' }, priceType: ['Gratuité'] }))
  writeFileSync(join(root, 'clock.js'), 'const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [\'2026-09-15T08:00:01+02:00\'])) } static now() { return new NativeDate(\'2026-09-15T08:00:01+02:00\').getTime() } }')
  const record = { id: 'test-job', status: 'scheduled', bookingOpensAt: '2026-09-15T08:00:00+02:00', request: { date: '21/09/2026', hours: ['18'], locations: ['Example'], courtType: ['Couvert'], players: [{ firstName: 'Test', lastName: 'Partner' }], dryRun: false } }
  const requestFile = join(root, 'state/test-job.json')
  const save = value => writeFileSync(requestFile, JSON.stringify(value))
  save(record)
  const run = (source, flags = []) => {
    writeFileSync(join(root, 'index.js'), source)
    return spawnSync(process.execPath, ['--import', join(root, 'clock.js'), join(root, 'scripts/run-booking-request.js'), '--request', requestFile, ...flags], {
      env: { ...process.env, TENNIS_FIXED_CONFIG_PATH: join(root, 'config.fixed.json'), HERMES_SCRIPTS_DIR: join(root, 'hermes/scripts') }, encoding: 'utf8', timeout: 10000,
    })
  }
  return { root, record, save, run, read: () => JSON.parse(readFileSync(requestFile, 'utf8')) }
}

test('runner preserves confirmation after child failure and refuses replay', t => {
  const f = fixture(t)
  const first = f.run('process.send({type:\'tennis-result\',status:\'confirmed\'}, () => {process.exitCode = 1})')
  assert.equal(first.status, 0, first.stderr)
  assert.equal(f.read().status, 'succeeded_with_warnings')
  assert.match(first.stdout, /confirmée/)
  const replay = f.run('throw new Error(\'must not execute\')')
  assert.equal(replay.status, 1)
  assert.match(replay.stderr, /cannot run/)
  assert.equal(f.read().status, 'succeeded_with_warnings')
  assert.equal(existsSync(join(f.root, 'state/.operation-lock')), false)
})
test('runner classifies interrupted submission and cancelled dry-run separately', t => {
  const f = fixture(t)
  f.run('process.send({type:\'tennis-result\',status:\'submitted\'}, () => {process.exitCode = 1})')
  assert.equal(f.read().status, 'needs_reconciliation')
  f.save({ ...f.record, request: { ...f.record.request, dryRun: true } })
  const dry = f.run('if (!process.argv.includes(\'--dry-run\')) throw new Error(\'Missing dry-run\'); process.send({type:\'tennis-result\',status:\'dry-run-cancelled\'})')
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(f.read().status, 'dry_run_succeeded')
})
test('configuration check leaves the request untouched and never starts the child', t => {
  const f = fixture(t)
  const result = f.run('throw new Error(\'must not execute\')', ['--check'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.read(), f.record)
})
test('overlapping execution and cancelled jobs cannot start a booking', t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'state/.operation-lock'))
  assert.match(f.run('throw new Error(\'must not execute\')').stderr, /Another tennis operation/)
  assert.equal(f.read().status, 'scheduled')
  rmSync(join(f.root, 'state/.operation-lock'), { recursive: true })
  f.save({ ...f.record, status: 'cancelled' })
  assert.match(f.run('throw new Error(\'must not execute\')').stderr, /cannot run/)
  assert.equal(f.read().status, 'cancelled')
})

test('runner starts the browser during warmup and passes the exact opening time', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'clock.js'), 'const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [\'2026-09-15T07:55:00+02:00\'])) } static now() { return new NativeDate(\'2026-09-15T07:55:00+02:00\').getTime() } }')
  f.save({ ...f.record, request: { ...f.record.request, polling: {} } })
  const result = f.run('if (process.env.TENNIS_SEARCH_START_AT !== \'2026-09-15T08:00:00+02:00\') throw new Error(\'Missing search start\')')
  assert.equal(result.status, 0, result.stderr)
})
test('an expired search window flags opening review even if the fallback succeeds', t => {
  const f = fixture(t)
  const result = f.run('process.send({type:\'tennis-search-expired\'}, () => process.send({type:\'tennis-result\',status:\'confirmed\'}))')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read().status, 'succeeded')
  assert.equal(f.read().openingReviewRequired, true)
  assert.match(result.stdout, /vérifier les horaires/)
})
test('a polling job started after its window never starts the browser', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'clock.js'), 'const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [\'2026-09-15T08:10:00+02:00\'])) } static now() { return new NativeDate(\'2026-09-15T08:10:00+02:00\').getTime() } }')
  f.save({ ...f.record, request: { ...f.record.request, polling: {} } })
  const result = f.run('throw new Error(\'Browser must not start\')')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Booking window expired/)
  assert.doesNotMatch(result.stderr, /Browser must not start/)
})

const consecutiveFixture = t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'config.fixed.json'), JSON.stringify({
    account: { email: 'first@example.test', password: 'first' }, priceType: ['Gratuité'],
    bookingAccounts: { second: { name: 'Second', email: 'second@example.test', password: 'second', priceType: ['Tarif plein'], defaultPlayers: [{firstName: 'First', lastName: 'Player'}] } },
  }))
  f.record.request.consecutive = { bookingAccount: 'second' }
  f.save(f.record)
  return f
}
const messages = rows => rows.map(([leg, status]) => `process.send(${JSON.stringify({type: 'tennis-result', leg, status})});`).join('\n')

test('runner persists both account outcomes and reports two confirmed hours', t => {
  const f = consecutiveFixture(t)
  const result = f.run(messages([[0, 'submitted'], [0, 'confirmed'], [1, 'submitted'], [1, 'confirmed']]))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read().status, 'succeeded')
  assert.deepEqual(f.read().legs.map(row => row.accountId), ['main', 'second'])
  assert.match(result.stdout, /Deux heures consécutives confirmées/)
})
test('runner never reports full success after only the first hour or an interrupted second attempt', t => {
  for (const [secondStatus, expected] of [['unavailable', 'partially_succeeded'], ['submitted', 'needs_reconciliation'], ['started', 'needs_reconciliation'], ['cleanup-unverified', 'needs_reconciliation']]) {
    const f = consecutiveFixture(t)
    const result = f.run(messages([[0, 'confirmed'], [1, secondStatus]]) + '\nprocess.exitCode = 1')
    assert.equal(result.status, 1)
    assert.equal(f.read().status, expected)
    assert.equal(f.read().legs[0].status, 'confirmed')
    assert.equal(f.run('throw new Error("must not replay")').status, 1)
  }
})
test('runner reports dry-run success only after both accounts cancel their holds', t => {
  const f = consecutiveFixture(t)
  f.record.request.dryRun = true
  f.save(f.record)
  const result = f.run(messages([[0, 'dry-run-cancelled'], [1, 'dry-run-cancelled']]))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read().status, 'dry_run_succeeded')
})

test('runner retains and accurately reports a second-hour-only success with out-of-order results', t => {
  for (const [firstStatus, expected] of [['unavailable', 'partially_succeeded'], ['failed', 'partially_succeeded'], ['submitted', 'needs_reconciliation'], ['cleanup-unverified', 'needs_reconciliation']]) {
    const f = consecutiveFixture(t)
    const result = f.run(messages([[1, 'submitted'], [1, 'confirmed'], [0, firstStatus]]) + '\nprocess.exitCode = 1')
    assert.equal(result.status, 1)
    assert.equal(f.read().status, expected)
    assert.equal(f.read().legs[1].status, 'confirmed')
    assert.equal(f.read().legs[1].accountId, 'second')
    assert.doesNotMatch(result.stdout, /La première est conservée|La deuxième heure n’est pas confirmée/)
    if (expected === 'partially_succeeded') assert.match(result.stdout, /même si seule la deuxième a réussi/)
    assert.equal(f.run('throw new Error("must not replay")').status, 1)
  }
})
