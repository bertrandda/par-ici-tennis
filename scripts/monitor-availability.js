#!/usr/bin/env node
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMonitoringConfig } from '../lib/config.js'
import { withSitePage } from '../lib/site-session.js'
import { acquireOperationLock } from '../lib/operation-lock.js'
import { bookingJobOptions } from '../lib/booking-job.js'
import { validateMonitorOptions, guardMonitorPage, observeAvailability, monitorWindow } from '../lib/availability-monitor.js'

const args = process.argv.slice(2)
const argument = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing ${name}`)
  }
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const parisTime = value => value ? new Date(value).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour12: false }) : 'non observée'
let release = () => {}
let reportFile
let logFile
let options
// Keep diagnostics in the run log; the final stdout is the Hermes report.
console.log = (...values) => console.error(...values)
try {
  options = validateMonitorOptions({ date: argument('--date'), club: argument('--club'), sport: argument('--sport', 'padel'), start: argument('--start'), end: argument('--end'), intervalSeconds: Number(argument('--interval-seconds', '2')) })
  const config = loadMonitoringConfig()
  const accountRole = config.dedicated ? 'monitoring' : 'booking'
  if (args.includes('--check')) {
    process.stdout.write(`${JSON.stringify(options, null, 2)}\nRead-only monitor configuration valid (account: ${accountRole}). No browser started.\n`)
  } else {
    if (Date.now() >= Date.parse(options.end)) throw new Error('Observation window already ended; refusing replay')
    if (Date.parse(options.start) - Date.now() > 600000) throw new Error('Monitor started more than ten minutes early')
    release = acquireOperationLock(bookingJobOptions().stateDirectory)
    const output = resolve(argument('--output-dir', join(root, 'logs', 'monitoring')))
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const id = `${options.sport}-${options.date.split('/').reverse().join('')}-${options.start.replace(/[^0-9]/g, '')}`
    logFile = join(output, `${id}.jsonl`)
    reportFile = join(output, `${id}.report.json`)
    if (existsSync(reportFile) || existsSync(logFile)) throw new Error('Monitor output already exists; refusing to overwrite evidence')
    writeFileSync(logFile, '', { mode: 0o600, flag: 'wx' })
    const summary = await withSitePage(async page => {
      await guardMonitorPage(page)
      return monitorWindow(options, () => observeAvailability(page, options, { ai: config.ai }), observation => {
        appendFileSync(logFile, `${JSON.stringify(observation)}\n`, { mode: 0o600 })
      })
    }, { authenticate: true, config })
    writeFileSync(reportFile, `${JSON.stringify({ options, accountRole, ...summary }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    const lines = [
      `Compte utilisé : ${accountRole}.`,
      `Observation ${options.club} pour le ${options.date} (Europe/Paris).`,
      `Premiers créneaux affichés : ${parisTime(summary.firstVisibleAt)}.`,
      `Premiers créneaux accessibles au compte : ${parisTime(summary.firstBookableAt)}.`,
      summary.possibleAppearanceAfter ? `Apparition située après la recherche de ${parisTime(summary.possibleAppearanceAfter)} et au plus tard à ${parisTime(summary.firstVisibleAt)}.` : summary.firstVisibleAt ? 'Déjà présents au premier relevé réussi : heure d’ouverture exacte indéterminée.' : 'Aucune ouverture observée ; cela ne démontre pas que les terrains étaient fermés.',
      `${summary.samples} relevés, ${summary.errors} erreurs. Fin : ${summary.stoppedReason}.`,
      'Aucun créneau sélectionné, aucune réservation créée.',
      `Rapport : ${reportFile}\nRelevés : ${logFile}`,
    ]
    process.stdout.write(lines.join('\n') + '\n')
    if (summary.stoppedReason !== 'window_complete' || summary.result === 'no_successful_observation') process.exitCode = 1
  }
} catch (error) {
  const failure = { options, status: 'failed', error: error.message, at: new Date().toISOString(), logFile }
  if (reportFile && !existsSync(reportFile)) writeFileSync(reportFile, JSON.stringify(failure, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write(`Échec du monitoring en lecture seule : ${error.message}. Aucune réservation lancée.\n`)
  process.exitCode = 1
} finally { release() }
