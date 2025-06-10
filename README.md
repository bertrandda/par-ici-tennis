# par-ici-tennis (*Paris i tennis*)

Script to automatically book a tennis court (on https://tennis.paris.fr)

**NOTE**: They recently added a CAPTCHA during reservation process. The latest version **should** pass through. If it fails, open an issue with error logs, I will try to find an other way.

## Get started
Create `config.json` file from `config.json.sample` and complete with your preferences.

`location`: a list of courts ordered by preference - [full list](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens)

`date` a string representing a date formated D/M/YYYY, if not set the date 6 days in future is used

`hours` a list of hours ordered by preference

`priceType` an array containing price type you can book `Tarif plein` and/or `Tarif réduit`

`courtType` an array containing court type you can book `Découvert` and/or `Couvert`

`players` list of players 3 max (without you)

To pass the payement phase without trouble you need a "carnet de réservation", be carefull you need a "carnet" that maches with your `priceType` & `courtType` [combination](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=rate&view=les_tarifs) selected previously

To run this project locally, install the dependencies

```sh
npm install
```

and run the script:

```sh
npm start
```

To test your configuration, you can run this project in dry-run mode. It will check court availability but no reservations will be made:

> [!IMPORTANT]
> due to a bug on the booking website, it is temporarily impossible to cancel a booking before final payment. The dry-run is therefore non-functional, and the command has been deactivated to avoid leaving an unsuccessful order. You can still try out using the classic launch command `npm start`, but you'll have to cancel the reservation manually (possible up to 24 hours before the reservation date).

```sh
npm run start-dry
```

You can start script automatically using cron or equivalent