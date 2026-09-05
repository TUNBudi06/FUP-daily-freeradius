# RADIUS Attributes — FUP Throttler

How to register the four FUP-related RADIUS attributes in **FreeRADIUS**
and **daloRADIUS**, and what each one does. Required before `fup-check`
can resolve a plan for any user.

The four attributes are read by `src/ops.ts:resolveUserPlan()` from the
standard FreeRADIUS tables in this order:

1. `radcheck`   (per-user check)
2. `radreply`   (per-user reply)
3. `radgroupcheck` (group check, joined via `radusergroup`)
4. `radgroupreply` (group reply, joined via `radusergroup`)

First non-null value wins. None of these tables are written by the
throttler — they are operator-managed.

---

## 1. Attribute reference

| Attribute name | Vendor | Type | Format | Unit | Default if unset |
|---|---|---|---|---|---|
| `Max-Daily-Traffic` | (custom, this project) | `integer` | plain integer | **bytes/day** | unlimited (no FUP) |
| `Mikrotik-Rate-Limit` | MikroTik | `string` | `rx/tx` like `10M/10M` | bits/sec | — |
| `FUP-Rate-Limit` | (custom, this project) | `string` | `rx/tx` like `256k/256k` | bits/sec | `5M/5M` (built-in) |
| `FUP-Reset-Time` | (custom, this project) | `integer` | plain integer | **minutes** | `null` = never auto-unthrottle |
| `FUP-Per-Device` | (custom, this project) | `integer` | `0` / `1` (truthy: `1`/`true`/`yes`/`on`) | — | `0` = per-user (aggregate) |

### 1.1 `Max-Daily-Traffic`

Daily quota in **bytes**. When a user's `daily_input + daily_output`
crosses this value, the user is throttled to `FUP-Rate-Limit` (or
`Mikrotik-Rate-Limit`, or the default) via CoA at the next cycle.

Examples:

| Plan | Bytes/day | Attribute value |
|---|---|---|
| 1 GiB/day | 1073741824 | `1073741824` |
| 5 GiB/day | 5368709120 | `5368709120` |
| 50 GiB/day | 53687091200 | `53687091200` |
| unlimited | 0 or unset | `<leave blank>` |

> Set to `0` or leave blank to opt the user out of FUP entirely.
> `0` is treated as "no quota" in `isQuotaReached` (fup.ts).

### 1.2 `Mikrotik-Rate-Limit`

The user's **normal** rate, restored on unthrottle. Standard MikroTik
Vendor-Specific Attribute. Format is `rx/tx`, suffixes
`k` / `K` / `m` / `M` / `g` / `G` are accepted.

Examples: `10M/10M`, `2M/512k`, `1G/1G`.

This attribute is already shipped in the MikroTik dictionary that
FreeRADIUS includes — no extra registration needed if you have the
MikroTik dictionary loaded (see §3.1).

### 1.3 `FUP-Rate-Limit`

The **throttled** rate pushed via CoA when the user trips their quota.
Same `rx/tx` format as `Mikrotik-Rate-Limit`.

Examples: `256k/256k`, `1M/1M`, `512k/2M` (asymmetric).

> If unset, the script falls back to the built-in `5M/5M` (see
> `DEFAULT_FUP_RATE` in `src/declare.ts`). Configure this attribute per
> plan group if you want a different throttled rate.

### 1.4 `FUP-Reset-Time`

**Minutes of grace** after a throttle before the script will
automatically restore the user's normal rate. Intended for "fair use"
plans: the user gets a few hours of slow access, then auto-recovers.

- Set to `1440` → 24 hours
- Set to `60` → 1 hour
- Set to `null` / `0` / negative → auto-unthrottle is **disabled**
  (the user stays throttled until an operator runs `fup-reset <user>`)
- **Soft-defect guard (post-2026-09 fix):** `resetMinutes <= 0` is
  rejected by `recoverResetTimeUsers` (ops.ts:484). Previously a value
  of `0` would silently auto-unthrottle every throttled user on the
  next cycle.

### 1.5 `FUP-Per-Device`

Switch between **per-user** (default) and **per-device** quota
evaluation. The script reads this attribute via
`resolveUserPlan` (ops.ts) and branches the throttling path on its
truthy/falsy value.

