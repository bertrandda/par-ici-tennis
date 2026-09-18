import { describeBookingAccounts, resolveBookingProfile } from './config.js'

export const migrateBookingAccounts = source => {
  const migrated = structuredClone(source)
  if (!Array.isArray(source.bookingAccounts)) {
    migrated.bookingAccounts = describeBookingAccounts(source).map(({ id }) => {
      const profile = resolveBookingProfile(source, id)
      return { ...structuredClone(profile.account), priceType: [...profile.priceType] }
    })
    delete migrated.account
    delete migrated.priceType
  }
  describeBookingAccounts(migrated)
  return migrated
}

// Resolve old keys before removing them; persist names so reordering is harmless.
export const migrateAccountReferences = (request, source, migrated) => {
  const nameFor = selector => {
    const old = resolveBookingProfile(source, selector)
    const current = resolveBookingProfile(migrated, old.name)
    if (old.account.email !== current.account.email || old.account.password !== current.account.password) throw new Error('Account migration changed booking identity')
    return current.id
  }
  return {
    ...request,
    bookingAccount: nameFor(request.bookingAccount),
    ...(request.consecutive ? { consecutive: { ...request.consecutive, bookingAccount: nameFor(request.consecutive.bookingAccount) } } : {}),
  }
}
