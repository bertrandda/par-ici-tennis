# par-ici-tennis (*Paris i tennis*)

Script to automatically book a tennis court (on https://tennis.paris.fr)

## Get started
Create `config.json` file from `config.json.sample` and complete with your preferences.

`location`: a list of courts ordered by preference - [full list](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens)

`date` a string representing a date formated D/M/YYYY

`hours` a list of hours ordered by preference

`priceType` an array containing price type you can book `Tarif plein` and/or `Tarif réduit`

`courtType` an array containing court type you can book `Découvert` and/or `Couvert`

`players` list of players 3 max (without you)

To pass the payement phase without trouble you need a "carnet de réservation", be carefull you need a "carnet" that maches with your `priceType` & `courtType` [combination](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=rate&view=les_tarifs) selected previously

To run this project locally, install the dependencies and run the script:

```sh
npm install
npm start
```
