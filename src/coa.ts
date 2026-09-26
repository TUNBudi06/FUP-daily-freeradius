import { spawn, type Subprocess } from "bun";
import type { AppConfig } from "./config.ts";
import { ATTR, isSafeRateString } from "./declare.ts";
import { isValidIp } from "./config.ts";
import { validUser } from "./fup.ts";
import type { Logger } from "./logger.ts";

export interface CoaResult {
  channel: "throttle" | "restore";
  ok: boolean;
  detail: string;
  /** Present only when radclient reported a CoA-NAK. */
  nakReason?: string;
}

/** radclient exit is indistinguishable from a network hang; cap the wait. */
const COA_TIMEOUT_MS = 5_000;

/**
 * Static argv prefix for radclient. No username/IP/rate is ever concatenated
 * here — those travel only via stdin, so no shell interpolation is possible.
 * Uses both dictionary dirs, matching the original Bash script.
 */
export function buildCoaArgv(cfg: AppConfig): string[] {
  return [
    cfg.radclientPath,
    "-x",
    "-d",
    cfg.radclientDict,
    "-D",
    cfg.radclientDictDir,
    `${cfg.nas.host}:${cfg.nas.coaPort}`,
    "coa",
    cfg.nas.secret,
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

/**
 * radclient prints NAK attribute dumps as:
 *   Received CoA-NAK
 *   Error-Cause = 402
 *   ... (Unsupported-Extension)
 * Grab the parenthesized human string; fall back to the numeric code.
 */
export function parseErrorCause(detail: string): string | undefined {
  const m = /Error-Cause\s*=\s*(\d+)/.exec(detail);
  if (!m) return undefined;
  const code = m[1];
  const human = /\(([^)]+)\)/.exec(detail)?.[1];
  return human ? `${human} (${code})` : code;
}

/**
 * Send a CoA rate-change for a user on one IP. Resolves `ok: true` only when
 * radclient reports `Received CoA-ACK`. Kills the child on timeout.
 */
export async function sendCoa(
  cfg: AppConfig,
  logger: Logger,
  username: string,
  ip: string,
  rate: string,
  channel: "throttle" | "restore",
): Promise<CoaResult> {
  // Everything below lands in radclient's stdin; refuse anything that could
  // break out of the quoted attribute values (defence in depth — callers
  // validate too, but a DB-sourced rate reaches here unfiltered).
  if (!validUser(username) || !isValidIp(ip) || !isSafeRateString(rate)) {
    return { channel, ok: false, detail: "refused: invalid username, IP or rate" };
  }
  let proc: Subprocess<"pipe", "pipe", "pipe">;
  const argv = buildCoaArgv(cfg);
  try {
    proc = spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as Subprocess<"pipe", "pipe", "pipe">;
  } catch (e) {
    return { channel, ok: false, detail: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const body = buildCoaBody(username, ip, rate);
  try {
    proc.stdin!.write(new TextEncoder().encode(body));
    proc.stdin!.end();
  } catch {
    // radclient died before reading stdin (EPIPE); the race below reports it.
  }

  if (cfg.debugLevel >= 1) {
    // The last argv element is cfg.nas.secret — never log it.
    const redacted = [...argv];
    redacted[redacted.length - 1] = "***";
    logger.log("COA_DEBUG", `argv: ${redacted.join(" ")}`);
    logger.log("COA_DEBUG", `body: ${JSON.stringify(body)}`);
  }
  if (cfg.debugLevel >= 2) {
    // Malformed rows must never abort a CoA; show the raw values so the
    // operator can see exactly what the NAS was asked for.
    logger.detail(2, "COA_DETAIL", `channel=${channel} user=${username || "<unset>"} ip=${ip || "<unset>"} rate=${rate || "<unset>"}`);
  }

  const full = async (): Promise<{ out: string; err: string }> => {
    const [out, err] = await Promise.all([
      proc.stdout!.text(),
      proc.stderr!.text(),
    ]);
    return { out, err };
  };

  const done = full().finally(() => proc.killed); // release handle when finished
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      proc.kill();
      reject(new Error(`radclient timed out after ${COA_TIMEOUT_MS}ms`));
    }, COA_TIMEOUT_MS);
  });

  const finish = (detail: string, ok: boolean): CoaResult => {
    const reason = /Received CoA-NAK/.test(detail) ? parseErrorCause(detail) : undefined;
    return {
      channel,
      ok,
      detail: reason ? `${detail} [NAK reason: ${reason}]` : detail,
      nakReason: reason,
    };
  };

  try {
    const { out, err } = await Promise.race([done, timer]);
    const ok = /Received CoA-ACK/.test(out + " " + err);
    return finish((out + " " + err).trim(), ok);
  } catch (e) {
    return finish(e instanceof Error ? e.message : String(e), false);
  } finally {
    clearTimeout(timerId);
  }
}