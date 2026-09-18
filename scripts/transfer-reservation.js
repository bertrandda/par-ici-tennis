#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { prepareTransfer, executeTransfer, readTransfer } from '../lib/transfer.js'

console.log = (...values) => console.error(...values)
const [command, ...args] = process.argv.slice(2)
try {
  const allowed = { prepare: ['--from', '--to', '--reservation-id', '--players-file', '--headed'], execute: ['--id', '--confirm', '--accept-release-risk', '--headed'], show: ['--id'] }[command]
  if (!allowed) throw new Error('Usage: transfer-reservation.js prepare|execute|show (preview required before execution)')
  const values = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)) throw new Error(`Unexpected or duplicate option ${flag}`)
    if (['--confirm', '--accept-release-risk', '--headed'].includes(flag)) values[flag] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      values[flag] = value
    }
  }
  let result
  if (command === 'prepare') result = await prepareTransfer({ fromAccount: values['--from'], toAccount: values['--to'], reservationId: values['--reservation-id'], headed: values['--headed'], players: values['--players-file'] ? JSON.parse(readFileSync(values['--players-file'], 'utf8')) : undefined })
  else if (command === 'execute') result = await executeTransfer(values['--id'], { confirm: values['--confirm'], acceptReleaseRisk: values['--accept-release-risk'], headed: values['--headed'] })
  else result = readTransfer(values['--id'])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!['prepared', 'transferred'].includes(result.status)) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`)
  process.exitCode = 1
}
