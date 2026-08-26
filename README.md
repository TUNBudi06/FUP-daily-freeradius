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

The migration adds `throttled_at` to `fup_session_state` so a user can be
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

```cron
# every minute: enforce FUP + handle FUP-Reset-Time recoveries
* * * * * /usr/bin/bun /path/script-FUP/src/bin/fup-check.ts
# once a day at 00:01: full reset (no CoA)
1 0 * * * /usr/bin/bun /path/script-FUP/src/bin/fup-reset.ts
```

Optional per-user manual + CoA restore:

```bash
bun src/bin/fup-reset.ts some-user --coa   # reset this user and CoA-restore
bun src/bin/fup-reset.ts                    # reset everyone, no CoA
```

## Entrypoints

- `fup-check.ts` — acquires a single lock; per user: skips `quota ≤ 0`,
  rolls a stale `fup_date` (NEW_DAY), throttles when `daily >= quota` (only on
  a CoA ACK), and auto-restores FUP-Reset-Time users.
- `fup-reset.ts` — clears `fup_date`/throttle, rebases session baselines; with
  `--coa username` re-applies the user's `normal_rate`.

## Database migration

The only schema change over the Bash version is one new column:

```sql
ALTER TABLE fup_state
  ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL AFTER throttled;
-- rollback:
-- ALTER TABLE fup_state DROP COLUMN throttled_at;
```

Run that on your raddb schema before deploying the .ts cronjobs.

## Security notes

- radclient is spawned through an argv array (`spawn`, no shell); the CoA body
  travels over stdin, never concatenated into a shell string.
- Usernames and IPs are validated/redacted before any logging.
- All octet counters use `bigint` end-to-end — no float precision loss.