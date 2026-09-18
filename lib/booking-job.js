import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import { homedir } from 'node:os'
import { loadClubCatalog, resolveLocations } from './clubs.js'
import { acquireOperationLock } from './operation-lock.js'
import { selectClubCourts, validateClubSport } from './sport.js'
import { getBookingSchedule, normalizeBookingRequest, buildBookingConfig, getBookingChoices, describeBookingChoices } from './booking-request.js'
import { assertNoCompetingLinuxCron, readLinuxCrontab } from './linux-cron-preflight.js'

const repositoryDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultStateDirectory = join(homedir(), '.local/state/par-ici-tennis/bookings')
const defaultHermesScriptsDirectory = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'scripts')
const defaultNodeBinary = process.execPath
const idPattern = /^[a-z0-9-]+$/

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'))

const writeJsonAtomic = (filePath, value) => {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, filePath)
}

const assertRequestId = (requestId) => {
  if (!idPattern.test(requestId)) throw new Error('Invalid booking request id')
  return requestId
}

const resolveBookingChoices = (catalog, normalized) => {
  const clubs = []
  const choices = getBookingChoices(normalized).map(choice => {
    const resolved = resolveLocations(catalog, choice.locations)
    for (const club of resolved.clubs) {
      validateClubSport(club.name, choice.sport)
      if (choice.sport === 'padel') selectClubCourts(catalog, club.name, { sport: choice.sport, courtNumbers: Array.isArray(resolved.locations) ? [] : resolved.locations[club.name] })
    }
    clubs.push(...resolved.clubs)
    return { ...choice, locations: resolved.locations }
  })
  const [primary, ...fallbacks] = choices
  return { request: { ...normalized, ...primary, ...(fallbacks.length ? { fallbacks } : {}) }, clubs }
}

const getPaths = (requestId, { stateDirectory, hermesScriptsDirectory }) => ({
  requestFile: join(stateDirectory, `${requestId}.json`),
  scriptFile: join(hermesScriptsDirectory, `tennis-booking-${requestId}.sh`),
  captchaWarmupScriptFile: join(hermesScriptsDirectory, `tennis-captcha-warmup-${requestId}.sh`),
})

const shellQuote = value => `'${value.replaceAll('\'', '\'"\'"\'')}'`

const buildWrapper = ({ nodeBinary, repositoryDirectory: root, requestFile, stateDirectory, fixedConfigPath, hermesScriptsDirectory }) => `#!/usr/bin/env bash

set -u -o pipefail

exec 9> /tmp/par-ici-tennis-booking.lock
if ! /usr/bin/flock -n 9; then
  echo "⚠️ Une autre réservation Paris Tennis est déjà en cours."
  exit 75
fi

export TENNIS_BOOKING_STATE_DIR=${shellQuote(stateDirectory)}
export TENNIS_FIXED_CONFIG_PATH=${shellQuote(fixedConfigPath)}
export HERMES_SCRIPTS_DIR=${shellQuote(hermesScriptsDirectory)}
cd ${shellQuote(root)} || exit 1
exec ${shellQuote(nodeBinary)} scripts/run-booking-request.js --request ${shellQuote(requestFile)}
`

const buildCaptchaWarmupWrapper = ({ nodeBinary, repositoryDirectory: root, fixedConfigPath, scriptFile }) => `#!/usr/bin/env bash

set -u -o pipefail

cleanup() {
  /bin/rm -f -- ${shellQuote(scriptFile)}
}
trap cleanup EXIT

export TENNIS_FIXED_CONFIG_PATH=${shellQuote(fixedConfigPath)}
cd ${shellQuote(root)} || exit 0
mkdir -p logs/hermes
/usr/bin/nohup ${shellQuote(nodeBinary)} scripts/warm-captcha-space.js >> logs/hermes/captcha-warmup.log 2>&1 </dev/null &
exit 0
`

const captchaWarmupDetails = (requestId, record, paths) => ({
  scheduleAt: dayjs(record.bookingOpensAt).subtract(6, 'minute').format(),
  cronName: `CAPTCHA warmup ${record.request.date} — ${requestId}`,
  script: basename(paths.captchaWarmupScriptFile),
  cronJobId: record.captchaWarmup?.cronJobId || null,
})

export const bookingJobOptions = (overrides = {}) => {
  const root = resolve(overrides.repositoryDirectory || repositoryDirectory)
  return {
    stateDirectory: resolve(overrides.stateDirectory || process.env.TENNIS_BOOKING_STATE_DIR || defaultStateDirectory),
    hermesScriptsDirectory: resolve(overrides.hermesScriptsDirectory || process.env.HERMES_SCRIPTS_DIR || defaultHermesScriptsDirectory),
    repositoryDirectory: root,
    nodeBinary: resolve(overrides.nodeBinary || process.env.TENNIS_NODE_BINARY || defaultNodeBinary),
    fixedConfigPath: resolve(overrides.fixedConfigPath || process.env.TENNIS_FIXED_CONFIG_PATH || join(root, 'config.fixed.json')),
    readLinuxCrontab: overrides.readLinuxCrontab || readLinuxCrontab,
  }
}

