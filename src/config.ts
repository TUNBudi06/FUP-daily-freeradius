/**
 * Typed application configuration loaded from environment variables.
 * Secrets (DB password, NAS secret) are read from env only, never hardcoded.
 */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface NasConfig {
  host: string;
  coaPort: number;
  secret: string;
}

export interface AppConfig {
  db: DbConfig;
  nas: NasConfig;
  logFile: string;
  lockFile: string;
  radclientPath: string;
  /** radclient -d main dictionary directory. */
  radclientDict: string;
  /** radclient -D second dictionary directory. */
  radclientDictDir: string;
  /**
   * Diagnostic verbosity from FUP_DEBUG, clamped to 0..2:
   *   0 = file log only (default)
   *   1 = also echo every log line to stderr (the old FUP_DEBUG=1 behaviour)
   *   2 = 1 + per-session/per-IP detail and raw radclient output
   */
  debugLevel: number;
}

const reIpV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** True when `s` is a valid dotted IPv4 address. */
export function isValidIp(s: string): boolean {
  if (!reIpV4.test(s)) return false;
  return s.split(".").every((o) => {
    const n = Number(o);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Return required env var or throw a descriptive error. */
function need(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") throw new Error(`Missing required env var ${key}`);
  return v.trim();
}

/** Parse a required positive integer env var. */
function needInt(env: Record<string, string | undefined>, key: string): number {
  const n = Number(need(env, key));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${key}: must be a positive integer`);
  return n;
}

/**
 * Parse FUP_DEBUG into a debug level clamped to 0..2. Diagnostics must never
 * take the cycle down, so every malformed value (missing, blank, whitespace,
 * non-numeric, negative, fractional, NaN) quietly falls back to 0; anything
 * above 2 is clamped to 2.
 */
export function parseDebugLevel(raw: string | undefined): number {
  if (raw == null) return 0;
  const s = raw.trim();
  if (!/^-?\d+$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n > 2 ? 2 : n;
}

/** Build a validated config from an env record. Throws on missing/invalid values. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const nasHost = need(env, "FUP_NAS_IP");
  if (!isValidIp(nasHost)) throw new Error(`Invalid FUP_NAS_IP=${nasHost}`);
  return {
    db: {
      host: need(env, "FUP_DB_HOST"),
      port: needInt(env, "FUP_DB_PORT"),
      database: need(env, "FUP_DB_NAME"),
      user: need(env, "FUP_DB_USER"),
      password: need(env, "FUP_DB_PASSWORD"),
    },
    nas: {
      host: nasHost,
      coaPort: needInt(env, "FUP_NAS_COA_PORT"),
      secret: need(env, "FUP_NAS_SECRET"),
    },
    logFile: need(env, "FUP_LOG_FILE"),
    lockFile: need(env, "FUP_LOCK_FILE"),
    radclientPath: need(env, "FUP_RADCLIENT"),
    radclientDict: need(env, "FUP_RADCLIENT_DICT"),
    radclientDictDir: need(env, "FUP_RADCLIENT_DICT_DIR"),
    debugLevel: parseDebugLevel(env.FUP_DEBUG),
  };
}

/**
 * One-line, secret-free summary of the resolved config for the START log
 * line — lets an operator confirm which DB/NAS/dictionaries a cron run
 * actually loaded (a common source of "why isn't this picking up my .env"
 * tickets) without ever printing the DB password or NAS secret.
 */
export function safeConfigSummary(cfg: AppConfig): string {
  return (
    `db=${cfg.db.user}@${cfg.db.host}:${cfg.db.port}/${cfg.db.database} ` +
    `nas=${cfg.nas.host}:${cfg.nas.coaPort} ` +
    `radclient=${cfg.radclientPath} dict=${cfg.radclientDict} dictDir=${cfg.radclientDictDir} ` +
    `debug=${cfg.debugLevel}`
  );
}

/** A fully-populated default config, used by tests and the entrypoints. */
export function defaultAppConfig(): AppConfig {
  return loadConfig({
    FUP_DB_HOST: "localhost",
    FUP_DB_PORT: "3306",
    FUP_DB_NAME: "raddb",
    FUP_DB_USER: "raduser",
    FUP_DB_PASSWORD: "pw",
    FUP_NAS_IP: "10.6.7.1",
    FUP_NAS_COA_PORT: "3799",
    FUP_NAS_SECRET: "secret",
    FUP_LOG_FILE: "/tmp/fup.log",
    FUP_LOCK_FILE: "/tmp/fup.lock",
    FUP_RADCLIENT: "/usr/bin/radclient",
    FUP_RADCLIENT_DICT: "/usr/share/freeradius",
    FUP_RADCLIENT_DICT_DIR: "/etc/freeradius/3.0",
    FUP_DEBUG: "0",
  });
}