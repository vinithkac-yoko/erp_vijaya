-- Milestone 16: the two settings for the monthly limit on reading PDFs and photos. A database that was set up before this milestone
-- gets them here (a new one gets them from the seed); the owner can change both in Settings.
INSERT INTO "settings" ("id", "key", "value", "valueType", "description", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'uploads.monthly_cap_inr', '1000', 'number', 'Monthly limit for reading PDFs and photos', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'uploads.usd_to_inr', '90', 'number', 'Rupees per US dollar (for the cost of reading files)', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
