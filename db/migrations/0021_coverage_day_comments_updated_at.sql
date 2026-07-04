-- Track edits to coverage day comments. Nullable: NULL = never edited (only
-- created_at applies). Set to an ISO timestamp when an author edits their own
-- comment via PATCH /coverage/day-comments. Surfaced to the UI as an "edited"
-- marker next to the timestamp.
ALTER TABLE coverage_day_comments ADD COLUMN updated_at TEXT;
