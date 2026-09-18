# Optimizing a Paris Tennis request

Use this guide when Hermes prepares or edits a booking. The purpose is to help the user make deliberate tradeoffs that increase coverage while preserving their real preferences.

## Conversation flow

1. Resolve the official club names and the selected accounts first.
2. Restate the user's hard constraints: date, participants, accounts, tariff, and whether one or two consecutive hours are required.
3. Identify only the criteria that could safely be relaxed: hours, ordered clubs, court type, or court number.
4. Give a short French recommendation and explain its effect.
5. If acceptance is unclear, ask one compact question covering the useful relaxations. Do not prepare the request until the answer is reflected exactly.
6. Show the effective optimization block in the complete booking summary.

Do not create a configuration field such as `optimizationMode`. “Strict” and “maximum chances” describe the conversation; translate the accepted choices into the existing request fields.

## Useful options

| User accepts | Request representation | Effect to explain |
|---|---|---|
| Any court at the same club | `courtSelection: "first"` | Stops scanning after the first compatible court and reaches checkout sooner. |
| Covered or uncovered | `courtType: "any"` | Searches both types; paid accounts still need a credit compatible with the court selected. |
| Several hours | Ordered `hours` | Gives more acceptable slots. Preserve the user's preferred hour first. |
| Several clubs | Ordered primary locations or `fallbacks` | Gives more places to try. Explain the order and when the fallback starts. |
| Two consecutive hours | `consecutive` with two explicitly selected accounts | Runs the two legs independently in isolated browsers; either confirmed hour is kept if the other fails. |
| Opening-time search | `polling: {"intervalSeconds":1,"durationSeconds":120,"fallbackMode":"after-window"}` | Keeps trying the primary choice once per second for two minutes, then performs the ordered fallback sweep. |

More choices increase coverage, but every extra primary target takes time to inspect. Keep the highest-priority club and hour first. When the user strongly prefers one scarce target, keep it as the primary choice throughout the opening window and put acceptable alternatives in `fallbacks` with `fallbackMode: "after-window"`.

Do not reduce `intervalSeconds` below 1. Do not extend the two-minute opening window or use `each-cycle` unless the user explicitly asks after the timing tradeoff is explained. The runner already keeps the booking sessions warm and reloads the marked results page at opening; adding another scheduler or process creates lock contention rather than speed.

## Account readiness

For every selected paid account, run the existing live compatible-credit check. State which court types the balance can actually pay for. Reusing configured `defaultPlayers` avoids missing participant details, but confirm that those people are really participating. A free account does not need carnet credit.

For consecutive hours, explain that the two accounts operate independently. A success for only one hour is retained. Never add a second account merely because it exists in configuration, and never swap accounts without the user's choice.

## User-facing wording

Adapt this example rather than copying it mechanically:

```text
Pour maximiser tes chances, je te propose :
- 20 h en priorité, puis 19 h si cela te convient ;
- Padel Jules Ladoumègue pendant la fenêtre d'ouverture, puis le club de repli ;
- le premier terrain compatible, couvert ou découvert seulement si tu acceptes les deux ;
- une vérification chaque seconde pendant deux minutes à partir de 8 h.

Cela augmente les créneaux acceptables, mais ne garantit pas une place : le site, le CAPTCHA et les disponibilités restent décisifs.
```

The complete summary should then contain:

```text
Optimisation des chances
- Horaires : 20 h, puis 19 h
- Clubs : priorité <club A>, repli <club B> après la fenêtre
- Terrain : premier compatible, couvert uniquement
- Ouverture : toutes les 1 s pendant 120 s
- Comptes/crédits : <account/result per leg>
```

If the user wants a strict request, say that exact constraints reduce the number of acceptable slots and preserve them without further persuasion.
