import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prewarmCaptchaSpace } from '../lib/captcha-prewarm.js'

test('CAPTCHA warmup sends only the synthetic fixture and accepts a valid inference', async () => {
  let calls = 0
  const result = await prewarmCaptchaSpace({
    ai: { space: 'fixture/space', timeoutMs: 12000 },
    now: (() => { let value = 1000; return () => value += 25 })(),
    recognize: async (blob, options) => {
      calls++
      assert.equal(blob.type, 'image/png')
      assert.ok(blob.size > 0)
      assert.equal(options.space, 'fixture/space')
      assert.equal(options.timeoutMs, 12000)
      return 'WARM7'
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { status: 'warmed', elapsedMs: 25 })
})

test('CAPTCHA warmup is best effort and skips a disabled provider', async () => {
  const failed = await prewarmCaptchaSpace({ recognize: async () => { throw new Error('Space sleeping') } })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /Space sleeping/)

  const disabled = await prewarmCaptchaSpace({
    ai: { enable: false },
    recognize: async () => assert.fail('Disabled warmup must not call the provider'),
  })
  assert.deepEqual(disabled, { status: 'disabled', elapsedMs: 0 })
})
