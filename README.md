# par-ici-tennis (_Paris ici tennis_)

Script to automatically book a tennis court (on https://tennis.paris.fr)

**NOTE**: They recently added a CAPTCHA during reservation process. The latest version **should** pass through. If it fails, open an issue with error logs, I will try to find an other way.

## Get started

Create `config.json` file from `config.json.sample` and complete with your preferences.

`location`: a list of courts ordered by preference - [full list](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens)

`date` a string representing a date formated D/M/YYYY. Leave empty to select current date plus 6 days to book the newest courts.

`hours` a list of hours

`courtType` an array containing court type ordered by preference: you can book `Découvert` and/or `Couvert`

`surfaceType` an array containing surface type ordered by preference: you can book `Gazon synthétique` and/or `Résine` and/or `Terre battue` and/or `Béton poreux` and/or `Bitume` and/or `Synthétique`

`priceType` an array containing price type ordered by preference: you can book `Tarif plein` and/or `Tarif réduit`

`players` list of players 3 max (without you)

The script first selects the best hour, followed by the best court type, surface type, and finally, price type.

To pass the payement phase without trouble you need a "carnet de réservation", be carefull you need a "carnet" that maches with your `priceType` & `courtType` [combination](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=rate&view=les_tarifs) selected previously.

## Installation

To run this project locally, install node from this [url](https://nodejs.org/en/download/prebuilt-installer).

Open a terminal, locate the package and install the dependencies:

```sh
cd par-ici-tennis
npm install
```

Then run the script:

```sh
npm start
```

# Run automatically

You can start script automatically using cron or the task scheduler.

## Using a Cron Job (Linux/macOS):

If you're on a Linux or macOS system, you can use cron to schedule tasks.

Open your terminal and type `crontab -e` to edit your cron jobs.

Add a line like this to run your script at 8 AM every day:

```sh
0 8 * * * cd par-ici-tennis && npm start
```

Save and exit the editor (crontab -e saves automatically on exit).

## Using Task Scheduler (Windows):

On Windows, you can use the Task Scheduler.

Open your terminal and type the following to add a new task every day at 8.

```sh
schtasks /create /tn par-ici-tennis /tr "cd par-ici-tennis && npm start" /sc daily /st 08:00
```
