export const reportBookingResult = (status, details = {}) => {
  if (process.send && process.connected) process.send({ type: 'tennis-result', status, ...details })
}

export const classifyConsecutiveResult = ({ legs, exitCode, dryRun }) => {
  const statuses = legs.map(leg => leg?.status)
  if (statuses.some(status => ['started', 'submitted', 'cleanup-unverified'].includes(status))) return 'needs_reconciliation'
  const complete = dryRun ? 'dry-run-cancelled' : 'confirmed'
  if (statuses[0] === complete && statuses[1] === complete) return dryRun ? (exitCode ? 'failed' : 'dry_run_succeeded') : (exitCode ? 'succeeded_with_warnings' : 'succeeded')
  if (statuses.includes(complete)) return dryRun ? 'dry_run_partial' : 'partially_succeeded'
  return exitCode === 0 && !statuses.includes('failed') ? 'unavailable' : 'failed'
}

export const classifyBookingResult = ({ exitCode, outcome, dryRun }) => {
  if (!dryRun && outcome === 'confirmed') return exitCode === 0 ? 'succeeded' : 'succeeded_with_warnings'
  if (dryRun && outcome === 'dry-run-cancelled' && exitCode === 0) return 'dry_run_succeeded'
  if (outcome === 'submitted' || outcome === 'cleanup-unverified') return 'needs_reconciliation'
  return exitCode === 0 && !outcome ? 'unavailable' : 'failed'
}
