/**
 * Centralized RADIUS attribute names, defaults, and validation.
 * Holds only attribute *names* and RADIUS *defaults* — never secrets.
 */
export const ATTR = {
  /** Daily traffic quota attribute (bytes/day). */
  MAX_DAILY: "Max-Daily-Traffic",
  /** Native MikroTik rate-limit attribute. */
  RATE: "Mikrotik-Rate-Limit",
  /** Custom FUP rate-limit attribute (this project's override). */
  FUP_RATE: "FUP-Rate-Limit",
  /** Minutes of grace before auto-unthrottle after a throttle. */
  FUP_RESET_TIME: "FUP-Reset-Time",
  /** Per-device FUP switch. Truthy: each device's own session is evaluated
   *  against the quota independently; only the specific framed IP that
   *  crosses the cap is CoA-throttled. Falsy (default): per-user aggregate
   *  (every device for the username is throttled together). */
  FUP_PER_DEVICE: "FUP-Per-Device",
} as const;

/** Fallback order for resolving the FUP rate: entry group then per-user, check before reply. */
export const RATE_RESOLUTION_ORDER = [
  "radcheck",
  "radreply",
  "radgroupcheck",
  "radgroupreply",
] as const;

/** Fallback throttle rate applied when no FUP rate is configured. */
export const DEFAULT_FUP_RATE = "5M/5M";

export interface FUPResolved {
  /** The rate to enforce over CoA, or null to fall back to DEFAULT_FUP_RATE. */
  fupRate: string;
  /** Minutes of grace before auto-unthrottle, or null if FUP-Reset-Time is unset. */
  resetMinutes: number | null;
}

const RATE_RE = /^\d+[kKmMgG]\/\d+[kKmMgG]$/;

/** True when the string is a valid MikroTik bandwidth token, e.g. "5M/5M". */
export function isMikrotikRate(s: string): boolean {
  return RATE_RE.test(s.trim());
}

/** Validate a user-supplied rate: must be a well-formed MikroTik rate. */
export function validRate(rate: string): boolean {
  return isMikrotikRate(rate);
}