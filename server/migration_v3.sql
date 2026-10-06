-- Migration to remove overly restrictive unique index on seq
DROP INDEX IF EXISTS idx_profiles_seq;
-- Optional: Re-create it as a non-unique index if searching by seq is common
CREATE INDEX IF NOT EXISTS idx_profiles_seq_nonunique ON profiles(seq);
