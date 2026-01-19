export const notify = async (file, filename, message, config) => {
  try {
    await fetch(`https://${config.domain || 'ntfy.sh'}/${config.topic}`, {
      method: 'PUT',
      headers: {
        'Title': 'Paris Tennis',
        'Message': message,
        'Icon': 'https://em-content.zobj.net/source/apple/419/tennis_1f3be.png',
        'Filename': filename,
        'Tags': 'calendar',
      },
      body: file
    })
    console.log('Notification sent via ntfy')
  } catch (err) {
    console.log('Error while sending notification using ntfy:', err)
  }
}
