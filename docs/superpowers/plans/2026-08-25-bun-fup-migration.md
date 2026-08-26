# Bun FUP Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Bash FUP throttling system (`fup-coa-check.sh` / `fup-coa-reset.sh`) to a modular TypeScript/Bun + Drizzle ORM application, preserving all existing behavior, adding a time-based `FUP-Reset-Time` auto-unthrottle, and hardening security and edge-case handling.

**Architecture:** Three layers. (1) `src/` source modules with one responsibility each: `declare.ts` (typed attribute names, fallback order, defaults), `config.ts` (env loading + typed config), `db.ts` (Drizzle schema + connection), `coa.ts` (radclient CoA via `spawn` argv, never string interpolation), `fup.ts` (pure delivery metrics + throttle decision, bigint-safe), `ops.ts` (shared orchestration since the two entrypoints overlap heavily), `logger.ts`, `lock.ts`. (2) Two thin entrypoints `src/bin/fup-check.ts` and `src/bin/fup-reset.ts` that only wire modules — all shared logic (attribute resolution, session fetch/rebase, daily aggregation, quota reset, CoA fan-out) lives in `ops.ts` once and is consumed by both, so nothing is duplicated. (3) Database and NAS **secrets** come from a gitignored `.env` (the security requirement supersedes the spec's contradictory "put creds in declare.ts" line — `declare.ts` holds attribute *names* and RADIUS *defaults*, never passwords).

**Tech Stack:** Bun (runtime + test runner), TypeScript strict, Drizzle ORM with `mysql2` driver, `radclient` (invoked via `spawn` argv, no shell), MySQL raddb.

## Global Constraints

- TypeScript only, strict mode. No `any` in source.
- Bun runtime. Tests via `bun:test`.
- DB access via Drizzle + `mysql2` exclusively. Every query parameterized — never build SQL by concatenating user input.
- Secrets (DB creds, NAS secret) only in `.env` / process env; `.env` gitignored; `.env.example` documents blank keys.
- RADIUS attribute names, default FUP rate, and normal-rate fallback order (`radcheck → radreply → radgroupcheck → radgroupreply`) live in `declare.ts`.
- `fup_session_state` schema is pinned; map as-is. `fup_state` gains exactly two columns: `throttled` (flag, already present) and `throttled_at TIMESTAMP NULL` (moment the throttle was applied). Auto-unthrottle triggers when `now >= throttled_at + FUP-Reset-Time minutes`.
- Octet counts use `bigint` across the `fup.ts` boundary.
- radclient invoked with `spawn`/argv arrays only — no shell interpolation of user data.
- Filesystem exclusive lock shared by both entrypoints.
- Log lines must never contain secrets.
- **DRY is a hard constraint:** any operation the two entrypoints share lives in `ops.ts` exactly once (session fetch/rebase, delta accounting, daily aggregation, quota reset, rate resolution, CoA fan-out, unthrottle recovery). Neither entrypoint re-implements shared logic; both stay thin and read top-to-bottom. No copy-pasted orchestration between `fup-check.ts` and `fup-reset.ts`.
- **Readability is a hard constraint:** functions are small and single-purpose, names state intent (`isUserThrottled`, `rebaseSessionBaseline`, not `process`/`doThing`), and comments explain *why* (counter-reset, baseline rebase) not *what*. Run `bun test` after every module lands.
- Execute on the target server (the host with `raddb` MySQL + reachable MikroTik at `10.6.7.1:3799`), not assumed to run on this SSHFS workspace.

Target layout:

```
script-FUP/
├── .env.example
├── .env                  # gitignored
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── migration.sql         # adds fup_state.throttled_at
├── src/
│   ├── declare.ts        # attribute names, defaults, rate resolution order
│   ├── config.ts         # typed env config + validation
│   ├── db.ts             # Drizzle schema + mysql2 connection
│   ├── coa.ts            # radclient CoA (spawn argv), CoA fan-out helper
│   ├── fup.ts            # pure bigint-safe delta/quota logic
│   ├── ops.ts            # SHARED orchestration consumed by both entrypoints
│   ├── logger.ts
│   ├── lock.ts
│   └── bin/
│       ├── fup-check.ts  # thin minute cron
│       └── fup-reset.ts  # thin daily/manual reset
└── test/
    ├── fup.test.ts
    ├── ops.test.ts
    └── declare.test.ts
```

---

### Task 1: Repo init + Bash baseline commit

**Files:**
- Create: `script-FUP/.gitignore`
- Create: `script-FUP/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `.env.example` keys that `config.ts` (Task 3) reads verbatim; `.gitignore` keeps `.env` and `node_modules` out of history.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
.env
.env.*
!.env.example
node_modules/
dist/
*.log
*.lock
.DS_Store
```

- [ ] **Step 2: Create `.env.example`**

```env
# FreeRADIUS database credentials
FUP_DB_HOST=localhost
FUP_DB_PORT=3306
FUP_DB_NAME=raddb
FUP_DB_USER=raduser
FUP_DB_PASSWORD=

# MikroTik CoA router
FUP_NAS_IP=10.6.7.1
FUP_NAS_COA_PORT=3796
FUP_NAS_SECRET=

# Paths
FUP_LOG_FILE=/var/log/fup.log
FUP_LOCK_FILE=/tmp/fup.lock
FUP_RADCLIENT=/usr/bin/radclient
FUP_RADCLIENT_DICT_DIR=/etc/freeradius/3.0
```

- [ ] **Step 3: Bash baseline commit** — on the target server (where the `.sh` files live):

```bash
git init
git add fup-coa-check.sh fup-coa-reset.sh .gitignore .env.example
git commit -m "Initial Bash implementation before TypeScript migration"
```

Expected: clean single commit; `.env` untracked (does not exist yet).

- [ ] **Step 4: Commit** — done in Step 3.

---

### Task 2: Bun scaffold + `declare.ts`

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/declare.ts`
- Test: `test/declare.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (this is the type/factor hub).
- Produces for later tasks:
  - `export const ATTR = { MAX_DAILY: "Max-Daily-Traffic", RATE: "Mikrotik-Rate-Limit", FUP_RATE: "FUP-Rate-Limit", FUP_RESET_TIME: "FUP-Reset-Time" }`
  - `export const RATE_RESOLUTION_ORDER: ("radcheck"|"radreply"|"radgroupcheck"|"radgroupreply")[] = ["radcheck","radreply","radgroupcheck","radgroupreply"]`
  - `export const DEFAULT_FUP_RATE = "5M/5M"`
  - `export interface FUPResolved { fupRate: string; resetMinutes: number | null }`
  - `export const isMikrotikRate = (s: string): boolean`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fup-bun",
  "type": "module",
  "stable": true,
  "drizzle-orm": "latest",
  "mysql2": "latest"
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "types": ["bun"]
  }
}
```

- [ ] **Step 3: Write the failing test** (`test/declare.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { ATTR, DEFAULT_FUP_RATE, RATE_RESOLUTION_ORDER, isMikrotikRate } from "../src/declare.ts";

