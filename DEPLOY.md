# DEPLOY.md — Deploying the daily FUP throttler

How to install `fup-check` (minute cron) and `fup-reset` (daily reset) on a
production FreeRADIUS/daloradius server (Debian/Ubuntu and similar).

Two ways to run, pick one:

| Mode | Requires on the server | Updates |
|---|---|---|
| **Binary** (`dist/fup-check`, `dist/fup-reset`) | `radclient` + dictionaries only | copy the compiled binary |
| **Source** (`bun run check` / `bun run reset`) | full Bun install + `node_modules` | `git pull` |

Same behaviour, same `.env`, same log format. This doc covers binary first
(recommended), then notes the source path.

There is also a third, **non-cron** entrypoint: `fup-debug`, a manual CoA
console. It is not built into `dist/` (only `check` and `reset` are), so it
runs from source with `bun run debug <user> [ip]`. See §7.

---

## 1. Prerequisites

- **Bun ≥ 1.4** — only needed to *build* the binaries (or to run from source).
  The deployed binary itself needs no Bun at runtime.
- **MySQL/MariaDB** with the FreeRADIUS `raddb` schema
  (`radcheck`, `radreply`, `radusergroup`, `radgroupcheck`, `radgroupreply`,
  `radacct`, plus the FUP tables `fup_state` and `fup_session_state`). The
  per-device join table `fup_state_throttled` is created by `migration.sql`
  (see §4).
- **radclient** (from the `freeradius-utils` package) on the machine that will
  fire CoAs:

  ```bash
  apt install -y freeradius-utils
  which radclient        # must be non-empty — this is FUP_RADCLIENT
  ```

- **Dictionary directories** — where `dictionary` + `mikrotik` live. Find them
  with `radclient -x -d ...`; on Debian these are `/usr/share/freeradius` and
  `/etc/freeradius/3.0` (the defaults in `.env.example`).
- **Network reachability from the deploy machine to**:
  - MySQL (`FUP_DB_HOST:FUP_DB_PORT`)
  - the MikroTik NAS CoA port (`FUP_NAS_IP:FUP_NAS_COA_PORT`, default 3799/1700)
- Root is only needed to install packages and write `/var/log`; the cronjobs can
  run as a normal user if `.env` and the log file permissions allow.

---

## 2. Install — binary mode (recommended)

Build on your workstation (Bun ≥ 1.4):

```bash
bun install
bun run build          # produces dist/fup-check and dist/fup-reset
```

Each binary is a single self-contained ELF (~80 MB) — Bun runtime, bundled JS,
and all deps inside. Copy them to the server. Architecture must match
(`x86_64` on both; the binaries build for the host you run `bun run build` on).

```bash
scp dist/fup-check dist/fup-reset root@srv-radius-daloradius:/root/script-FUP/dist/
```

Re-build after every code change and copy again — `dist/` is `.gitignore`d, so
binaries never travel through git.

### Install — source mode (alternative)

Requires Bun on the server, updates via git:

```bash
apt install -y unzip curl
curl -fsSL https://bun.sh/install | bash   # or your distro package
bun --version                               # must be >= 1.4

git clone https://github.com/TUNBudi06/FUP-daily-freeradius.git ~/script-FUP
cd ~/script-FUP && bun install
```

From then on, `git pull && bun install` brings the latest code.

---

## 3. Configuration — `.env`

```bash
cp .env.example .env
chmod 600 .env     # contains the DB password and NAS secret
```

| Variable | Meaning | Example |
|---|---|---|
| `FUP_DB_HOST` | MySQL host | `localhost` |
| `FUP_DB_PORT` | MySQL port | `3306` |
| `FUP_DB_NAME` | FreeRADIUS DB name | `raddb` |
| `FUP_DB_USER` | DB user (read + write on FUP tables) | `raduser` |
| `FUP_DB_PASSWORD` | DB password | — |
| `FUP_NAS_IP` | MikroTik router IP (CoA target) — must be a valid IPv4 | `10.6.7.1` |
| `FUP_NAS_COA_PORT` | CoA port on the router | `3799` |
| `FUP_NAS_SECRET` | RADIUS secret shared with the router | — |
| `FUP_RADCLIENT` | path to radclient | `/usr/bin/radclient` |
| `FUP_RADCLIENT_DICT` | main dictionary dir (`-d`) | `/usr/share/freeradius` |
| `FUP_RADCLIENT_DICT_DIR` | second dictionary dir (`-D`) | `/etc/freeradius/3.0` |
| `FUP_LOG_FILE` | log file (must be writable) | `/var/log/fup.log` |
| `FUP_LOCK_FILE` | lock file (must be writable) | `/tmp/fup.lock` |
| `FUP_DEBUG` | debug level `0`–`2`: `1` echoes every log line to stderr, `2` adds per-session/per-IP detail. Malformed/out-of-range → `0` | `0` |

