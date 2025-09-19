export const notify = async (file, message, config) => {
  try {
    await fetch(`https://${config.domain || 'ntfy.sh'}/${config.topic}`, {
      method: 'PUT',
      headers: {
        'Title': 'Paris Tennis',
        'Message': message,
        'Icon': 'https://em-content.zobj.net/source/apple/419/tennis_1f3be.png',
        'Filename': 'event.ics',
        'Tags': 'calendar',
      },
      body: file
    })
    console.log('ICS file sent via ntfy')
  } catch (err) {
    console.log('Error sending ICS file via ntfy:', err)
  }
}