| Value | Mode | What gets CoA-throttled |
|---|---|---|
| `0` (or unset) | **per-user** (default) | When the user's `Σ daily_input + daily_output` crosses `Max-Daily-Traffic`, **every** live session for the username is throttled via fan-out CoA. |
| `1` / `true` / `yes` / `on` | **per-device** | Each `radacct` session is evaluated independently. Only the specific `(username, acctuniqueid)` whose own daily bytes cross the cap is CoA-throttled; other devices for the same username stay at `Mikrotik-Rate-Limit`. |

Per-device state is tracked in `fup_state_throttled` (added in
`migration.sql`):

```
PRIMARY KEY (username, acctuniqueid)
```

- A row is **inserted** the cycle a device's session crosses the cap.
- A row is **deleted** the cycle the device's session is restored
  (in-cycle unthrottle, FUP-Reset-Time recovery, `fup-reset <user>`,
  or daily reset via `rebaseSessionBaselines`).
- The user-level `fup_state.throttled` flag is the **recomputed aggregate**:
  `1` when at least one row exists, `0` when empty; `throttled_at` is
  the `MIN(throttled_at)` across all live join rows (so FUP-Reset-Time
  on the user is "the oldest still-throttled device's grace").

**Operator use case.** A household plan where the kid's tablet burns
through the quota in the morning shouldn't slow the parent's laptop.
Set `FUP-Per-Device=1` and only the offending device is throttled
until either the day resets, FUP-Reset-Time elapses, or the operator
runs `fup-reset <user>` (which clears **every** throttled device).

**Mode transitions** (handled automatically):
- `0 → 1`: any leftover `fup_state.throttled=1` from a previous
  per-user throttle is overwritten on the next per-device cycle via
  `recomputeUserThrottleFlag`. The user-level flag is rebuilt from
  the (initially empty) join table.
- `1 → 0`: leftover per-device join rows are deleted at the top of
  the next per-user cycle (ops.ts `runCheckCycle`); the aggregate
  path then re-evaluates and re-throttles as needed.
- Self-heal (`selfHealThrottleFlag`): if `fup_state.throttled=1` but
  the join table is empty (e.g. radacct session closed while the
  device was throttled), the flag is cleared so subsequent cycles
  start clean.
- Stale-clear (`clearStaleJoinRows`): join rows whose radacct session
  is no longer open are removed at the start of each per-device
  cycle; this prevents ghost rows from holding a throttle forever.

**Required schema.** Run `migration.sql` once before flipping any
plan to per-device mode. The migration is additive (`CREATE TABLE
IF NOT EXISTS`) and safe to re-run on a live system.

---

## 2. FreeRADIUS — register the custom attributes

The three custom attributes (`Max-Daily-Traffic`, `FUP-Rate-Limit`,
`FUP-Reset-Time`) are not in the FreeRADIUS base dictionary. You need
to add them once. There are two methods.

### 2.1 Method A — extend an existing dictionary (recommended)

Append to `/etc/freeradius/3.0/dictionary` (or a project-local file
sourced from it):

```
# /etc/freeradius/3.0/dictionary

# ... existing contents ...

# ---- FUP throttler (project: script-FUP) ----
ATTRIBUTE   Max-Daily-Traffic     3000    integer
ATTRIBUTE   FUP-Rate-Limit        3001    string
ATTRIBUTE   FUP-Reset-Time        3002    integer
ATTRIBUTE   FUP-Per-Device        3003    integer
```

Attribute codes `3000`–`3002` are picked from the unallocated
FreeRADIUS user-defined range (`3000`+). Pick anything in that range
that doesn't collide with your existing dictionary.

After editing, **no restart is required** for the dictionary to be
re-read, but `radclient` (used by the throttler) needs the new
dictionary at the path you point `FUP_RADCLIENT_DICT_DIR` to. If you
keep `dictionary` at `/etc/freeradius/3.0/dictionary`, the default
`.env.example` already points there.

### 2.2 Method B — separate dictionary file

Create `/etc/freeradius/3.0/dictionary.fup`:

```
# /etc/freeradius/3.0/dictionary.fup
ATTRIBUTE   Max-Daily-Traffic     3000    integer
ATTRIBUTE   FUP-Rate-Limit        3001    string
ATTRIBUTE   FUP-Reset-Time        3002    integer
ATTRIBUTE   FUP-Per-Device        3003    integer
```

And include it from the main dictionary:

```
# /etc/freeradius/3.0/dictionary
$INCLUDE dictionary.fup
```

