import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

dayjs.extend(utc)
dayjs.extend(timezone)

const wait8AM = async () => {
  const now = dayjs().tz('Europe/Paris')
  let next8AM = now.hour(8).minute(0).second(0).millisecond(0)

  if (now.isAfter(next8AM)) {
    return
  }

  const waitMs = next8AM.diff(now)
  console.log(`Waiting until 8 AM Paris time (${next8AM.format()}) - sleeping for ${waitMs} ms`)

  return new Promise(resolve => setTimeout(resolve, waitMs))
}

wait8AM()
