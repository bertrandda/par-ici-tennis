#!/usr/bin/env node
import { loadAccountConfig } from '../lib/config.js'
import { prewarmCaptchaSpace } from '../lib/captcha-prewarm.js'

try {
  const config = loadAccountConfig()
  const result = await prewarmCaptchaSpace({ ai: config.ai })
  if (result.status === 'warmed') {
    process.stdout.write(`Hugging Face CAPTCHA space warmed in ${result.elapsedMs} ms.\n`)
  } else if (result.status === 'disabled') {
    process.stdout.write('Hugging Face CAPTCHA warmup skipped because recognition is disabled.\n')
  } else {
    process.stderr.write(`CAPTCHA warmup failed without blocking the booking: ${result.error}\n`)
  }
} catch (error) {
  process.stderr.write(`CAPTCHA warmup failed without blocking the booking: ${error.message || String(error)}\n`)
}
