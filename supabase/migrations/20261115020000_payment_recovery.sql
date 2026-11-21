-- Run as schema owner, after the gateway migration. Runtime remains NOBYPASSRLS.
BEGIN;
SET LOCAL search_path TO hostel360;
ALTER TABLE allocations ADD COLUMN refunded_amount INTEGER NOT NULL DEFAULT 0
  CHECK(refunded_amount >= 0 AND refunded_amount <= amount);
ALTER TABLE gateway_orders DROP CONSTRAINT gateway_orders_status_check;
ALTER TABLE gateway_orders ADD CONSTRAINT gateway_orders_status_check
  CHECK(status IN ('creating','open','authorized','paid','partially_refunded','review','refunded','creation_failed','superseded'));
ALTER TABLE gateway_orders ADD COLUMN refunded_amount INTEGER NOT NULL DEFAULT 0 CHECK(refunded_amount >= 0 AND refunded_amount <= amount);
ALTER TABLE gateway_orders ADD COLUMN refund_baseline INTEGER NOT NULL DEFAULT 0 CHECK(refund_baseline >= 0 AND refund_baseline <= refunded_amount);
ALTER TABLE gateway_orders ADD COLUMN checked_at TEXT;
ALTER TABLE gateway_orders ADD COLUMN next_check_at TEXT NOT NULL DEFAULT '';
ALTER TABLE gateway_orders ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE gateway_orders ADD UNIQUE(community_id,id);
CREATE INDEX gateway_recovery ON gateway_orders(community_id,next_check_at);
CREATE TABLE gateway_refunds (
  community_id INTEGER NOT NULL DEFAULT nullif(current_setting('app.community_id',true),'')::integer REFERENCES communities(id),
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(key_id,id),
  FOREIGN KEY(community_id,order_id) REFERENCES gateway_orders(community_id,id)
);
ALTER TABLE gateway_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY community_isolation ON gateway_refunds
  USING (community_id=nullif(current_setting('app.community_id',true),'')::integer)
  WITH CHECK (community_id=nullif(current_setting('app.community_id',true),'')::integer);
REVOKE ALL ON gateway_refunds FROM PUBLIC;
INSERT INTO schema_migrations(version) VALUES ('20261115020000');
COMMIT;
