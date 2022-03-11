const { chromium } = require('playwright')
const dayjs = require('dayjs')
const customParseFormat = require('dayjs/plugin/customParseFormat')
const config = require('./config.json')

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 10, timeout: 120000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
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

  await new Promise(r => setTimeout(r, 500));

  try {
    for (const location of config.locations) {
      console.log(`${dayjs().format()} - Search at ${location}`)
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

      // select tennis location
      await page.type('.tokens-input-text', location)
      await new Promise(r => setTimeout(r, 300));
      await page.press('.tokens-input-text', 'ArrowDown');
      await page.press('.tokens-input-text', 'Enter');

      // select date
      await page.click('#when')
      await new Promise(r => setTimeout(r, 1000));
      const date = dayjs(config.date, 'D/MM/YYYY')
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await new Promise(r => setTimeout(r, 300));

      await page.click('#rechercher')

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

      for (const [i, player] of config.players.entries()) {
        if (i < config.players.length - 1) {
          await page.click('.addPlayer')
        }
      }
      await new Promise(r => setTimeout(r, 100));

      for (const [i, player] of config.players.entries()) {
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
      }

      await page.keyboard.press('Enter');

      await page.click('[paymentmode="existingTicket"]')

      await page.click('#submit')

      await new Promise(r => setTimeout(r, 100));

      if (await page.$('.confirmReservation')) {
        console.log(`${dayjs().format()} - Réservation faite : ${await (
          await (await page.$('.address')).textContent()
        ).trim().replace(/( ){2,}/g, ' ')}`)
        console.log(`pour le ${await (
          await (await page.$('.date')).textContent()
        ).trim().replace(/( ){2,}/g, ' ')}`)
        break
      }
    }
  } catch (e) {
    console.log(e);
    await page.screenshot({ path: 'failure.png' });
  }

  await browser.close()
}

bookTennis()