### 2.3 Verify FreeRADIUS sees them

```bash
echo "User-Name=test" | radclient -x 127.0.0.1 auth testing123
# In the radclient output you should see:
#   recv: User-Name = "test"
# If your radclient now parses the new attributes without "Unknown
# attribute" warnings, registration succeeded.
```

Or with `radattr`:

```bash
radattr <(echo "User-Name=test")           # just lists known attrs
radtest test 127.0.0.1 0 testing123        # auth test, then check radacct
```

### 2.4 Set on a user or group (FreeRADIUS SQL)

`radcheck` / `radreply` rows look like:

```sql
-- 1 GiB/day plan, throttle to 256k/256k, auto-unthrottle after 24h
INSERT INTO radreply (username, attribute, op, value)
VALUES
  ('alice', 'Max-Daily-Traffic', ':=', '1073741824'),
  ('alice', 'FUP-Rate-Limit',    ':=', '256k/256k'),
  ('alice', 'FUP-Reset-Time',    ':=', '1440'),
  ('alice', 'Mikrotik-Rate-Limit',':=', '10M/10M');
```

Group-level (`radgroupreply`):

```sql
-- "plan-1g" group: 1 GiB/day, 256k throttle, 24h reset
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES
  ('plan-1g', 'Max-Daily-Traffic',  ':=', '1073741824'),
  ('plan-1g', 'FUP-Rate-Limit',     ':=', '256k/256k'),
  ('plan-1g', 'FUP-Reset-Time',     ':=', '1440'),
  ('plan-1g', 'Mikrotik-Rate-Limit',':=', '10M/10M');

INSERT INTO radusergroup (username, groupname, priority)
VALUES ('alice', 'plan-1g', 0);
```

---

## 3. daloRADIUS — register the custom attributes

daloRADIUS exposes a web UI to manage attributes per-user and per-group,
but the underlying list of "known attributes" comes from the same
FreeRADIUS dictionary. So you must:

1. Register the attributes in FreeRADIUS first (§2).
2. Make daloRADIUS aware of them via its `dictionary` config.

### 3.1 Edit `daloradius/dictionary.php` (or the equivalent)

The daloRADIUS attribute form reads a list of attribute names from
`/etc/daloradius/dictionary` (or wherever your installation puts it).
Add:

```
# /etc/daloradius/dictionary (or contrib/dictionary/daloradius-dictionary.txt)
Max-Daily-Traffic
FUP-Rate-Limit
FUP-Reset-Time
FUP-Per-Device
```

Some daloRADIUS forks ship this list in
`daloradius/library/attributes/` or as a CSV imported at install time.
Locate it with:

```bash
grep -rln "Mikrotik-Rate-Limit" /etc/daloradius /var/www/daloradius 2>/dev/null
```

Add the three FUP names anywhere alongside `Mikrotik-Rate-Limit`.

### 3.2 Set on a user via daloRADIUS web UI

1. Login as operator.
2. **Users → List Users → <user> → Edit → Attributes**.
3. The "Attribute" dropdown should now include the three FUP names.
4. For each attribute, set:
   - `Max-Daily-Traffic` → `Value` = bytes, e.g. `1073741824`
   - `FUP-Rate-Limit` → `Value` = rate, e.g. `256k/256k`
   - `FUP-Reset-Time` → `Value` = minutes, e.g. `1440`
5. Click **Apply**.

daloRADIUS writes to the same `radcheck` / `radreply` tables —
the throttler doesn't care which UI wrote the rows.

### 3.3 Set on a group via daloRADIUS web UI

**Users → Groups → <group> → Edit → Attributes** — same flow as 3.2,
just at the group level. daloRADIUS writes to `radgroupcheck` /
`radgroupreply` and the throttler's `resolveUserPlan` will find them
via the `radusergroup` join.

### 3.4 Verify

After saving, the underlying SQL row should appear:

```bash
mysql -u root -p raddb \
  -e "SELECT username, attribute, op, value FROM radreply WHERE attribute LIKE '%FUP%' OR attribute='Max-Daily-Traffic';"
```

You should see one row per attribute you set.

---

## 4. Common recipes

### 4.1 "Strict 1 GiB, no auto-unthrottle" (subscriber line)

