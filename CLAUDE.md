# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Daily Fair-Use-Policy (FUP) throttling for FreeRADIUS/MikroTik. TypeScript + Bun + Drizzle + mysql2. Overview in `README.md`; RADIUS attributes in `@ATTRIBUTES.md`; deployment in `@DEPLOY.md`.

## Where things run

- **Do not run `bun run check` / `reset` / `debug` in this local environment.** They need the live FreeRADIUS DB, `radclient`, and the MikroTik NAS. Run them on the server via `ssh root@10.6.7.5` (the `radius06` server, which is where this actually runs).
- Offline commands are fine locally: `bun test` (single file: `bun test test/ops.test.ts`, single case: `bun test -t "<name>"`) and `bunx tsc --noEmit`.
- `bun run debug <username> [ip]` always fires a **real CoA** at the NAS, so treat it as a live operation.

## Architecture rules

- All decision logic lives once in `src/ops.ts`. The entrypoints in `src/bin/` are thin wiring (config → lock → logger → db → `ops` helper). Don't re-implement attribute resolution, delta accounting, rebase, quota reset, or CoA fan-out in a `bin/` file.
- `src/fup.ts` is pure math with no I/O. Octet counters are `bigint` end-to-end, so never introduce `number`/float arithmetic on them.
- `radclient` is spawned via an argv array with the CoA body on stdin (`src/coa.ts`). Never build a shell string.
- Usernames and IPs are validated/redacted before logging. The NAS secret must never reach a log line.
- `FUP_DEBUG` is a level 0–2 (invalid values → 0, >2 clamps to 2), not a boolean. `bin/fup-debug.ts` forces level 2 without mutating the loaded config.
- `check` and `reset` share one filesystem lock (`src/lock.ts`); keep both guarded by it.

## Build / schema gotchas

- `scripts/build.mjs` only compiles `check` and `reset` into `dist/`. `fup-debug` is not a build target (run it from source).
- Schema changes go in `migration.sql` and must be additive and safe to re-run (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc. — a bare `ADD COLUMN` breaks re-runs). Per-device mode depends on the `fup_state_throttled` table. `create.sql` is the from-scratch counterpart for a `raddb` with no FUP tables yet — keep both files' table shapes in sync.
- `.gitignore` excludes `*.lock`, `*.log`, `dist/`, `package-lock.json`, and the legacy Bash scripts (`fup-coa-*.sh`). Bun's lockfile is `bun.lock`; ignore `package-lock.json`.
