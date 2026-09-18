#!/usr/bin/env node
import { findClubs, loadClubCatalog } from '../lib/clubs.js'
import { cancelReservation, listReservations } from '../lib/reservations.js'
import { listCredits } from '../lib/credits.js'
import { loadAccountConfig, describeBookingAccounts, resolveBookingProfile, assertBookingCredentials } from '../lib/config.js'

console.log = (...values) => console.error(...values)
const [resource, command, ...args] = process.argv.slice(2)
try {
  const allowed = resource === 'accounts' ? [] : resource === 'clubs' ? ['--query', '--arrondissement', '--headed'] : resource === 'credits' ? ['--account', '--all', '--headed'] : ['--id', '--confirm', '--headed', '--account']
  const parsed = new Map()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!allowed.includes(key) || parsed.has(key)) throw new Error(`Unexpected or duplicate option ${key}`)
    if (['--confirm', '--headed', '--all'].includes(key)) parsed.set(key, true)
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
      parsed.set(key, value)
    }
  }
  const option = name => parsed.get(name)
  const options = { headed: args.includes('--headed') }
  if (resource === 'reservations' && option('--account')) {
    const fixed = loadAccountConfig()
    const profile = resolveBookingProfile(fixed, option('--account'))
    assertBookingCredentials(profile)
    options.config = { ...fixed, bookingAccount: profile.id, account: profile.account, priceType: profile.priceType }
  }
  let result
  if (resource === 'accounts' && command === 'list') {
    result = { accounts: describeBookingAccounts(loadAccountConfig()) }
  } else if (resource === 'credits' && command === 'list') {
    result = await listCredits({ ...options, account: option('--account'), all: option('--all') })
    if (result.accounts.some(account => account.status === 'error')) process.exitCode = 1
  } else if (resource === 'clubs' && ['list', 'find'].includes(command)) {
    const query = option('--query')
    if (command === 'find' && !query) throw new Error('Missing --query')
    result = { source: 'Paris Tennis', fetchedAt: new Date().toISOString(), ...findClubs(await loadClubCatalog(options), { query, arrondissement: option('--arrondissement') }) }
  } else if (resource === 'reservations' && command === 'list') {
    if (args.includes('--confirm') || args.includes('--id')) throw new Error('list does not accept --confirm or --id')
    result = { source: 'Paris Tennis', fetchedAt: new Date().toISOString(), reservations: await listReservations(options) }
  } else if (resource === 'reservations' && command === 'cancel') {
    result = await cancelReservation(option('--id'), { ...options, confirm: args.includes('--confirm') })
  } else throw new Error('Usage: tennis.js accounts list | credits list [--account NAME | --all] [--headed] | clubs list|find [--query NAME] [--arrondissement N] | reservations list|cancel [--account ID] [--id ID] [--confirm] [--headed]')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`)
  process.exitCode = 1
}