Secrets are read from the environment only, never hardcoded or logged
(redacted with `***` in log output).

---

## 4. Database migration

Run `migration.sql` once before the first cycle:

```bash
mysql raddb < migration.sql
```

It makes three changes — the `throttled_at` column, the `normal_rate`
nullability fix, and the per-device join table:

```sql
ALTER TABLE fup_state
  ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE fup_state MODIFY normal_rate VARCHAR(64) NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS fup_state_throttled (
  username        VARCHAR(64) NOT NULL,
  acctuniqueid    VARCHAR(64) NOT NULL,
  framedipaddress VARCHAR(45) NOT NULL,
  throttled_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  throttled_rate  VARCHAR(64) NOT NULL,
  PRIMARY KEY (username, acctuniqueid),
  KEY idx_user (username)
) ENGINE=InnoDB;
```

- `throttled_at` drives FUP-Reset-Time auto-restore (timestamps the moment a
  user is throttled).
- The `MODIFY` allows NULL so the bootstrap seed can write an unresolved
  `normal_rate`; safe to re-run on an already-migrated DB.
- `fup_state_throttled` holds one row per throttled `(username, acctuniqueid)`
  pair. It is only populated in **per-device** mode (`FUP-Per-Device=1`), but
  the table must exist before you enable that mode — see §5. `CREATE TABLE IF
  NOT EXISTS` makes the whole file safe to re-run on a live system.

Verify the three FUP tables exist and have data after the first check cycle:
```sql
SELECT COUNT(*) FROM fup_state;
SELECT COUNT(*) FROM fup_session_state;
SELECT COUNT(*) FROM fup_state_throttled;   -- 0 unless per-device is in use
```

---

## 5. RADIUS attributes per user/group

Set these in `radcheck`/`radreply` per user, or in `radgroupcheck`/
`radgroupreply` per group (group rows are joined with the lowest
`radusergroup.priority` winning; user rows win over group rows — order:
radcheck → radreply → radgroupcheck → radgroupreply):

| Attribute | Meaning |
|---|---|
| `Max-Daily-Traffic` | daily quota in **bytes** (0/unset = unlimited) |
| `Mikrotik-Rate-Limit` | the user's **normal** rate, restored on reset, e.g. `100M/100M` |
| `FUP-Rate-Limit` | the **throttled** rate sent when quota is exceeded, e.g. `5M/5M` |
| `FUP-Reset-Time` | optional minutes of grace before auto-restore after a throttle (0/unset = never; only the daily reset clears it) |
| `FUP-Per-Device` | `1` to evaluate each session against the cap independently and throttle only the offending device; `0`/unset = throttle every device for the username together |

`FUP-Per-Device=1` requires the `fup_state_throttled` table from §4 — apply the
migration **before** setting the attribute on any user or group. In per-device
mode `Max-Daily-Traffic` is a per-device cap, not a per-username cap, and
`FUP-Reset-Time` is measured from when each individual device was throttled;
`fup-reset <user>` still clears every throttled device for the user. Full
reference, mode-transition rules, and profile examples (residential, household,
wholesale) are in [ATTRIBUTES.md](ATTRIBUTES.md) §1.5 and §5.

The custom attribute names must also be registered in the FreeRADIUS and
daloRADIUS dictionaries — see [ATTRIBUTES.md §2 and §3](ATTRIBUTES.md) — or
`radclient` and the daloRADIUS UI will not recognise them.

For ready-to-paste per-group **profiles** (`radgroupcheck` / `radgroupreply` +
`radusergroup`), see [ATTRIBUTES.md §5](ATTRIBUTES.md).

---

## 6. Cron setup

Run the checks every minute; roll the daily quota at 00:01. Timing of the reset
should sit **after** any NAS-side "midnight" zeroing, and the two timeouts of
the minute cron are forgiving (lock + short cycle), so a 00:01 daily is safe.

### Binary mode

```cron
# every minute: enforce FUP + auto-restore FUP-Reset-Time users
* * * * * /root/script-FUP/dist/fup-check
# once a day at 00:01: full quota rollover (CoA-restores anyone still throttled)
1 0 * * * /root/script-FUP/dist/fup-reset
```

The binary reads `.env` from the current working directory (or exported env).
Make the project dir its `cd` so `.env` is found:

```cron
* * * * * cd /root/script-FUP && /root/script-FUP/dist/fup-check
1 0 * * * cd /root/script-FUP && /root/script-FUP/dist/fup-reset
```

### Source mode

```cron
* * * * * cd /root/script-FUP && /usr/bin/bun run check
1 0 * * * cd /root/script-FUP && /usr/bin/bun run reset
```

Install with `crontab -e` (root). Both binaries **share one lock file**, so a
minute run and the daily reset can never write simultaneously — a `false` lock
acquire exits 0 and retries next cycle.

