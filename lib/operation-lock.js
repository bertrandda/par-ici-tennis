import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// No automatic stale-lock deletion: an interrupted payment may have succeeded.
export const acquireOperationLock = stateDirectory => {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const directory = join(stateDirectory, '.operation-lock')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another tennis operation is active or requires reconciliation: ${directory}`, { cause: error })
    throw error
  }
  try { writeFileSync(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 }) } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(directory, { recursive: true, force: true })
}
