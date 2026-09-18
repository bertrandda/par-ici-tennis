import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { huggingFaceAPI } from './huggingface.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const DEFAULT_CAPTCHA_WARMUP_FIXTURE = resolve(root, 'fixtures/captcha-warmup.png')

export const prewarmCaptchaSpace = async ({
  ai = {},
  fixturePath = DEFAULT_CAPTCHA_WARMUP_FIXTURE,
  recognize = huggingFaceAPI,
  now = () => Date.now(),
} = {}) => {
  if (ai?.enable === false) return { status: 'disabled', elapsedMs: 0 }
  const startedAt = now()
  try {
    const bytes = readFileSync(resolve(fixturePath))
    const answer = await recognize(new Blob([bytes], { type: 'image/png' }), {
      ...ai,
      timeoutMs: Math.min(50000, Math.max(1000, Number(ai?.timeoutMs) || 30000)),
    })
    if (!/^[a-zA-Z0-9]{3,10}$/.test(answer)) throw new Error('Hugging Face returned an invalid CAPTCHA answer')
    return { status: 'warmed', elapsedMs: Math.max(0, now() - startedAt) }
  } catch (error) {
    return { status: 'failed', elapsedMs: Math.max(0, now() - startedAt), error: error.message || String(error) }
  }
}
