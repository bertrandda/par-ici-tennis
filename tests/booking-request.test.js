import assert from 'node:assert/strict'
import { test } from 'node:test'
import dayjs from 'dayjs'
import { buildBookingConfig, getBookingSchedule, normalizeBookingRequest } from '../lib/booking-request.js'

const validRequest = () => ({
  date: '21/9/2026',
  locations: ['Max Rousié', 'Jesse Owens'],
  hours: [18, '19'],
  courtType: ['Couvert'],
  players: [{ lastName: 'DUPONT', firstName: 'Paul' }],
})

test('booking requests are normalized and scheduled six days before the target', () => {
  const request = normalizeBookingRequest(validRequest(), { now: dayjs('2026-09-11T12:00:00+02:00') })
  assert.equal(request.date, '21/09/2026')
  assert.deepEqual(request.hours, ['18', '19'])
  assert.deepEqual(getBookingSchedule(request), {
    scheduleAt: '2026-09-15T07:55:00+02:00',
    bookingOpensAt: '2026-09-15T08:00:00+02:00',
  })
})

test('booking schedules use the Europe/Paris winter offset', () => {
  const request = normalizeBookingRequest({ ...validRequest(), date: '04/01/2027' }, { now: dayjs('2026-12-20T12:00:00+01:00') })
  assert.deepEqual(getBookingSchedule(request), {
    scheduleAt: '2026-12-29T07:55:00+01:00',
    bookingOpensAt: '2026-12-29T08:00:00+01:00',
  })
})

test('variable requests cannot contain fixed configuration fields', () => {
  assert.throws(() => normalizeBookingRequest({ ...validRequest(), priceType: ['Tarif plein'] }), /Unsupported booking request fields: priceType/)
})

test('requests require one to three partners and a future opening time', () => {
  assert.throws(() => normalizeBookingRequest({ ...validRequest(), players: [] }), /between one and three partners/)
  assert.throws(() => normalizeBookingRequest(validRequest(), { now: dayjs('2026-09-15T08:00:00+02:00') }), /already passed/)
})

test('temporary booking config preserves account, price and notifications', () => {
  const request = normalizeBookingRequest(validRequest(), { now: dayjs('2026-09-11T12:00:00+02:00') })
  const config = buildBookingConfig({
    account: { email: 'fixed@example.test', password: 'secret' },
    priceType: ['Gratuité'],
    ntfy: { enable: true, topic: 'fixed-topic' },
  }, request)
  assert.equal(config.account.password, 'secret')
  assert.deepEqual(config.priceType, ['Gratuité'])
  assert.equal(config.ntfy.topic, 'fixed-topic')
  assert.deepEqual(config.locations, validRequest().locations)
})

test('opening times recalculate the Paris offset across both DST transitions', () => {
  assert.deepEqual(getBookingSchedule({ date: '27/10/2026' }), {
    scheduleAt: '2026-10-21T07:55:00+02:00', bookingOpensAt: '2026-10-21T08:00:00+02:00',
  })
  assert.deepEqual(getBookingSchedule({ date: '30/03/2027' }), {
    scheduleAt: '2027-03-24T07:55:00+01:00', bookingOpensAt: '2027-03-24T08:00:00+01:00',
  })
  assert.throws(() => normalizeBookingRequest({ ...validRequest(), date: '27/10/2026' }, { now: dayjs('2026-10-21T08:30:00+02:00') }), /already passed/)
})

test('a string dryRun flag cannot silently create a real booking', () => {
  assert.throws(() => normalizeBookingRequest({ ...validRequest(), dryRun: 'true' }), /boolean/)
})
