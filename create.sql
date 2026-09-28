-- create.sql — fresh-install schema for the FUP throttler's own tables.
--
-- Use this on a raddb that does NOT already have fup_state / fup_session_state
-- (a brand-new FreeRADIUS install, or one that never ran the original Bash
-- throttler). It creates all three FUP tables in their current shape —
-- everything migration.sql's ALTERs would otherwise bring an old Bash-era
-- install up to.
--
--   mysql raddb < create.sql
--
-- Upgrading an EXISTING Bash-era install (one that already has fup_state /
-- fup_session_state from the old fup-coa-check.sh / fup-coa-reset.sh
-- bootstrap)? Use migration.sql instead — it ALTERs those tables in place
-- rather than trying to (re)create them.
--
-- Safe to run more than once, and safe to run before or after migration.sql:
-- every statement here is CREATE TABLE IF NOT EXISTS, so it never touches a
-- table that already exists. None of this touches FreeRADIUS's own tables
-- (radcheck, radreply, radgroupcheck, radgroupreply, radusergroup, radacct) —
-- those come from FreeRADIUS's own schema and must already be present.

-- ----------------------------------------------------------------------------
-- fup_state — one row per RADIUS user: today's throttle flag, the rate to
-- restore on unthrottle, and when the throttle was applied (drives the
-- FUP-Reset-Time auto-restore in ops.ts). Rows are created on demand by
-- runCheckCycle as users appear in fup_session_state.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fup_state (
  username     VARCHAR(64) NOT NULL,
  normal_rate  VARCHAR(64) DEFAULT NULL,      -- Mikrotik-Rate-Limit to restore; NULL until resolved
  fup_date     DATE DEFAULT NULL,             -- the day this row's usage/throttle applies to
  throttled    TINYINT(1) NOT NULL DEFAULT 0, -- 1 = currently CoA-throttled to FUP-Rate-Limit
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  throttled_at TIMESTAMP NULL DEFAULT NULL,   -- moment the throttle was applied; FUP-Reset-Time grace starts here
  PRIMARY KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- fup_session_state — one row per radacct accounting session: the last-seen
-- octet counters (baseline for the next cycle's delta) and today's
-- accumulated total. runCheckCycle sums daily_input+daily_output per
-- username (aggregateUsage) to compare against Max-Daily-Traffic.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fup_session_state (
  id              BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  username        VARCHAR(64) NOT NULL,
  acctuniqueid    VARCHAR(64) NOT NULL,          -- ties this row to one radacct session
  acctsessionid   VARCHAR(64) NOT NULL DEFAULT '',
  framedipaddress VARCHAR(15) NOT NULL DEFAULT '', -- cache only; the live IP is always read from radacct
  last_input      BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,  -- baseline acctinputoctets from the last cycle
  last_output     BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,  -- baseline acctoutputoctets from the last cycle
  usage_date      DATE NOT NULL,                 -- the day daily_input/daily_output apply to
  daily_input     BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,  -- accumulated bytes in for usage_date
  daily_output    BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,  -- accumulated bytes out for usage_date
  last_seen       DATETIME NOT NULL,
  closed          TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_acctuniqueid (acctuniqueid),
  KEY idx_username_date (username, usage_date),
  KEY idx_username_active (username, closed),
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- fup_state_throttled — per-device FUP mode only (FUP-Per-Device=1, see
-- ATTRIBUTES.md §1.5). One row per currently-throttled (username, acctuniqueid)
-- pair; fup_state.throttled/.throttled_at for such a user are the recomputed
-- aggregate of these rows (recomputeUserThrottleFlag in ops.ts). Empty on a
-- deployment that never uses per-device mode.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fup_state_throttled (
  username        VARCHAR(64) NOT NULL,
  acctuniqueid    VARCHAR(64) NOT NULL,
  framedipaddress VARCHAR(45) NOT NULL,             -- snapshot for log/debugging
  throttled_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  throttled_rate  VARCHAR(64) NOT NULL,             -- rate sent via CoA (FUP-Rate-Limit)
  PRIMARY KEY (username, acctuniqueid),
  KEY idx_user (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Verify:
--   SELECT COUNT(*) FROM fup_state;
--   SELECT COUNT(*) FROM fup_session_state;
--   SELECT COUNT(*) FROM fup_state_throttled;   -- 0 until FUP-Per-Device=1 is used