export const prepareBookingJob = async (input, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  assertNoCompetingLinuxCron(options.readLinuxCrontab())
  const now = overrides.now || dayjs()
  const fixedConfig = readJson(options.fixedConfigPath)
  const normalized = normalizeBookingRequest(input, { now, fixedConfig })
  buildBookingConfig(fixedConfig, normalized)
  const catalog = overrides.catalog || await loadClubCatalog()
  const resolved = resolveBookingChoices(catalog, normalized)
  const request = resolved.request

  mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(options.hermesScriptsDirectory, { recursive: true, mode: 0o700 })
  chmodSync(options.stateDirectory, 0o700)

  const release = acquireOperationLock(options.stateDirectory)
  try {
    const datePart = request.date.split('/').reverse().join('')
    const requestId = `${datePart}-${request.hours[0]}-${randomBytes(3).toString('hex')}`
    const { scheduleAt, bookingOpensAt } = getBookingSchedule(request)
    const conflict = listBookingJobs(options).find(job =>
      ['prepared', 'scheduled', 'running'].includes(job.status)
    && job.bookingOpensAt === bookingOpensAt)
    if (conflict) throw new Error(`Another active booking request already opens at this time: ${conflict.id}`)

    const paths = getPaths(requestId, options)
    const record = {
      version: 1,
      id: requestId,
      status: 'prepared',
      createdAt: now.toISOString(),
      scheduleAt,
      bookingOpensAt,
      cronJobId: null,
      captchaWarmup: null,
      clubs: resolved.clubs,
      request,
    }
    record.captchaWarmup = captchaWarmupDetails(requestId, record, paths)

    try {
      writeFileSync(paths.requestFile, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      writeFileSync(paths.scriptFile, buildWrapper({
        ...options,
        repositoryDirectory: options.repositoryDirectory,
        requestFile: paths.requestFile,
      }), { flag: 'wx', mode: 0o700 })
      writeFileSync(paths.captchaWarmupScriptFile, buildCaptchaWarmupWrapper({
        ...options,
        repositoryDirectory: options.repositoryDirectory,
        scriptFile: paths.captchaWarmupScriptFile,
      }), { flag: 'wx', mode: 0o700 })
      chmodSync(paths.requestFile, 0o600)
      chmodSync(paths.scriptFile, 0o700)
      chmodSync(paths.captchaWarmupScriptFile, 0o700)
    } catch (error) {
      rmSync(paths.requestFile, { force: true })
      rmSync(paths.scriptFile, { force: true })
      rmSync(paths.captchaWarmupScriptFile, { force: true })
      throw error
    }

    return {
      requestId,
      cronName: `${request.sport === 'padel' ? 'Padel' : 'Tennis'} ${request.date} — ${describeBookingChoices(request)}`,
      schedule: scheduleAt,
      bookingOpensAt,
      script: basename(paths.scriptFile),
      captchaWarmup: record.captchaWarmup,
      dryRun: request.dryRun,
      clubs: resolved.clubs,
    }
  } finally { release() }
}

export const prepareCaptchaWarmup = (requestId, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const paths = getPaths(assertRequestId(requestId), options)
    const record = readJson(paths.requestFile)
    if (!['prepared', 'scheduled'].includes(record.status)) throw new Error('CAPTCHA warmup can only be added to a pending request')
    const details = captchaWarmupDetails(requestId, record, paths)
    if (!dayjs(details.scheduleAt).isAfter(overrides.now || dayjs())) throw new Error('CAPTCHA warmup time has already passed; keep the booking job unchanged')
    writeFileSync(paths.captchaWarmupScriptFile, buildCaptchaWarmupWrapper({
      ...options,
      repositoryDirectory: options.repositoryDirectory,
      scriptFile: paths.captchaWarmupScriptFile,
    }), { mode: 0o700 })
    chmodSync(paths.captchaWarmupScriptFile, 0o700)
    record.captchaWarmup = details
    writeJsonAtomic(paths.requestFile, record)
    return { requestId, ...details }
  } finally { release() }
}

export const attachCronJob = (requestId, cronJobId, overrides = {}, attachments = {}) => {
  const options = bookingJobOptions(overrides)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const paths = getPaths(assertRequestId(requestId), options)
    const record = readJson(paths.requestFile)
    if (!String(cronJobId || '').trim()) throw new Error('cronJobId must be a non-empty string')
    if (record.status !== 'prepared') throw new Error('Only prepared requests can be scheduled')
    record.cronJobId = String(cronJobId).trim()
    if (attachments.captchaWarmupCronJobId !== undefined) {
      if (!String(attachments.captchaWarmupCronJobId || '').trim()) throw new Error('captchaWarmupCronJobId must be a non-empty string')
      record.captchaWarmup = { ...record.captchaWarmup, cronJobId: String(attachments.captchaWarmupCronJobId).trim() }
    }
    record.status = 'scheduled'
    writeJsonAtomic(paths.requestFile, record)
    return record
  } finally { release() }
}

