import { supabase } from '../lib/supabase.js';
const INACTIVE_CALL_STATUSES = [
    'completed',
    'failed',
    'no_answer',
    'voicemail',
    'aborted',
    'abandoned',
    'ended',
];
async function cleanStaleActiveCall(session, reason) {
    if (!session?.active_call_id)
        return session;
    const { data: call, error } = await supabase
        .from('calls')
        .select('id, status, ended_at, wrapped_at')
        .eq('id', session.active_call_id)
        .maybeSingle();
    if (error) {
        console.warn('[SESSION_STALE_ACTIVE_CALL_CLEARED]', {
            agent_id: session.agent_id,
            active_call_id: session.active_call_id,
            reason,
            lookup_error: error.message,
        });
    }
    const inactive = !call ||
        INACTIVE_CALL_STATUSES.includes(String(call.status ?? '')) ||
        Boolean(call.ended_at) ||
        Boolean(call.wrapped_at);
    const staleState = ['REGISTERED', 'OFFLINE'].includes(session.state);
    if (!inactive || !staleState)
        return session;
    const { data: cleaned, error: updateError } = await supabase
        .from('agent_sessions')
        .update({
        active_call_id: null,
        updated_at: new Date().toISOString(),
    })
        .eq('agent_id', session.agent_id)
        .select('*')
        .single();
    if (updateError) {
        console.warn('[SESSION_STALE_ACTIVE_CALL_CLEARED]', {
            agent_id: session.agent_id,
            active_call_id: session.active_call_id,
            reason,
            update_error: updateError.message,
        });
        return session;
    }
    console.log('[SESSION_STALE_ACTIVE_CALL_CLEARED]', {
        agent_id: session.agent_id,
        active_call_id: session.active_call_id,
        state: session.state,
        call_status: call?.status ?? null,
        reason,
    });
    return cleaned ?? { ...session, active_call_id: null };
}
export async function sessionRoutes(app) {
    // GET /session/me — get current agent + session
    app.get('/me', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { agentId } = req.user;
        const { data: agent } = await supabase
            .from('agents')
            .select('id, name, email, role, telnyx_sip_username')
            .eq('id', agentId)
            .single();
        const { data: rawSession } = await supabase
            .from('agent_sessions')
            .select('*')
            .eq('agent_id', agentId)
            .single();
        const session = await cleanStaleActiveCall(rawSession, 'session_me');
        console.log('[SESSION_ME]', {
            agent_id: agentId,
            state: session?.state ?? null,
            active_call_id: session?.active_call_id ?? null,
        });
        return reply.send({ agent, session });
    });
    // POST /session/ready — agent enters READY state
    app.post('/ready', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { agentId } = req.user;
        const { data: rawSession } = await supabase
            .from('agent_sessions')
            .select('*')
            .eq('agent_id', agentId)
            .single();
        const session = await cleanStaleActiveCall(rawSession, 'session_ready');
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
            active_call_id: null,
            last_ready_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
            .eq('agent_id', agentId);
        console.log('[SESSION_READY_STATE_CLEAN]', {
            agent_id: agentId,
            previous_state: session.state,
            previous_active_call_id: session.active_call_id ?? null,
        });
        await supabase.from('audit_events').insert({
            entity_type: 'agent_session',
            entity_id: session.id,
            event_type: 'AGENT_READY',
            payload: { agent_id: agentId },
        });
        return reply.send({ state: 'READY' });
    });
    // POST /session/pause — agent pauses
    app.post('/pause', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { agentId } = req.user;
        const { data: session } = await supabase
            .from('agent_sessions')
            .select('*')
            .eq('agent_id', agentId)
            .single();
        if (!session)
            return reply.status(404).send({ error: 'No session' });
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
    app.post('/register', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { agentId } = req.user;
        const now = new Date().toISOString();
        const { data: rawSession } = await supabase
            .from('agent_sessions')
            .select('*')
            .eq('agent_id', agentId)
            .single();
        const session = await cleanStaleActiveCall(rawSession, 'session_register');
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
    app.get('/webrtc-token', { onRequest: [app.authenticate] }, async (req, reply) => {
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
