const { chromium } = require("playwright");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const config = require("./config.json");

dayjs.extend(customParseFormat);

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 120000 })

  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
    timeout: 120000,
  });

  console.log(`${dayjs().format()} - Browser started`);
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(
    "https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1"
  );

  await page.click("#button_suivi_inscription");
  await page.fill("#username", config.account.email);
  await page.fill("#password", config.account.password);
  await page.click('button.btn.btn-primary.btn-lg[name="Submit"]');

  console.log(`${dayjs().format()} - User connected`);

  // wait for login redirection before continue
  await page.waitForSelector(".main-informations");

  try {
    locationsLoop:
    for (const location of config.locations) {
      console.log(`${dayjs().format()} - Search at ${location}`);
      await page.goto(
        "https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!"
      );

      await page.waitForLoadState("domcontentloaded");

      if ((await page.title()) === "Paris | TENNIS - Reservation") {
        console.log(
          `${dayjs().format()} - Reservation already in progress. Please cancel before restarting. Exiting...`
        );
        await browser.close();
        return;
      }

      // select tennis location
      await page.type(".tokens-input-text", location);
      await page.waitForSelector(
        `.tokens-suggestions-list-element >> text="${location}"`
      );
      await page.click(
        `.tokens-suggestions-list-element >> text="${location}"`
      );

      // select date
      await page.click("#when");
      const date = config.date
        ? dayjs(config.date, "D/MM/YYYY")
        : dayjs().add(6, "day");
      console.log(
        `${dayjs().format()} - Search ${
          config.date ? "" : "for newest courts "
        }on ${date.format("DD/MM/YYYY")}`
      );
      await page.waitForSelector(`[dateiso="${date.format("DD/MM/YYYY")}"]`);
      await page.click(`[dateiso="${date.format("DD/MM/YYYY")}"]`);
      await page.waitForSelector(".date-picker", { state: "hidden" });
      await page.click("#rechercher");
      console.log(`${dayjs().format()} - Search done`);

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState("domcontentloaded");

      let [
        bestHour,
        bestCourtType,
        bestSurfaceType,
        bestPriceType,
        bestBookSlotButton,
      ] = [null, null, null, null, null];

      hoursLoop: for (const hour of config.hours) {
        console.log(`${dayjs().format()} - Search at ${hour}h`);
        const dateDeb = `[datedeb="${date.format(
          "YYYY/MM/DD"
        )} ${hour}:00:00"]`;
        if (await page.$(dateDeb)) {
          console.log(`${dayjs().format()} - ${hour}h available`);
          bestHour = hour;

          const inputDateTime = dayjs(
            `${config.date} ${hour}`,
            "D/MM/YYYY HH:00"
          );
          const now = dayjs();
          const in24Hours = now.add(24, "hour");

          if (inputDateTime.isBefore(in24Hours)) {
            const userConfirmed = await confirmTomorrowBooking();
            if (!userConfirmed) {
              console.log(
                "User did not confirm booking for tomorrow. Exiting."
              );
              await browser.close();
              return;
            }
          }

          if (await page.isHidden(dateDeb)) {
            await page.evaluate((selector) => {
              document.querySelector(selector).click();
            }, `a[href="#collapse${location.replaceAll(" ", "")}${hour}h"]`);
          }

          console.log(`${dayjs().format()} - Finding best slot...`);

          const slots = await page.$$(dateDeb);

          for (const slot of slots) {
            const bookSlotButton = `[courtid="${await slot.getAttribute(
              "courtid"
            )}"]${dateDeb}`;
            const [priceType, courtType] = await (
              await (
                await page.$(`.price-description:left-of(${bookSlotButton})`)
              ).innerHTML()
            ).split("<br>");

            const surfaceType = (
              await page.evaluate(
                (element) => element.textContent,
                await page.$(".court")
              )
            )
              .match(/-\s+([^-]+)\s+-/)[1]
              .trim();

            if (
              !config.priceType.includes(priceType) ||
              !config.courtType.includes(courtType) ||
              !config.surfaceType.includes(surfaceType)
            ) {
              continue;
            }

            if (bestCourtType === null) {
              bestCourtType = courtType;
              bestSurfaceType = surfaceType;
              bestPriceType = priceType;
              bestBookSlotButton = bookSlotButton;
            } else if (
              config.courtType.indexOf(courtType) <=
              config.courtType.indexOf(bestCourtType)
            ) {
              if (
                config.surfaceType.indexOf(surfaceType) <=
                config.surfaceType.indexOf(bestSurfaceType)
              ) {
                if (
                  config.priceType.indexOf(priceType) <=
                  config.priceType.indexOf(bestPriceType)
                ) {
                  bestCourtType = courtType;
                  bestSurfaceType = surfaceType;
                  bestPriceType = priceType;
                  bestBookSlotButton = bookSlotButton;
                }
              }
            }
          }

          console.log(
            `${dayjs().format()} - Best slot found: ${bestCourtType} - ${bestSurfaceType} - ${bestPriceType}`
          );

          await page.evaluate((selector) => {
            document.querySelector(selector).click();
          }, `button[type="submit"]${bestBookSlotButton}`);

          console.log(`${dayjs().format()} - Slot selected`);

          await new Promise((resolve) => setTimeout(resolve, 500));

          const modal = await page.$(
            '#reservationEnCours[style*="display: block;"]'
          );
          if (modal !== null) {
            console.log(
              "Another reservation is already booked.\nPlease remove it before running par-ici-tennis.\nExiting..."
            );
            await browser.close();
            return;
          }

          await page.waitForLoadState("domcontentloaded");

          break hoursLoop;
        }
      }

      if ((await page.title()) !== "Paris | TENNIS - Reservation") {
        console.log(
          `${dayjs().format()} - Failed to find reservation for ${location}`
        );
        continue;
      }

      await page.waitForLoadState("domcontentloaded");

      if (await page.$(".captcha")) {
        await page.goto(
          "https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=reservation&view=reservation_creneau"
        );
        await page.waitForLoadState("domcontentloaded");
      }

      console.log(`${dayjs().format()} - Captcha bypassed`);

      for (const [i, player] of config.players.entries()) {
        console.log(`${dayjs().format()} - Adding player ${i + 1}`);
        if (i > 0 && i < config.players.length) {
          await page.click(".addPlayer");
        }
        await page.waitForSelector(`[name="player${i + 1}"]`);
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName);
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName);
      }

      await page.keyboard.press("Enter");

      console.log(`${dayjs().format()} - Players added`);

      await page.waitForSelector("#order_select_payment_form #paymentMode", {
        state: "attached",
      });
      const paymentMode = await page.$(
        "#order_select_payment_form #paymentMode"
      );
      await paymentMode.evaluate((el) => {
        el.removeAttribute("readonly");
        el.style.display = "block";
      });
      await paymentMode.fill("existingTicket");
      
      if (DRY_RUN_MODE) {
        console.log(`${dayjs().format()} - Fausse réservation faite : ${location}`)
        console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
        console.log('----- DRY RUN END -----')
        console.log("Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run")

        await page.click('#previous')
        await page.click('#btnCancelBooking')

        break locationsLoop
      }

      console.log(`${dayjs().format()} - Payment mode selected`);

      const submit = await page.$("#order_select_payment_form #envoyer");
      submit.evaluate((el) => el.classList.remove("hide"));
      await submit.click();

      console.log(`${dayjs().format()} - Submit clicked`);

      await page.waitForLoadState("domcontentloaded");

      if ((await page.title()) === "Error") {
        console.log(
          `${dayjs().format()} - FREE reservation made: at ${bestHour}h on ${date.format(
            "DD/MM/YYYY"
          )} at ${location} on ${bestSurfaceType} ${bestCourtType} in ${bestPriceType}`
        );
      } else {
        await page.waitForSelector(".confirmReservation");

        console.log(
          `${dayjs().format()} - Reservation made: ${await (
            await (await page.$(".address")).textContent()
          )
            .trim()
            .replace(/( ){2,}/g, " ")}`
        );
        console.log(
          `on ${await (await (await page.$(".date")).textContent())
            .trim()
            .replace(/( ){2,}/g, " ")}`
        );
        console.log(
          `on ${bestSurfaceType} ${bestCourtType} in ${bestPriceType}`
        );
      }
      break;
    }
  } catch (e) {
    console.log(e);
    await page.screenshot({ path: "failure.png" });
  }

  await browser.close();
};

// Function to prompt user for confirmation when booking for tomorrow
const confirmTomorrowBooking = async () => {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      "The booking date is in less than 24 hours. Do you want to proceed ?\nWARNING: You won't be able to cancel the reservation! (yes/no) ",
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "yes");
      }
    );
  });
};

bookTennis();
