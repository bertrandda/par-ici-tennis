#!/usr/bin/env node
import { scanConnectedAvailability, scanPublicPlanning, validatePlanningOptions } from '../lib/public-planning.js'

const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(name)
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

try {
  const flags = args.filter(arg => arg.startsWith('--'))
  if (flags.some(flag => !['--club', '--dates', '--hours', '--sport', '--connected', '--check'].includes(flag)) || new Set(flags).size !== flags.length || args.some((arg, index) => !arg.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')))) throw new Error('Usage: scan-public-planning.js --club NAME --dates DD/MM/YYYY,... --hours 19,20 [--sport tennis|padel] [--connected] [--check]')
  const options = validatePlanningOptions({ club: value('--club'), dates: value('--dates').split(','), hours: value('--hours').split(',') })
  if (args.includes('--check')) process.stdout.write(`${JSON.stringify(options, null, 2)}\nConfiguration planning public valide. Aucun navigateur lancé.\n`)
  else {
    const report = await scanPublicPlanning(options)
    const free = report.slots.filter(slot => slot.state === 'free')
    const connected = args.includes('--connected') ? await scanConnectedAvailability({ ...options, sport: args.includes('--sport') ? value('--sport') : 'tennis' }) : null
    process.stdout.write(`${JSON.stringify({ ...report, free, ...(connected ? { connected } : {}) }, null, 2)}\n`)
    process.stdout.write(`Planning public : ${free.length} créneau(x) LIBRE(s). « LIBRE » est un signal ; vérifie ensuite la recherche connectée avant toute réservation.\n`)
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`)
  process.exitCode = 1
}
