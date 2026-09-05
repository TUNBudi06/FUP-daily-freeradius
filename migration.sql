-- Record when a throttle was applied. FUP-Reset-Time auto-unthrottle compares
-- the wall clock against throttled_at + resetMinutes.
ALTER TABLE fup_state ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL;

-- The bootstrap INSERT (runCheckCycle) seeds fup_state from fup_session_state with
-- normal_rate = NULL (rate is resolved later, at throttle time). The live table
-- is NOT NULL, which makes that seed fail. Bring it in line with the Drizzle model.
-- Safe to re-run; existing rows are untouched.
ALTER TABLE fup_state MODIFY normal_rate VARCHAR(64) NULL DEFAULT NULL;

-- ----------------------------------------------------------------------------
-- Per-device FUP mode (FUP-Per-Device attribute, see ATTRIBUTES.md §1.5).
--
-- When the user's plan sets FUP-Per-Device = 1 (truthy), the throttler
-- evaluates quota per row in fup_session_state rather than per user. Each
-- (username, acctuniqueid) pair that crosses the cap is CoA-throttled
-- independently. This table tracks which sessions are currently throttled
-- for that user. Rows are created on the cycle that trips the cap and
-- removed on the cycle that restores the rate (in-cycle unthrottle, FUP-
-- Reset-Time recovery, or fup-reset). rebaseSessionBaselines also clears
-- any remaining rows for a user on a daily reset.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fup_state_throttled (
  username        VARCHAR(64) NOT NULL,
  acctuniqueid    VARCHAR(64) NOT NULL,
  framedipaddress VARCHAR(45) NOT NULL,   -- snapshot for log/debugging
  throttled_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  throttled_rate  VARCHAR(64) NOT NULL,   -- rate we sent via CoA
  PRIMARY KEY (username, acctuniqueid),
  KEY idx_user (username)
) ENGINE=InnoDB;