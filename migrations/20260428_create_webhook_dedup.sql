-- Webhook deduplication table to prevent double-execution on Telnyx retries
CREATE TABLE IF NOT EXISTS webhook_dedup (
  id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ DEFAULT now()
);

-- Cleanup job: delete entries older than 24 hours (managed by application)
-- SELECT * FROM webhook_dedup WHERE received_at < now() - INTERVAL '24 hours';
