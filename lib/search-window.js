import { setTimeout as sleep } from 'node:timers/promises'

export const normalizePolling = value => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('polling must be an object')
  const unknown = Object.keys(value).filter(key => !['intervalSeconds', 'durationSeconds', 'fallbackMode'].includes(key))
  if (unknown.length) throw new Error(`Unsupported polling fields: ${unknown.join(', ')}`)
  const { intervalSeconds = 1, durationSeconds = 120, fallbackMode = 'after-window' } = value
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) throw new Error('polling.intervalSeconds must be between 1 and 60')
  if (!Number.isInteger(durationSeconds) || durationSeconds < intervalSeconds || durationSeconds > 120) throw new Error('polling.durationSeconds must be between the interval and 120')
  if (!['after-window', 'each-cycle'].includes(fallbackMode)) throw new Error('Invalid polling.fallbackMode')
  return { intervalSeconds, durationSeconds, fallbackMode }
}

export const parseSearchStart = (value, now = Date.now()) => {
  if (value === undefined) return now
  const start = Date.parse(value)
  if (!Number.isFinite(start)) throw new Error('Invalid search start time')
  return start
}

export const waitForSearchStart = async (start, { now = Date.now, wait = sleep } = {}) => {
  while (now() < start) await wait(Math.min(1000, start - now()))
}

// One browser and one outstanding search; the interval is a minimum between starts.
export async function* searchAttempts(targets, polling, start, { now = Date.now, wait = sleep } = {}) {
  await waitForSearchStart(start, { now, wait })
  if (!polling) {
    for (const target of targets) yield { target, attempt: 1 }
    return
  }
  const deadline = start + polling.durationSeconds * 1000
  const repeated = polling.fallbackMode === 'after-window' ? targets.filter(target => target.priority === 0) : targets
  let nextStart = start
  let attempt = 0
  while (now() < deadline) {
    for (const target of repeated) {
      if (nextStart > now()) await wait(Math.min(nextStart, deadline) - now())
      if (now() >= deadline) break
      nextStart = now() + polling.intervalSeconds * 1000
      yield { target, attempt: ++attempt, deadline }
    }
  }
  // A final fallback sweep does not start another polling window.
  if (polling.fallbackMode === 'after-window') {
    for (const target of targets.filter(target => target.priority > 0)) yield { target, attempt: ++attempt, finalFallback: true }
  }
}