```sql
INSERT INTO radreply (username, attribute, op, value) VALUES
  ('bob', 'Max-Daily-Traffic',  ':=', '1073741824'),
  ('bob', 'FUP-Rate-Limit',     ':=', '512k/512k'),
  ('bob', 'Mikrotik-Rate-Limit',':=', '10M/10M');
-- No FUP-Reset-Time row => user stays throttled until fup-reset bob
```

### 4.2 "5 GiB with 4-hour grace" (fair-use plan)

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
  ('plan-5g-fairuse', 'Max-Daily-Traffic',  ':=', '5368709120'),
  ('plan-5g-fairuse', 'FUP-Rate-Limit',     ':=', '1M/1M'),
  ('plan-5g-fairuse', 'FUP-Reset-Time',     ':=', '240'),
  ('plan-5g-fairuse', 'Mikrotik-Rate-Limit',':=', '20M/20M');
```

### 4.3 "Unlimited" (no FUP)

Either omit `Max-Daily-Traffic` entirely or set it to `0`. Both are
treated as "no quota" and the user is never throttled.

### 4.4 "Per-device fair use" (household plan)

Each device's session is evaluated against the cap independently.
When a device trips, only that device is throttled; siblings stay at
`Mikrotik-Rate-Limit` until the day's reset.

```sql
-- Apply to a user directly
INSERT INTO radreply (username, attribute, op, value) VALUES
  ('household', 'Max-Daily-Traffic',  ':=', '5368709120'),  -- 5 GiB per device
  ('household', 'FUP-Rate-Limit',     ':=', '1M/1M'),
  ('household', 'FUP-Reset-Time',     ':=', '60'),          -- 1h grace per device
  ('household', 'FUP-Per-Device',     ':=', '1'),           -- <-- the switch
  ('household', 'Mikrotik-Rate-Limit',':=', '20M/20M');

-- Or apply to a group (recommended for many households)
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
  ('plan-household-5g', 'Max-Daily-Traffic',  ':=', '5368709120'),
  ('plan-household-5g', 'FUP-Rate-Limit',     ':=', '1M/1M'),
  ('plan-household-5g', 'FUP-Reset-Time',     ':=', '60'),
  ('plan-household-5g', 'FUP-Per-Device',     ':=', '1'),
  ('plan-household-5g', 'Mikrotik-Rate-Limit',':=', '20M/20M');
```

**Pre-flight checklist** before flipping a group to per-device:

1. Run `migration.sql` once to create `fup_state_throttled`.
2. Make sure each NAS supports per-IP CoA. MikroTik does; if you
   mix vendors, verify before enabling at scale.
3. `FUP-Reset-Time` is per-row in per-device mode: the grace is
   measured from when *that specific device* was throttled, not
   when the user first crossed the aggregate.
4. `fup-reset <user>` clears **every** throttled device for the
   user (operator intent = full restore).

---

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `radclient` errors with "Unknown attribute" | dictionary not loaded | re-check §2.1 / §2.2, point `FUP_RADCLIENT_DICT_DIR` to the dir with `dictionary` |
| `resolveUserPlan` returns null `quota` | no row in any of the 4 tables | add `Max-Daily-Traffic` to `radreply` or `radgroupreply` |
| User never throttled even when over quota | `Max-Daily-Traffic=0` or missing | check §1.1 — must be a positive byte count |
| daloRADIUS dropdown doesn't list the attribute | daloRADIUS dictionary not extended | §3.1 |
| All users throttled immediately on first cycle after a plan change | pre-fix `FUP-Reset-Time=0` bug | upgrade to ≥ 2026-09 fix commit; the guard `plan.resetMinutes <= 0` now rejects 0 |
| CoA succeeds but user keeps normal rate | MikroTik `Rate-Limit` not set on the queue | §1.2 — script restores `Mikrotik-Rate-Limit`; queue must accept it |
| User with `FUP-Per-Device=1` still throttled as a whole | stale `fup_state.throttled` from a prior per-user cycle | run a `fup-check` cycle; `recomputeUserThrottleFlag` rebuilds the flag from the join table |
| `fup-reset <user>` on a per-device plan only restores some devices | expected: `fup-reset` CoAs every join row for the user; check `radclient` for any IP that failed to ACK and look for `RADCLIENT_MISSING` | inspect logs for the IP that failed CoA; the row remains until ACK succeeds or until daily reset |
| `fup_state_throttled` table missing | `migration.sql` not yet run on this DB | run `migration.sql` (additive, `IF NOT EXISTS`) and restart the cycle |
