import { Client } from '@gradio/client'
import { config } from '../staticFiles.js'

export const huggingFaceAPI = async (captchaBlob) => {
  const client = await Client.connect(config.ai?.space || 'FatBoyEnglish/Text_Captcha_breaker')
  const result = await client.predict('/predict', {
    img_org: captchaBlob,
  })

  console.log(result.data[0])

  return result.data[0].replace(/\||-/gi, '').substr(0, 6)
}
