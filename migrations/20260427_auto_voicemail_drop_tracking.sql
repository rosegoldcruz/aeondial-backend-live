-- Run in Supabase SQL editor

-- Track automated voicemail drops on calls
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS voicemail_dropped  BOOLEAN   DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voicemail_at       TIMESTAMPTZ;

-- Track per-lead voicemail history
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS voicemail_drop_count  INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_voicemail_at     TIMESTAMPTZ;

-- Index so we can query "leads who got a VM in last 7 days" efficiently
CREATE INDEX IF NOT EXISTS idx_leads_last_voicemail ON leads (last_voicemail_at);
CREATE INDEX IF NOT EXISTS idx_calls_voicemail      ON calls (voicemail_dropped, campaign_id);

-- Helper RPC used by the webhook to safely increment the counter
CREATE OR REPLACE FUNCTION increment(row_id UUID, col TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  result INTEGER;
BEGIN
  EXECUTE format('UPDATE leads SET %I = COALESCE(%I, 0) + 1 WHERE id = $1 RETURNING %I', col, col, col)
  USING row_id INTO result;
  RETURN result;
END;
$$;

-- Harden helper RPC for server-side use only
CREATE OR REPLACE FUNCTION public.increment(row_id UUID, col TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  result INTEGER;
BEGIN
  EXECUTE format('UPDATE public.leads SET %I = COALESCE(%I, 0) + 1 WHERE id = $1 RETURNING %I', col, col, col)
  USING row_id INTO result;
  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment(UUID, TEXT) TO service_role;
