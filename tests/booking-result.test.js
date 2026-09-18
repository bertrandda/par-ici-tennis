import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyBookingResult } from '../lib/booking-result.js'

test('confirmed reservations stay successful after an ancillary failure', () => {
  assert.equal(classifyBookingResult({ outcome: 'confirmed', exitCode: 1 }), 'succeeded_with_warnings')
  assert.equal(classifyBookingResult({ outcome: 'submitted', exitCode: 1 }), 'needs_reconciliation')
})
test('dry-run success requires the verified cancellation outcome', () => {
  assert.equal(classifyBookingResult({ outcome: 'dry-run-cancelled', dryRun: true, exitCode: 0 }), 'dry_run_succeeded')
  assert.equal(classifyBookingResult({ outcome: 'dry-run-cancelled', dryRun: true, exitCode: 1 }), 'failed')
  assert.equal(classifyBookingResult({ outcome: 'confirmed', dryRun: true, exitCode: 0 }), 'failed')
})
