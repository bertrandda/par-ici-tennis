#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import dayjs from 'dayjs'
import { buildBookingConfig, normalizeBookingRequest, getBookingSchedule, describeBookingChoices } from '../lib/booking-request.js'
import { bookingJobOptions, claimBookingJob, updateBookingJob } from '../lib/booking-job.js'
import { acquireOperationLock } from '../lib/operation-lock.js'
import { loadMonitoringConfig } from '../lib/config.js'
import { classifyBookingResult, classifyConsecutiveResult } from '../lib/booking-result.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
let release = () => {}
let temporaryDirectory
let child
let record
let options
let claimed = false
let outcome
const legs = []
let logFile
let openingReviewRequired = false
const controller = new AbortController()
const interrupt = () => { controller.abort(); child?.kill('SIGTERM') }
process.once('SIGTERM', interrupt)
process.once('SIGINT', interrupt)

try {
  const index = args.indexOf('--request')
  if (index === -1 || !args[index + 1]) throw new Error('Missing --request')
  const requestFile = resolve(args[index + 1])
  record = JSON.parse(readFileSync(requestFile, 'utf8'))
  if (!/^[a-z0-9-]+$/.test(record.id) || requestFile !== join(dirname(requestFile), `${record.id}.json`)) throw new Error('Invalid request file or id')
  options = bookingJobOptions({ stateDirectory: dirname(requestFile) })
  if (!checkOnly) release = acquireOperationLock(options.stateDirectory)
  record = JSON.parse(readFileSync(requestFile, 'utf8'))
  const fixed = JSON.parse(readFileSync(options.fixedConfigPath, 'utf8'))
  const request = normalizeBookingRequest(record.request, { allowPastOpening: true, fixedConfig: fixed })
  const fullConfig = buildBookingConfig(fixed, request)
  loadMonitoringConfig({ bookingConfig: fullConfig, rootDirectory: root })
  // Check configuration without creating a secret file or changing job status.
  if (checkOnly) {
    process.stdout.write('Booking request check passed. No browser was started.\n')
  } else {
    const expected = getBookingSchedule(request)
    if (record.bookingOpensAt !== expected.bookingOpensAt) throw new Error('Stored opening time differs from the Paris schedule; re-prepare this request')
    const waitMilliseconds = Math.max(0, dayjs(record.bookingOpensAt).diff(dayjs()))
    if (waitMilliseconds > 600000) throw new Error('Booking runner started more than ten minutes before opening')
    if (dayjs().diff(dayjs(record.bookingOpensAt)) >= (request.polling ? request.polling.durationSeconds * 1000 : 3600000)) throw new Error('Booking window expired; prepare a new request instead of replaying it')
    claimBookingJob(record.id, options)
    claimed = true
    if (controller.signal.aborted) throw new Error('Booking interrupted before launch')
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'par-ici-tennis-'))
    const configPath = join(temporaryDirectory, 'config.json')
    writeFileSync(configPath, `${JSON.stringify(fullConfig)}\n`, { mode: 0o600 })
    const logDirectory = join(root, 'logs', 'hermes')
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
    logFile = join(logDirectory, `${record.id}.log`)
    const childArgs = ['index.js', '--debug', ...(request.dryRun ? ['--dry-run'] : [])]
    child = spawn(process.execPath, childArgs, {
      cwd: root,
      env: { ...process.env, TENNIS_CONFIG_PATH: configPath, TENNIS_SEARCH_START_AT: record.bookingOpensAt },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.on('message', message => {
      if (message?.type === 'tennis-search-expired' && !outcome) {
        openingReviewRequired = true
        updateBookingJob(record.id, { openingReviewRequired, logFile }, options)
        return
      }
      if (message?.type !== 'tennis-result' || !['submitted', 'confirmed', 'dry-run-cancelled', 'cleanup-unverified', ...(request.consecutive ? ['started', 'failed', 'unavailable'] : [])].includes(message.status)) return
      if (request.consecutive) {
        const leg = message.leg ?? 0
        if (![0, 1].includes(leg) || ['confirmed', 'dry-run-cancelled'].includes(legs[leg]?.status)) return
        legs[leg] = { status: message.status, accountId: leg === 0 ? request.bookingAccount || 'main' : request.consecutive.bookingAccount, selection: message.selection }
        updateBookingJob(record.id, { legs, logFile }, options)
        return
      }
      if (outcome === 'confirmed' || outcome === 'dry-run-cancelled') return
      outcome = message.status
      // Persist confirmation before ancillary work (ICS, notifications) can fail.
      updateBookingJob(record.id, { outcome, logFile }, options)
    })
    const capture = chunk => appendFileSync(logFile, chunk, { mode: 0o600 })
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const exitCode = await new Promise((resolveCode, reject) => {
      child.once('error', reject)
      child.once('close', code => resolveCode(code ?? 1))
    })
    const status = request.consecutive ? classifyConsecutiveResult({ legs, exitCode, dryRun: request.dryRun }) : classifyBookingResult({ exitCode, outcome, dryRun: request.dryRun })
    updateBookingJob(record.id, { status, outcome, ...(request.consecutive ? { legs } : {}), openingReviewRequired, exitCode, logFile, completedAt: new Date().toISOString() }, options)
    const label = `${request.date} — priorités : ${describeBookingChoices(request)}`
    const messages = {
      succeeded: `✅ Réservation Paris Tennis confirmée : ${label}.`,
      succeeded_with_warnings: `⚠️ Réservation Paris Tennis confirmée : ${label}. Une étape après réservation a échoué ; ne pas relancer. Journal : ${logFile}`,
      dry_run_succeeded: `✅ Test Paris Tennis terminé et annulation vérifiée : ${label}. Aucune réservation réelle.`,
      unavailable: `⚠️ Aucun terrain correspondant trouvé : ${label}.`,
      needs_reconciliation: `⚠️ Résultat de réservation incertain : ${label}. Vérifier le compte avant toute nouvelle tentative. Journal : ${logFile}`,
      failed: `Échec de la réservation Paris Tennis : ${label}. Journal : ${logFile}`,
    }
    const legSummary = request.consecutive ? legs.map((leg, i) => `${i + 1}: ${leg.accountId}, ${leg.selection?.location || '?'}, ${leg.selection?.hour || '?'}h, ${leg.status}`).join(' ; ') : ''
    if (request.consecutive && ['succeeded', 'succeeded_with_warnings'].includes(status)) messages[status] = `✅ Deux heures consécutives confirmées : ${legSummary}.${exitCode ? ' Une étape annexe a échoué ; ne pas relancer.' : ''}`
    messages.partially_succeeded = `⚠️ Réservation partielle : ${legSummary}. L’heure confirmée est conservée, même si seule la deuxième a réussi ; ne pas relancer la demande.`
    messages.dry_run_partial = `⚠️ Test partiel : ${legSummary}. Les deux heures n’ont pas été validées en dry-run.`
    if (request.consecutive && status === 'needs_reconciliation') messages[status] += ` État par compte : ${legSummary}. Une réservation déjà confirmée est conservée.`
    process.stdout.write(`${messages[status]}${openingReviewRequired ? ' Fenêtre de recherche terminée : vérifier les horaires d’ouverture et la disponibilité à partir du journal ; un horaire incorrect n’est pas démontré.' : ''}\n`)
    if (['failed', 'needs_reconciliation', 'partially_succeeded', 'dry_run_partial'].includes(status)) process.exitCode = 1
  }
} catch (error) {
  if (claimed) {
    const status = record.request.consecutive ? classifyConsecutiveResult({ legs, exitCode: 1, dryRun: record.request.dryRun }) : outcome === 'confirmed' ? 'succeeded_with_warnings' : outcome === 'submitted' || controller.signal.aborted ? 'needs_reconciliation' : 'failed'
    updateBookingJob(record.id, { status, outcome, ...(record.request.consecutive ? { legs } : {}), error: error.message, logFile, completedAt: new Date().toISOString() }, options)
  }
  process.stderr.write(`${outcome === 'confirmed' ? 'Réservation confirmée, erreur après réservation' : 'Échec du lanceur Paris Tennis'} : ${error.message}\n`)
  process.exitCode = outcome === 'confirmed' ? 0 : 1
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  if (claimed) {
    rmSync(join(options.hermesScriptsDirectory, `tennis-booking-${record.id}.sh`), { force: true })
    rmSync(join(options.hermesScriptsDirectory, `tennis-captcha-warmup-${record.id}.sh`), { force: true })
  }
  release()
  process.removeListener('SIGTERM', interrupt)
  process.removeListener('SIGINT', interrupt)
}