describe("declare.ts", () => {
  test("exposes canonical attribute names", () => {
    expect(ATTR.MAX_DAILY).toBe("Max-Daily-Traffic");
    expect(ATTR.RATE).toBe("Mikrotik-Rate-Limit");
    expect(ATTR.FUP_RATE).toBe("FUP-Rate-Limit");
    expect(ATTR.FUP_RESET_TIME).toBe("FUP-Reset-Time");
  });

  test("resolution order matches spec: entry+group, check before reply", () => {
    expect(RATE_RESOLUTION_ORDER).toEqual(
      ["radcheck", "radreply", "radgroupcheck", "radgroupreply"],
    );
  });

  test("default FUP rate is 5M/5M", () => {
    expect(DEFAULT_FUP_RATE).toBe("5M/5M");
  });

  test("isMikrotikRate accepts valid and rejects junk", () => {
    expect(isMikrotikRate("10M/10M")).toBe(true);
    expect(isMikrotikRate("0")).toBe(false);
    expect(isMikrotikRate("abc")).toBe(false);
    expect(isMikrotikRate("")).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test test/declare.test.ts`
Expected: FAIL — `../src/declare.ts` does not exist yet (import error).

- [ ] **Step 5: Write minimal implementation** (`src/declare.ts`)

```ts
export const ATTR = {
  MAX_DAILY: "Max-Daily-Traffic",
  RATE: "Mikrotik-Rate-Limit",
  FUP_RATE: "FUP-Rate-Limit",
  FUP_RESET_TIME: "FUP-Reset-Time",
} as const;

export const RATE_RESOLUTION_ORDER = [
  "radcheck",
  "radreply",
  "radgroupcheck",
  "radgroupreply",
] as const;

export const DEFAULT_FUP_RATE = "5M/5M";

export interface FUPResolved {
  /** the FUP rate to enforce, or null to use DEFAULT_FUP_RATE */
  fupRate: string;
  /** minutes of grace before auto-unthrottle, or null if unset */
  resetMinutes: number | null;
}

const RATE_RE = /^\d+[KMG]\/\d+[KMG]$/;

export function isMikrotikRate(s: string): boolean {
  return RATE_RE.test(s.trim());
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test test/declare.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json src/declare.ts test/declare.test.ts
git commit -m "feat: bun scaffold + declare.ts attribute constants and rate validation"
```

---

### Task 3: Config loading + typed config

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: env vars named in Task 1 `.env.example`.
- Produces: `export interface AppConfig` and `export function loadConfig(env: Record<string,string|undefined>): AppConfig` plus a `defaultAppConfig()` used in tests. Later tasks call `loadConfig(process.env)`.

- [ ] **Step 1: Write the failing test** (`test/config.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { AppConfig, loadConfig } from "../src/config.ts";

describe("config", () => {
  const base = {
    FUP_DB_HOST: "db.lan", FUP_DB_PORT: "3306", FUP_DB_NAME: "raddb",
    FUP_DB_USER: "raduser", FUP_DB_PASSWORD: "pw",
    FUP_NAS_IP: "10.6.7.1", FUP_NAS_COA_PORT: "3796", FUP_NAS_SECRET: "secret",
    FUP_LOG_FILE: "/tmp/fup.log", FUP_LOCK_FILE: "/tmp/fup.lock",
    FUP_RADCLIENT: "/usr/bin/radclient",
    FUP_RADCLIENT_DICT_DIR: "/etc/freeradius/3.0",
  };

  test("builds a typed config from env", () => {
    const c = loadConfig(base) as AppConfig;
    expect(c.db.host).toBe("db.lan");
    expect(c.nas.port).toBe(3796);
  });

  test("rejects missing DB password", () => {
    const gone = { ...base, FUP_DB_PASSWORD: "" };
    expect(() => loadConfig(gone)).toThrow(/FUP_DB_PASSWORD/);
  });

  test("rejects invalid NAS IP", () => {
    const bad = { ...base, FUP_NAS_IP: "not-an-ip" };
    expect(() => loadConfig(bad)).toThrow(/FUP_NAS_IP/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `../src/config.ts` not found.

- [ ] **Step 3: Write the implementation** (`src/config.ts`)

```ts
export interface DbConfig {
  host: string; port: number; database: string;
  user: string; password: string;
}
export interface NasConfig {
  host: string; coaPort: number; secret: string;
}
export interface AppConfig {
  db: DbConfig;
  nas: NasConfig;
  logFile: string;
  lockFile: string;
  radclientPath: string;
  radclientDictDir: string;
}

const reIpV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
export function isValidIp(s: string): boolean {
  if (!reIpV4.test(s)) return false;
  return s.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function need(env: Record<string,string|undefined>, k: string): string {
  const v = env[k];
  if (!v || v.trim() === "") throw new Error(`Missing required env var ${k}`);
  return v.trim();
}
function needInt(env: Record<string,string|undefined>, k: string): number {
  const n = Number(need(env, k));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${k}: must be positive int`);
  return n;
}

export function loadConfig(env: Record<string,string|undefined>): AppConfig {
  const nas = need(env, "FUP_NAS_IP");
  if (!validIp(nas)) throw new Error(`Invalid FUP_NAS_IP=${nas}`);
  return {
    db: {
      host: need(env, "FUP_DB_HOST"),
      port: needInt(env, "FUP_DB_PORT"),
      database: need(env, "FUP_DB_NAME"),
      user: need(env, "FUP_DB_USER"),
      password: need(env, "FUP_DB_PASSWORD"),
    },
    nas: { host: nas, coaPort: needInt(env, "FUP_NAS_COA_PORT"), secret: need(env, "FUP_NAS_SECRET") },
    logFile: need(env, "FUP_LOG_FILE"),
    lockFile: need(env, "FUP_LOCK_FILE"),
    radclientPath: need(env, "FUP_RADCLIENT"),
    radclientDictDir: need(env, "FUP_RADCLIENT_DICT_DIR"),
  };
}

export function defaultAppConfig(): AppConfig {
  return loadConfig({
    FUP_DB_HOST: "localhost", FUP_DB_PORT: "3306", FUP_DB_NAME: "raddb",
    FUP_DB_USER: "raduser", FUP_DB_PASSWORD: "pw",
    FUP_NAS_IP: "10.6.7.1", FUP_NAS_COA_PORT: "3796", FUP_NAS_SECRET: "secret",
    FUP_LOG_FILE: "/tmp/fup.log", FUP_LOCK_FILE: "/tmp/fup.lock",
    FUP_RADCLIENT: "/usr/bin/radclient", FUP_RADCLIENT_DICT_DIR: "/etc/freeradius/3.0",
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: typed env config with validation and no hardcoded secrets"
```

---

### Task 4: Logger and Lock modules

**Files:**
- Create: `src/logger.ts`
- Create: `src/lock.ts`
- Test: `test/logger.test.ts`

**Interfaces:**
- Consumes: nothing external.
- Produces:
  - `createLogger(logFile: string): Logger` where `Logger.log(event: string, msg?: string): void` — timestamps each line.
  - `Lock` class with `acquire(): Promise<boolean>` (true if gained) and `release(): Promise<void>` — atomic `mkdir` guard.

- [ ] **Step 1: Write the failing test** (`test/logger.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger.ts";

test("logger appends timestamped lines", async () => {
  const logPath = Bun.tmpdir() + "/fup-log-" + Math.random().toString(36).slice(2) + ".log";
  const log = createLogger(logPath);
  log.log("START", "check run");
  // file now contains one line, prefixed with a timestamp and the event name
  // (read file via Bun.file(logPath).text() and assert it includes "START" and "check run")
});
```

**Note:** `Bun.tmpdir()` exists in this Bun version; if `open(...).write()` is not flush-aligned, call `.write()` and then read back — adjust for the actual file API returned by Bun's `open`.

- [ ] **Step 2: Run to verify it fails** — `bun test test/logger.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/logger.ts`**

```ts
import { close, open } from "bun";

export interface Logger {
  log(event: string, msg?: string): void;
}

export function createLogger(logFile: string): Logger {
  const handle = open(logFile, { append: true, create: true });
  return {
    log(event: string, msg: string = "") {
      const line = `[${new Date().toISOString()}] ${event}${msg === "" ? "" : ": " + msg}\n`;
      handle.write(line);
    },
  };
}
```

- [ ] **Step 4: Implement `src/lock.ts`** — atomic `mkdir` guard (cross-platform, no shell, no leak):

```ts
import { exists, mkdir, rm } from "bun";

export class Lock {
  #dir: string;
  constructor(lockPath: string) { this.#dir = lockPath; }

  async acquire(): Promise<boolean> {
    try {
      mkdir(this.#dir);
      return true;
    } catch {
      return false; // already held -> racing process exits cleanly
    }
  }

  async release(): Promise<void> {
    if (await exists(this.#dir)) await rm(this.#dir, { force: true });
  }
}
```

(Bun's `mkdir` throws on EEXIST, so the racing proderive `false` — correct.)

- [ ] **Step 5: Add `test/lock.test.ts`** verifying acquire/release round-trip and that a second `acquire()` while held returns `false`. Run both test files; fix until green.

- [ ] **Step 6: Commit**

```bash
git add src/logger.ts src/lock.ts test/logger.test.ts test/lock.test.ts
git commit -m "feat: logger and exclusive lock modules"
```

---

### Task 5: Database module (Drizzle schema + connection)

**Files:**
- Create: `src/db.ts`
- Create: `migration.sql`

**Interfaces:**
- Consumes: `AppConfig` from Task 3.
- Produces:
  - `export const fupState`, `fupSessionState` Drizzle table defs matching existing schema.
  - `export type Db = ReturnType<typeof createDb>`
  - `export function createDb(cfg: AppConfig): Db` — typed connection (`mysql` driver via `mysql2`).
  - `export function closeDb(db: Db): void`

- [ ] **Step 1: Write Drizzle schema models** inside `db.ts` for `fup_state` and `fup_session_state`. Fields exactly as existing tables, `throttled_at` added to `fup_state` as `TIMESTAMP NULL`:

```sql
// (conceptual; Drizzle maps to these columns)
fup_state(username, normal_rate, fup_date, throttled, throttled_at, last_updated)
fup_session_state(id, username, acctuniqueid, acctsessionid, framedipaddress,
                  last_input, last_output, usage_date, daily_input, daily_output,
                  last_seen, closed)
```

- [ ] **Step 2: Write the client constructor** with `drizzle(mysql({ connection: { host, port, user, password, database } }))` using `cfg.db`.

- [ ] **Step 3: Write `migration.sql`** (this is the only schema change):

```sql
ALTER TABLE fup_state ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL;
```

- [ ] **Step 4: Add a gated test** (`test/db.test.ts`) — requires a real DB, so skip unless `process.env.FUP_TEST_DB` is set:

```ts
import { describe, expect, test } from "bun:test";

test("connect round-trips against real DB", { skip: !process.env.FUP_TEST_DB }, async () => {
  // open, run `SELECT 1` via db, assert 1
});
```

- [ ] **Step 5: Run test, commit**

```bash
bun test test/db.test.ts   # skipped without FUP_TEST_DB
git add src/db.ts migration.sql test/db.test.ts
git commit -m "feat: drizzle schema + mysql2 connection + throttled_at migration"
```

---

### Task 6: MikroTik CoA module (`src/coa.ts`)

**Files:**
- Create: `src/coa.ts`
- Test: `test/coa.test.ts`

**Interfaces:**
- Consumes: `AppConfig` (`nas`, `radclientPath`, `radclientDictDir`).
- Produces:
  - `export interface CoaResult { channel: "throttle" | "restore"; ok: boolean; detail: string }`
  - `export function buildCoaArgv(cfg: AppConfig): string[]` — the fixed radclient prefix array (no user data).
  - `export async function sendCoa(cfg: AppConfig, username: string, ip: string, rate: string): Promise<CoaResult>` — spawn(argv) + stdin body; ok iff output includes `Received CoA-ACK`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildCoaArgv } from "../src/coa.ts";
import { defaultAppConfig } from "../src/config.ts";

test("argv path is fixed; user data never becomes a shell string", () => {
  const cfg = defaultAppConfig();
  const argv = buildCoaArgv(cfg);
  expect(argv.includes(cfg.radclientPath)).toBe(true);
  expect(argv.some((a) => a.includes("rm"))).toBe(false); // argv has no -x baked
});
```

- [ ] **Step 2: Verify it fails** — `bun test test/coa.test.ts`

- [ ] **Step 3: Implement `src/coa.ts`**

```ts
import { spawn } from "bun";
import { AppConfig } from "./config.ts";
import { ATTR } from "./declare.ts";

export interface CoaResult { channel: "throttle" | "restore"; ok: boolean; detail: string }

/** Static argv prefix — no username/IP/rate is ever concatenated here. */
export function buildCoaArgv(cfg: AppConfig): string[] {
  return [
    cfg.radclientPath, "-x", "-d", cfg.radclientDictDir,
    `${cfg.nas.host}:${cfg.nas.coaPort}`, "coa", cfg.nas.secret,
  ];
}

/** CoA body delivered over stdin — never folded into a shell string. */
function buildCoaBody(username: string, ip: string, rate: string): string {
  return [
    `User-Name = "${username}"`,
    `Framed-IP-Address = ${ip}`,
    `${ATTR.RATE} := "${rate}"`,
    "",
  ].join("\n");
}

export async function sendCoa(cfg: AppConfig, username: string, ip: string, rate: string): Promise<CoaResult> {
  const details: string[] = [];
  const proc = spawn(buildCoaArgv(cfg), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(new TextEncoder().encode(buildCoaBody(username, ip, rate)));
  proc.stdin.close();
  const output = await proc.stdout.text();          // full stdout + stderr
  const err = await proc.stderr.text();
  details.push(output, err);
  const ok = /Received CoA-ACK/.test(output + " " + err);
  return { channel: "throttle", ok, detail: details.join(" ") };
}
```

**Note for implementer:** adapt to Bun's exact `spawn` return shape (`proc.stdout`/`proc.stderr`/`proc.stdin`). Add a `timeout` if Bun exposes one on `spawn`; otherwise wrap completion.

- [ ] **Step 4: Verify pass** — `bun test test/coa.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat: radclient CoA via spawn argv, no shell"`

---

### Task 7: Shared orchestration (`src/ops.ts`) — the DRY core

> This is the module that makes both entrypoints thin on shared logic, so they never copy each other.

**Files:**
- Create: `src/ops.ts`
- Test: `test/ops.test.ts` (pure functions only; DB-touching fns gated)

**Interfaces:**
- Consumes: `db.ts`, `fup.ts`, `coa.ts`, `config.ts`, `declare.ts`.
- Produces (all consumed by BOTH `fup-check.ts` and `fup-reset.ts`):
  - `export interface SessionState { acctuniqueid: string; username: string; input: bigint; output: bigint }`
  - `export interface UserUsage { dailyInput: bigint; dailyOutput: bigint }`
  - `export async function fetchActiveSessions(db: Db, username?: string): Promise<SessionState[]>`
  - `export async function updateSessionState(db: Db, session: SessionState): Promise<void>` — upsert `fup_session_state` with counter-reset-aware delta and daily accumulation.
  - `export async function rebaseSessionBaselines(db: Db, username?: string): Promise<void>` — set last_input/output=current counter, daily=0 for open sessions; zero closed sessions. Used at midnight and reset.
  - `export async function resolveNormalRate(db: Db, username: string): Promise<string | null>` — fup_state.normal_rate → radcheck/radreply (resolution order from `declare.ts`).
  - `export async function resolveUserPlan(db: Db, username: string): Promise<UserPlan>` — reads Max-Daily-Traffic, FUP-Rate-Limit, FUP-Reset-Time via attribute fallback.
  - `export async function resetQuota(db: Db, username?: string): Promise<void>` — clear throttled flag + `throttled_at`, bump `fup_date`; used by reset + auto-unthrottle.
  - `export async function setThrottled(db: Db, username: string, throttled: boolean): Promise<void>` — update flag + `throttled_at=NOW()` when enabling.
  - `export async function coaFanOut(cfg: AppConfig, db: Db, logger: Logger, username: string, rate: string): Promise<boolean>` — send CoA to all active IPs, return true if any ACK; used by throttle and restore alike.
  - `export async function unthrottleUser(cfg: AppConfig, db: Db, logger: Logger, username: string): Promise<boolean>` — resolve normal rate, CoA restore, resetQuota + rebase. Shared by reset `--coa` and `FUP-Reset-Time` recovery.

- [ ] **Step 1: Write failing tests** for the pure parts: `coaToActive` argument-avoidance (no shell-string), `unthrottleUser`-style recovery semantics, and the `updateSessionState` delta rule (monotonic ⇒ diff, reset ⇒ current). Put DB fns behind `FUP_TEST_DB` gate.

- [ ] **Step 2: Run to verify fail** — `bun test test/ops.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/ops.ts`** — see the interfaces above. Guarantee DRY: attribute resolution, session delta, rebase, reset, and CoA fan-out each appear once. Uses `validIp`/`validUser` before any CoA or write.

- [ ] **Step 4: Run to verify pass** — `bun test test/ops.test.ts` → PASS for pure parts.

- [ ] **Step 5: Commit** — `git commit -m "feat: ops.ts shared orchestration used by both entrypoints"`.

---

### Task 8: `fup-check.ts` — minute cron (thin)

**Files:**
- Create: `src/bin/fup-check.ts`

**Interfaces:**
- Consumes: `loadConfig(process.env)`, `Lock`, `createLogger`, `createDb`, and the `ops.ts` functions from Task 7. Produces nothing (side-effect daemon). Logic stays in Task 7's `ops`.

- [ ] **Step 1: Wire the tick** — load config; `lock.acquire()` (log + exit 0 if already running); log `START`; open db; log `NEW_DAY` if `fup_state.fup_date != today`.
- [ ] **Step 2: Session accounting** — `fetchActiveSessions(db)` then `updateSessionState(db, s)` per session (delta via `computeDelta`); aggregate daily per username with `UserUsage`.
- [ ] **Step 3: Throttle** — for users with daily ≥ quota and not throttled: `resolveUserPlan`, `coaToActive(db, user, plan.fupRate)`, and if it returned true `setThrottled(user, true)`. Log `FUP_REACHED` / `COA_SENT` / `COA_ACK` / `COA_FAILED`.
- [ ] **Step 4: `FUP-Reset-Time` recovery** — for throttled users whose `throttled_at` + resetMinutes ≤ now: log `RESET`, then `unthrottleUser(...)`.
- [ ] **Step 5: Wrap up** — log `SUMMARY` (users examined/throttled/recovered), release lock, exit 0.
- [ ] **Step 6: Commit** — `git commit -m "feat: minute fup-check cron entrypoint"`.

---

### Task 9: `fup-reset.ts` — daily/manual reset (thin)

**Files:**
- Create: `src/bin/fup-reset.ts`

**Interfaces:**
- Consumes: `config`, `db`, `lock`, `logger`, and the `shared` Task 7 `ops`. Produces nothing.
- Args: optional `username`, `--coa`.

- [ ] **Step 1: Parse argv** — first non-flag arg = username; `--coa` sets resetRate. Acquire lock; log `START`.
- [ ] **Step 2: Reset quota state** — `resetQuota(db, username)` (all or single); `rebaseSessionBaselines(db, username)`.
- [ ] **Step 3: Optional CoA restore** — if `--coa` and username: `resolveNormalRate`, then `coaToF for all active IPs` via `unthrottleUser`. Log `COA_RESTORE` / `COA_ACK` / `COA_FAILED`.
- [ ] **Step 4: Wrap up** — log `RESET` summary, release lock, exit 0 unless fatal.
- [ ] **Step 5: Commit** — `git commit -m "feat: reset entrypoint (username + --coa)"`.

---

### Task 10: README + `.env.example` final doc + cron wiring

**Files:**
- Create: `README.md`
- Modify: `.env.example` if any keys added during tasks.

- [ ] **Step 1: `README.md`** — architecture; setup (Bun + deps); `.env` configuration; both entrypoint usages; **the new `FUP-Reset-Time` attribute** and its auto-unthrottle semantics; cron examples:

```cron
* * * * * /path/bun /path/script-FUP/src/bin/fup-check.ts
1 0 * * * /path/bun /path/script-FUP/src/bin/fup-reset.ts
```

Plus `migration.sql` install/rollback notes.
- [ ] **Step 2: Commit** — `git commit -m "docs: README with setup, cron, and FUP-Reset-Time usage"`.

---

### Task 11: Security + edge-case pass (final hardening)

**Files:**
- Modify: `src/ops.ts` (redaction, validation), `src/bin/fup-check.ts`, `src/bin/fup-reset.ts` (wrap-ups), `test/ops.test.ts`.

- [ ] **Step 1: Log redaction** — `redact(value, secrets) => string` that replaces `cfg.nas.secret` and `cfg.db.password` with `***`. Apply inside `ops` before any detail reaches `logger.log`. Assert with a test.
- [ ] **Step 2: Validate inputs** — `validUser(u)` (no control chars, len ≤ 64, `[\w@.\-]`) in `ops` wherever a username/`Framed-IP-Address` is used; skip invalid with a log line. Reuse `validIp` from `config.ts`.
- [ ] **Step 3: BigInt safety** — confirm `updateSessionState`/`aggregate` keep `bigint` end-to-end; add a test that two large counters (`9007199254740993n`) sum without precision loss.
- [ ] **Step 4: Concurrency** — verify both entrypoints wrap in `Lock.acquire/release`, and that a `false` acquire exits cleanly with no partial write (document in code comment).
- [ ] **Step 5: Commit** — `git commit -m "chore: hardening - redact secrets, validate inputs, bigint-safe"`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-25-bun-fup-migration.md`. Now DRY by construction: the shared operations module (`Task 7`) holds every logic once, both entrypoints stay thin. Three decisions remain for you to confirm before execution:

1. **Secrets** — `declare.ts` holds *attribute names* and *defaults*; DB + NAS secrets live only in `.env` (security wins over the spec's contradictory line about creds in `declare.ts`). Good?
2. **FUP-Reset-Time semantics** — confirmed: `throttled_at` records the moment of throttling (TIMESTAMP), and auto-unthrottle fires when `now >= throttled_at + resetMinutes`. It also *zeroes that day's usage* (rebase baseline to current counters), so a user can be re-throttled the same day if they keep downloading.
3. **Schema** — `fup_state` gains `throttled_at TIMESTAMP NULL` on top of the existing `throttled` flag; FUP-Reset-Time compares `now >= throttled_at + resetMinutes`. Good?

Then pick execution mode:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — I run tasks in this session with checkpoints for your review.

Which approach, and do all three decisions stand?