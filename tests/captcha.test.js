import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { Client } from '@gradio/client'
import { waitForStep } from '../lib/captcha.js'
import { huggingFaceAPI } from '../lib/huggingface.js'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

const fixture = async (t) => {
  const page = await browser.newPage()
  t.after(() => page.close())
  const src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="white"/><text x="5" y="25">AbC4</text></svg>')
  await page.setContent('<button id="proceed" hidden onclick="document.querySelector(\'.ready\').hidden=false">Poursuivre la réservation</button><div class="ready" hidden>Booking step</div>')
  await page.evaluate(html => {
    const frame = globalThis.document.createElement('iframe')
    frame.srcdoc = html
    globalThis.document.body.append(frame)
  }, `<div id="li-antibot-questions-container"><img src="${src}"></div>
    <input id="li-antibot-answer"><button id="li-antibot-validate" onclick="
      if(document.querySelector('input').value==='AbC4') {
        parent.document.querySelector('#proceed').hidden=false;
      } else {
        document.querySelector('img').style.width=(100+(++window.rejected)*10)+'px';
      }
    ">Validate</button><script>window.rejected=0</script>`)
  await page.frameLocator('iframe').locator('#li-antibot-answer').waitFor()
  return page
}

test('no CAPTCHA makes no inference call', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setContent('<div class="ready">Booking step</div>')
  await waitForStep(page, '.ready', {}, () => assert.fail('Unexpected inference'))
})

test('a late booking step wakes the bounded visible wait without invoking recognition', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setContent('<div class="ready" hidden>Booking step</div>')
  // Trigger the transition only once the event-driven wait has been armed.
  const locator = page.locator.bind(page)
  let waiting = false
  page.locator = (...args) => {
    const result = locator(...args)
    const wait = result.waitFor.bind(result)
    result.waitFor = async options => {
      waiting = true
      await page.evaluate(() => { setTimeout(() => { globalThis.document.querySelector('.ready').hidden = false }, 30) })
      return wait(options)
    }
    return result
  }
  await waitForStep(page, '.ready', { timeoutMs: 1000 }, () => assert.fail('Unexpected recognition'))
  assert.equal(waiting, true)
  assert.equal(await locator('.ready').isVisible(), true)
})

test('recognized text unlocks continuation without confirming a booking', async t => {
  const page = await fixture(t)
  let calls = 0
  await waitForStep(page, '.ready', { timeoutMs: 5000 }, async blob => {
    calls++
    assert.equal(blob.type, 'image/png')
    assert.ok(blob.size > 0)
    return 'AbC4'
  })
  assert.equal(calls, 1)
  assert.equal(await page.locator('.ready').isVisible(), true)
})

test('rejected answers stop after two attempts in headless mode', async t => {
  const page = await fixture(t)
  let calls = 0
  await assert.rejects(waitForStep(page, '.ready', { timeoutMs: 5000 }, async () => {
    calls++
    return 'Wrong'
  }), /attempt limit reached/)
  assert.equal(calls, 2)
  assert.equal(await page.locator('.ready').isVisible(), false)
})

test('an accepted CAPTCHA is not recaptured while the booking page loads', async t => {
  const page = await fixture(t)
  await page.frameLocator('iframe').locator('#li-antibot-validate').evaluate(button => {
    button.onclick = () => {
      const note = globalThis.document.createElement('div')
      note.id = 'li-antibot-check-note'
      note.textContent = 'Vérifié avec succès'
      globalThis.document.body.append(note)
      globalThis.document.querySelector('img').style.width = '25px'
      setTimeout(() => { globalThis.parent.document.querySelector('.ready').hidden = false }, 1200)
    }
  })
  let calls = 0
  await waitForStep(page, '.ready', { ai: { maxAttempts: 1 }, timeoutMs: 5000 }, async () => {
    calls++
    return 'AbC4'
  })
  assert.equal(calls, 1)
  assert.equal(await page.locator('.ready').isVisible(), true)
})

test('headless validation waits for the widget to process the entered answer', async t => {
  const page = await fixture(t)
  await page.frameLocator('iframe').locator('#li-antibot-answer').evaluate(input => {
    let processedAnswer = ''
    input.oninput = () => { setTimeout(() => { processedAnswer = input.value }, 150) }
    globalThis.document.querySelector('#li-antibot-validate').onclick = () => {
      if (processedAnswer === 'AbC4') globalThis.parent.document.querySelector('#proceed').hidden = false
    }
  })
  let calls = 0
  await waitForStep(page, '.ready', { timeoutMs: 5000 }, async () => {
    calls++
    return 'AbC4'
  })
  assert.equal(calls, 1)
  assert.equal(await page.locator('.ready').isVisible(), true)
})

