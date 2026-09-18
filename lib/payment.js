// Select the site's payment card so its own handler enables the next step.
// This prepares checkout only: clicking the returned button confirms the booking.
export const preparePayment = async (page, { free = false } = {}) => {
  const mode = free ? 'free' : 'existingTicket'
  const submitSelector = '.step-two #submit:not(.disabled):not([disabled]):not([aria-disabled="true"])'
  const selectCard = async () => {
    const card = page.locator(`.priceTable .price-item[paymentMode="${mode}"]`)
    if (await card.count() !== 1) throw new Error(free ? 'Free payment card unavailable' : 'No compatible existing credit offered at checkout; card payment is not supported')
    await card.click()
  }

  await selectCard()
  let submit = page.locator(submitSelector)
  try {
    await submit.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    // Paris Tennis can ignore the first native card click while retaining the hold.
    // Reloading stays on the payment step; retry the same native selection once.
    await page.reload()
    await page.waitForSelector('.priceTable')
    await selectCard()
    submit = page.locator(submitSelector)
    await submit.waitFor({ state: 'visible' })
  }
  if (!(await submit.isEnabled())) throw new Error('Payment next step is not enabled')
  return submit
}