Manual operations:

```bash
cd /root/script-FUP
./dist/fup-check                      # one check cycle, now
./dist/fup-reset                      # reset everyone (still-throttled users are CoA-restored first)
./dist/fup-reset some-user --coa      # reset one user and CoA-restore their normal rate
```

---

## 7. Verification

Right after cron is installed, tail the log:

```bash
tail -f /var/log/fup.log
```

A healthy first cycle looks like:

```
START fup-check minute cron | db=raduser@localhost:3306/raddb nas=10.6.7.1:3799 radclient=/usr/bin/radclient dict=/usr/share/freeradius dictDir=/etc/freeradius/3.0 debug=0
ACTIVE_SESSIONS 12
DAILY_USAGE alice = 13241280 bytes (quota=52428800)
SUMMARY Processed 12 users, throttled=0, recovered=0, duration_ms=182
END fup-check
```

The `START` line's config summary (never the DB password or NAS secret — those
are always redacted) is the fastest way to confirm a cron run picked up the
`.env` you expect. `ACTIVE_SESSIONS` gives a one-glance health signal even at
the default debug level 0 — a sudden drop to `0` usually means a `radacct`/NAS
problem, not that every subscriber disconnected at once. `duration_ms` in
`SUMMARY` flags a cycle that's creeping toward the next minute's cron tick.

### Log events reference

