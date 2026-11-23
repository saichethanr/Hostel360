-- Run once as the schema owner. Student IDs become JSSPDA-<joining year>-<number>.
-- Students without a college ID keep their student ID as the roll, so rename it too.
-- Row-level security is forced, so update each community in turn.
BEGIN;
SET LOCAL search_path TO hostel360;
DO $$
DECLARE c integer;
BEGIN
  FOR c IN SELECT id FROM communities LOOP
    PERFORM set_config('app.community_id', c::text, true);
    UPDATE students SET
      roll = CASE WHEN roll = code THEN 'JSSPDA-' || left(joined, 4) || '-' || lpad(id::text, 4, '0') ELSE roll END,
      code = 'JSSPDA-' || left(joined, 4) || '-' || lpad(id::text, 4, '0')
    WHERE code NOT LIKE 'JSSPDA-%';
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('20261123020000');
COMMIT;
