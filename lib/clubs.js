import { withSitePage, siteUrl } from './site-session.js'
import { courtSport } from './sport.js'

export const CLUBS_URL = siteUrl('page=tennisParisien&view=les_tennis_parisiens')
const normalize = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^tennis /, '')

// The public map embeds the same official names used by the search autocomplete.
// Parse data only; never evaluate scripts returned by the site.
export const parseClubCatalog = html => {
  const match = html.match(/\bvar\s+tennis\s*=\s*(\{[^\r\n]*\})\s*;/)
  if (!match) throw new Error('Official club catalogue not found; the site may have changed')
  const data = JSON.parse(match[1])
  if (!Array.isArray(data.features) || !data.features.length) throw new Error('Empty official club catalogue')
  return data.features.map(feature => {
    const item = feature.properties?.general
    if (!Number.isInteger(item?._id) || !item._nomSrtm || !Number.isInteger(item._arrondissement)) throw new Error('Invalid official club entry')
    return {
      id: String(item._id),
      name: item._nomSrtm,
      arrondissement: item._arrondissement,
      address: [item._adresse, item._codePostal, item._ville].filter(Boolean).join(', '),
      courts: (feature.properties.courts || []).map(court => ({
        id: String(court._airId), name: court._airNom, covered: court._airCvt === 'V',
        sport: courtSport(court._airNom || ''),
        number: Number.isInteger(court._formattedAirNum) ? court._formattedAirNum : Number(court._airNom?.match(/n[°º]\s*(\d+)/i)?.[1]) || null,
      })),
    }
  })
}

export const loadClubCatalog = (options = {}) => withSitePage(async page => {
  const response = await page.goto(CLUBS_URL)
  if (!response?.ok()) throw new Error(`Cannot load official club catalogue (${response?.status()})`)
  return parseClubCatalog(await page.content())
}, options)

const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j] ? 1 : 0)))
    row = next
  }
  return row[b.length]
}

export const findClubs = (catalog, { query = '', arrondissement } = {}) => {
  if (arrondissement !== undefined && (!Number.isInteger(Number(arrondissement)) || Number(arrondissement) < 1 || Number(arrondissement) > 20)) throw new Error('arrondissement must be between 1 and 20')
  const clubs = catalog.filter(club => arrondissement === undefined || club.arrondissement === Number(arrondissement))
  if (!query.trim()) return { match: 'all', clubs }
  const key = normalize(query)
  const exact = clubs.filter(club => normalize(club.name) === key || club.id === query)
  if (exact.length) return { match: 'exact', clubs: exact }
  const partial = clubs.filter(club => normalize(club.name).includes(key))
  if (partial.length) return { match: 'partial', clubs: partial }
  return { match: 'suggestions', clubs: clubs.filter(club => distance(normalize(club.name), key) <= 3) }
}

export const resolveClub = (catalog, query) => {
  const result = findClubs(catalog, { query })
  const names = [...new Set(result.clubs.map(club => club.name))]
  if (result.match === 'suggestions' || names.length !== 1) {
    const error = new Error(`Unknown or ambiguous club: ${query}. Choose an exact official name${names.length ? `: ${names.join(', ')}` : ''}`)
    error.candidates = result.clubs
    throw error
  }
  return { name: names[0], ids: result.clubs.map(club => club.id) }
}

export const resolveLocations = (catalog, locations) => {
  const names = Array.isArray(locations) ? locations : Object.keys(locations)
  const clubs = names.map(name => resolveClub(catalog, name))
  if (new Set(clubs.map(club => club.name)).size !== clubs.length) throw new Error('The same club was requested more than once')
  return {
    clubs,
    locations: Array.isArray(locations) ? clubs.map(club => club.name) : Object.fromEntries(clubs.map((club, i) => [club.name, locations[names[i]]])),
  }
}
