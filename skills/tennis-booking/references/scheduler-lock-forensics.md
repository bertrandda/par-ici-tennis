# Scheduler and lock forensics

Use this when a Paris Tennis attempt exits with code `75`, reports another operation in progress, or a lock owner is not explained by the current Hermes job list.

## Safe investigation order

1. **Do not rerun or delete locks.** Read the request state and reconcile live reservations for every selected booking account first.
2. **Build a timeline** from:
   - the generated wrapper and booking logs;
   - the state lock owner metadata under the configured booking state directory;
   - Hermes cron definitions and outputs;
   - live Node/Chromium/Playwright processes.
3. **Inspect every scheduler namespace**, not only Hermes:
   - user crontab;
   - system crontab and `/etc/cron.d` entries when readable;
   - user and system systemd timers;
   - repository scripts referenced by any scheduler.
4. **Trace provenance** for an unexpected script:
   - inspect file metadata;
   - search all scheduler definitions for its absolute path;
   - inspect `git log --follow -- <script>` and the introducing commit;
   - search prior sessions for the script path, club, target date, cron expression, and request identifier.
5. Distinguish evidence carefully:
   - Git author metadata proves which identity authored the commit, not necessarily which human or agent initiated it.
   - A script committed in the repository does not prove its scheduler entry is still active.
   - A stale local request marked `scheduled` does not prove a cron can still execute it.
6. **Only after reconciliation**, disable obsolete scheduler entries and close orphaned request records. Preserve audit evidence; do not silently delete uncertain state.
7. **Edit narrowly and verify:** remove only the exact obsolete comment/command pair, reinstall the remaining crontab unchanged, then re-read it and confirm the request has a terminal status such as `cancelled`. Never rewrite unrelated cron entries from memory.
8. **Report safely:** crontab commands may embed environment assignments, tokens, or malformed secret-loading fragments. Do not paste the raw crontab into chat. Summarize each remaining entry by schedule and purpose, redacting values and omitting command internals unless the user explicitly needs a sanitized diagnostic.

## Durable scheduling rule

Use one scheduling authority for booking attempts: Hermes one-shot jobs created from `booking-manager`. Never install an additional Linux crontab entry for the same request. Before attaching a new booking cron, reconcile existing Hermes jobs and scan for legacy scheduler references to the repository's booking wrappers when there is any sign of an older installation.

Avoid holding the exclusive operation lock during a long pre-opening wait when the architecture can instead schedule the process near the effective action time. Read-only monitoring and booking jobs must not share a coarse outer lock unless their overlap policy is explicit.

## Known failure pattern

A legacy shell wrapper may start well before opening, acquire a global lock, wait until the opening time, and block a newer Hermes one-shot job that starts later. The blocked job can remain misleadingly `scheduled` after its one-shot cron disappears. The correct response is to identify the owning scheduler, verify that no reservation was submitted, disable the obsolete scheduler, and close the orphaned request rather than replaying it blindly.

When the site visibly says `Complet` / `Pas de disponibilité` but the expected empty-result selector is absent, classify availability from corroborating page evidence and live reservation reconciliation; record the DOM mismatch as a parser defect rather than waiting repeatedly for the missing selector.