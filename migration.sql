-- Record when a throttle was applied. FUP-Reset-Time auto-unthrottle compares
-- the wall clock against throttled_at + resetMinutes.
ALTER TABLE fup_state ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL;

-- The bootstrap INSERT (runCheckCycle) seeds fup_state from fup_session_state with
-- normal_rate = NULL (rate is resolved later, at throttle time). The live table
-- is NOT NULL, which makes that seed fail. Bring it in line with the Drizzle model.
-- Safe to re-run; existing rows are untouched.
ALTER TABLE fup_state MODIFY normal_rate VARCHAR(64) NULL DEFAULT NULL;