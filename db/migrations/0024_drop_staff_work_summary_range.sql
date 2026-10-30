-- Sales per hour is haircuts over hours worked from staff_performance_facts
-- (handler GET /staff-performance, 2026-10-30). Nothing reads YOT's
-- range-level Staff Work Summary figure any more, so the tables 0023 added
-- for it go. Per-day staff_work_summary_facts stays: Chair time (Avg Length)
-- still comes from it.
DROP INDEX IF EXISTS idx_staff_work_summary_range_facts_window;
DROP TABLE IF EXISTS staff_work_summary_range_facts;
DROP TABLE IF EXISTS staff_work_summary_range_jobs;
