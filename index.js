const { chromium } = require("playwright");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const config = require("./config.json");

dayjs.extend(customParseFormat);

const bookTennis = async () => {
  console.log(`${dayjs().format()} - Starting searching tennis`);

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
    for (const location of config.locations) {
      console.log(`${dayjs().format()} - Search at ${location}`);
      await page.goto(
        "https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!"
      );

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
      const date = dayjs(config.date, "D/MM/YYYY");
      await page.waitForSelector(`[dateiso="${date.format("DD/MM/YYYY")}"]`);
      await page.click(`[dateiso="${date.format("DD/MM/YYYY")}"]`);
      await page.waitForSelector(".date-picker", { state: "hidden" });

      await page.click("#rechercher");
      console.log(`${dayjs().format()} - Search done`);

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState("domcontentloaded");

      hoursLoop: for (const hour of config.hours) {
        console.log(`${dayjs().format()} - Search at ${hour}h`);
        const dateDeb = `[datedeb="${date.format(
          "YYYY/MM/DD"
        )} ${hour}:00:00"]`;
        if (await page.$(dateDeb)) {
          console.log(`${dayjs().format()} - ${hour}h available`);

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
            console.log(`${dayjs().format()} - ${hour}h is now visible`);
          }

          const slots = await page.$$(dateDeb);
          for (const slot of slots) {
            console.log(`${dayjs().format()} - Search for slot`);
            const bookSlotButton = `[courtid="${await slot.getAttribute(
              "courtid"
            )}"]${dateDeb}`;
            const [priceType, courtType] = await (
              await (
                await page.$(`.price-description:left-of(${bookSlotButton})`)
              ).innerHTML()
            ).split("<br>");
            if (
              !config.priceType.includes(priceType) ||
              !config.courtType.includes(courtType)
            ) {
              continue;
            }
            console.log(`${dayjs().format()} - Slot found`);

            await page.evaluate((selector) => {
              document.querySelector(selector).click();
            }, `button[type="submit"]${bookSlotButton}`);

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

            await page.waitForNavigation({ waitUntil: "domcontentloaded" });

            break hoursLoop;
          }
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

      console.log(`${dayjs().format()} - Payment mode selected`);

      const submit = await page.$("#order_select_payment_form #envoyer");
      submit.evaluate((el) => el.classList.remove("hide"));
      await submit.click();

      console.log(`${dayjs().format()} - Submit clicked`);

      await page.waitForNavigation({ waitUntil: "domcontentloaded" });

      if ((await page.title()) === "Error") {
        console.log(
          `${dayjs().format()} - Réservation gratuite effectuée : ${hour} le ${date.format(
            "DD/MM/YYY"
          )}  à ${location}`
        );
      } else {
        await page.waitForSelector(".confirmReservation");

        console.log(
          `${dayjs().format()} - Réservation faite : ${await (
            await (await page.$(".address")).textContent()
          )
            .trim()
            .replace(/( ){2,}/g, " ")}`
        );
        console.log(
          `pour le ${await (await (await page.$(".date")).textContent())
            .trim()
            .replace(/( ){2,}/g, " ")}`
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
