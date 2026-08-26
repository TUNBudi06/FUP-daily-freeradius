/**
 * Pure, bigint-safe FUP delivery/throttle math. No DB, no I/O — every function
 * here is deterministic on its inputs so it can be unit-tested in isolation.
 */
import { isMikrotikRate } from "./declare.ts";

/** Read an octet counter as bigint, guarding against NULL / invalid driver types. */
export function asBig(v: unknown, fallback: bigint = 0n): bigint {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    return BigInt(v as string | number | bigint);
  } catch {
    return fallback;
  }
}

/**
 * Counter-reset-aware per-cycle delta. As long as the counter moved forward we
 * take the difference; the moment it wraps (counter reset) the full current
 * value counts as the cycle's delta. Mirrors the Bash `-ge` else-branch.
 */
export function computeDelta(current: bigint, last: bigint): bigint {
  return current >= last ? current - last : current;
}

/** Accumulate a cycle delta onto a daily total. */
export function accumulateDaily(daily: bigint, delta: bigint): bigint {
  return daily + delta;
}

/**
 * True once accumulated daily traffic reaches the quota.
 * A null or non-positive quota means no limit, so it never trips.
 */
export function isQuotaReached(daily: bigint, quota: bigint): boolean {
  if (quota <= 0n) return false;
  return daily >= quota;
}

/** A rate is CoA-safe only if it is a well-formed MikroTik bandwidth token. */
export function validCoaRate(rate: string): boolean {
  return isMikrotikRate(rate);
}