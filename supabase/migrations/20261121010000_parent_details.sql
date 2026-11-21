-- Run as schema owner. Additive: parent phone for applications; college IDs
-- become optional, so roll uniqueness applies only when one is recorded.
BEGIN;
SET LOCAL search_path TO hostel360;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS guardian_phone TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS application_roll;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='hostel360' AND table_name='applications' AND column_name='community_id') THEN
    CREATE UNIQUE INDEX application_roll ON applications(community_id, roll) WHERE roll <> '';
  ELSE
    CREATE UNIQUE INDEX application_roll ON applications(roll) WHERE roll <> '';
  END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES ('20261121010000') ON CONFLICT DO NOTHING;
COMMIT;
