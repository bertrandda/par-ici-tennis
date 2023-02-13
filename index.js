const { chromium } = require('playwright')
const dayjs = require('dayjs')
const customParseFormat = require('dayjs/plugin/customParseFormat')
const config = require('./config.json')

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 120000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
  page.setDefaultTimeout(120000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#button_suivi_inscription'),
  ])
  await popup.waitForLoadState()
  await popup.fill('#username-login', config.account.email)
  await popup.fill('#password-login', config.account.password)
  await popup.click('section >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  try {
    for (const location of config.locations) {
      console.log(`${dayjs().format()} - Search at ${location}`)
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

      // select tennis location
      await page.type('.tokens-input-text', location)
      await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

      // select date
      await page.click('#when')
      const date = dayjs(config.date, 'D/MM/YYYY')
      await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.waitForSelector('.date-picker', { state: 'hidden' })

      await page.click('#rechercher')

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState('domcontentloaded')

      hoursLoop:
      for (const hour of config.hours) {
        const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
        if (await page.$(dateDeb)) {
          if (await page.isHidden(dateDeb)) {
            await page.click(`#head${location.replaceAll(' ', '')}${hour}h .panel-title`)
          }

          const slots = await page.$$(dateDeb)
          for (const slot of slots) {
            const bookSlotButton = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
            const [priceType, courtType] = await (
              await (await page.$(`.price-description:left-of(${bookSlotButton})`)).innerHTML()
            ).split('<br>')
            if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) {
              continue
            }
            await page.click(bookSlotButton)

            break hoursLoop
          }
        }
      }

      if (await page.title() !== 'Paris | TENNIS - Reservation') {
        console.log(`${dayjs().format()} - Failed to find reservation for ${location}`)
        continue
      }

      await page.waitForLoadState('domcontentloaded')

      if (await page.$('.captcha')) {
        await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=reservation&view=reservation_creneau')
        await page.waitForLoadState('domcontentloaded')
      }


      for (const [i, player] of config.players.entries()) {
        if (i > 0 && i < config.players.length) {
          await page.click('.addPlayer')
        }
        await page.waitForSelector(`[name="player${i + 1}"]`)
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
      }

      await page.keyboard.press('Enter')

      await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
      const paymentMode = await page.$('#order_select_payment_form #paymentMode')
      await paymentMode.evaluate(el => {
        el.removeAttribute('readonly')
        el.style.display = 'block'
      })
      await paymentMode.fill('existingTicket')

      const submit = await page.$('#order_select_payment_form #envoyer')
      submit.evaluate(el => el.classList.remove('hide'))
      await submit.click()

      await page.waitForSelector('.confirmReservation')

      console.log(`${dayjs().format()} - Réservation faite : ${await (
        await (await page.$('.address')).textContent()
      ).trim().replace(/( ){2,}/g, ' ')}`)
      console.log(`pour le ${await (
        await (await page.$('.date')).textContent()
      ).trim().replace(/( ){2,}/g, ' ')}`)
      break
    }
  } catch (e) {
    console.log(e)
    await page.screenshot({ path: 'failure.png' })
  }

  await browser.close()
}

bookTennis()
