-- The only schema change: record when a throttle was applied. FUP-Reset-Time
-- auto-unthrottle compares the wall clock against throttled_at + resetMinutes.
ALTER TABLE fup_state ADD COLUMN throttled_at TIMESTAMP NULL DEFAULT NULL;