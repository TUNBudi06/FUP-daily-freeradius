# script-FUP

Daily Fair-Use-Policy (FUP) throttling for FreeRADIUS/MikroTik networks, migrated
from Bash to TypeScript + Bun + Drizzle. Every decision is in one shared
operations module; the two entrypoints are thin wiring.

## Architecture

```
src/
  fup.ts            pure bigint-safe math (deltas, quota, rate checks) — no I/O
  ops.ts            shared orchestration — ALL logic lives here exactly once
  coa.ts            radclient CoA via spawn argv (no shell)
  db.ts             Drizzle schema + mysql2 connection
  config.ts         typed, validated .env loader
  logger.ts         timestamped file logger (fire-and-forget)
  lock.ts           atomic mkdir-based filesystem lock
  declare.ts        radius attribute names, defaults, rate regex
  bin/fup-check.ts  minute cron entrypoint
  bin/fup-reset.ts  daily / manual reset entrypoint
```

Both entrypoints only wire config → lock → logger → db, then call shared
helpers from `ops.ts`. They never re-implement attribute resolution, session
delta accounting, rebase, quota reset, or CoA fan-out. This mirrors the Bash
`fup-coa-check.sh` / `fup-coa-reset.sh` behaviour.

## Setup

```bash
bun install
cp .env.example .env
# edit .env to taste, then install the RADIUS attribute below
```

Requirements: [Bun](https://bun.sh) ≥ 1.4, a running FreeRADIUS MySQL database
and a MikroTik router reachable on the CoA port.

### New RADIUS attribute (FUP-Reset-Time)

The migration adds `throttled_at` to `fup_state` so a user can be
**auto-unthrottled** a fixed number of minutes after being throttled.

Set `FUP-Reset-Time` (seconds are not used; the value is whole minutes) per
user or group. When that many minutes pass after a user was throttled, the
minute cron restores their `normal_rate` and clears the throttle automatically.

```
FUP-Reset-Time = 1440   # restore 24h after throttling
```

- `0` / unset → never auto-restores; only the daily reset (or manual) clears it.
- Requires a `normal_rate` (the checked `Mikrotik-Rate-Limit`), else the
  restore is skipped with an `ERROR` log.

## Cron wiring

Stand up the minute and daily entrypoints with the package scripts (or point
cron directly at the files — same behaviour):

```cron
# every minute: enforce FUP + auto-restore FUP-Reset-Time users
* * * * * cd /path/script-FUP && /usr/bin/bun run check
# once a day at 00:01: full quota rollover (no CoA)
1 0 * * * cd /path/script-FUP && /usr/bin/bun run reset
```

Optional per-user manual + CoA restore:

```bash
bun run reset some-user --coa   # reset this user and CoA-restore
bun run reset                    # reset everyone, no CoA
```

## Entrypoints (why two, not one)

The two entrypoints are **not** merged because they fire on different cadences:

- `fup-check.ts` (minute) — throttles users whose `daily >= quota`, rolls a
  stale `fup_date` (NEW_DAY), and **auto-restores** throttled users whose
  `FUP-Reset-Time` grace has elapsed. This is what makes "reset after
  throttled" dynamic — it runs every minute, so a user is unthrottled
  immediately once their reset timer passes.
- `fup-reset.ts` (daily 00:01) — clears `fup_date`/throttle and rebases
  session baselines for the next day. With `--coa username` it re-applies the
  user's `normal_rate` (used for manual restore too).

Both share every decision in `ops.ts` and guard each other with the same
filesystem lock, so the minute run and daily rollover can never write
concurrently.

## Database migration

The only schema change over the Bash version is one new column:

```sql
ALTER TABLE fup_state
  ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL AFTER throttled;
-- rollback:
-- ALTER TABLE fup_state DROP COLUMN throttled_at;
```

Run that on your raddb schema before deploying the .ts cronjobs.

> **Note:** the Bash bootstrap inserted a resolved `normal_rate` (never NULL), but the TypeScript bootstrap seeds `NULL` (rate is resolved later, at throttle time). If your live `fup_state.normal_rate` is `NOT NULL` (the Bash-era default), apply the one-time adjustment to allow the seed:
> ```sql
> ALTER TABLE fup_state MODIFY normal_rate VARCHAR(64) NULL DEFAULT NULL;
> ```

## Verbose / debug output

Set `FUP_DEBUG=1` in `.env` (or prefix the command) to echo every timestamped log line to stderr — useful for ad-hoc runs and verifying the minute cron without tailing the log file:

```bash
FUP_DEBUG=1 bun run check
```

In cron you can keep it off (default) and rely on the log file; enable temporarily for diagnosis.

## Testing

Offline (no DB / router needed):

```bash
bun test        # unit tests — pure math, logger, config, rate parsing
bunx tsc --noEmit   # type check
```

Live dry-run against a real DB — echoes every step to stderr but reviews what
it *would* do before letting a real CoA fire:

```bash
FUP_DEBUG=1 bun run check
```

To force a test user over quota and observe a real throttle + auto-restore:

```sql
-- nothing already throttled: push the user past their daily quota
UPDATE fup_session_state
   SET daily_input = daily_input + 500 * 1024 * 1024
 WHERE username = 'testuser';
```

Then run `bun run check` every minute (see FUP-Reset-Time above) and watch the
log for `THROTTLE` → (after `FUP-Reset-Time` minutes) `RESET` restore. To test
the restore without touching the live router first, point `FUP_NAS_IP` at an
unreachable address so the CoA fails on purpose — the throttle will be logged
but nothing on the router changes.

## Deployment checklist

1. `bun install` (Bun ≥ 1.4 required).
2. `cp .env.example .env` and fill in DB / NAS credentials.
3. **Apply the migration before deploying the cronjobs** (see the Database
   migration section above): `mysql raddb < migration.sql`.
4. Set `Max-Daily-Traffic`, `Mikrotik-Rate-Limit`, `FUP-Rate-Limit` and
   (optional) `FUP-Reset-Time` per user/group in the RADIUS config.
5. Install the two crons from the Cron wiring section.
6. Tail `/var/log/fup.log` (`FUP_LOG_FILE`) for the first cycle.

## Security notes

- radclient is spawned through an argv array (`spawn`, no shell); the CoA body
  travels over stdin, never concatenated into a shell string.
- Usernames and IPs are validated/redacted before any logging.
- All octet counters use `bigint` end-to-end — no float precision loss.