CREATE TABLE IF NOT EXISTS inbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_number TEXT,
  recording_url TEXT,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  handled BOOLEAN DEFAULT false,
  handled_by UUID REFERENCES agents(id),
  handled_at TIMESTAMPTZ
);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
