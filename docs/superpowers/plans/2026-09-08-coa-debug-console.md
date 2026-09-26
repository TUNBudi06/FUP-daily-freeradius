# Plan: CoA Debug Console (argv + body + parsed NAK reason)

> **Superseded note:** this plan was written when verbosity was the boolean
> `AppConfig.verbose` (`FUP_DEBUG === "1"`). That was later replaced by the
> numeric `AppConfig.debugLevel` (`parseDebugLevel`, clamped 0–2). Wherever this
> document says `cfg.verbose` / `FUP_DEBUG=1`, read `cfg.debugLevel >= 1`
> (`FUP_DEBUG` level 1). The plan body below is kept as written.

## Goal

Give the operator a way to see exactly what radclient ran and what it returned,
without grepping through a 3-way interleaved stdout/stderr blob. This is a
debugging aid, not a new feature:

- Before each `spawn`, log the exact argv and the CoA body delivered over stdin
  (debug-only, gated by `FUP_DEBUG` level ≥ 1).
- Always include the full raw stdout+stderr in `detail` (unchanged behavior).
- When radclient emits `Received CoA-NAK`, parse the `Error-Cause` attribute
  value and surface it as a distinct field so the operator sees e.g.
  `Unsupported-Extension` instead of hunting for it in a long string.

## Background (from the code)

- `sendCoa` (src/coa.ts:47) currently takes `(cfg, username, ip, rate, channel)`
  — no logger. It returns `{ channel, ok, detail }` where `detail` is the
  combined `stdout + " " + stderr` trimmed (src/coa.ts:87).
- `ok` is set by `ok = /Received CoA-ACK/.test(out + " " + err)`.
- A CoA-NAK from the NAS appears in radclient output as `Received CoA-NAK`
  followed by an attribute dump that includes
  `Error-Cause = <number>` and a human string in parentheses, e.g.
  `Error-Cause = 402` / `(Unsupported-Extension)`.
- `AppConfig.verbose` is `FUP_DEBUG === "1"` (src/config.ts:80). The logger
  created with `verbose: true` echoes every line to stderr (src/logger.ts:27),
  so gating on the logger's verbose flag gives us the console output for free.
  *(Superseded: now `AppConfig.debugLevel` 0–2; the console echo happens at
  level ≥ 1.)*
- `ops.ts` has three `sendCoa` call sites: src/ops.ts:361 (throttle fan-out),
  src/ops.ts:586 (restore), src/ops.ts:659 (per-device throttle).

## Changes

### 1. src/coa.ts — accept a logger, emit debug lines

- Add `import type { Logger } from "./logger.ts";`
- Extend the `sendCoa` signature to take a `logger: Logger` parameter
  (placed after `cfg`, before `username`):

  ```ts
  export async function sendCoa(
    cfg: AppConfig,
    logger: Logger,
    username: string,
    ip: string,
    rate: string,
    channel: "throttle" | "restore",
  ): Promise<CoaResult>
  ```

- Add a `debug()` helper inside `sendCoa` that only emits when `cfg.debugLevel >= 1`:

  ```ts
  const debug = (msg: string) => {
    if (cfg.debugLevel >= 1) logger.log("COA_DEBUG", msg);
  };
  ```

- Before `spawn`, emit the argv (secret redacted) and the body:

  ```ts
  debug(`argv: ${buildCoaArgv(cfg).map((a, i) => (i === argv.length - 1 ? "***" : a)).join(" ")}`);
  debug(`body: ${JSON.stringify(buildCoaBody(username, ip, rate))}`);
  ```

  (The last argv element is `cfg.nas.secret`, so it is replaced with `***`.
  Never log the secret.)

- After the race resolves, before returning, if the result is a NAK, parse and
  attach the reason:

  ```ts
  const reason = /Received CoA-NAK/.test(detail)
    ? parseErrorCause(detail)
    : undefined;
  return { channel, ok, detail, nakReason: reason };
  ```

