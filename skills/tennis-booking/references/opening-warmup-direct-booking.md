# Opening agenda and independent booking sessions

The 07:55 warmup authenticates each selected booking profile and submits a read-only
club search to reach the results agenda before 07:59. If the target date is absent,
an exposed earlier date is selected through the native calendar. No slot selection,
hold or checkout is allowed before the stored opening.

At 08:00, reload the marked results document. Polling starts at least one second
apart, waits for responses/rendering, never overlaps, and ends at opening + 120 s
by default. Only exact dates in the correct club's visible agenda establish opening.
Hidden duplicates, the rightmost position, daily counts and other clubs do not.

When the day appears, use its native selection and wait for the exact date/club
`ajax_rechercher_creneau` response before reading candidates. The site's full-day
label can contradict its bookable slot rows. Existing exact-date buttons are usable;
a disabled new date uses the spare native form prepared before opening in the same
account context. Verify its document marker, consume it once, select the exact date,
then continue results and checkout in that tab. If it was replaced or closed, use
a fresh native search. The original tab stays idle; no parallel booking occurs
within one account. Later refreshes reuse the exact-date results POST. Never force
a disabled control.

A results reload is read-only but must remain tied to the original document and
URL. Invalidate the marker before navigation; stop on redirect, HTTP error, replaced
document or expired login. Never replay a checkout or confirmation. Switching
targets discards the old agenda. The fallback sweep and a checkout started before
the deadline may finish after it; never interrupt an in-flight mutation to retry it.

Two consecutive legs warm up independently in separate Chromium sessions. Each
owns its login, fixed hour, tariff, guests, fallbacks, hold and cleanup. The first
configured hour sets leg 0; leg 1 uses the immediately following hour. Neither leg
waits for or cancels the other. Keep either confirmed hour, including second-only
success; uncertain submissions remain reconciliation-required. Independent fallbacks
can produce different courts, clubs or sports. The parent alone owns the operation lock.

Regression checks live in `tests/opening-agenda.test.js`, `tests/fallback-browser.test.js`
and `tests/search-window.test.js`: pre-opening warmup without a hold, late date
appearance, native POST reuse, response timing, hidden/wrong-day rejection, full-day
results, contradictory counts, session loss, stale document rejection, non-overlapping
polling, fallback and independent consecutive outcomes. Run these plus the complete
suite, ESLint and `git diff --check`. Fixture success does not establish live booking
success or guarantee availability at the next opening.

Optional `courtSelection: "first"` performs a single browser read and stops at the
first fully compatible candidate, retaining hour priority and tariff/court filters.
The default scan remains unchanged. Checkout waits wake on the next visible step
instead of blind 250 ms sleeps; CAPTCHA input processing delays remain intact.
