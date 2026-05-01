import { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';

export async function sessionRoutes(app: FastifyInstance) {

  // GET /session/me — get current agent + session
  app.get('/me', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, email, role, telnyx_sip_username')
      .eq('id', agentId)
      .single();

    const { data: session } = await supabase
      .from('agent_sessions')
      .select('*')
      .eq('agent_id', agentId)
      .single();

    return reply.send({ agent, session });
  });

  // POST /session/ready — agent enters READY state
  app.post('/ready', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: session } = await supabase
      .from('agent_sessions')
      .select('*')
      .eq('agent_id', agentId)
      .single();

    if (!session) {
      return reply.status(404).send({ error: 'No session found' });
    }

    // Only allow REGISTERED or WRAP_UP or PAUSED → READY
    const allowed = ['REGISTERED', 'WRAP_UP', 'PAUSED'];
    if (!allowed.includes(session.state)) {
      return reply.status(409).send({
        error: `Cannot enter READY from state ${session.state}`,
      });
    }

    await supabase
      .from('agent_sessions')
      .update({
        state: 'READY',
        last_ready_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('agent_id', agentId);

    await supabase.from('audit_events').insert({
      entity_type: 'agent_session',
      entity_id: session.id,
      event_type: 'AGENT_READY',
      payload: { agent_id: agentId },
    });

    return reply.send({ state: 'READY' });
  });

  // POST /session/pause — agent pauses
  app.post('/pause', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: session } = await supabase
      .from('agent_sessions')
      .select('*')
      .eq('agent_id', agentId)
      .single();

    if (!session) return reply.status(404).send({ error: 'No session' });

    // Only pause from READY or WRAP_UP
    if (!['READY', 'WRAP_UP'].includes(session.state)) {
      return reply.status(409).send({
        error: `Cannot pause from state ${session.state}`,
      });
    }

    await supabase
      .from('agent_sessions')
      .update({
        state: 'PAUSED',
        updated_at: new Date().toISOString(),
      })
      .eq('agent_id', agentId);

    return reply.send({ state: 'PAUSED' });
  });

  // POST /session/register — mark WebRTC as registered without downgrading active dialer state
  app.post('/register', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const now = new Date().toISOString();

    const { data: session } = await supabase
      .from('agent_sessions')
      .select('state')
      .eq('agent_id', agentId)
      .single();

    const currentState = session?.state ?? 'REGISTERED';

    // Registering WebRTC should not kick an agent out of the predictive loop.
    // It should only move OFFLINE/ERROR/empty sessions into REGISTERED.
    const nextState = ['READY', 'RESERVED', 'IN_CALL', 'WRAP_UP', 'PAUSED'].includes(currentState)
      ? currentState
      : 'REGISTERED';

    await supabase
      .from('agent_sessions')
      .update({
        state: nextState,
        telnyx_client_state: 'registered',
        updated_at: now,
      })
      .eq('agent_id', agentId);

    return reply.send({ state: nextState });
  });

  // GET /session/webrtc-token — generate Telnyx WebRTC token for agent
  app.get('/webrtc-token', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: agent } = await supabase
      .from('agents')
      .select('telnyx_sip_username, telnyx_sip_password')
      .eq('id', agentId)
      .single();

    if (!agent?.telnyx_sip_username || !agent?.telnyx_sip_password) {
      return reply.status(404).send({ error: 'No Telnyx SIP credentials found for this agent' });
    }

    return reply.send({
      sip_username: agent.telnyx_sip_username,
      sip_password: agent.telnyx_sip_password,
    });
  });
}
