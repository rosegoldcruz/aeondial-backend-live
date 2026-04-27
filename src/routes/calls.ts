import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { hangupCall } from '../lib/telnyx.js';
import Telnyx from 'telnyx';

const telnyx = new (Telnyx as any)({ apiKey: process.env.TELNYX_API_KEY });

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

const wrapUpSchema = z.object({
  disposition: z.enum([
    'Interested',
    'Not Interested',
    'Callback',
    'Do Not Call',
    'No Answer',
    'Voicemail',
    'Wrong Number',
    'Other',
  ]),
  notes: z.string().optional(),
  callback_at: z.string().datetime().optional(),
});

export async function callRoutes(app: FastifyInstance) {

  // GET /calls/current — get agent's active call with lead info
  app.get('/current', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: call } = await supabase
      .from('calls')
      .select(`
        *,
        leads (
          id, first_name, last_name, phone, email,
          city, state, quality
        )
      `)
      .eq('agent_id', agentId)
      .in('status', [
        'created',
        'agent_dialing',
        'agent_answered',
        'lead_dialing',
        'lead_answered',
        'dialing',
        'agent_reserved',
        'bridged',
      ])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return reply.send({ call: call ?? null });
  });

  // POST /calls/:id/wrapup — submit disposition and notes
  app.post('/:id/wrapup', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const { id: callId } = req.params as { id: string };

    const body = wrapUpSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid wrap-up data', details: body.error.flatten() });
    }

    const { disposition, notes, callback_at } = body.data;

    // Verify this call belongs to this agent
    const { data: call } = await supabase
      .from('calls')
      .select('id, lead_id, agent_id, status')
      .eq('id', callId)
      .eq('agent_id', agentId)
      .single();

    if (!call) {
      return reply.status(404).send({ error: 'Call not found' });
    }

    // Update call
    await supabase
      .from('calls')
      .update({
        disposition,
        notes: notes ?? null,
        status: 'completed',
        wrapped_at: new Date().toISOString(),
      })
      .eq('id', callId);

    // Update lead status
    let leadStatus = 'disposed';
    if (disposition === 'Do Not Call') leadStatus = 'dnc';
    else if (disposition === 'Callback') leadStatus = 'callback';
    else if (disposition === 'No Answer') leadStatus = 'no_answer';
    else if (disposition === 'Voicemail') leadStatus = 'voicemail';

    const leadUpdate: any = {
      status: leadStatus,
      assigned_agent_id: null,
    };

    if (disposition === 'Callback' && callback_at) {
      leadUpdate.callback_at = callback_at;
    }

    await supabase
      .from('leads')
      .update(leadUpdate)
      .eq('id', call.lead_id);

    // If DNC, make sure it never gets dialed again
    if (disposition === 'Do Not Call') {
      await supabase
        .from('leads')
        .update({ status: 'dnc', callback_at: null })
        .eq('id', call.lead_id);
    }

    // Schedule callback if needed
    if (disposition === 'Callback' && callback_at) {
      await supabase.from('callbacks').insert({
        call_id: callId,
        lead_id: call.lead_id,
        agent_id: agentId,
        scheduled_at: callback_at,
        notes: notes ?? null,
        status: 'pending',
      });
    }

    // Return agent to READY or keep PAUSED based on session
    const { data: session } = await supabase
      .from('agent_sessions')
      .select('state')
      .eq('agent_id', agentId)
      .single();

    // If agent is in WRAP_UP, set back to READY
    if (session?.state === 'WRAP_UP') {
      await supabase
        .from('agent_sessions')
        .update({
          state: 'READY',
          active_call_id: null,
          last_ready_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);
    }

    await supabase.from('audit_events').insert({
      entity_type: 'call',
      entity_id: callId,
      event_type: 'CALL_WRAPPED_UP',
      payload: { disposition, notes, callback_at, agent_id: agentId },
    });

    return reply.send({ success: true, state: 'READY' });
  });

  // POST /calls/:id/hangup — end call via Telnyx (from END CALL button)
  app.post('/:id/hangup', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const { id: callId } = req.params as { id: string };

    const { data: call } = await supabase
      .from('calls')
      .select('id, agent_leg_id, lead_leg_id, status, agent_id')
      .eq('id', callId)
      .eq('agent_id', agentId)
      .single();

    if (!call) {
      return reply.status(404).send({ error: 'Call not found' });
    }

    // Hang up both legs if they exist; ignore errors (already dead calls 404)
    const hangups: Promise<any>[] = [];
    if (call.lead_leg_id) hangups.push(hangupCall(call.lead_leg_id).catch(() => null));
    if (call.agent_leg_id) hangups.push(hangupCall(call.agent_leg_id).catch(() => null));
    await Promise.all(hangups);

    return reply.send({ success: true });
  });

  // POST /calls/manual-dial — agent initiates outbound call to a specific number
  app.post('/manual-dial', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const { phone: rawPhone, lead_id: existingLeadId } = req.body as { phone?: string; lead_id?: string };

    if (!rawPhone && !existingLeadId) {
      return reply.status(400).send({ error: 'phone or lead_id required' });
    }

    // Get agent SIP username
    const { data: agent } = await supabase
      .from('agents')
      .select('telnyx_sip_username')
      .eq('id', agentId)
      .single();

    if (!agent?.telnyx_sip_username) {
      return reply.status(400).send({ error: 'Agent has no SIP credentials' });
    }

    // Resolve lead
    let leadId = existingLeadId;
    let leadPhone = rawPhone ? normalizePhone(rawPhone) : '';

    if (!leadId && leadPhone) {
      // Find existing lead or create a manual one
      const { data: existing } = await supabase
        .from('leads')
        .select('id, phone')
        .eq('phone', leadPhone)
        .limit(1)
        .single();

      if (existing) {
        leadId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('leads')
          .insert({ phone: leadPhone, status: 'reserved', assigned_agent_id: agentId, first_name: 'Manual', last_name: 'Dial' })
          .select('id')
          .single();
        leadId = created?.id;
      }
    }

    if (!leadId) return reply.status(500).send({ error: 'Could not resolve lead' });

    // Get lead phone if coming from lead_id
    if (!leadPhone) {
      const { data: lead } = await supabase.from('leads').select('phone').eq('id', leadId).single();
      leadPhone = lead?.phone ?? '';
    }

    // Create call record
    const { data: callRecord } = await supabase
      .from('calls')
      .insert({
        agent_id: agentId,
        lead_id: leadId,
        status: 'created',
        started_at: new Date().toISOString(),
        notes: 'manual-dial',
      })
      .select('id')
      .single();

    if (!callRecord) return reply.status(500).send({ error: 'Failed to create call record' });

    const callId = callRecord.id;
    const sipDomain = process.env.AGENT_LEG_SIP_DOMAIN || 'aeondial.sip.telnyx.com';
    const sipUsername = agent.telnyx_sip_username.trim().replace(/^sip:/, '').split('@')[0];
    const agentSipUri = `sip:${sipUsername}@${sipDomain}`;

    try {
      const agentCallResponse = await telnyx.calls.dial({
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: agentSipUri,
        from: process.env.TELNYX_OUTBOUND_NUMBER,
        webhook_url: process.env.TELNYX_WEBHOOK_URL,
        client_state: Buffer.from(JSON.stringify({
          leg_type: 'agent',
          call_id: callId,
          agent_id: agentId,
          lead_id: leadId,
        })).toString('base64'),
      });

      await supabase.from('calls').update({
        agent_leg_id: agentCallResponse.data.call_control_id,
        status: 'agent_dialing',
      }).eq('id', callId);

      await supabase.from('agent_sessions').update({
        state: 'RESERVED',
        updated_at: new Date().toISOString(),
      }).eq('agent_id', agentId);

      app.log.info(`[MANUAL DIAL] Agent ${agentId} → ${leadPhone} | call: ${callId}`);
      return reply.send({ success: true, call_id: callId, phone: leadPhone });
    } catch (err: any) {
      await supabase.from('calls').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', callId);
      return reply.status(500).send({ error: 'Dial failed: ' + err.message });
    }
  });

  // GET /calls/history — recent calls for agent
  app.get('/history', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: calls } = await supabase
      .from('calls')
      .select(`
        id, status, disposition, notes, started_at, ended_at, duration_seconds,
        leads (first_name, last_name, phone, city, state)
      `)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(50);

    return reply.send({ calls: calls ?? [] });
  });
}
