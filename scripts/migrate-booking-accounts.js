#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import dayjs from 'dayjs'
import { bookingJobOptions } from '../lib/booking-job.js'
import { acquireOperationLock } from '../lib/operation-lock.js'
import { migrateBookingAccounts, migrateAccountReferences } from '../lib/account-migration.js'
import { buildBookingConfig } from '../lib/booking-request.js'

const args = process.argv.slice(2)
const flags = new Map()
for (let i = 0; i < args.length; i++) {
  const key = args[i]
  if (!['--fixed', '--request-config', '--state-dir', '--apply'].includes(key) || flags.has(key)) throw new Error('Invalid migration option')
  const value = key === '--apply' ? true : args[++i]
  if (!value || (typeof value === 'string' && value.startsWith('--'))) throw new Error(`Missing value for ${key}`)
  flags.set(key, value)
}
const options = bookingJobOptions({ fixedConfigPath: flags.get('--fixed'), stateDirectory: flags.get('--state-dir') })
const apply = flags.has('--apply')
let release = () => {}
const atomicWrite = (path, contents) => {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
try {
  if (apply) release = acquireOperationLock(options.stateDirectory)
  const changes = []
  const read = path => {
    const original = readFileSync(path)
    const value = JSON.parse(original)
    return { path, original, value }
  }
  const fixed = read(options.fixedConfigPath)
  const migrated = migrateBookingAccounts(fixed.value)
  const stage = (file, value) => {
    if (JSON.stringify(file.value) !== JSON.stringify(value)) changes.push({ ...file, contents: `${JSON.stringify(value, null, 2)}\n` })
  }
  stage(fixed, migrated)
  const requestPath = resolve(flags.get('--request-config') || join(dirname(options.fixedConfigPath), 'config.request.json'))
  if (existsSync(requestPath)) {
    const file = read(requestPath)
    const request = migrateAccountReferences(file.value, fixed.value, migrated)
    buildBookingConfig(migrated, { ...request, date: request.date || dayjs().add(6, 'days').format('DD/MM/YYYY') })
    stage(file, request)
  }
  let pending = 0
  for (const filename of existsSync(options.stateDirectory) ? readdirSync(options.stateDirectory).filter(name => name.endsWith('.json')) : []) {
    const file = read(join(options.stateDirectory, filename))
    if (file.value.status === 'running') throw new Error('A booking job is running; migration refused')
    if (!['prepared', 'scheduled'].includes(file.value.status)) continue
    const request = migrateAccountReferences(file.value.request, fixed.value, migrated)
    buildBookingConfig(migrated, request)
    stage(file, { ...file.value, request })
    pending++
  }
  if (apply && changes.length) {
    for (const file of changes) if (!readFileSync(file.path).equals(file.original)) throw new Error('Configuration changed during migration; nothing written')
    const backupRoot = join(options.stateDirectory, '.account-migrations')
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
    const backup = mkdtempSync(join(backupRoot, 'backup-'))
    for (const [i, file] of changes.entries()) writeFileSync(join(backup, `${i}.json`), file.original, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(changes.map((file, i) => ({ source: file.path, backup: `${i}.json` }))), { mode: 0o600 })
    const written = []
    try {
      for (const file of changes) { atomicWrite(file.path, file.contents); written.push(file) }
    } catch (error) {
      try { for (const file of written.reverse()) atomicWrite(file.path, file.original) } catch {
        release = () => {}
        throw new Error('Migration rollback failed; operation lock retained. Restore the private backup before continuing.', { cause: error })
      }
      throw error
    }
    console.log(`Migration applied. Private backup: ${backup}`)
  }
  console.log(`Accounts: ${migrated.bookingAccounts.length}; pending jobs checked: ${pending}; files ${apply ? 'updated' : 'to update'}: ${changes.length}. No browser started.`)
} catch (error) {
  // Validation messages only; never print parsed private configurations.
  console.error(error.message)
  process.exitCode = 1
} finally { release() }
