-- Apply as the schema owner after the communities migration, before enabling
-- Razorpay credentials. No secrets or card details are stored here.
BEGIN;
SET LOCAL search_path TO hostel360;
ALTER TABLE payments DROP CONSTRAINT payments_mode_check;
ALTER TABLE payments ADD CONSTRAINT payments_mode_check CHECK (mode IN ('Cash','UPI','Bank','Card'));
CREATE TABLE gateway_orders (
  id TEXT PRIMARY KEY,
  community_id INTEGER NOT NULL DEFAULT nullif(current_setting('app.community_id',true),'')::integer REFERENCES communities(id),
  user_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  key_id TEXT NOT NULL,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  amount INTEGER NOT NULL CHECK(amount>0),
  category TEXT NOT NULL,
  allocations TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('creating','open','paid','review','refunded','creation_failed')),
  payment_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(community_id,user_id) REFERENCES users(community_id,id),
  FOREIGN KEY(community_id,student_id) REFERENCES students(community_id,id),
  FOREIGN KEY(community_id,payment_id) REFERENCES payments(community_id,id),
  UNIQUE(community_id,user_id,request_key),
  UNIQUE(key_id,provider_order_id),
  UNIQUE(key_id,provider_payment_id)
);
CREATE INDEX gateway_student ON gateway_orders(community_id,student_id,created_at);
ALTER TABLE gateway_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY community_isolation ON gateway_orders
  USING (community_id=nullif(current_setting('app.community_id',true),'')::integer)
  WITH CHECK (community_id=nullif(current_setting('app.community_id',true),'')::integer);
REVOKE ALL ON gateway_orders FROM PUBLIC;
INSERT INTO schema_migrations(version) VALUES ('20261115010000');
COMMIT;
