#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  attachCaptchaWarmupCronJob,
  attachCronJob,
  cancelBookingJob,
  editBookingJob,
  listBookingJobs,
  prepareCaptchaWarmup,
  prepareBookingJob,
  readBookingJob,
  removeBookingJob,
} from '../lib/booking-job.js'

console.log = (...values) => console.error(...values)

const [command, ...args] = process.argv.slice(2)
const getArgument = (name) => {
  const index = args.indexOf(name)
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

try {
  if (command === 'prepare') {
    const inputPath = resolve(getArgument('--input'))
    const consume = args.includes('--consume')
    if (consume && (dirname(inputPath) !== '/tmp' || !/^tennis-booking-request-[a-zA-Z0-9-]+\.json$/.test(basename(inputPath)))) {
      throw new Error('--consume is restricted to /tmp/tennis-booking-request-*.json')
    }
    try {
      print(await prepareBookingJob(JSON.parse(readFileSync(inputPath, 'utf8'))))
    } finally {
      if (consume) rmSync(inputPath, { force: true })
    }
  } else if (command === 'attach') {
    const warmupIndex = args.indexOf('--captcha-warmup-cron-job-id')
    const attachments = warmupIndex === -1 ? {} : { captchaWarmupCronJobId: getArgument('--captcha-warmup-cron-job-id') }
    print(attachCronJob(getArgument('--request-id'), getArgument('--cron-job-id'), {}, attachments))
  } else if (command === 'captcha-warmup') {
    print(prepareCaptchaWarmup(getArgument('--request-id')))
  } else if (command === 'attach-captcha-warmup') {
    print(attachCaptchaWarmupCronJob(getArgument('--request-id'), getArgument('--cron-job-id')))
  } else if (command === 'list') {
    print(listBookingJobs())
  } else if (command === 'show') {
    print(readBookingJob(getArgument('--request-id')))
  } else if (command === 'cancel') {
    print(cancelBookingJob(getArgument('--request-id')))
  } else if (command === 'edit') {
    print(await editBookingJob(getArgument('--request-id'), JSON.parse(readFileSync(resolve(getArgument('--input')), 'utf8'))))
  } else if (command === 'cleanup') {
    print({ removed: removeBookingJob(getArgument('--request-id'))?.id || null })
  } else {
    throw new Error('Usage: booking-manager.js prepare|attach|captcha-warmup|attach-captcha-warmup|list|show|edit|cancel|cleanup')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
