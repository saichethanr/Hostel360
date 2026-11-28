-- Apply as the schema owner after the holidays migration.
-- Admission fees are now set per challan head (fee_<type>_<category>_<head>).
-- Saved fees move to the head that holds them by default.
BEGIN;
SET LOCAL search_path TO hostel360;
UPDATE settings SET key = CASE key
  WHEN 'fee_fresher_management' THEN 'fee_fresher_management_development'
  WHEN 'fee_fresher_fund' THEN 'fee_fresher_fund_others'
  WHEN 'fee_fresher_caution' THEN 'fee_fresher_fund_caution'
  WHEN 'fee_fresher_establishment' THEN 'fee_fresher_establishment_establishment'
  WHEN 'fee_existing_management' THEN 'fee_existing_management_development'
  WHEN 'fee_existing_fund' THEN 'fee_existing_fund_others'
  WHEN 'fee_existing_establishment' THEN 'fee_existing_establishment_establishment'
END
WHERE key IN ('fee_fresher_management','fee_fresher_fund','fee_fresher_caution',
  'fee_fresher_establishment','fee_existing_management','fee_existing_fund',
  'fee_existing_establishment');
INSERT INTO schema_migrations(version) VALUES ('20261129010000');
COMMIT;
