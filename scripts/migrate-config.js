#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VARIABLE_CONFIG_KEYS, mergeConfig } from '../lib/config.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourcePath = resolve(root, 'config.json')
const fixedPath = resolve(root, 'config.fixed.json')
const requestPath = resolve(root, 'config.request.json')

if (!existsSync(sourcePath)) throw new Error(`Missing source configuration: ${sourcePath}`)
if (existsSync(fixedPath) || existsSync(requestPath)) throw new Error('Split configuration files already exist')

const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
const request = Object.fromEntries(VARIABLE_CONFIG_KEYS
  .filter(key => Object.hasOwn(source, key))
  .map(key => [key, source[key]]))
const fixed = Object.fromEntries(Object.entries(source)
  .filter(([key]) => !VARIABLE_CONFIG_KEYS.includes(key)))

writeFileSync(fixedPath, `${JSON.stringify(fixed, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
chmodSync(fixedPath, 0o600)
chmodSync(requestPath, 0o600)

assert.deepEqual(mergeConfig(fixed, request), source)

if (process.argv.includes('--remove-source')) rmSync(sourcePath)

process.stdout.write('Configuration split successfully.\n')
