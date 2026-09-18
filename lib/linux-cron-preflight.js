import { execFileSync } from 'node:child_process'

const cronCommand = line => line.trim()

const isActiveCronLine = (line) => {
  const trimmed = line.trim()
  return trimmed && !trimmed.startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)
}

const runsParisTennisBooking = (line) => {
  const normalized = line.toLowerCase()
  if (!normalized.includes('par-ici-tennis')) return false
  return /(?:^|[\s/'"])(?:index\.js|run-booking(?:-[^\s/'"]+)?\.sh|run-booking-request\.js)(?:[\s'"&;]|$)/.test(normalized)
}

export const findCompetingLinuxCronEntries = crontab => String(crontab || '')
  .split(/\r?\n/)
  .filter(isActiveCronLine)
  .map(cronCommand)
  .filter(runsParisTennisBooking)

export const assertNoCompetingLinuxCron = (crontab) => {
  const entries = findCompetingLinuxCronEntries(crontab)
  if (!entries.length) return
  throw new Error([
    'Competing Paris Tennis automation found in the Linux crontab:',
    ...entries.map(entry => `- ${entry}`),
    'Remove or disable it with `crontab -e`, then retry. Hermes via booking-manager must remain the only scheduler.',
  ].join('\n'))
}

export const readLinuxCrontab = () => {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.status === 1 && /no crontab/i.test(String(error.stderr || ''))) return ''
    throw new Error(
      `Unable to inspect the Linux crontab before preparing a booking: ${String(error.stderr || error.message).trim()}`,
      { cause: error },
    )
  }
}
