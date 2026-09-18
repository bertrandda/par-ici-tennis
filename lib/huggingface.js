import { Client } from '@gradio/client'
export const DEFAULT_CAPTCHA_SPACE = 'Nischay103/captcha_recognition'

const closeClient = (client) => {
  // Gradio 1.x otherwise logs an AbortError for our intentional stream shutdown.
  if (client?.stream_instance) client.stream_instance.onerror = null
  client?.close()
}

export const huggingFaceAPI = async (captchaBlob, options = {}) => {
  const timeoutMs = Math.min(60000, Math.max(1000, Number(options.timeoutMs) || 30000))
  let client
  let finished = false
  let timer
  try {
    const prediction = (async () => {
      const connected = await Client.connect(options.space || DEFAULT_CAPTCHA_SPACE)
      if (finished) {
        closeClient(connected)
        return
      }
      client = connected
      const result = await client.predict('/predict', { input: captchaBlob })
      const answer = typeof result.data?.[0] === 'string' ? result.data[0].trim() : ''
      // Preserve case and length: Paris Tennis does not always use six characters.
      if (!/^[a-zA-Z0-9]{3,10}$/.test(answer)) {
        throw new Error('Hugging Face returned an invalid CAPTCHA answer')
      }
      return answer
    })()
    return await Promise.race([
      prediction,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Hugging Face CAPTCHA request timed out')), timeoutMs)
      }),
    ])
  } finally {
    finished = true
    clearTimeout(timer)
    closeClient(client)
  }
}
