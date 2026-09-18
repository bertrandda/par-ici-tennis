#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const destination = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'skills', 'tennis-booking')
const placeholder = '{{PROJECT_DIR}}'
const template = readFileSync(join(root, 'skills/tennis-booking/SKILL.md'), 'utf8')
if (!template.includes(placeholder)) throw new Error(`Missing ${placeholder} in the versioned skill`)
const rendered = template.replaceAll(placeholder, root)

mkdirSync(destination, { recursive: true, mode: 0o700 })
const file = join(destination, 'SKILL.md')
if (existsSync(file)) copyFileSync(file, join(destination, `SKILL.md.backup-${Date.now()}`))
writeFileSync(file, rendered, { mode: 0o600 })
chmodSync(file, 0o600)
const references = join(root, 'skills/tennis-booking/references')
if (existsSync(references)) {
  const output = join(destination, 'references')
  mkdirSync(output, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(references, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const target = join(output, entry.name)
    if (existsSync(target)) copyFileSync(target, `${target}.backup-${Date.now()}`)
    writeFileSync(target, readFileSync(join(references, entry.name), 'utf8').replaceAll(placeholder, root), { mode: 0o600 })
    chmodSync(target, 0o600)
  }
}
process.stdout.write(`Hermes skill installed: ${file}\n`)
