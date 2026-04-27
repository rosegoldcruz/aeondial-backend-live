"use strict";
/**
 * Progressive Auto-Dialer – HTTP routes
 * ──────────────────────────────────────
 * All routes are mounted at /dialer (registered in src/index.ts).
 *
 * Agent state management
 * ─────────────────────
 *   POST /dialer/agents/session            – login / go-ready
 *   GET  /dialer/agents/:agent_id/session  – get current session
 *   POST /dialer/agents/:session_id/state  – transition state (ready/pause/wrap/offline)
 *
 * Campaign dialer controls
 * ─────────────────────────
 *   POST /dialer/campaigns/:campaign_id/start   – start the campaign dialer
 *   POST /dialer/campaigns/:campaign_id/stop    – stop the campaign dialer
 *   GET  /dialer/campaigns/:campaign_id/status  – queue depth + agent counts
 *   POST /dialer/campaigns/:campaign_id/leads   – bulk-add leads to campaign queue
 *
 * Call handling (dialer-driven)
 * ─────────────────────────────
 *   POST /dialer/calls/:call_id/amd_result  – Asterisk dialplan webhook
 *   POST /dialer/calls/:call_id/disposition – agent submits disposition
 *   GET  /dialer/calls/live                 – list active dialer calls for org
 *
 * Supervisor
 * ──────────
 *   GET  /dialer/supervisor/queue           – full queue snapshot
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.dialerModule = void 0;
const supabase_1 = require("../../core/supabase");
const logger_1 = require("../../core/logger");
const config_1 = require("../../core/config");
const ari_1 = require("../../core/ari");
const agentState_1 = require("./agentState");
const amd_1 = require("./amd");
const orchestrator_1 = require("./orchestrator");
const engine_1 = require("./engine");
// ─── Guards ──────────────────────────────────────────────────────────────────
function requireOrg(req, reply) {
    if (!req.org_id) {
        reply.status(401).send({ error: 'Missing org scope' });
        return null;
    }
    return req.org_id;
}
function normalizeAgentEndpoint(endpoint) {
    const trimmed = endpoint.trim();
    if (!trimmed)
        return trimmed;
    if (trimmed.includes('/'))
        return trimmed;
    return `${config_1.config.ariEndpointPrefix}/${trimmed}`;
}
function parseUrlEncodedBody(payload) {
    return Object.fromEntries(new URLSearchParams(payload).entries());
}
function firstString(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            const nested = firstString(...value);
            if (nested)
                return nested;
            continue;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed)
                return trimmed;
        }
    }
    return undefined;
}
function firstNumber(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            const nested = firstNumber(...value);
            if (nested !== undefined)
                return nested;
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
async function findUserInOtherOrg(userId, orgId) {
    const { data, error } = await supabase_1.supabase
        .from('users')
        .select('user_id, org_id, email, full_name, role, status, metadata')
        .eq('user_id', userId)
        .neq('org_id', orgId)
        .limit(1)
        .maybeSingle();
    if (error) {
        logger_1.logger.warn({ error, user_id: userId, org_id: orgId }, 'Failed to check for cross-org user mapping');
        return null;
    }
    return data || null;
}
function canReconcileLegacyUser(crossOrgUser) {
    if (!crossOrgUser)
        return false;
    if (crossOrgUser.org_id === 'default-tenant')
        return true;
    const metadata = crossOrgUser.metadata;
    if (!metadata || typeof metadata !== 'object')
        return false;
    return metadata.identity_provider === 'clerk';
}
async function reconcileLegacyUserToActiveOrg(args) {
    const { userId, activeOrgId, activeEmail, activeName, desiredSoftphone, crossOrgUser } = args;
    const metadata = crossOrgUser.metadata && typeof crossOrgUser.metadata === 'object'
        ? { ...crossOrgUser.metadata }
        : {};
    const existingSoftphone = metadata.softphone && typeof metadata.softphone === 'object'
        ? { ...metadata.softphone }
        : {};
    const reconciledAt = new Date().toISOString();
    const mergedMetadata = {
        ...metadata,
        identity_provider: 'clerk',
        reconciled_from_org_id: crossOrgUser.org_id,
        reconciled_at: reconciledAt,
        softphone: {
            ...existingSoftphone,
            endpoint: (typeof existingSoftphone.endpoint === 'string' && existingSoftphone.endpoint.trim())
                ? existingSoftphone.endpoint
                : desiredSoftphone.endpoint,
            transport: (typeof existingSoftphone.transport === 'string' && existingSoftphone.transport.trim())
                ? existingSoftphone.transport
                : desiredSoftphone.transport,
            host: (typeof existingSoftphone.host === 'string' && existingSoftphone.host.trim())
                ? existingSoftphone.host
                : desiredSoftphone.host,
        },
    };
    const { data, error } = await supabase_1.supabase
        .from('users')
        .update({
        org_id: activeOrgId,
        email: activeEmail,
        full_name: activeName || (typeof crossOrgUser.full_name === 'string' ? crossOrgUser.full_name : null),
        role: typeof crossOrgUser.role === 'string' ? crossOrgUser.role : 'agent',
        status: typeof crossOrgUser.status === 'string' ? crossOrgUser.status : 'active',
        metadata: mergedMetadata,
        updated_by: userId,
        updated_at: reconciledAt,
    })
        .eq('user_id', userId)
        .eq('org_id', String(crossOrgUser.org_id))
        .select('user_id, full_name, metadata')
        .maybeSingle();
    if (error) {
        logger_1.logger.error({ err: error, user_id: userId, active_org_id: activeOrgId, existing_org_id: crossOrgUser.org_id }, 'Failed to reconcile legacy Clerk user into active org');
        return null;
    }
    logger_1.logger.info({ user_id: userId, active_org_id: activeOrgId, existing_org_id: crossOrgUser.org_id }, 'Reconciled legacy Clerk user into active org');
    return data || null;
}
function coerceRequestBody(body) {
    if (!body)
        return {};
    if (typeof body === 'object')
        return body;
    if (typeof body !== 'string')
        return {};
    const trimmed = body.trim();
    if (!trimmed)
        return {};
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    }
    catch {
        // Fall back to URL-encoded parsing for plain-text dialplan callbacks.
    }
    return parseUrlEncodedBody(trimmed);
}
function normalizeAmdCallbackPayload(req) {
    const params = (req.params || {});
    const query = (req.query || {});
    const body = coerceRequestBody(req.body);
    return {
        callId: firstString(params.call_id, params.id, body.call_id, body.callId, query.call_id, query.callId),
        orgId: firstString(body.org_id, body.orgId, query.org_id, query.orgId, req.org_id),
        amdStatus: firstString(body.AMDSTATUS, body.result, body.status, query.AMDSTATUS, query.result, query.status),
        amdCause: firstString(body.AMDCAUSE, body.cause, query.AMDCAUSE, query.cause),
        durationMs: firstNumber(body.duration_ms, body.durationMs, query.duration_ms, query.durationMs),
        body,
        query,
        params,
    };
}
// ─── Plugin ──────────────────────────────────────────────────────────────────
const dialerModule = async (app) => {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, payload, done) => {
        try {
            const rawPayload = typeof payload === 'string' ? payload : payload.toString('utf8');
            done(null, parseUrlEncodedBody(rawPayload));
        }
        catch (error) {
            done(error);
        }
    });
    app.get('/', async (req) => ({
        module: 'dialer',
        org_id: req.org_id,
        user_id: req.user_id,
        role: req.role,
    }));
    // ────────────────────────────────────────────────────────────────────────────
    // AGENT STATE ROUTES
    // ────────────────────────────────────────────────────────────────────────────
    app.get('/agents/self/softphone', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        if (!req.user_id) {
            return reply.status(401).send({ error: 'Missing user scope' });
        }
        const headerEmail = req.headers['x-user-email'];
        const headerName = req.headers['x-user-name'];
        const headerEndpoint = req.headers['x-softphone-endpoint'];
        const headerTransport = req.headers['x-softphone-transport'];
        const headerHost = req.headers['x-softphone-host'];
        const desiredSoftphone = {
            endpoint: typeof headerEndpoint === 'string' && headerEndpoint.trim()
                ? headerEndpoint.trim()
                : config_1.config.dialerDefaultAgentEndpoint || null,
            transport: typeof headerTransport === 'string' && headerTransport.trim()
                ? headerTransport.trim()
                : config_1.config.dialerDefaultAgentTransport,
            host: typeof headerHost === 'string' && headerHost.trim()
                ? headerHost.trim()
                : config_1.config.dialerDefaultAgentHost || null,
        };
        let { data: user, error } = await supabase_1.supabase
            .from('users')
            .select('user_id, full_name, metadata')
            .eq('user_id', req.user_id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (error)
            return reply.status(500).send({ error: error.message });
        if (!user) {
            const bootstrapEmail = typeof headerEmail === 'string' && headerEmail.trim()
                ? headerEmail.trim().toLowerCase()
                : null;
            const bootstrapName = typeof headerName === 'string' && headerName.trim()
                ? headerName.trim()
                : null;
            if (!bootstrapEmail) {
                return reply.status(401).send({ error: 'Missing authenticated user identity (x-user-email)' });
            }
            // EXACT-FIRST resolver:
            // 1. Exact match already checked above — if we are here, no exact row exists.
            // 2. Attempt fallback: find any row for this user_id.
            // 3. If found in a different org, always attempt migration (Clerk JWT proves
            //    ownership; the active org is authoritative for this session).
            // 4. Only throw USER_ORG_CONFLICT if the migration DB call itself fails.
            const crossOrgUser = await findUserInOtherOrg(req.user_id, orgId);
            if (crossOrgUser) {
                const reconciledUser = await reconcileLegacyUserToActiveOrg({
                    userId: req.user_id,
                    activeOrgId: orgId,
                    activeEmail: bootstrapEmail,
                    activeName: bootstrapName,
                    desiredSoftphone,
                    crossOrgUser: crossOrgUser,
                });
                if (reconciledUser) {
                    user = reconciledUser;
                }
                else {
                    return reply.status(409).send({
                        error: 'User exists in a different org and cannot be resolved for the active org',
                        code: 'USER_ORG_CONFLICT',
                        user_id: req.user_id,
                        active_org_id: orgId,
                        existing_org_id: crossOrgUser.org_id,
                        existing_email: crossOrgUser.email ?? null,
                    });
                }
            }
            if (user) {
                // Reconciliation succeeded; skip bootstrap upsert.
            }
            else {
                const { data: seededUser, error: seedError } = await supabase_1.supabase
                    .from('users')
                    .upsert({
                    user_id: req.user_id,
                    org_id: orgId,
                    email: bootstrapEmail,
                    full_name: bootstrapName,
                    role: 'agent',
                    status: 'active',
                    metadata: {
                        softphone: desiredSoftphone,
                        identity_provider: 'clerk',
                    },
                    created_by: req.user_id,
                    updated_by: req.user_id,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' })
                    .select('user_id, full_name, metadata')
                    .maybeSingle();
                if (seedError) {
                    logger_1.logger.error({ err: seedError, org_id: orgId, user_id: req.user_id }, 'Failed to bootstrap Clerk-linked user');
                    return reply.status(409).send({
                        error: 'Failed to create or resolve the active-org user row',
                        code: 'USER_BOOTSTRAP_FAILED',
                        details: seedError.message,
                        user_id: req.user_id,
                        org_id: orgId,
                    });
                }
                user = seededUser || null;
            }
        }
        if (!user) {
            return reply.status(404).send({
                error: 'No user row exists for the active user and org',
                code: 'USER_ROW_MISSING',
                user_id: req.user_id,
                org_id: orgId,
            });
        }
        let metadata = (user.metadata || {});
        const currentSoftphone = (metadata.softphone || {});
        const currentEndpoint = typeof currentSoftphone.endpoint === 'string' ? currentSoftphone.endpoint.trim() : '';
        if (!currentEndpoint && desiredSoftphone.endpoint) {
            const mergedMetadata = {
                ...metadata,
                softphone: {
                    ...currentSoftphone,
                    endpoint: desiredSoftphone.endpoint,
                    transport: currentSoftphone.transport || desiredSoftphone.transport,
                    host: currentSoftphone.host || desiredSoftphone.host,
                },
            };
            const { data: updatedUser, error: updateError } = await supabase_1.supabase
                .from('users')
                .update({
                metadata: mergedMetadata,
                updated_by: req.user_id,
                updated_at: new Date().toISOString(),
            })
                .eq('user_id', req.user_id)
                .eq('org_id', orgId)
                .select('user_id, full_name, metadata')
                .maybeSingle();
            if (!updateError && updatedUser) {
                user = updatedUser;
                metadata = (updatedUser.metadata || {});
            }
        }
        const softphone = (metadata.softphone || {});
        const fallbackEndpoint = (typeof softphone.endpoint === 'string' && softphone.endpoint.trim()) ? softphone.endpoint : config_1.config.dialerDefaultAgentEndpoint || null;
        let registrationStatus = 'unknown';
        let registrationSource = 'none';
        let registrationReason = 'missing_endpoint';
        if (fallbackEndpoint) {
            const normalized = normalizeAgentEndpoint(fallbackEndpoint);
            const [technology, ...resourceParts] = normalized.split('/');
            const resource = resourceParts.join('/');
            if (technology && resource && config_1.config.ariUrl && config_1.config.ariUsername && config_1.config.ariPassword && config_1.config.ariApp) {
                try {
                    const endpoint = await ari_1.ARI.endpoints.get(technology, resource);
                    const state = String(endpoint?.state || '').toLowerCase();
                    registrationSource = 'ari';
                    registrationReason = state || 'unknown_state';
                    registrationStatus = state === 'online' ? 'registered' : state === 'offline' ? 'unregistered' : 'unknown';
                }
                catch (error) {
                    registrationReason =
                        error instanceof ari_1.AriRequestError ? `ari_http_${error.status}` : 'ari_query_failed';
                    logger_1.logger.warn({ error, org_id: orgId, user_id: req.user_id, endpoint: normalized }, 'Failed to verify endpoint registration from ARI');
                }
            }
            else {
                registrationReason = 'ari_not_configured';
            }
        }
        return reply.send({
            agent_id: user.user_id,
            display_name: user.full_name ?? null,
            endpoint: fallbackEndpoint,
            sip_uri: softphone.sip_uri ?? null,
            authorization_username: softphone.authorization_username ?? null,
            password: softphone.password ?? null,
            ws_server: softphone.ws_server ?? null,
            registration_status: registrationStatus,
            registration_source: registrationSource,
            registration_reason: registrationReason,
            metadata: {
                ...(softphone || {}),
                registration_status: registrationStatus,
                registration_source: registrationSource,
                registration_reason: registrationReason,
                ...(fallbackEndpoint && !softphone.endpoint
                    ? {
                        endpoint: fallbackEndpoint,
                        transport: config_1.config.dialerDefaultAgentTransport,
                        host: config_1.config.dialerDefaultAgentHost || null,
                    }
                    : {}),
            },
        });
    });
    /** POST /dialer/agents/session – login/go-ready */
    app.post('/agents/session', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const body = (req.body || {});
        if (!body.agent_id) {
            return reply.status(400).send({ error: 'agent_id is required' });
        }
        // Verify agent belongs to org
        const { data: agent, error: agentErr } = await supabase_1.supabase
            .from('users')
            .select('user_id, metadata')
            .eq('user_id', body.agent_id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (agentErr)
            return reply.status(500).send({ error: agentErr.message });
        if (!agent)
            return reply.status(404).send({ error: 'Agent not found' });
        const agentMetadata = (agent.metadata || {});
        const storedSoftphone = (agentMetadata.softphone || {});
        const rawEndpoint = body.endpoint ||
            (typeof body.softphone?.endpoint === 'string' ? body.softphone.endpoint : null) ||
            (typeof storedSoftphone.endpoint === 'string' ? storedSoftphone.endpoint : null);
        if (!rawEndpoint) {
            return reply.status(400).send({ error: 'Agent endpoint is required before going READY' });
        }
        const endpoint = normalizeAgentEndpoint(rawEndpoint);
        // ── SIP Registration Gate ──────────────────────────────────────────────
        const { registered, state: epState } = await (0, agentState_1.verifyAriEndpoint)(endpoint);
        if (!registered) {
            return reply.status(409).send({
                error: 'SIP endpoint is not registered in Asterisk. Register your softphone first.',
                code: 'ENDPOINT_NOT_REGISTERED',
                endpoint,
                ari_state: epState,
            });
        }
        try {
            const session = await (0, agentState_1.createAgentSession)(orgId, body.agent_id, body.campaign_id ?? null, req.user_id || body.agent_id, {
                endpoint,
                softphone: {
                    ...storedSoftphone,
                    ...(body.softphone || {}),
                    endpoint,
                },
                wrap_until: null,
                active_call_id: null,
            });
            // ── Originate Agent Leg ────────────────────────────────────────────
            // Agent's phone will ring; when answered the ARI StasisStart handler
            // will create the waiting bridge and set registration_verified=true.
            let agentLegStatus = 'skipped';
            try {
                await (0, agentState_1.originateAgentLeg)(orgId, session.session_id, body.agent_id, endpoint);
                agentLegStatus = 'originating';
            }
            catch (legErr) {
                logger_1.logger.warn({ err: legErr, session_id: session.session_id }, 'Failed to originate agent leg — session still created OFFLINE');
                agentLegStatus = 'failed';
            }
            logger_1.logger.info({
                org_id: orgId, user_id: req.user_id, agent_id: body.agent_id,
                session_id: session.session_id, campaign_id: body.campaign_id ?? null,
                endpoint, agent_leg_status: agentLegStatus, session_state: session.state,
            }, '[DEBUG] session created');
            return reply.status(201).send({ session, agent_leg_status: agentLegStatus });
        }
        catch (err) {
            logger_1.logger.error({ err, org_id: orgId }, 'Failed to create agent session');
            return reply.status(500).send({ error: 'Failed to create session' });
        }
    });
    /** GET /dialer/agents/:agent_id/session */
    app.get('/agents/:agent_id/session', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { agent_id } = req.params;
        const session = await (0, agentState_1.getAgentSession)(orgId, agent_id);
        if (!session)
            return reply.status(404).send({ error: 'No active session found' });
        return reply.send({ session });
    });
    /** POST /dialer/agents/:session_id/go-ready – confirm agent leg live, transition OFFLINE → READY */
    app.post('/agents/:session_id/go-ready', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { session_id } = req.params;
        const { data: session, error: sessErr } = await supabase_1.supabase
            .from('agent_sessions')
            .select('session_id, state, channel_id, registration_verified, agent_id')
            .eq('session_id', session_id)
            .eq('org_id', orgId)
            .is('ended_at', null)
            .maybeSingle();
        if (sessErr)
            return reply.status(500).send({ error: sessErr.message });
        if (!session)
            return reply.status(404).send({ error: 'Session not found' });
        logger_1.logger.info({
            org_id: orgId, user_id: req.user_id, session_id, agent_id: session.agent_id,
            state_before: session.state, registration_verified: session.registration_verified,
            channel_id: session.channel_id,
        }, '[DEBUG] go-ready received');
        if (!session.registration_verified || !session.channel_id) {
            logger_1.logger.warn({ session_id, registration_verified: session.registration_verified, channel_id: session.channel_id }, '[DEBUG] go-ready rejected: agent leg not live');
            return reply.status(409).send({
                error: 'Agent leg not yet confirmed. Wait for your phone to connect first.',
                code: 'AGENT_LEG_NOT_LIVE',
            });
        }
        // Verify the agent's channel is still alive in ARI
        try {
            await ari_1.ARI.channels.get(session.channel_id);
        }
        catch {
            logger_1.logger.warn({ session_id, channel_id: session.channel_id }, '[DEBUG] go-ready rejected: ARI channel dead');
            return reply.status(409).send({
                error: 'Agent channel is no longer active. Please re-arm your session.',
                code: 'AGENT_CHANNEL_DEAD',
            });
        }
        try {
            const updated = await (0, agentState_1.transitionAgentState)(session_id, orgId, 'READY', { reason: 'go_ready' });
            logger_1.logger.info({
                org_id: orgId, session_id, agent_id: updated.agent_id,
                state_after: updated.state, campaign_id: updated.campaign_id,
            }, '[DEBUG] go-ready success: session is now READY');
            return reply.send({ session: updated });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'State transition failed';
            logger_1.logger.error({ session_id, err }, '[DEBUG] go-ready transition failed');
            return reply.status(409).send({ error: msg });
        }
    });
    /** POST /dialer/agents/:session_id/state – FSM transition */
    app.post('/agents/:session_id/state', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { session_id } = req.params;
        const body = (req.body || {});
        if (!body.state) {
            return reply.status(400).send({ error: 'state is required' });
        }
        const ALLOWED = ['OFFLINE', 'READY', 'PAUSED', 'WRAP'];
        if (!ALLOWED.includes(body.state)) {
            return reply.status(400).send({
                error: `state must be one of: ${ALLOWED.join(', ')}`,
            });
        }
        try {
            const session = await (0, agentState_1.transitionAgentState)(session_id, orgId, body.state, { reason: body.reason, updatedBy: req.user_id ?? 'system' });
            return reply.send({ session });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'State transition failed';
            return reply.status(409).send({ error: msg });
        }
    });
    // ────────────────────────────────────────────────────────────────────────────
    // CAMPAIGN DIALER CONTROLS
    // ────────────────────────────────────────────────────────────────────────────
    /** POST /dialer/campaigns/:campaign_id/start */
    app.post('/campaigns/:campaign_id/start', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id } = req.params;
        // Scope check
        const { data: campaign, error: campErr } = await supabase_1.supabase
            .from('campaigns')
            .select('campaign_id, status')
            .eq('campaign_id', campaign_id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (campErr)
            return reply.status(500).send({ error: campErr.message });
        if (!campaign)
            return reply.status(404).send({ error: 'Campaign not found' });
        // ─── PREFLIGHT GATE ────────────────────────────────────────────────
        // 1. Require at least one READY agent session
        const readyAgents = await (0, agentState_1.countReadyAgents)(orgId, campaign_id);
        logger_1.logger.info({
            org_id: orgId, user_id: req.user_id, campaign_id, ready_agent_count: readyAgents,
        }, '[DEBUG] campaign start READY check');
        if (readyAgents === 0) {
            // Dump open sessions for this org to show what state they are in
            const { data: openSessions } = await supabase_1.supabase
                .from('agent_sessions')
                .select('session_id, agent_id, state, campaign_id, registration_verified, ended_at')
                .eq('org_id', orgId)
                .is('ended_at', null)
                .limit(5);
            logger_1.logger.warn({ org_id: orgId, campaign_id, open_sessions: openSessions ?? [] }, '[DEBUG] NO_READY_AGENT: open sessions dump');
            return reply.status(409).send({
                error: 'No READY agent session found. Agent must be logged in and in READY state before starting the dialer.',
                code: 'NO_READY_AGENT',
                campaign_id,
            });
        }
        // 2. Require at least one dialable lead in queue
        const { count: dialableLeads, error: queueErr } = await supabase_1.supabase
            .from('v_dialer_queue')
            .select('cl_id', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('campaign_id', campaign_id);
        if (queueErr)
            return reply.status(500).send({ error: queueErr.message });
        if (!dialableLeads || dialableLeads === 0) {
            return reply.status(409).send({
                error: 'No dialable leads in queue for this campaign. Import leads or reset exhausted leads before starting.',
                code: 'NO_DIALABLE_LEADS',
                campaign_id,
            });
        }
        // ─── START ───────────────────────────────────────────────────────────
        (0, engine_1.startDialerWorker)(orgId, campaign_id);
        const enqueued = await (0, engine_1.seedDialerQueue)(orgId, campaign_id, 100);
        // Mark campaign active
        await supabase_1.supabase
            .from('campaigns')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('campaign_id', campaign_id)
            .eq('org_id', orgId);
        logger_1.logger.info({ org_id: orgId, campaign_id, enqueued, ready_agents: readyAgents }, 'Campaign dialer started');
        return reply.send({ success: true, campaign_id, enqueued, ready_agents: readyAgents });
    });
    /** POST /dialer/campaigns/:campaign_id/stop */
    app.post('/campaigns/:campaign_id/stop', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id } = req.params;
        await (0, engine_1.drainDialerQueue)(orgId, campaign_id);
        await (0, engine_1.stopDialerWorker)(orgId, campaign_id);
        await supabase_1.supabase
            .from('campaigns')
            .update({ status: 'paused', updated_at: new Date().toISOString() })
            .eq('campaign_id', campaign_id)
            .eq('org_id', orgId);
        logger_1.logger.info({ org_id: orgId, campaign_id }, 'Campaign dialer stopped');
        return reply.send({ success: true, campaign_id });
    });
    /** GET /dialer/campaigns/:campaign_id/status */
    app.get('/campaigns/:campaign_id/status', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id } = req.params;
        const queue = (0, engine_1.getDialerQueue)(orgId, campaign_id);
        const [waiting, active, failed, completed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getFailedCount(),
            queue.getCompletedCount(),
        ]);
        // Agent counts
        const { count: readyCount } = await supabase_1.supabase
            .from('agent_sessions')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('campaign_id', campaign_id)
            .eq('state', 'READY')
            .is('ended_at', null);
        const { count: incallCount } = await supabase_1.supabase
            .from('agent_sessions')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('campaign_id', campaign_id)
            .eq('state', 'INCALL')
            .is('ended_at', null);
        // Leads remaining
        const { count: pendingLeads } = await supabase_1.supabase
            .from('campaign_leads')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('campaign_id', campaign_id)
            .in('dial_state', ['pending', 'callback']);
        // Live calls for this campaign (active/bridged)
        const { data: liveCalls } = await supabase_1.supabase
            .from('calls')
            .select('call_id, contact_id, lead_id, assigned_agent, status, started_at, metadata')
            .eq('org_id', orgId)
            .eq('campaign_id', campaign_id)
            .in('status', ['DIALING_LEAD', 'ANSWERED', 'AMD_HUMAN', 'BRIDGED', 'dialing', 'originated', 'bridged']);
        return reply.send({
            campaign_id,
            queue: { waiting, active, failed, completed },
            agents: { ready: readyCount ?? 0, incall: incallCount ?? 0 },
            leads: { pending: pendingLeads ?? 0 },
            live_calls_data: liveCalls ?? [],
        });
    });
    /**
     * POST /dialer/campaigns/:campaign_id/leads
     * Bulk-add leads to a campaign queue.
     * Body: { leads: [{ lead_id, contact_id?, phone, priority? }] }
     */
    app.post('/campaigns/:campaign_id/leads', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id } = req.params;
        const body = (req.body || {});
        if (!Array.isArray(body.leads) || body.leads.length === 0) {
            return reply.status(400).send({ error: 'leads array is required and cannot be empty' });
        }
        if (body.leads.length > 1000) {
            return reply.status(400).send({ error: 'Maximum 1000 leads per request' });
        }
        // Scope check
        const { data: campaign } = await supabase_1.supabase
            .from('campaigns')
            .select('campaign_id')
            .eq('campaign_id', campaign_id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (!campaign)
            return reply.status(404).send({ error: 'Campaign not found' });
        const rows = body.leads
            .filter((l) => l.lead_id && l.phone)
            .map((l) => ({
            cl_id: crypto.randomUUID(),
            org_id: orgId,
            campaign_id,
            lead_id: l.lead_id,
            contact_id: l.contact_id ?? null,
            phone: l.phone,
            priority: l.priority ?? 0,
            max_attempts: l.max_attempts ?? 3,
            dial_state: 'pending',
            created_by: req.user_id ?? 'api',
            updated_by: req.user_id ?? 'api',
        }));
        const { error } = await supabase_1.supabase
            .from('campaign_leads')
            .upsert(rows, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true });
        if (error)
            return reply.status(500).send({ error: error.message });
        return reply.status(201).send({ success: true, inserted: rows.length });
    });
    // ────────────────────────────────────────────────────────────────────────────
    // CALL HANDLING
    // ────────────────────────────────────────────────────────────────────────────
    /**
     * POST /dialer/calls/:call_id/amd_result
     * Called by Asterisk dialplan via CURL() after AMD() completes.
     * The dialplan variable DIALER_BACKEND_URL is set during origination.
     *
     * Accepts:
     *   - application/json
     *   - application/x-www-form-urlencoded
     *   - query params when the request body is empty
     *
     * Normalized fields: { call_id, org_id, result|AMDSTATUS, cause|AMDCAUSE, duration_ms? }
     */
    app.post('/calls/:call_id/amd_result', async (req, reply) => {
        const normalized = normalizeAmdCallbackPayload(req);
        const orgId = normalized.orgId;
        const callId = normalized.callId;
        const rawResult = normalized.amdStatus ?? '';
        const cause = normalized.amdCause;
        const durationMs = normalized.durationMs;
        if (!orgId)
            return reply.status(400).send({ error: 'org_id is required' });
        if (!callId)
            return reply.status(400).send({ error: 'call_id is required' });
        const amdResult = (0, amd_1.parseAmdResult)(rawResult);
        logger_1.logger.info({
            route: 'dialer.calls.amd_result',
            content_type: req.headers['content-type'],
            params_id: normalized.params.id ?? normalized.params.call_id,
            query: normalized.query,
            body: normalized.body,
            normalized: {
                callId,
                orgId,
                amdStatus: rawResult,
                amdCause: cause,
                durationMs,
                parsedResult: amdResult,
            },
        }, 'Received dialer AMD callback');
        try {
            await (0, amd_1.recordAmdResult)({ call_id: callId, org_id: orgId, result: amdResult, cause, duration_ms: durationMs });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'AMD result error';
            return reply.status(500).send({ error: msg });
        }
        const action = (0, amd_1.amdDispatchAction)(amdResult);
        try {
            await (0, orchestrator_1.processDialerAmdResult)(callId, orgId, amdResult, cause, durationMs);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Dialer orchestration error';
            logger_1.logger.error({ err, org_id: orgId, call_id: callId }, 'Failed processing AMD result');
            return reply.status(500).send({ error: msg });
        }
        return reply.send({ success: true, action, amd_result: amdResult });
    });
    /**
     * POST /dialer/calls/:call_id/disposition
     * Agent submits call outcome after WRAP.
     */
    app.post('/calls/:call_id/disposition', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { call_id } = req.params;
        const body = (req.body || {});
        if (!body.outcome) {
            return reply.status(400).send({ error: 'outcome is required' });
        }
        const VALID_OUTCOMES = [
            'ANSWERED_HUMAN', 'ANSWERED_MACHINE', 'NO_ANSWER', 'BUSY', 'FAILED',
            'DNC', 'CALLBACK', 'SALE', 'NOT_INTERESTED', 'WRONG_NUMBER', 'OTHER',
        ];
        if (!VALID_OUTCOMES.includes(body.outcome)) {
            return reply.status(400).send({ error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(', ')}` });
        }
        // Fetch call (org-scoped)
        const { data: call, error: callErr } = await supabase_1.supabase
            .from('calls')
            .select('call_id, org_id, campaign_id, cl_id, metadata')
            .eq('call_id', call_id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (callErr)
            return reply.status(500).send({ error: callErr.message });
        if (!call)
            return reply.status(404).send({ error: 'Call not found' });
        const metadata = (call.metadata || {});
        const clId = call.cl_id ?? (typeof metadata.cl_id === 'string' ? metadata.cl_id : null);
        const disposition_id = crypto.randomUUID();
        const { error: dispErr } = await supabase_1.supabase.from('dispositions').insert({
            disposition_id,
            org_id: orgId,
            call_id,
            cl_id: clId,
            agent_id: req.user_id ?? null,
            outcome: body.outcome,
            notes: body.notes ?? null,
            callback_at: body.callback_at ?? null,
            duration_wrap: body.duration_wrap ?? null,
            created_by: req.user_id ?? 'system',
            updated_by: req.user_id ?? 'system',
        });
        if (dispErr)
            return reply.status(500).send({ error: dispErr.message });
        // Update campaign_lead dial_state
        if (clId) {
            const leadDialState = body.outcome === 'CALLBACK' ? 'callback' :
                body.outcome === 'DNC' ? 'dnc' :
                    ['SALE', 'ANSWERED_HUMAN', 'NOT_INTERESTED', 'WRONG_NUMBER'].includes(body.outcome)
                        ? 'disposed' : 'disposed';
            await supabase_1.supabase
                .from('campaign_leads')
                .update({
                dial_state: leadDialState,
                callback_at: body.outcome === 'CALLBACK' ? body.callback_at ?? null : null,
                updated_at: new Date().toISOString(),
            })
                .eq('cl_id', clId)
                .eq('org_id', orgId);
        }
        await (0, orchestrator_1.markDispositioned)(call_id, orgId);
        // Transition agent WRAP → READY if session_id provided
        if (body.session_id) {
            await (0, agentState_1.transitionAgentState)(body.session_id, orgId, 'READY', {
                reason: 'disposition_submitted',
                updatedBy: req.user_id ?? 'system',
            }).catch(() => undefined);
        }
        return reply.status(201).send({ disposition_id, success: true });
    });
    // ────────────────────────────────────────────────────────────────────────────
    // WRAP-UP (new atomic endpoint using dialer_call_attempts + apply_dialer_wrap_up)
    // ────────────────────────────────────────────────────────────────────────────
    /**
     * POST /dialer/call-attempts/:id/wrap-up
     * Atomic: disposition + notes + lead summary + queue state in one DB call.
     */
    app.post('/call-attempts/:id/wrap-up', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { id } = req.params;
        const body = (req.body || {});
        const disposition = body.disposition || body.agent_disposition;
        if (!disposition) {
            return reply.status(400).send({ error: 'disposition is required' });
        }
        const VALID = [
            'no_answer', 'voicemail', 'busy', 'wrong_number', 'bad_number',
            'do_not_call', 'callback_requested', 'interested', 'not_interested',
            'qualified', 'appointment_set', 'sale', 'failed', 'abandoned',
        ];
        if (!VALID.includes(disposition)) {
            return reply.status(400).send({ error: `Invalid disposition. Must be one of: ${VALID.join(', ')}` });
        }
        // Verify attempt belongs to this org
        const { data: attempt, error: attemptErr } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('id, org_id')
            .eq('id', id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (attemptErr)
            return reply.status(500).send({ error: attemptErr.message });
        if (!attempt)
            return reply.status(404).send({ error: 'Call attempt not found' });
        // Call the atomic wrap-up function
        const { data, error } = await supabase_1.supabase.rpc('apply_dialer_wrap_up', {
            p_call_attempt_id: id,
            p_agent_disposition: disposition,
            p_notes: body.notes ?? null,
            p_callback_at: body.callback_at ?? null,
            p_author_user_id: req.user_id ?? null,
        });
        if (error)
            return reply.status(500).send({ error: error.message });
        // Also mark the old calls row as DISPOSITIONED if there's a linked call_id
        const { data: attemptRow } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('call_id')
            .eq('id', id)
            .maybeSingle();
        if (attemptRow?.call_id) {
            await (0, orchestrator_1.markDispositioned)(attemptRow.call_id, orgId);
        }
        // Transition agent WRAP → READY
        if (body.session_id) {
            await (0, agentState_1.transitionAgentState)(body.session_id, orgId, 'READY', {
                reason: 'wrapup_submitted',
                updatedBy: req.user_id ?? 'system',
            }).catch(() => undefined);
        }
        const result = Array.isArray(data) ? data[0] : data;
        return reply.status(201).send({ success: true, ...result });
    });
    /**
     * POST /dialer/leads/:lead_id/notes
     * Add a standalone note to a lead (not tied to wrap-up).
     */
    app.post('/leads/:lead_id/notes', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { lead_id } = req.params;
        const body = (req.body || {});
        if (!body.body || !body.body.trim()) {
            return reply.status(400).send({ error: 'body is required and cannot be blank' });
        }
        const VALID_TYPES = ['call_note', 'general_note', 'callback_note', 'manager_note', 'disposition_note'];
        const noteType = body.note_type && VALID_TYPES.includes(body.note_type) ? body.note_type : 'general_note';
        const { data, error } = await supabase_1.supabase
            .from('lead_notes')
            .insert({
            org_id: orgId,
            lead_id,
            campaign_id: null,
            call_attempt_id: body.call_attempt_id ?? null,
            author_user_id: req.user_id ?? 'system',
            note_type: noteType,
            body: body.body.trim(),
            is_pinned: body.is_pinned ?? false,
        })
            .select('id, created_at')
            .single();
        if (error)
            return reply.status(500).send({ error: error.message });
        // Mirror to leads.latest_note
        await supabase_1.supabase
            .from('leads')
            .update({ latest_note: body.body.trim() })
            .eq('lead_id', lead_id)
            .eq('org_id', orgId);
        return reply.status(201).send({ success: true, note_id: data.id, created_at: data.created_at });
    });
    /**
     * GET /dialer/leads/:lead_id/notes
     * List notes for a lead.
     */
    app.get('/leads/:lead_id/notes', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { lead_id } = req.params;
        const { limit } = req.query;
        const safeLimit = Math.min(Number.parseInt(limit ?? '50', 10) || 50, 200);
        const { data, error } = await supabase_1.supabase
            .from('lead_notes')
            .select('id, call_attempt_id, author_user_id, note_type, body, is_pinned, created_at')
            .eq('org_id', orgId)
            .eq('lead_id', lead_id)
            .order('created_at', { ascending: false })
            .limit(safeLimit);
        if (error)
            return reply.status(500).send({ error: error.message });
        return reply.send(data ?? []);
    });
    /**
     * GET /dialer/call-attempts/:id
     * Get a single call attempt with full detail.
     */
    app.get('/call-attempts/:id', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { id } = req.params;
        const { data, error } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('*')
            .eq('id', id)
            .eq('org_id', orgId)
            .maybeSingle();
        if (error)
            return reply.status(500).send({ error: error.message });
        if (!data)
            return reply.status(404).send({ error: 'Call attempt not found' });
        return reply.send(data);
    });
    /** GET /dialer/calls/live – active dialer calls for org */
    app.get('/calls/live', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id, limit } = req.query;
        const safeLimit = Math.min(Math.max(Number.parseInt(limit ?? '100', 10) || 100, 1), 500);
        let query = supabase_1.supabase
            .from('calls')
            .select('call_id, org_id, campaign_id, contact_id, lead_id, assigned_agent, status, started_at, metadata')
            .eq('org_id', orgId)
            .in('status', ['QUEUED', 'DIALING_LEAD', 'ANSWERED', 'AMD_HUMAN', 'AMD_MACHINE', 'BRIDGED', 'dialing', 'originated', 'bridged', 'answering'])
            .order('started_at', { ascending: false })
            .limit(safeLimit);
        if (campaign_id) {
            query = query.eq('campaign_id', campaign_id);
        }
        const { data, error } = await query;
        if (error)
            return reply.status(500).send({ error: error.message });
        return reply.send(data ?? []);
    });
    // ────────────────────────────────────────────────────────────────────────────
    // ACTIVE CALL CONTEXT (agent-facing)
    // ────────────────────────────────────────────────────────────────────────────
    /**
     * GET /dialer/agents/self/active-call
     * Returns the current active lead + call attempt context for the signed-in agent.
     * Polled by the CRM dialer UI every 2s.
     */
    app.get('/agents/self/active-call', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const userId = req.user_id;
        if (!userId)
            return reply.status(401).send({ error: 'Missing user scope' });
        // 1. Find the agent's active session
        const { data: session } = await supabase_1.supabase
            .from('agent_sessions')
            .select('session_id, state, campaign_id, metadata')
            .eq('org_id', orgId)
            .eq('agent_id', userId)
            .is('ended_at', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        const sessionId = session?.session_id ?? null;
        const campaignId = session?.campaign_id ?? null;
        // 2. Find the latest call attempt for this agent that is still active (ended_at IS NULL)
        const { data: attempt } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('*')
            .eq('org_id', orgId)
            .eq('agent_user_id', userId)
            .is('ended_at', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!attempt) {
            return reply.send({
                has_active_call: false,
                agent_user_id: userId,
                session_id: sessionId,
                campaign: null,
                lead: null,
                call_attempt: null,
                queue: null,
            });
        }
        // 3. Fetch campaign name
        let campaignName = null;
        const aCampaignId = attempt.campaign_id || campaignId;
        if (aCampaignId) {
            const { data: camp } = await supabase_1.supabase
                .from('campaigns')
                .select('name')
                .eq('campaign_id', aCampaignId)
                .maybeSingle();
            campaignName = camp?.name ?? null;
        }
        // 4. Fetch lead + contact for name/phone
        let leadData = null;
        let contactName = null;
        if (attempt.lead_id) {
            const { data: lead } = await supabase_1.supabase
                .from('leads')
                .select('lead_id, status, metadata, latest_note, last_agent_disposition, callback_at, do_not_call, attempt_count')
                .eq('lead_id', attempt.lead_id)
                .eq('org_id', orgId)
                .maybeSingle();
            leadData = lead;
            // Try to get contact name from contacts table
            const { data: contacts } = await supabase_1.supabase
                .from('contacts')
                .select('first_name, last_name, phone')
                .eq('lead_id', attempt.lead_id)
                .eq('org_id', orgId)
                .limit(1);
            if (contacts && contacts.length > 0) {
                contactName = [contacts[0].first_name, contacts[0].last_name].filter(Boolean).join(' ') || null;
            }
        }
        // 5. Fetch campaign_leads queue context
        let queueData = null;
        if (attempt.cl_id) {
            const { data: cl } = await supabase_1.supabase
                .from('campaign_leads')
                .select('dial_state, attempts, max_attempts, next_retry_at, is_callable, last_disposition, callback_at')
                .eq('cl_id', attempt.cl_id)
                .eq('org_id', orgId)
                .maybeSingle();
            queueData = cl;
        }
        // Derive lead name from contacts or lead metadata
        const leadMeta = (leadData?.metadata || {});
        const leadName = contactName
            || (typeof leadMeta.lead_name === 'string' ? leadMeta.lead_name : null)
            || (typeof leadMeta.name === 'string' ? leadMeta.name : null);
        const nameParts = leadName ? leadName.split(' ') : [];
        const firstName = nameParts[0] || null;
        const lastName = nameParts.slice(1).join(' ') || null;
        // Derive call state from system_outcome + ended_at
        let callState = attempt.system_outcome || 'queued';
        if (!attempt.ended_at) {
            if (attempt.bridged_at)
                callState = 'bridged';
            else if (attempt.answered_at)
                callState = 'answered';
            else
                callState = 'dialing';
        }
        else {
            if (attempt.system_outcome === 'completed')
                callState = 'completed';
            else if (attempt.system_outcome)
                callState = attempt.system_outcome;
            else
                callState = 'completed';
        }
        return reply.send({
            has_active_call: true,
            agent_user_id: userId,
            session_id: sessionId,
            campaign: {
                id: aCampaignId,
                name: campaignName,
            },
            lead: {
                id: attempt.lead_id,
                first_name: firstName,
                last_name: lastName,
                phone: attempt.to_number || (typeof leadMeta.phone === 'string' ? leadMeta.phone : null),
                status: leadData?.status ?? null,
                latest_note: leadData?.latest_note ?? null,
                last_agent_disposition: leadData?.last_agent_disposition ?? null,
                callback_at: leadData?.callback_at ?? null,
                do_not_call: leadData?.do_not_call ?? false,
                attempt_count: leadData?.attempt_count ?? 0,
            },
            call_attempt: {
                id: attempt.id,
                call_id: attempt.call_id,
                state: callState,
                system_outcome: attempt.system_outcome,
                agent_disposition: attempt.agent_disposition,
                started_at: attempt.created_at,
                answered_at: attempt.answered_at,
                bridged_at: attempt.bridged_at,
                ended_at: attempt.ended_at,
                duration_seconds: attempt.duration_seconds,
                talk_seconds: attempt.talk_seconds,
            },
            queue: queueData ? {
                dial_state: queueData.dial_state ?? null,
                attempt_count: queueData.attempts ?? 0,
                max_attempts: queueData.max_attempts ?? 3,
                next_retry_at: queueData.next_retry_at ?? null,
                is_callable: queueData.is_callable ?? true,
                callback_at: queueData.callback_at ?? null,
            } : null,
        });
    });
    // ────────────────────────────────────────────────────────────────────────────
    // AGENT HANGUP
    // ────────────────────────────────────────────────────────────────────────────
    /**
     * POST /dialer/agents/self/hangup
     * Agent-initiated hangup. Looks up the active call, hangs up both channel legs via ARI.
     * State transitions are handled by the ARI hangup event (handleCallChannelHangup).
     */
    app.post('/agents/self/hangup', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const userId = req.user_id;
        if (!userId)
            return reply.status(401).send({ error: 'Missing user scope' });
        // Find the agent's active call attempt (ended_at IS NULL)
        const { data: attempt } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('id, call_id, org_id, provider_channel_id, provider_bridge_id')
            .eq('org_id', orgId)
            .eq('agent_user_id', userId)
            .is('ended_at', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!attempt) {
            return reply.status(404).send({ error: 'No active call to hang up' });
        }
        // Get channel IDs from the calls table metadata
        const callId = attempt.call_id;
        let leadChannelId = null;
        let agentChannelId = null;
        if (callId) {
            const call = await (0, orchestrator_1.findCallByChannelId)(callId);
            if (call) {
                const meta = (call.metadata || {});
                leadChannelId = (typeof meta.lead_channel_id === 'string' ? meta.lead_channel_id : null) || callId;
                agentChannelId = typeof meta.agent_channel_id === 'string' ? meta.agent_channel_id : null;
            }
        }
        // Hang up both channel legs via ARI — the ARI hangup event will handle state transitions
        const hungUp = [];
        for (const chId of [agentChannelId, leadChannelId]) {
            if (!chId)
                continue;
            try {
                await ari_1.ARI.channels.hangup(chId);
                hungUp.push(chId);
            }
            catch {
                // Channel may already be gone
            }
        }
        // If no ARI channels were found, still mark the attempt as ended
        if (hungUp.length === 0 && attempt.id) {
            await supabase_1.supabase
                .from('dialer_call_attempts')
                .update({ ended_at: new Date().toISOString(), system_outcome: 'completed' })
                .eq('id', attempt.id)
                .eq('org_id', orgId);
        }
        return reply.send({ success: true, hung_up: hungUp });
    });
    // ────────────────────────────────────────────────────────────────────────────
    // WRAP-UP CONTEXT (agent-facing)
    // ────────────────────────────────────────────────────────────────────────────
    /**
     * GET /dialer/agents/self/wrap-up
     * Returns the most recent call attempt needing wrap-up (ended but not dispositioned).
     */
    app.get('/agents/self/wrap-up', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const userId = req.user_id;
        if (!userId)
            return reply.status(401).send({ error: 'Missing user scope' });
        // Find latest ended call attempt with wrap_up_status = 'pending'
        // Only return wrap-ups from the last 30 minutes to prevent stale cross-session wrap-ups
        const wrapUpCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const { data: attempt } = await supabase_1.supabase
            .from('dialer_call_attempts')
            .select('*')
            .eq('org_id', orgId)
            .eq('agent_user_id', userId)
            .not('ended_at', 'is', null)
            .gte('ended_at', wrapUpCutoff)
            .eq('wrap_up_status', 'pending')
            .order('ended_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!attempt) {
            return reply.send({ has_wrap_up: false });
        }
        // Fetch lead context
        let leadData = null;
        let contactName = null;
        if (attempt.lead_id) {
            const { data: lead } = await supabase_1.supabase
                .from('leads')
                .select('lead_id, status, metadata, latest_note, last_agent_disposition, callback_at, do_not_call, attempt_count')
                .eq('lead_id', attempt.lead_id)
                .eq('org_id', orgId)
                .maybeSingle();
            leadData = lead;
            const { data: contacts } = await supabase_1.supabase
                .from('contacts')
                .select('first_name, last_name, phone')
                .eq('lead_id', attempt.lead_id)
                .eq('org_id', orgId)
                .limit(1);
            if (contacts && contacts.length > 0) {
                contactName = [contacts[0].first_name, contacts[0].last_name].filter(Boolean).join(' ') || null;
            }
        }
        // Campaign name
        let campaignName = null;
        if (attempt.campaign_id) {
            const { data: camp } = await supabase_1.supabase
                .from('campaigns')
                .select('name')
                .eq('campaign_id', attempt.campaign_id)
                .maybeSingle();
            campaignName = camp?.name ?? null;
        }
        const leadMeta = (leadData?.metadata || {});
        const leadName = contactName
            || (typeof leadMeta.lead_name === 'string' ? leadMeta.lead_name : null)
            || (typeof leadMeta.name === 'string' ? leadMeta.name : null);
        const nameParts = leadName ? leadName.split(' ') : [];
        // Get agent's active session for session_id
        const { data: agentSession } = await supabase_1.supabase
            .from('agent_sessions')
            .select('session_id')
            .eq('org_id', orgId)
            .eq('agent_id', userId)
            .is('ended_at', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        return reply.send({
            has_wrap_up: true,
            session_id: agentSession?.session_id ?? null,
            campaign: {
                id: attempt.campaign_id,
                name: campaignName,
            },
            lead: {
                id: attempt.lead_id,
                first_name: nameParts[0] || null,
                last_name: nameParts.slice(1).join(' ') || null,
                phone: attempt.to_number || (typeof leadMeta.phone === 'string' ? leadMeta.phone : null),
                status: leadData?.status ?? null,
                latest_note: leadData?.latest_note ?? null,
                last_agent_disposition: leadData?.last_agent_disposition ?? null,
                do_not_call: leadData?.do_not_call ?? false,
                attempt_count: leadData?.attempt_count ?? 0,
            },
            call_attempt: {
                id: attempt.id,
                call_id: attempt.call_id,
                system_outcome: attempt.system_outcome,
                agent_disposition: attempt.agent_disposition,
                wrap_up_status: attempt.wrap_up_status,
                started_at: attempt.created_at,
                answered_at: attempt.answered_at,
                bridged_at: attempt.bridged_at,
                ended_at: attempt.ended_at,
                duration_seconds: attempt.duration_seconds,
                talk_seconds: attempt.talk_seconds,
            },
        });
    });
    // ────────────────────────────────────────────────────────────────────────────
    // SUPERVISOR
    // ────────────────────────────────────────────────────────────────────────────
    /** GET /dialer/supervisor/queue */
    app.get('/supervisor/queue', async (req, reply) => {
        const orgId = requireOrg(req, reply);
        if (!orgId)
            return;
        const { campaign_id } = req.query;
        // Active agent sessions
        let sessionsQuery = supabase_1.supabase
            .from('agent_sessions')
            .select('session_id, agent_id, campaign_id, state, last_state_at')
            .eq('org_id', orgId)
            .is('ended_at', null);
        if (campaign_id)
            sessionsQuery = sessionsQuery.eq('campaign_id', campaign_id);
        // Live calls
        let callsQuery = supabase_1.supabase
            .from('calls')
            .select('call_id, campaign_id, contact_id, lead_id, assigned_agent, status, started_at')
            .eq('org_id', orgId)
            .in('status', ['QUEUED', 'DIALING_LEAD', 'ANSWERED', 'AMD_HUMAN', 'AMD_MACHINE', 'BRIDGED', 'dialing', 'originated', 'bridged']);
        if (campaign_id)
            callsQuery = callsQuery.eq('campaign_id', campaign_id);
        const [sessionsResult, callsResult] = await Promise.all([sessionsQuery, callsQuery]);
        return reply.send({
            agents: sessionsResult.data ?? [],
            live_calls: callsResult.data ?? [],
        });
    });
};
exports.dialerModule = dialerModule;
