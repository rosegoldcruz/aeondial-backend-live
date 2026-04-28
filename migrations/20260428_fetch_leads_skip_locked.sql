-- Atomic lead fetching with SKIP LOCKED to prevent double-dial
CREATE OR REPLACE FUNCTION fetch_leads_skip_locked(
  p_campaign_id UUID,
  p_max_attempts INT,
  p_batch_size INT
) RETURNS TABLE (
  lead_id UUID,
  phone TEXT,
  first_name TEXT,
  last_name TEXT,
  timezone TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH leads_to_dial AS (
    SELECT id, phone, first_name, last_name, timezone
    FROM leads
    WHERE campaign_id = p_campaign_id
      AND status = 'pending'
      AND attempts < p_max_attempts
      AND dnc_at IS NULL
      AND (callback_at IS NULL OR callback_at <= now())
      AND assigned_agent_id IS NULL
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  SELECT l.id, l.phone, l.first_name, l.last_name, l.timezone
  FROM leads_to_dial l;
END;
$$ LANGUAGE plpgsql;
