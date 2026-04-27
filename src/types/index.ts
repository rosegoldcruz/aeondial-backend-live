// ============================================================
// IRON VAULT DIALER — SHARED TYPES
// ============================================================

export type AgentState =
  | 'OFFLINE'
  | 'REGISTERING'
  | 'REGISTERED'
  | 'READY'
  | 'RESERVED'
  | 'IN_CALL'
  | 'WRAP_UP'
  | 'PAUSED'
  | 'ERROR';

export type LeadStatus =
  | 'pending'
  | 'reserved'
  | 'dialing'
  | 'answered'
  | 'no_answer'
  | 'voicemail'
  | 'callback'
  | 'dnc'
  | 'disposed'
  | 'failed';

export type CallStatus =
  | 'created'
  | 'dialing'
  | 'agent_reserved'
  | 'agent_dialing'
  | 'agent_answered'
  | 'lead_dialing'
  | 'lead_answered'
  | 'bridged'
  | 'completed'
  | 'failed'
  | 'voicemail'
  | 'no_answer'
  | 'aborted'
  | 'abandoned';

export type Disposition =
  | 'Interested'
  | 'Not Interested'
  | 'Callback'
  | 'Do Not Call'
  | 'No Answer'
  | 'Voicemail'
  | 'Wrong Number'
  | 'Other';

export interface Agent {
  id: string;
  name: string;
  email: string;
  role: string;
  telnyx_sip_username: string | null;
  telnyx_sip_password: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AgentSession {
  id: string;
  agent_id: string;
  state: AgentState;
  telnyx_client_state: string | null;
  active_call_id: string | null;
  last_ready_at: string | null;
  updated_at: string;
}

export interface Lead {
  id: string;
  campaign_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string;
  quality: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
  status: LeadStatus;
  attempts: number;
  last_called_at: string | null;
  callback_at: string | null;
  assigned_agent_id: string | null;
}

export interface Call {
  id: string;
  agent_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  group_id: string | null;
  call_control_id: string | null;
  agent_leg_id: string | null;
  lead_leg_id: string | null;
  status: CallStatus;
  disposition: Disposition | null;
  notes: string | null;
  duration_seconds: number | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  wrapped_at: string | null;
}

export interface JWTPayload {
  agentId: string;
  email: string;
  role: string;
}
