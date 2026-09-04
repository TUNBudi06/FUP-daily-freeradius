import { spawn, type Subprocess } from "bun";
import type { AppConfig } from "./config.ts";
import { ATTR } from "./declare.ts";

export interface CoaResult {
  channel: "throttle" | "restore";
  ok: boolean;
  detail: string;
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
 * Send a CoA rate-change for a user on one IP. Resolves `ok: true` only when
 * radclient reports `Received CoA-ACK`. Kills the child on timeout.
 */
export async function sendCoa(
  cfg: AppConfig,
  username: string,
  ip: string,
  rate: string,
  channel: "throttle" | "restore",
): Promise<CoaResult> {
  let proc: Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = spawn(buildCoaArgv(cfg), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as Subprocess<"pipe", "pipe", "pipe">;
  } catch (e) {
    return { channel, ok: false, detail: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  proc.stdin!.write(new TextEncoder().encode(buildCoaBody(username, ip, rate)));
  proc.stdin!.end();

  const full = async (): Promise<{ out: string; err: string }> => {
    const [out, err] = await Promise.all([
      proc.stdout!.text(),
      proc.stderr!.text(),
    ]);
    return { out, err };
  };

  const done = full().finally(() => proc.killed); // release handle when finished
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`radclient timed out after ${COA_TIMEOUT_MS}ms`));
    }, COA_TIMEOUT_MS),
  );

  try {
    const { out, err } = await Promise.race([done, timer]);
    const ok = /Received CoA-ACK/.test(out + " " + err);
    return { channel, ok, detail: (out + " " + err).trim() };
  } catch (e) {
    return { channel, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}