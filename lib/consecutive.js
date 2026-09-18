export const nextHour = hour => String(Number(hour) + 1).padStart(2, '0')

// Each browser owns its complete fallback chain, but searches exactly one fixed
// hour across it: fallbacks may change sport/club, never the leg's time.
export const consecutiveLegTargets = (targets, leg) => {
  const hour = leg === 0 ? targets[0].hours[0] : nextHour(targets[0].hours[0])
  return targets.map(target => ({
    ...target,
    hours: [hour],
  }))
}

// Invoke both legs before awaiting either. allSettled deliberately isolates a
// failed session: it must never cancel, delay or replay the other one.
export const runConsecutiveLegs = run => {
  const jobs = []
  for (const leg of [0, 1]) {
    try { jobs.push(Promise.resolve(run(leg))) } catch (error) { jobs.push(Promise.reject(error)) }
  }
  return Promise.allSettled(jobs)
}
