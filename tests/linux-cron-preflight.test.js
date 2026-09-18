import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNoCompetingLinuxCron,
  findCompetingLinuxCronEntries,
} from '../lib/linux-cron-preflight.js'

test('active legacy Paris Tennis cron entries are competing automations', () => {
  const crontab = `
# old disabled launcher
# 45 7 * * * /home/me/par-ici-tennis/scripts/run-booking-2026-09-15.sh
45 7 * * * cd /home/me/par-ici-tennis && node index.js --debug
@reboot /home/me/par-ici-tennis/scripts/run-booking-2026-09-15.sh
`

  assert.deepEqual(findCompetingLinuxCronEntries(crontab), [
    '45 7 * * * cd /home/me/par-ici-tennis && node index.js --debug',
    '@reboot /home/me/par-ici-tennis/scripts/run-booking-2026-09-15.sh',
  ])
})

test('comments, variables and unrelated cron jobs do not block preparation', () => {
  const crontab = `
SHELL=/bin/bash
MAILTO=ops@example.test
# node /srv/par-ici-tennis/index.js
0 3 * * * /usr/local/bin/backup-par-ici-tennis
*/5 * * * * node /srv/another-project/index.js
`

  assert.doesNotThrow(() => assertNoCompetingLinuxCron(crontab))
})

test('preflight failure identifies the active entry and gives cleanup guidance', () => {
  const entry = '45 7 * * * /home/me/par-ici-tennis/scripts/run-booking-2026-09-15.sh'

  assert.throws(
    () => assertNoCompetingLinuxCron(`${entry}\n`),
    error => error.message.includes(entry)
      && error.message.includes('crontab -e')
      && error.message.includes('Hermes'),
  )
})
