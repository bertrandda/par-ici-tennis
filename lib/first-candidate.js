// Read and validate candidates in one browser call, stopping at the first match.
// Keep configured hour priority; "first" does not loosen tariff/court restrictions.
export const firstBookingCandidate = async (page, { target, date, courtIds, priceTypes }) => page.locator('[courtid][datedeb]').evaluateAll((slots, options) => {
  const allowedCourts = new Set(options.courtIds)
  for (const hour of options.target.hours) {
    const dateDeb = `${options.date} ${hour}:00:00`
    for (const slot of slots) {
      if (slot.getAttribute('datedeb') !== dateDeb) continue
      const courtId = slot.getAttribute('courtid')
      if (!allowedCourts.has(courtId) || (options.target.courtId && courtId !== options.target.courtId)) continue
      if (slot.matches(':disabled') || slot.getAttribute('aria-disabled') === 'true') continue
      const price = slot.closest('.row.tennis-court')?.querySelector('.price-description')?.cloneNode(true)
      if (!price) continue
      price.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
      const [priceType, courtType] = price.textContent.split('\n').map(value => value.trim()).filter(Boolean)
      if (!options.target.courtType.includes(courtType) || (options.priceTypes && !options.priceTypes.includes(priceType))) continue
      return { courtId, hour, priceType, courtType, selector: `[courtid="${courtId}"][datedeb="${dateDeb}"]`, key: `${courtId}/${options.date.replaceAll('/', '-')}/${hour}` }
    }
  }
  return null
}, { target, date: date.format('YYYY/MM/DD'), courtIds: [...courtIds], priceTypes })