- Add the field to `CoaResult` and a parser:

  ```ts
  export interface CoaResult {
    channel: "throttle" | "restore";
    ok: boolean;
    detail: string;
    /** Present only when radclient reported a CoA-NAK. */
    nakReason?: string;
  }

  /**
   * radclient prints NAK attribute dumps as:
   *   Received CoA-NAK
   *   Error-Cause = 402
   *   ... (Unsupported-Extension)
   * Grab the parenthesized human string; fall back to the numeric code.
   */
  function parseErrorCause(detail: string): string | undefined {
    const m = /Error-Cause\s*=\s*(\d+)/.exec(detail);
    if (!m) return undefined;
    const code = m[1];
    const human = /\(([^)]+)\)/.exec(detail)?.[1];
    return human ? `${human} (${code})` : code;
  }
  ```

### 2. src/ops.ts — pass the logger at all three call sites

- `src/ops.ts:361` (coaFanOut throttle): `sendCoa(cfg, logger, username, ip, rate, "throttle")`
- `src/ops.ts:586` (restore): `sendCoa(cfg, logger, username, ip, normalRate, "restore")`
- `src/ops.ts:659` (per-device throttle): `sendCoa(cfg, logger, username, row.framedipaddress, plan.fupRate, "throttle")`

These already have `logger` in scope (they take it as a parameter).

### 3. src/coa.ts — surface the NAK reason in the returned detail

When `nakReason` is present, append it to `detail` so it is also visible in the
existing `COA_ACK`/`COA_FAILED` log lines without extra work in ops.ts:

```ts
const detail = (out + " " + err).trim();
const reason = /Received CoA-NAK/.test(detail) ? parseErrorCause(detail) : undefined;
return {
  channel,
  ok,
  detail: reason ? `${detail} [NAK reason: ${reason}]` : detail,
  nakReason: reason,
};
```

## Log event naming

- `COA_DEBUG` — argv + body, only when `FUP_DEBUG` is at least level 1.
- NAK reason is folded into the existing result detail (`COA_ACK` / `COA_FAILED`
  lines already carry `detail`), so no new event type is strictly required.
  Optionally, ops.ts could emit a distinct `COA_NAK` event, but that is
  unnecessary — the operator asked for the *reason*, which is now in detail.

## Security notes

- The CoA secret is redacted in the debug argv line (`***`), never written to
  the log or console. The body (User-Name, IP, rate) is not sensitive in this
  context (these already appear in normal logs), but is still fine to log.
- No shell string is ever built — argv and body remain separate, exactly as in
  the existing code.

## Testing

- Add a unit test for `parseErrorCause` in `test/coa.test.ts`:
  - Input with `Error-Cause = 402` and `(Unsupported-Extension)` → `Unsupported-Extension (402)`.
  - Input with only the numeric code → `402`.
  - Input without `Error-Cause` → `undefined`.
- `parseErrorCause` must be exported for the test to import it.
- Run `bun test` — all existing tests must still pass. The `buildCoaArgv` tests
  are unaffected (signature unchanged).
- Manual smoke check (operator, not automated): run
  `FUP_DEBUG=1 bun src/bin/fup-check.ts` (or `bun run debug <user>`, always
  level 2) against a test user and confirm
  `COA_DEBUG` lines appear with argv + body, and that a NAK (if any) shows the
  reason.

## Checklist

- [ ] src/coa.ts: `CoaResult` gains `nakReason?`
- [ ] src/coa.ts: `sendCoa` takes `logger` and emits `COA_DEBUG` (argv redacted, body)
- [ ] src/coa.ts: `parseErrorCause` exported, tested
- [ ] src/coa.ts: NAK reason folded into `detail`
- [ ] src/ops.ts: three call sites pass `logger`
- [ ] test/coa.test.ts: `parseErrorCause` tests
- [ ] `bun test` green
