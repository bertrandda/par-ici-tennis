import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findClubs, parseClubCatalog, resolveClub, resolveLocations } from '../lib/clubs.js'

const clubs = [
  { id: '293', name: 'Max Rousié', arrondissement: 17 },
  { id: '294', name: 'Jesse Owens', arrondissement: 18 },
  { id: '300', name: 'Tennis A', arrondissement: 18 },
  { id: '301', name: 'Tennis B', arrondissement: 18 },
]
test('official data is parsed without evaluating site JavaScript', () => {
  const data = { features: [{ properties: { general: { _id: 293, _nomSrtm: 'Max Rousié', _arrondissement: 17, _adresse: 'Rue', _codePostal: '75017', _ville: 'Paris' }, courts: [] } }] }
  assert.equal(parseClubCatalog(`<script>var tennis = ${JSON.stringify(data)};</script>`)[0].name, 'Max Rousié')
  assert.throws(() => parseClubCatalog('<h1>Service unavailable</h1>'), /not found/)
})
test('accent-insensitive exact matching preserves the official label and ID', () => {
  assert.deepEqual(resolveClub(clubs, 'max rousie'), { name: 'Max Rousié', ids: ['293'] })
  assert.deepEqual(resolveLocations(clubs, { 'max rousie': [1, 2] }).locations, { 'Max Rousié': [1, 2] })
  assert.deepEqual(findClubs(clubs, { arrondissement: '17' }).clubs, [clubs[0]])
  assert.throws(() => findClubs(clubs, { arrondissement: 21 }), /between/)
})
test('ambiguous names and fuzzy suggestions never silently choose a club', () => {
  assert.throws(() => resolveClub(clubs, 'Tennis'), /ambiguous/)
  assert.equal(findClubs(clubs, { query: 'Max Rousiee' }).match, 'suggestions')
  assert.throws(() => resolveClub(clubs, 'Max Rousiee'), /ambiguous/)
  assert.throws(() => resolveLocations(clubs, ['Max Rousié', 'max rousie']), /more than once/)
})