| Event | Meaning |
| --- | --- |
| `START` / `END` | Cycle boundaries; `START` includes the config summary above. |
| `LOCK_RECLAIMED` | The lock directory belonged to a dead PID (or was pid-less and stale) and was cleared before this run acquired it — the previous cycle didn't exit cleanly. Worth alerting on if it repeats. |
| `ACTIVE_SESSIONS` | Count of open `radacct` sessions seen this cycle. |
| `DAILY_USAGE` | Per-user (or aggregate, in per-device mode) usage vs. quota. |
| `PER_DEVICE_ACTIVE` / `DEVICE_USAGE` / `DEVICE_THROTTLED` | Per-device mode detail (the latter two need `FUP_DEBUG=2`). |
| `FUP_REACHED` | A user/device just crossed its quota. |
| `THROTTLED` | CoA-ACK received for the throttled rate; the flag is now set. |
| `RESET` | `FUP-Reset-Time` grace elapsed; about to CoA-restore. |
| `RESTORE` | CoA-ACK received for the normal rate; the flag is now cleared and the quota rebased. |
| `NEW_DAY` | The check cron found a user still throttled from a previous `fup_date` (the daily reset cron missed or hasn't run yet) and is restoring them. |
| `SELF_HEAL` | `fup_state.throttled=1` had no matching `fup_state_throttled` rows (e.g. the last throttled session closed) — the flag was cleared. |
| `STALE_THROTTLE_CLEARED` | A per-device join row's `radacct` session is no longer open; the row was dropped. |
| `RESET_TARGETS` | A global `fup-reset` (no username) found N throttled users to CoA-restore before rebasing. |
| `COA_ACK` | radclient reported `CoA-ACK`. |
| `COA_TIMEOUT` | No radclient reply within the timeout — usually an unreachable NAS, distinct from a NAK/refusal. |
| `COA_FAILED` | Anything else: NAK, `radclient` missing, or refused (unsafe username/IP/rate). The throttle flag is left untouched so the next cycle retries. |
| `SKIP` | An invalid username, invalid IP, or an already-locked run was skipped. |
| `ERROR` | A single user's cycle step failed (isolated — the rest of the cycle continues) or the whole process aborted before the lock/db were set up. |
| `COA_DEBUG` / `COA_DETAIL` | `FUP_DEBUG=1`/`=2` only — radclient argv+body, and per-IP/attribute detail. |
| `SUMMARY` | End-of-cycle counts, including `duration_ms`. |

Forced end-to-end test (safe — the CoA is a real rate change):

```sql
UPDATE fup_session_state
   SET daily_input = daily_input + 500 * 1024 * 1024
 WHERE username = 'testuser';
```

Then watch one minute cron cycle: `DAILY_USAGE` jumps over quota →
`FUP_REACHED` → `COA_ACK` → `THROTTLED testuser -> 5M/5M`.

After the daily reset you should see, for **every** user including mismatched /
closed-session rows, usage back to ~0 on the next minute run:

```
START fup-reset ALL | db=raduser@localhost:3306/raddb nas=10.6.7.1:3799 radclient=/usr/bin/radclient dict=/usr/share/freeradius dictDir=/etc/freeradius/3.0 debug=0
RESET_TARGETS 2 throttled user(s) to restore before the daily rollover
COA_ACK ...
RESTORE testuser -> 20M/20M
SUMMARY RESET ALL, duration_ms=340
...
DAILY_USAGE alice = 0 bytes (quota=52428800)   # post-reset
```

`RESET_TARGETS` only appears on a **global** reset (no username) when at
least one user is still flagged throttled — the daily reset now CoA-restores
them first instead of just clearing the flag (see §8 if a restore fails).

### Debug console (single user, real CoA)

When the cycle log isn't enough, `fup-debug` runs one user's CoA path in the
foreground. It always sends a **real** CoA (unlike the cron, which only fires
on a throttle decision) and always runs at debug level 2:

```bash
cd /root/script-FUP
bun run debug alice            # every active IP for alice
bun run debug alice 10.6.7.20  # only this IP
```

It is not compiled into `dist/` — run it from source (`bun` + `node_modules`
required), i.e. only in source-mode installs. It prints a header with the
resolved plan (quota, `FUP-Rate-Limit`, `normal_rate`, `FUP-Per-Device`) and
the targeted IPs, then one result line per IP ending in `✓ ACK` or `✗ FAILED`.
A NAK is suffixed with the parsed `Error-Cause`, e.g.
`[NAK reason: Unsupported-Extension (402)]`.

Exit codes: `0` all ACKs, `1` at least one failure, `2` bad/missing username,
`3` no active session IPs. To exercise the path without touching the live
router, temporarily point `FUP_NAS_IP` at an unreachable address — the CoA is
logged but nothing changes on the NAS.

---

## 8. Troubleshooting

### Reset ran but next check still shows the old byte count

Fixed root cause (the rebase in `ops.ts` previously zeroed only rows joining an
open `radacct` session, so stale/mismatched rows kept their old usage). Current
behavior: `rebaseSessionBaselines` zeroes **all** users' daily counters
unconditionally — closed, unmatched, and ghost rows included.

If usage still isn't zero, check:

1. The reset actually ran `RESET ALL` (grep the log under `START fup-reset`).
2. The minute cron is running *after* the reset (a stale check writes usage back
   with `last_input`/`last_output` baselines from old counters — run the check
   first, then reset once; both under the lock).
3. `.env` for the cron user points at the right DB, not a local scratch one.

### `COA_FAILED: user - will retry next cycle` / no `COA_ACK`

The throttle decision happened but the router never accepted the rate change:

```bash
# 1. Is radclient present and are dicts right?
which radclient
radclient -x -d /usr/share/freeradius -D /etc/freeradius/3.0 10.6.7.1:3799 coa SECRET

# 2. Is the CoA port reachable from this machine?
nc -zv 10.6.7.1 3799    # or: timeout 3 bash -c 'echo > /dev/tcp/10.6.7.1/3799'

# 3. Does the router's CoA/ACCT secret match FUP_NAS_SECRET?
# 4. Does the user have an OPEN session (acctstoptime IS NULL) with a
#    framed IP? CoA is only fanned out to active IPs:
SELECT username, framedipaddress, acctstoptime FROM radacct
 WHERE username = 'testuser' AND acctstoptime IS NULL;
```

`COA_FAILED` does **not** lose state — the user is simply left unthrottled and
retried every cycle. Only an `ACK` sets `throttled = 1`.

To see the exact radclient argv, CoA body, and parsed NAK reason for one user in
the foreground, run the debug console (§7): `bun run debug <user> [ip]`.

### Per-device user isn't throttled (or throttles everyone)

Check the mode actually resolved for the user:

```bash
bun run debug testuser    # header shows perDevice=true/false and the plan
```

- `perDevice=false` with `FUP-Per-Device=1` set on the group → the user-level
  attribute resolution is winning; confirm no `radcheck`/`radreply` row shadows
  the group, and that the group is joined in `radusergroup`.
- `perDevice=true` but the whole user throttled → a stale aggregate flag from a
  prior per-user cycle; the next per-device cycle rebuilds it
  (`recomputeUserThrottleFlag`).
- Table missing error → `migration.sql` was not applied (§4).

---

### `ERROR: Missing required env var ...`

The cron user isn't seeing `.env` — either `cd` into the project dir in the
cron line (see above) or export the vars. Debug with:

```bash
FUP_DEBUG=1 ./dist/fup-check
# source mode, single user with full CoA detail:
FUP_DEBUG=2 bun run debug testuser
```

### Drizzle says `Table 'raddb.fup_state' doesn't exist`

The migration was never applied. See section 4 before the first cron run.

---

## 9. Updating the deployment

```bash
# binary mode
git -C ~/script-FUP pull          # get new source (run on your workstation)
bun install && bun run build      # rebuild binaries
scp dist/fup-* root@srv-radius-daloradius:/root/script-FUP/dist/

# source mode
cd ~/script-FUP && git pull && bun install
```

If a new migration ships, apply it before restarting the crons (see section 4).
The crons themselves don't need restarting — they pick up the new binary/script
on the next scheduled run.