export const attachCaptchaWarmupCronJob = (requestId, cronJobId, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const paths = getPaths(assertRequestId(requestId), options)
    const record = readJson(paths.requestFile)
    if (!['prepared', 'scheduled'].includes(record.status)) throw new Error('CAPTCHA warmup can only be attached to a pending request')
    if (!record.captchaWarmup) throw new Error('Prepare CAPTCHA warmup before attaching its cron')
    if (!String(cronJobId || '').trim()) throw new Error('captchaWarmupCronJobId must be a non-empty string')
    if (record.captchaWarmup.cronJobId && record.captchaWarmup.cronJobId !== String(cronJobId).trim()) throw new Error('A different CAPTCHA warmup cron is already attached')
    record.captchaWarmup = { ...record.captchaWarmup, cronJobId: String(cronJobId).trim() }
    writeJsonAtomic(paths.requestFile, record)
    return record
  } finally { release() }
}

export const updateBookingJob = (requestId, updates, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const paths = getPaths(assertRequestId(requestId), options)
  const record = readJson(paths.requestFile)
  const updated = { ...record, ...updates, id: record.id, request: record.request }
  writeJsonAtomic(paths.requestFile, updated)
  return updated
}

export const listBookingJobs = (overrides = {}) => {
  const options = bookingJobOptions(overrides)
  if (!existsSync(options.stateDirectory)) return []
  return readdirSync(options.stateDirectory)
    .filter(name => idPattern.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
    .map(name => readJson(join(options.stateDirectory, name)))
    .sort((a, b) => a.bookingOpensAt.localeCompare(b.bookingOpensAt))
}

export const removeBookingJob = (requestId, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const paths = getPaths(assertRequestId(requestId), options)
    const record = existsSync(paths.requestFile) ? readJson(paths.requestFile) : null
    if (record && record.status !== 'prepared') throw new Error('Only unscheduled prepared requests can be cleaned up; cancel other requests instead')
    rmSync(paths.requestFile, { force: true })
    rmSync(paths.scriptFile, { force: true })
    rmSync(paths.captchaWarmupScriptFile, { force: true })
    return record
  } finally { release() }
}

export const readBookingJob = (requestId, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  return readJson(getPaths(assertRequestId(requestId), options).requestFile)
}

export const claimBookingJob = (requestId, overrides = {}) => {
  const record = readBookingJob(requestId, overrides)
  if (!['prepared', 'scheduled'].includes(record.status)) throw new Error(`Request cannot run from status ${record.status}; reconcile the account before preparing a new request`)
  return updateBookingJob(requestId, { status: 'running', startedAt: new Date().toISOString() }, overrides)
}

export const cancelBookingJob = (requestId, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const record = readBookingJob(requestId, options)
    if (record.status === 'cancelled') return record
    if (!['prepared', 'scheduled'].includes(record.status)) throw new Error(`Cannot cancel an automation in status ${record.status}. This does not cancel a confirmed reservation.`)
    const updated = updateBookingJob(requestId, { status: 'cancelled', cancelledAt: new Date().toISOString() }, options)
    const paths = getPaths(requestId, options)
    rmSync(paths.scriptFile, { force: true })
    rmSync(paths.captchaWarmupScriptFile, { force: true })
    return updated
  } finally { release() }
}

export const editBookingJob = async (requestId, input, overrides = {}) => {
  const options = bookingJobOptions(overrides)
  const fixedConfig = readJson(options.fixedConfigPath)
  const normalized = normalizeBookingRequest(input, { now: overrides.now || dayjs(), fixedConfig })
  buildBookingConfig(fixedConfig, normalized)
  const catalog = overrides.catalog || await loadClubCatalog()
  const resolved = resolveBookingChoices(catalog, normalized)
  const release = acquireOperationLock(options.stateDirectory)
  try {
    const record = readBookingJob(requestId, options)
    if (!['prepared', 'scheduled'].includes(record.status)) throw new Error('Only pending requests can be edited')
    if (getBookingSchedule(normalized).bookingOpensAt !== record.bookingOpensAt) throw new Error('Changing the date requires cancelling this automation and scheduling a new one')
    const updated = { ...record, request: resolved.request, clubs: resolved.clubs, updatedAt: new Date().toISOString() }
    writeJsonAtomic(getPaths(requestId, options).requestFile, updated)
    return updated
  } finally { release() }
}
