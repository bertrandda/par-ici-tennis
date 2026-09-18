export const normalizeSport = (sport = 'tennis') => {
  if (!['tennis', 'padel'].includes(sport)) throw new Error('sport must be tennis or padel')
  return sport
}

export const validateSportPlayers = (sport, players) => {
  if (normalizeSport(sport) === 'padel' && (!Array.isArray(players) || players.length < 1 || players.length > 3)) {
    throw new Error('Padel accepts between one and three partners in addition to the account holder')
  }
}

export const courtSport = name => /^padel\b/i.test(name) ? 'padel' : /^(?:(?:TEP\/)?court|gymnase)\b/i.test(name) ? 'tennis' : null

export const validateClubSport = (name, sport) => {
  if (/^padel\b/i.test(name) && normalizeSport(sport) !== 'padel') throw new Error('Set sport to padel when choosing a Padel club')
}

export const selectClubCourts = (catalog, name, { sport = 'tennis', courtNumbers = [] } = {}) => {
  normalizeSport(sport)
  validateClubSport(name, sport)
  const courts = catalog.filter(club => club.name === name).flatMap(club => club.courts || [])
    .filter(court => (court.sport ?? courtSport(court.name)) === sport
      && (!courtNumbers.length || courtNumbers.includes(court.number)))
  if (!courts.length) throw new Error(`No ${sport} courts matching the requested numbers at ${name}`)
  return new Set(courts.map(court => court.id))
}
