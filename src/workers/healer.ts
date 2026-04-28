import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

const STALE_CALL_SECONDS = Number(process.env.HEALER_STALE_CALL_SECONDS ?? '30');
const STALE_AGENT_SECONDS = Number(process.env.HEALER_STALE_AGENT_SECONDS ?? '30');
const TICK_MS = 30_000;          // run every 30 seconds

async function heal() {
  const now = new Date();
  const staleCallCutoff = new Date(now.getTime() - STALE_CALL_SECONDS * 1000).toISOString();
  const staleAgentCutoff = new Date(now.getTime() - STALE_AGENT_SECONDS * 1000).toISOString();

  // ── 1. Kill stale active calls ────────────────────────────
  const { data: staleCalls } = await supabase
    .from('calls')
    .select('id, agent_id, lead_id, status')
    .in('status', ['created','agent_dialing','agent_answered','lead_dialing','lead_answered','agent_reserved','dialing','bridged'])
    .lt('created_at', staleCallCutoff);

  if (staleCalls && staleCalls.length > 0) {
    console.log(`[HEALER] Found ${staleCalls.length} stale call(s) — cleaning up`);

    for (const call of staleCalls) {
      await supabase.from('calls')
        .update({ status: 'failed', ended_at: now.toISOString(), wrapped_at: now.toISOString() })
        .eq('id', call.id);

      if (call.lead_id) {
        await supabase.from('leads')
          .update({ status: 'pending', assigned_agent_id: null, last_called_at: now.toISOString() })
          .eq('id', call.lead_id)
          .in('status', ['reserved','answered']);
      }

      if (call.agent_id) {
        await supabase.from('agent_sessions')
          .update({ state: 'READY', active_call_id: null, updated_at: now.toISOString() })
          .eq('agent_id', call.agent_id)
          .in('state', ['RESERVED','IN_CALL','WRAP_UP']);
      }

      console.log(`[HEALER] Cleaned stale call ${call.id} | agent:${call.agent_id} | lead:${call.lead_id}`);
    }
  }

  // ── 2. Release agents stuck in RESERVED ──────────────────
  const { data: stuckAgents } = await supabase
    .from('agent_sessions')
    .select('id, agent_id')
    .eq('state', 'RESERVED')
    .lt('updated_at', staleAgentCutoff);

  if (stuckAgents && stuckAgents.length > 0) {
    console.log(`[HEALER] Found ${stuckAgents.length} stuck RESERVED agent(s) — releasing`);
    for (const a of stuckAgents) {
      await supabase.from('agent_sessions')
        .update({ state: 'READY', active_call_id: null, updated_at: now.toISOString() })
        .eq('agent_id', a.agent_id);
      console.log(`[HEALER] Released stuck agent ${a.agent_id}`);
    }
  }

  // ── 3. Clear stale active_call_id on READY/REGISTERED sessions ───
  const { data: staleSessions } = await supabase
    .from('agent_sessions')
    .select('agent_id, active_call_id')
    .not('active_call_id', 'is', null)
    .in('state', ['READY', 'REGISTERED']);

  for (const session of staleSessions ?? []) {
    const { data: call } = await supabase
      .from('calls')
      .select('status')
      .eq('id', session.active_call_id)
      .single();

    if (call && ['completed', 'failed', 'voicemail', 'no_answer', 'aborted', 'abandoned'].includes(call.status)) {
      await supabase
        .from('agent_sessions')
        .update({ active_call_id: null, updated_at: now.toISOString() })
        .eq('agent_id', session.agent_id);
      console.log(`[HEALER] Cleared stale active_call_id for agent ${session.agent_id}`);
    }
  }
}

async function run() {
  console.log('[HEALER] Self-healing worker started');
  await heal();
  setInterval(async () => {
    try { await heal(); } catch (e) { console.error('[HEALER] Error:', e); }
  }, TICK_MS);
}

run().catch(e => { console.error('[HEALER] Fatal:', e); process.exit(1); });
