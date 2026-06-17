-- Resume cursor for paginated syncs (notably /clients, which has no working
-- incremental/limit/location filter and times out past ~page 7500). When set,
-- the next sync run resumes from this page; cleared (NULL) when a full pass
-- completes so the following run starts a fresh pass.
ALTER TABLE sync_state ADD COLUMN resume_page INTEGER;
