import { Client } from '@gradio/client';

export const parseqAPI = async (captchaBlob) => {
    const client = await Client.connect('baudm/PARSeq-OCR');
    const result = await client.predict('/App', {
      model_name: 'parseq',
      image: captchaBlob,
    });
  
    console.log(result.data[0]);

    return result.data[0].replace(/\||-/gi, '').substr(0, 6)
}
