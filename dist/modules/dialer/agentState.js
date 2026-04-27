"use strict";
/**
 * Agent state-machine helpers for the progressive dialer.
 *
 * Valid FSM transitions (agent-first model)
 * ─────────────────────────────────────────
 * OFFLINE  → READY      (agent confirmed SIP leg + clicks "Go Ready")
 * READY    → RESERVED   (dialer picks agent for next lead)
 * READY    → PAUSED     (agent pauses)
 * RESERVED → INCALL     (lead answered; bridged to agent)
 * RESERVED → READY      (lead ring-no-answer; release agent)
 * INCALL   → WRAP       (lead or agent hangs up)
 * WRAP     → READY      (disposition submitted or wrap timer expires)
 * PAUSED   → READY      (agent resumes)
 * Any      → OFFLINE    (logout / agent leg drop)
 *
 * DB columns used (added in migration 006):
 *   channel_id              — agent's live ARI channel ID
 *   waiting_bridge_id       — the persistent bridge agent sits in between calls
 *   registration_verified   — true once agent leg has answered
 *   registration_verified_at
 *   agent_leg_answered_at
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTransition = isValidTransition;
exports.transitionAgentState = transitionAgentState;
exports.createAgentSession = createAgentSession;
exports.reserveNextAgent = reserveNextAgent;
exports.countReadyAgents = countReadyAgents;
exports.getAgentSession = getAgentSession;
exports.getAgentSessionByChannelId = getAgentSessionByChannelId;
exports.verifyAriEndpoint = verifyAriEndpoint;
exports.originateAgentLeg = originateAgentLeg;
exports.markAgentLegAnswered = markAgentLegAnswered;
exports.clearAgentLeg = clearAgentLeg;
exports.setAgentWaitingBridge = setAgentWaitingBridge;
const supabase_1 = require("../../core/supabase");
const ari_1 = require("../../core/ari");
const config_1 = require("../../core/config");
const websocket_1 = require("../../core/websocket");
const logger_1 = require("../../core/logger");
/** Columns fetched in all read queries */
const SESSION_COLS = 'session_id, org_id, agent_id, campaign_id, state, last_state_at, channel_id, waiting_bridge_id, registration_verified';
const ALLOWED_TRANSITIONS = {
    OFFLINE: ['READY'],
    READY: ['RESERVED', 'PAUSED', 'OFFLINE'],
    RESERVED: ['INCALL', 'READY', 'OFFLINE'],
    INCALL: ['WRAP', 'OFFLINE'],
    WRAP: ['READY', 'OFFLINE'],
    PAUSED: ['READY', 'OFFLINE'],
};
function isValidTransition(from, to) {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * Atomically transition an agent session to a new state.
 * Returns the updated session row or throws on invalid transition.
 */
async function transitionAgentState(sessionId, orgId, toState, opts = {}) {
    // Fetch current session (scoped to org)
    const { data: session, error: fetchErr } = await supabase_1.supabase
        .from('agent_sessions')
        .select(SESSION_COLS)
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .maybeSingle();
    if (fetchErr)
        throw new Error(`Failed to fetch agent session: ${fetchErr.message}`);
    if (!session)
        throw new Error(`Agent session ${sessionId} not found in org ${orgId}`);
    const fromState = session.state;
    if (fromState === toState) {
        return session;
    }
    if (!isValidTransition(fromState, toState)) {
        throw new Error(`Invalid agent state transition: ${fromState} → ${toState}`);
    }
    const now = new Date().toISOString();
    // Record history
    await supabase_1.supabase.from('agent_state_history').insert({
        history_id: crypto.randomUUID(),
        org_id: orgId,
        session_id: sessionId,
        agent_id: session.agent_id,
        from_state: fromState,
        to_state: toState,
        reason: opts.reason ?? null,
        occurred_at: now,
    });
    const endedAt = toState === 'OFFLINE' ? now : null;
    const patch = {
        state: toState,
        last_state_at: now,
        updated_by: opts.updatedBy ?? 'system',
    };
    if (endedAt)
        patch.ended_at = endedAt;
    const { data: updated, error: updateErr } = await supabase_1.supabase
        .from('agent_sessions')
        .update(patch)
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .select(SESSION_COLS)
        .single();
    if (updateErr)
        throw new Error(`Failed to update agent session: ${updateErr.message}`);
    const updatedSession = updated;
    // Broadcast state change
    (0, websocket_1.emitOrgEvent)({
        type: 'agent.state',
        org_id: orgId,
        campaign_id: updatedSession.campaign_id ?? undefined,
        payload: {
            session_id: sessionId,
            agent_id: updatedSession.agent_id,
            from_state: fromState,
            to_state: toState,
            reason: opts.reason,
            occurred_at: now,
        },
    });
    logger_1.logger.info({ org_id: orgId, agent_id: updatedSession.agent_id, from_state: fromState, to_state: toState }, 'Agent state transition');
    return updatedSession;
}
/**
 * Create a new agent session (agent login / go-ready).
 */
async function createAgentSession(orgId, agentId, campaignId, createdBy, metadata = {}) {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Hang up any live ARI channels from previous sessions before ending them in DB.
    // Without this, old channels linger in Asterisk and can fire spurious hangup events
    // against the new session (channel_id drift), or pile up as zombie bridges.
    const { data: openSessions } = await supabase_1.supabase
        .from('agent_sessions')
        .select('session_id, channel_id, waiting_bridge_id')
        .eq('org_id', orgId)
        .eq('agent_id', agentId)
        .is('ended_at', null);
    if (openSessions?.length) {
        await Promise.allSettled(openSessions.map(async (s) => {
            if (s.waiting_bridge_id) {
                await ari_1.ARI.bridges.destroy(s.waiting_bridge_id).catch(() => { });
            }
            if (s.channel_id) {
                await ari_1.ARI.channels.hangup(s.channel_id).catch(() => { });
            }
        }));
    }
    // Terminate any existing open session for this agent in this org
    await supabase_1.supabase
        .from('agent_sessions')
        .update({ state: 'OFFLINE', ended_at: now, updated_by: createdBy })
        .eq('org_id', orgId)
        .eq('agent_id', agentId)
        .is('ended_at', null);
    const { data: inserted, error } = await supabase_1.supabase
        .from('agent_sessions')
        .insert({
        session_id: sessionId,
        org_id: orgId,
        agent_id: agentId,
        campaign_id: campaignId,
        state: 'OFFLINE',
        started_at: now,
        last_state_at: now,
        metadata,
        created_by: createdBy,
        updated_by: createdBy,
    })
        .select(SESSION_COLS)
        .single();
    if (error)
        throw new Error(`Failed to create agent session: ${error.message}`);
    (0, websocket_1.emitOrgEvent)({
        type: 'agent.state',
        org_id: orgId,
        campaign_id: campaignId ?? undefined,
        payload: {
            session_id: sessionId,
            agent_id: agentId,
            from_state: null,
            to_state: 'OFFLINE',
            reason: 'login',
        },
    });
    return inserted;
}
/**
 * Find one READY agent for a campaign and atomically move them to RESERVED.
 * Returns the reserved session or null if none available.
 */
async function reserveNextAgent(orgId, campaignId) {
    // Require READY + verified registration + live SIP channel
    const { data: sessions } = await supabase_1.supabase
        .from('agent_sessions')
        .select(SESSION_COLS)
        .eq('org_id', orgId)
        .eq('campaign_id', campaignId)
        .eq('state', 'READY')
        .eq('registration_verified', true)
        .not('channel_id', 'is', null)
        .is('ended_at', null)
        .order('last_state_at', { ascending: true })
        .limit(1);
    if (!sessions || sessions.length === 0)
        return null;
    const session = sessions[0];
    try {
        return await transitionAgentState(session.session_id, orgId, 'RESERVED', {
            reason: 'dialer_reserved',
        });
    }
    catch {
        // Race condition: another worker grabbed the agent; return null
        return null;
    }
}
/**
 * Return a count of ready agents for a campaign.
 */
async function countReadyAgents(orgId, campaignId) {
    const { count } = await supabase_1.supabase
        .from('agent_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('campaign_id', campaignId)
        .eq('state', 'READY')
        .is('ended_at', null);
    return count ?? 0;
}
/**
 * Fetch the current open session for an agent.
 */
async function getAgentSession(orgId, agentId) {
    const { data } = await supabase_1.supabase
        .from('agent_sessions')
        .select(SESSION_COLS)
        .eq('org_id', orgId)
        .eq('agent_id', agentId)
        .is('ended_at', null)
        .maybeSingle();
    return data ?? null;
}
/**
 * Find an open session by its active ARI channel ID.
 * Used when an agent-leg hangup event fires and we need to identify the session.
 */
async function getAgentSessionByChannelId(channelId) {
    const { data } = await supabase_1.supabase
        .from('agent_sessions')
        .select(SESSION_COLS)
        .eq('channel_id', channelId)
        .is('ended_at', null)
        .maybeSingle();
    return data ?? null;
}
/**
 * Parse an endpoint string such as "PJSIP/4699" or "4699" into
 * { technology, resource } for the ARI endpoints API.
 */
function parseEndpoint(endpoint) {
    const trimmed = endpoint.trim();
    const slash = trimmed.indexOf('/');
    if (slash > 0) {
        return {
            technology: trimmed.slice(0, slash),
            resource: trimmed.slice(slash + 1),
        };
    }
    // Bare extension — use configured prefix
    const prefix = config_1.config.ariEndpointPrefix || 'PJSIP';
    const tech = prefix.split('/')[0] ?? 'PJSIP';
    return { technology: tech, resource: trimmed };
}
/**
 * Verify that an agent's SIP endpoint is currently registered in Asterisk.
 * Returns true if the endpoint state is "not_inuse", "inuse", or "online".
 */
async function verifyAriEndpoint(endpoint) {
    try {
        const { technology, resource } = parseEndpoint(endpoint);
        const ep = await ari_1.ARI.endpoints.get(technology, resource);
        const state = ep?.state ?? null;
        const registered = state !== null && state !== 'unavailable' && state !== 'unknown';
        return { registered, state };
    }
    catch (err) {
        // ARI 404 = endpoint not found (not registered)
        if (err instanceof ari_1.AriRequestError && err.status === 404) {
            return { registered: false, state: null };
        }
        logger_1.logger.warn({ err, endpoint }, 'verifyAriEndpoint: unexpected ARI error');
        return { registered: false, state: null };
    }
}
/**
 * Originate the agent's persistent SIP leg into the ARI Stasis app.
 * The agent's phone will ring; when they answer, StasisStart fires with
 * appArgs = "agent-leg,{sessionId},{orgId}".
 *
 * Returns the ARI channel ID that was created.
 */
async function originateAgentLeg(orgId, sessionId, agentId, endpoint) {
    const channelId = `agent-${sessionId}`;
    await ari_1.ARI.channels.originate({
        debugContext: 'dialer.agent_leg',
        endpoint,
        channelId,
        appArgs: `agent-leg,${sessionId},${orgId}`,
        callerId: agentId,
        timeout: 60,
        variables: {
            DIALER_SESSION_ID: sessionId,
            DIALER_ORG_ID: orgId,
            DIALER_CHANNEL_ROLE: 'agent',
        },
    });
    logger_1.logger.info({ org_id: orgId, session_id: sessionId, channel_id: channelId, endpoint }, 'Agent leg originated');
    return channelId;
}
/**
 * Confirm that the agent's SIP leg has answered (called from ariEvents on StasisStart).
 * Sets channel_id, registration_verified = true, and agent_leg_answered_at.
 * Does NOT transition state — that happens when agent clicks "Go Ready".
 */
async function markAgentLegAnswered(sessionId, orgId, channelId) {
    const now = new Date().toISOString();
    await supabase_1.supabase
        .from('agent_sessions')
        .update({
        channel_id: channelId,
        registration_verified: true,
        registration_verified_at: now,
        agent_leg_answered_at: now,
        updated_at: now,
    })
        .eq('session_id', sessionId)
        .eq('org_id', orgId);
}
/**
 * Clear agent leg tracking after the agent's SIP channel drops.
 * Resets channel_id, waiting_bridge_id, and registration_verified.
 */
async function clearAgentLeg(sessionId, orgId) {
    await supabase_1.supabase
        .from('agent_sessions')
        .update({
        channel_id: null,
        waiting_bridge_id: null,
        registration_verified: false,
        updated_at: new Date().toISOString(),
    })
        .eq('session_id', sessionId)
        .eq('org_id', orgId);
}
/**
 * Store the waiting bridge ID on the session after creating it.
 */
async function setAgentWaitingBridge(sessionId, orgId, waitingBridgeId) {
    await supabase_1.supabase
        .from('agent_sessions')
        .update({
        waiting_bridge_id: waitingBridgeId,
        updated_at: new Date().toISOString(),
    })
        .eq('session_id', sessionId)
        .eq('org_id', orgId);
}
