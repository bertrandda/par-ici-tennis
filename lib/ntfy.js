export const notify = async (file, filename, message, config) => {
  try {
    const headers = {
      'Title': 'Paris Tennis',
      'Message': message,
      'Icon': 'https://em-content.zobj.net/source/apple/419/tennis_1f3be.png',
      'Tags': 'calendar',
    }
    if (filename) headers['Filename'] = filename
    await fetch(`https://${config.domain || 'ntfy.sh'}/${config.topic}`, {
      method: 'PUT',
      headers,
      body: file || undefined,
    })
    console.log('Notification sent via ntfy')
  } catch (err) {
    console.log('Error while sending notification using ntfy:', err)
  }
}
