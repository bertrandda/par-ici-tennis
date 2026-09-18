import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadAccountConfig, resolveBookingProfile, assertBookingCredentials } from './config.js'
import { bookingJobOptions } from './booking-job.js'
import { acquireOperationLock } from './operation-lock.js'
import { withTransferSession } from './transfer-session.js'

export const TRANSFER_RISK = 'Annulation puis nouvelle réservation, sans transfert garanti : le créneau redevient public et peut être perdu. Le quota final reste soumis au site.'
const fingerprint = profile => createHash('sha256').update(JSON.stringify([profile.account.email.trim().toLowerCase(), profile.priceType])).digest('hex')
const profiles = (config, fromAccount, toAccount) => {
  if (!fromAccount || !toAccount) throw new Error('Explicit source and destination account names are required')
  const from = resolveBookingProfile(config, fromAccount)
  const to = resolveBookingProfile(config, toAccount)
  for (const profile of [from, to]) assertBookingCredentials(profile)
  if (from.id === to.id || from.account.email.trim().toLowerCase() === to.account.email.trim().toLowerCase()) throw new Error('Source and destination must be different accounts')
  return { from, to }
}
const directory = options => join(bookingJobOptions(options).stateDirectory, 'transfers')
const pathFor = (id, options) => {
  if (!/^transfer-[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid transfer plan ID')
  return join(directory(options), `${id}.json`)
}
const save = (record, options) => {
  mkdirSync(directory(options), { recursive: true, mode: 0o700 })
  const path = pathFor(record.id, options)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}
export const readTransfer = (id, options = {}) => JSON.parse(readFileSync(pathFor(id, options), 'utf8'))

export const prepareTransfer = async ({ fromAccount, toAccount, reservationId, players, headed = false }, options = {}) => {
  if (!/^reservation-[a-f0-9]{24}$/.test(reservationId || '')) throw new Error('Use the source reservation ID returned by reservations list')
  const config = options.config || loadAccountConfig()
  const accounts = profiles(config, fromAccount, toAccount)
  const release = acquireOperationLock(bookingJobOptions(options).stateDirectory)
  try {
    const preflight = await (options.session || withTransferSession)({ config, ...accounts, headed }, session => session.preflight(reservationId, players))
    const now = Date.now()
    const record = {
      id: `transfer-${randomUUID()}`, status: 'prepared', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
      fromAccount: accounts.from.id, toAccount: accounts.to.id, fromIdentity: fingerprint(accounts.from), toIdentity: fingerprint(accounts.to),
      reservationId, ...preflight, risk: TRANSFER_RISK, history: [],
    }
    save(record, options)
    return record
  } finally { release() }
}

// Persist before each irreversible action; replay of any started plan is forbidden.
export const runTransfer = async (record, session, persist, { now = Date.now, pause = sleep, windowMs = 600000, intervalMs = 60000 } = {}) => {
  const change = status => {
    record.status = status
    record.history.push({ status, at: new Date(now()).toISOString() })
    persist(record)
  }
  try {
    change('prechecking')
    const fresh = await session.preflight(record.reservationId, record.players)
    if (JSON.stringify(fresh.selection) !== JSON.stringify(record.selection) || JSON.stringify(fresh.players) !== JSON.stringify(record.players)) throw new Error('Transfer preview changed')
    if (record.expiresAt && now() >= Date.parse(record.expiresAt)) throw new Error('Transfer preview expired during preflight')
    change('cancellation_started')
    const cancellation = await session.cancel(record.reservationId)
    if (cancellation.status !== 'cancelled' || !cancellation.verified) throw new Error('Cancellation unverified')
    record.sourceCancelled = true
    change('source_cancelled')
    const deadline = now() + windowMs
    let found = false
    while (now() < deadline) {
      const started = now()
      // Non-authoritative early signal: a public LIBRE cell can precede the
      // connected search. A failed public read never suppresses the exact-slot
      // connected check and never authorizes a different court or hour.
      if (session.publicSignal) {
        try {
          const signal = await session.publicSignal()
          record.publicPlanning = { ...signal, observedAt: new Date(now()).toISOString() }
          persist(record)
        } catch {
          record.publicPlanning = { state: 'unreadable', observedAt: new Date(now()).toISOString() }
          persist(record)
        }
      }
      found = await session.find(deadline)
      if (found && now() < deadline) break
      found = false
      // The public planning can show LIBRE before the authenticated search accepts
      // the released court. Keep retrying only this exact, preflight-verified slot.
      await pause(Math.max(0, Math.min(deadline - now(), intervalMs - (now() - started))))
    }
    if (!found) { change('released_unrecovered'); return record }
    change('holding')
    const button = await session.hold()
    change('submitted')
    await session.submit(button)
    record.destinationConfirmationVisible = true
    change('verifying')
    record.destinationReservation = await session.verify()
    change('transferred')
  } catch {
    // Do not retain raw browser errors: they can contain credentials or session data.
    if (record.status === 'holding') {
      try { await session.cleanup(); change('released_unrecovered') } catch { change('needs_reconciliation') }
    } else if (['cancellation_started', 'submitted', 'verifying'].includes(record.status)) change('needs_reconciliation')
    else change(record.sourceCancelled ? 'released_unrecovered' : 'blocked')
    record.error = record.status === 'blocked' ? 'Preflight failed; source was not cancelled by this run. Prepare a fresh preview.' : 'Replacement incomplete. Inspect both accounts before any further action; never replay this plan.'
    persist(record)
  }
  return record
}

export const executeTransfer = async (id, { confirm = false, acceptReleaseRisk = false, headed = false, ...options } = {}) => {
  if (!confirm || !acceptReleaseRisk) throw new Error('Execution requires --confirm and --accept-release-risk after reviewing the preview')
  const release = acquireOperationLock(bookingJobOptions(options).stateDirectory)
  let keepLock = false
  try {
    const record = readTransfer(id, options)
    if (record.status !== 'prepared' || Date.now() >= Date.parse(record.expiresAt)) throw new Error('Transfer already started or preview expired; never replay it')
    const config = options.config || loadAccountConfig()
    const accounts = profiles(config, record.fromAccount, record.toAccount)
    if (fingerprint(accounts.from) !== record.fromIdentity || fingerprint(accounts.to) !== record.toIdentity) throw new Error('Accounts or tariffs changed; prepare a fresh preview')
    const result = await (options.session || withTransferSession)({ config, ...accounts, headed }, session => {
      keepLock = true
      return runTransfer(record, session, value => save(value, options))
    })
    keepLock = result.status === 'needs_reconciliation'
    return result
  } finally {
    // An uncertain cancellation/payment requires reconciliation, not another operation.
    if (!keepLock) release()
  }
}