test('a frame navigation during capture resumes at the next booking step', async t => {
  const page = await fixture(t)
  const frame = page.frames().find(frame => frame !== page.mainFrame())
  const locator = frame.locator.bind(frame)
  t.mock.method(frame, 'locator', (selector, ...args) => {
    const result = locator(selector, ...args)
    if (selector === '#li-antibot-questions-container img') {
      result.screenshot = async () => {
        await page.locator('.ready').evaluate(el => { el.hidden = false })
        throw new Error('Protocol error (DOM.scrollIntoViewIfNeeded): Cannot find context with specified id')
      }
    }
    return result
  })
  await waitForStep(page, '.ready', { timeoutMs: 5000 }, () => assert.fail('Unexpected inference'))
  assert.equal(await page.locator('.ready').isVisible(), true)
})

for (const selector of ['#li-antibot-answer', '#li-antibot-questions-container img']) {
  test(`a detached frame during ${selector} visibility is retried`, async t => {
    const page = await fixture(t)
    const frame = page.frames().find(frame => frame !== page.mainFrame())
    const locator = frame.locator.bind(frame)
    let detached = false
    t.mock.method(frame, 'locator', (value, ...args) => {
      const result = locator(value, ...args)
      if (value === selector) {
        const isVisible = result.isVisible.bind(result)
        result.isVisible = async () => {
          if (!detached) {
            detached = true
            await page.locator('.ready').evaluate(el => { el.hidden = false })
            throw new Error('locator.isVisible: Frame was detached')
          }
          return isVisible()
        }
      }
      return result
    })
    await waitForStep(page, '.ready', { timeoutMs: 5000 }, () => assert.fail('Unexpected inference'))
    assert.equal(detached, true)
    assert.equal(await page.locator('.ready').isVisible(), true)
  })
}

test('unexpected visibility errors are not swallowed as frame navigation', async t => {
  const page = await fixture(t)
  const frame = page.frames().find(frame => frame !== page.mainFrame())
  const locator = frame.locator.bind(frame)
  t.mock.method(frame, 'locator', (selector, ...args) => {
    const result = locator(selector, ...args)
    if (selector === '#li-antibot-answer') result.isVisible = async () => { throw new Error('Unexpected browser error') }
    return result
  })
  await assert.rejects(waitForStep(page, '.ready', { timeoutMs: 5000 }), /Unexpected browser error/)
})

test('provider failure allows manual completion in headed mode', async t => {
  const page = await fixture(t)
  let signalFailure
  const failed = new Promise(resolve => { signalFailure = resolve })
  const waiting = waitForStep(page, '.ready', { headed: true, timeoutMs: 5000 }, async () => {
    signalFailure()
    throw new Error('Space unavailable')
  })
  await failed
  await page.frameLocator('iframe').locator('#li-antibot-answer').fill('AbC4')
  await page.frameLocator('iframe').locator('#li-antibot-validate').click()
  await waiting
  assert.equal(await page.locator('.ready').isVisible(), true)
})

test('disabled recognition stops headless mode without contacting HF', async t => {
  const page = await fixture(t)
  await assert.rejects(waitForStep(page, '.ready', { ai: { enable: false }, timeoutMs: 2000 }, () => assert.fail('Unexpected inference')), /recognition is disabled/)
})

test('HF adapter preserves four-character mixed-case answers and closes its client', async t => {
  let closed = false
  t.mock.method(Client, 'connect', async () => ({
    predict: async (endpoint, data) => {
      assert.equal(endpoint, '/predict')
      assert.ok(data.input instanceof Blob)
      return { data: [' AbC4 '] }
    },
    close: () => { closed = true },
  }))
  assert.equal(await huggingFaceAPI(new Blob(['image'])), 'AbC4')
  assert.equal(closed, true)
})

test('HF adapter rejects prose instead of submitting it as an answer', async t => {
  t.mock.method(Client, 'connect', async () => ({ predict: async () => ({ data: ['Service unavailable'] }), close: () => {} }))
  await assert.rejects(huggingFaceAPI(new Blob(['image'])), /invalid CAPTCHA answer/)
})

test('HF inference has a bounded timeout and closes the client', async t => {
  let closed = false
  t.mock.method(Client, 'connect', async () => ({ predict: () => new Promise(() => {}), close: () => { closed = true } }))
  await assert.rejects(huggingFaceAPI(new Blob(['image']), { timeoutMs: 1000 }), /timed out/)
  assert.equal(closed, true)
})
