-- Smoke test hard safety gate: atomic lead fetching with phone whitelist filter + SKIP LOCKED
-- Prevents any non-approved lead from ever being fetched when AEON_SMOKE_TEST_MODE=true
CREATE OR REPLACE FUNCTION fetch_smoke_test_leads_skip_locked(
  p_campaign_id UUID,
  p_max_attempts INT,
  p_batch_size INT,
  p_phone_whitelist TEXT[] DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  phone TEXT,
  first_name TEXT,
  last_name TEXT,
  timezone TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH leads_to_dial AS (
    SELECT l.id, l.phone, l.first_name, l.last_name, l.timezone
    FROM leads l
    WHERE l.campaign_id = p_campaign_id
      AND l.status = 'pending'
      AND l.attempts < p_max_attempts
      AND l.dnc_at IS NULL
      AND (l.callback_at IS NULL OR l.callback_at <= now())
      AND l.assigned_agent_id IS NULL
      AND (p_phone_whitelist IS NULL OR l.phone = ANY(p_phone_whitelist))
    ORDER BY l.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  SELECT l.id, l.phone, l.first_name, l.last_name, l.timezone
  FROM leads_to_dial l;
END;
$$ LANGUAGE plpgsql;