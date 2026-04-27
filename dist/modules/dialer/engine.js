"use strict";
/**
 * Progressive Auto-Dialer Engine
 * ───────────────────────────────
 * BullMQ-based queue that paces outbound calls for campaigns.
 *
 * Dialing model (1:1 progressive)
 * ──────────────────────────────────
 * One call is placed per READY agent.  When a call is answered as HUMAN:
 *   1. The lead channel is bridged to the agent's channel.
 *   2. Agent state moves RESERVED → INCALL.
 * When AMD=MACHINE or call is not answered:
 *   1. Optionally play a voicemail drop, then hangup lead channel.
 *   2. Agent state moves RESERVED → READY so the next dial can start.
 *
 * Job payload shape  (DialerJobData)
 * ────────────────────────────────────
 *   org_id, campaign_id, cl_id, lead_id, contact_id, phone, session_id, attempt
 *
 * Queue names
 * ────────────────────────────────────
 *   dialer:<org_id>:<campaign_id>   – per-campaign queue for isolation
 *   (all share the same Redis connection)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDialerQueue = getDialerQueue;
exports.seedDialerQueue = seedDialerQueue;
exports.drainDialerQueue = drainDialerQueue;
exports.startDialerWorker = startDialerWorker;
exports.stopDialerWorker = stopDialerWorker;
const bullmq_1 = require("bullmq");
const redis_1 = require("../../core/redis");
const supabase_1 = require("../../core/supabase");
const ari_1 = require("../../core/ari");
const websocket_1 = require("../../core/websocket");
const logger_1 = require("../../core/logger");
const agentState_1 = require("./agentState");
const orchestrator_1 = require("./orchestrator");
const callState_1 = require("./callState");
// ── Infra-failure classification ──────────────────────────────────────────────
// ARI HTTP codes that indicate the SIP trunk / Asterisk / session is unavailable
// (NOT a real lead outcome). These must NOT increment lead attempt count or mark
// the lead failed — they are system-side rejections.
const INFRA_ARI_STATUSES = new Set([0, 400, 500, 502, 503, 504]);
const INFRA_ARI_MESSAGES = [
    'connection refused', 'econnrefused', 'enotfound', 'timeout', 'etimedout',
    'service unavailable', 'bad gateway', 'channel not found', 'unknown endpoint',
    'no such endpoint', 'cannot create channel', 'request timeout',
];
function isInfraFailure(err) {
    if (err instanceof ari_1.AriRequestError) {
        if (INFRA_ARI_STATUSES.has(err.status))
            return true;
        const msg = (err.message || '').toLowerCase();
        return INFRA_ARI_MESSAGES.some((pat) => msg.includes(pat));
    }
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        return INFRA_ARI_MESSAGES.some((pat) => msg.includes(pat));
    }
    return false;
}
/** Structured audit record written to campaign_leads.metadata.infra_failure_log */
async function recordInfraFailureAudit(args) {
    const { clId, orgId, campaignId, leadId, agentId, sessionId, endpoint, rejectionSource, rejectionReason, callId } = args;
    logger_1.logger.warn({
        category: 'INFRA_FAILURE',
        lead_state_changed: false,
        org_id: orgId,
        campaign_id: campaignId,
        lead_id: leadId,
        cl_id: clId,
        call_id: callId,
        agent_id: agentId,
        session_id: sessionId,
        endpoint,
        rejection_source: rejectionSource,
        rejection_reason: rejectionReason,
    }, '[INFRA_BLOCK] ARI originate rejected by infrastructure — lead NOT consumed');
    // Append to metadata.infra_failure_log — does NOT touch attempts or dial_state
    const { data: row } = await supabase_1.supabase
        .from('campaign_leads')
        .select('metadata')
        .eq('cl_id', clId)
        .eq('org_id', orgId)
        .maybeSingle();
    const existing = (row?.metadata ?? {});
    const log = Array.isArray(existing.infra_failure_log) ? existing.infra_failure_log : [];
    log.push({
        at: new Date().toISOString(),
        call_id: callId,
        agent_id: agentId,
        session_id: sessionId,
        endpoint,
        rejection_source: rejectionSource,
        rejection_reason: rejectionReason,
    });
    const infraFailureCount = typeof existing.infra_failure_count === 'number'
        ? existing.infra_failure_count + 1
        : 1;
    await supabase_1.supabase
        .from('campaign_leads')
        .update({
        metadata: {
            ...existing,
            infra_failure_log: log,
            infra_failure_count: infraFailureCount,
            last_infra_failure_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
    })
        .eq('cl_id', clId)
        .eq('org_id', orgId);
}
/** Auto-pause a campaign and drain the queue immediately */
async function pauseCampaignOnInfraFailure(orgId, campaignId, reason) {
    logger_1.logger.error({ org_id: orgId, campaign_id: campaignId, reason }, '[INFRA_AUTOPAUSE] Pausing campaign due to infrastructure failure');
    await supabase_1.supabase
        .from('campaigns')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('campaign_id', campaignId)
        .eq('org_id', orgId);
    (0, websocket_1.emitOrgEvent)({
        type: 'campaign.paused',
        org_id: orgId,
        campaign_id: campaignId,
        payload: { reason: 'infra_failure', detail: reason, auto_paused: true },
    });
    await drainDialerQueue(orgId, campaignId);
    await stopDialerWorker(orgId, campaignId);
}
// ── Queue factory ─────────────────────────────────────────────────────────────
const dialerQueues = new Map();
function queueName(orgId, campaignId) {
    return `dialer__${orgId}__${campaignId}`;
}
function getDialerQueue(orgId, campaignId) {
    const name = queueName(orgId, campaignId);
    if (!dialerQueues.has(name)) {
        dialerQueues.set(name, new bullmq_1.Queue(name, { connection: redis_1.bullConnection }));
    }
    return dialerQueues.get(name);
}
/**
 * Add the next batch of leads to the dialer queue.
 * Called when a campaign starts or when the queue drains below a threshold.
 * Returns how many leads were enqueued.
 */
async function seedDialerQueue(orgId, campaignId, batchSize = 50) {
    const { data: leads, error } = await supabase_1.supabase
        .from('v_dialer_queue')
        .select('cl_id, lead_id, contact_id, phone, priority')
        .eq('org_id', orgId)
        .eq('campaign_id', campaignId)
        .limit(batchSize);
    if (error) {
        logger_1.logger.error({ error, org_id: orgId, campaign_id: campaignId }, 'Failed to seed dialer queue');
        return 0;
    }
    if (!leads || leads.length === 0)
        return 0;
    const queue = getDialerQueue(orgId, campaignId);
    let enqueued = 0;
    for (const lead of leads) {
        // Mark lead as 'dialing' to prevent double-dial
        const { error: updateErr } = await supabase_1.supabase
            .from('campaign_leads')
            .update({ dial_state: 'dialing', updated_at: new Date().toISOString() })
            .eq('cl_id', lead.cl_id)
            .eq('org_id', orgId)
            .eq('dial_state', 'pending'); // Only if still pending (idempotent guard)
        if (updateErr)
            continue;
        // Create a placeholder call row
        const callId = crypto.randomUUID();
        await supabase_1.supabase.from('calls').insert({
            call_id: callId,
            org_id: orgId,
            campaign_id: campaignId,
            contact_id: lead.contact_id,
            lead_id: lead.lead_id,
            cl_id: lead.cl_id,
            direction: 'outbound',
            status: 'QUEUED',
            created_by: 'dialer',
            updated_by: 'dialer',
        });
        await queue.add('dial', {
            org_id: orgId,
            campaign_id: campaignId,
            cl_id: lead.cl_id,
            lead_id: lead.lead_id,
            contact_id: lead.contact_id,
            phone: lead.phone,
            session_id: '', // filled at dispatch time
            call_id: callId,
            attempt: 1,
        }, {
            attempts: 1, // handled at application level; do not auto-retry
            removeOnComplete: { age: 60 * 60 * 24 }, // keep 24h
            removeOnFail: { age: 60 * 60 * 24 * 7 },
            priority: lead.priority ?? 0,
        });
        enqueued++;
    }
    logger_1.logger.info({ org_id: orgId, campaign_id: campaignId, enqueued }, 'Dialer queue seeded');
    return enqueued;
}
/**
 * Drain (cancel) all pending jobs for a campaign.
 */
async function drainDialerQueue(orgId, campaignId) {
    const queue = getDialerQueue(orgId, campaignId);
    await queue.drain();
    // Return any 'dialing' leads back to 'pending' so they can be re-queued after restart
    await supabase_1.supabase
        .from('campaign_leads')
        .update({ dial_state: 'pending', updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('campaign_id', campaignId)
        .eq('dial_state', 'dialing');
    logger_1.logger.info({ org_id: orgId, campaign_id: campaignId }, 'Dialer queue drained');
}
// ── Worker process ─────────────────────────────────────────────────────────────
const activeWorkers = new Map();
function startDialerWorker(orgId, campaignId) {
    const name = queueName(orgId, campaignId);
    if (activeWorkers.has(name))
        return; // already running
    // Progressive dialing: always 1 concurrent call per worker
    // One agent, one lead at a time — no parallel dials
    const concurrency = 1;
    const rateLimitMax = 1;
    const rateLimitDuration = 2000;
    logger_1.logger.info({ org_id: orgId, campaign_id: campaignId }, 'Dialer worker started: concurrency=1 (progressive agent-first mode)');
    const worker = new bullmq_1.Worker(name, async (job) => processDialerJob(job), {
        connection: redis_1.bullConnection,
        concurrency,
        limiter: {
            max: rateLimitMax,
            duration: rateLimitDuration,
        },
    });
    worker.on('failed', (job, err) => {
        logger_1.logger.error({ queue: name, jobId: job?.id, err }, 'Dialer job failed');
    });
    worker.on('completed', async (job) => {
        const { org_id, campaign_id } = job.data;
        // Re-seed when queue starts to empty (< 20 jobs remaining)
        const waiting = await getDialerQueue(org_id, campaign_id).getWaitingCount();
        if (waiting < 20) {
            await seedDialerQueue(org_id, campaign_id, 50);
        }
    });
    activeWorkers.set(name, worker);
    logger_1.logger.info({ org_id: orgId, campaign_id: campaignId }, 'Dialer worker started');
}
async function stopDialerWorker(orgId, campaignId) {
    const name = queueName(orgId, campaignId);
    const worker = activeWorkers.get(name);
    if (!worker)
        return;
    await worker.close();
    activeWorkers.delete(name);
    logger_1.logger.info({ org_id: orgId, campaign_id: campaignId }, 'Dialer worker stopped');
}
// ── Job processor ─────────────────────────────────────────────────────────────
async function processDialerJob(job) {
    const { org_id, campaign_id, cl_id, lead_id, contact_id, phone, call_id, attempt } = job.data;
    logger_1.logger.info({ org_id, campaign_id, cl_id, call_id, attempt }, 'Dialer job started');
    // 1. Reserve an available agent
    const session = await (0, agentState_1.reserveNextAgent)(org_id, campaign_id);
    if (!session) {
        // No agent available: return lead to pending and emit queue metric
        await releaseCampaignLead(cl_id, org_id, 'pending');
        const abandonedCall = await (0, callState_1.getDialerCall)(call_id, org_id);
        if (abandonedCall) {
            await (0, callState_1.transitionDialerCallState)(abandonedCall, 'ABANDONED', {
                eventType: 'queue.lead_abandoned',
                metadataPatch: { abandon_reason: 'no_agent' },
                eventPayload: { reason: 'no_agent' },
            }).catch(() => undefined);
        }
        (0, websocket_1.emitOrgEvent)({
            type: 'queue.lead_abandoned',
            org_id,
            campaign_id,
            payload: { call_id, cl_id, reason: 'no_agent_available', attempt },
        });
        logger_1.logger.warn({ org_id, campaign_id, cl_id }, 'No ready agent; lead returned to queue');
        return;
    }
    const sessionId = session.session_id;
    const agentId = session.agent_id;
    // Emit lead-dialing event
    (0, websocket_1.emitOrgEvent)({
        type: 'queue.lead_dialing',
        org_id,
        campaign_id,
        payload: { call_id, cl_id, phone, agent_id: agentId, session_id: sessionId, attempt },
    });
    // 2. Resolve outbound endpoint
    const endpoint = (0, orchestrator_1.resolveOutboundEndpoint)(phone);
    const leadSnapshot = await resolveLeadSnapshot(org_id, contact_id, lead_id);
    // Update call row with assigned agent
    const queuedCall = await (0, callState_1.getDialerCall)(call_id, org_id);
    if (!queuedCall) {
        await releaseCampaignLead(cl_id, org_id, 'pending');
        await (0, agentState_1.transitionAgentState)(sessionId, org_id, 'READY', { reason: 'call_missing' });
        return;
    }
    const dialingCallState = await (0, callState_1.transitionDialerCallState)(queuedCall, 'DIALING_LEAD', {
        eventType: 'queue.lead_dialing',
        metadataPatch: (0, orchestrator_1.buildDialerCallMetadata)({
            session_id: sessionId,
            agent_id: agentId,
            endpoint,
            attempt,
            cl_id,
            phone,
            lead_name: leadSnapshot.lead_name,
            contact_name: leadSnapshot.contact_name,
        }),
        extraUpdates: {
            assigned_agent: agentId,
        },
        eventPayload: {
            phone,
            agent_id: agentId,
            session_id: sessionId,
            attempt,
            cl_id,
        },
    });
    // Update campaign_lead attempts and last_called_at
    await supabase_1.supabase
        .from('campaign_leads')
        .update({
        attempts: attempt,
        last_called_at: new Date().toISOString(),
        last_call_id: call_id,
        assigned_agent: agentId,
    })
        .eq('cl_id', cl_id)
        .eq('org_id', org_id);
    // Create dialer_call_attempts row (canonical per-attempt record)
    const callAttemptId = crypto.randomUUID();
    const callerIdNumber = await resolveCallerId(org_id, campaign_id);
    const { error: attemptErr } = await supabase_1.supabase.from('dialer_call_attempts').insert({
        id: callAttemptId,
        org_id,
        campaign_id,
        lead_id,
        cl_id,
        call_id,
        agent_user_id: agentId,
        agent_endpoint: endpoint,
        session_id: sessionId,
        provider: 'asterisk',
        to_number: phone,
        from_number: callerIdNumber ?? null,
        system_outcome: 'originated',
    });
    if (attemptErr) {
        logger_1.logger.error({ error: attemptErr, call_id, call_attempt_id: callAttemptId }, 'Failed to create dialer_call_attempts row');
    }
    // Store attempt_id in call metadata for later wrap-up linking
    await (0, callState_1.transitionDialerCallState)(dialingCallState, 'DIALING_LEAD', {
        allowSameState: true,
        eventType: 'attempt.created',
        metadataPatch: { call_attempt_id: callAttemptId },
    });
    // Update campaign_leads with active_call_attempt_id
    await supabase_1.supabase
        .from('campaign_leads')
        .update({ active_call_attempt_id: callAttemptId })
        .eq('cl_id', cl_id)
        .eq('org_id', org_id);
    // ── 2b. Validate agent has a live SIP channel (agent-first model) ───────────
    const agentChannelId = session.channel_id;
    const waitingBridgeId = session.waiting_bridge_id;
    if (!agentChannelId) {
        logger_1.logger.warn({ org_id, campaign_id, session_id: sessionId, agent_id: agentId }, '[AGENT_FIRST] Agent has no live channel — releasing lead and resetting agent to READY');
        await releaseCampaignLead(cl_id, org_id, 'pending');
        const callToAbandon = await (0, callState_1.getDialerCall)(call_id, org_id);
        if (callToAbandon) {
            await (0, callState_1.transitionDialerCallState)(callToAbandon, 'ABANDONED', {
                eventType: 'queue.lead_abandoned',
                metadataPatch: { abandon_reason: 'no_agent_channel' },
                eventPayload: { reason: 'no_agent_channel' },
            }).catch(() => undefined);
        }
        await (0, agentState_1.transitionAgentState)(sessionId, org_id, 'READY', { reason: 'no_agent_channel' });
        return;
    }
    // ── 2c. Create call bridge and add agent ─────────────────────────────────────
    const callBridgeId = `call-bridge-${call_id}`;
    try {
        await ari_1.ARI.bridges.create(callBridgeId, 'mixing');
    }
    catch (err) {
        // 409 = already exists (shouldn't happen but tolerate)
        if (!(err instanceof ari_1.AriRequestError && err.status === 409)) {
            throw err;
        }
    }
    // Remove agent from waiting bridge
    if (waitingBridgeId) {
        await ari_1.ARI.bridges.removeChannel(waitingBridgeId, [agentChannelId]).catch(() => { });
    }
    // Add agent to call bridge — agent is now waiting for lead
    try {
        await ari_1.ARI.bridges.addChannel(callBridgeId, [agentChannelId]);
    }
    catch (bridgeErr) {
        // Failed to put agent in bridge — treat as infra failure
        logger_1.logger.error({ err: bridgeErr, call_id, agent_channel: agentChannelId, bridge_id: callBridgeId }, 'Failed to add agent to call bridge');
        await ari_1.ARI.bridges.destroy(callBridgeId).catch(() => { });
        // Return agent to waiting bridge
        if (waitingBridgeId) {
            await ari_1.ARI.bridges.addChannel(waitingBridgeId, [agentChannelId]).catch(() => { });
        }
        await releaseCampaignLead(cl_id, org_id, 'pending');
        await (0, agentState_1.transitionAgentState)(sessionId, org_id, 'READY', { reason: 'bridge_setup_failed' });
        return;
    }
    // ── Store bridge_id in call metadata before originate ─────────────────────
    await (0, callState_1.transitionDialerCallState)(dialingCallState, 'DIALING_LEAD', {
        allowSameState: true,
        eventType: 'call.bridge_created',
        metadataPatch: {
            call_bridge_id: callBridgeId,
            agent_channel_id: agentChannelId,
        },
    });
    // 3. Originate lead — no AMD; lead goes directly to Stasis
    let ariChannelId;
    try {
        const ariChannel = await ari_1.ARI.channels.originate({
            debugContext: 'dialer.lead',
            endpoint,
            callerId: callerIdNumber,
            channelId: call_id,
            appArgs: `lead-leg,${call_id},${org_id},${callBridgeId}`,
            timeout: 30,
            variables: {
                DIALER_CALL_ID: call_id,
                DIALER_ORG_ID: org_id,
                DIALER_CAMPAIGN_ID: campaign_id,
                DIALER_CL_ID: cl_id,
                DIALER_BRIDGE_ID: callBridgeId,
                DIALER_BACKEND_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:4000',
                DIALER_CHANNEL_ROLE: 'lead',
                // AMD_ENABLED intentionally absent — agent-first progressive mode
            },
        });
        ariChannelId =
            ariChannel && typeof ariChannel === 'object' && 'id' in ariChannel && ariChannel.id
                ? ariChannel.id
                : call_id;
        const dialingCall = await (0, callState_1.getDialerCall)(call_id, org_id);
        if (dialingCall) {
            await (0, callState_1.transitionDialerCallState)(dialingCall, 'DIALING_LEAD', {
                allowSameState: true,
                eventType: 'lead.originated',
                metadataPatch: {
                    lead_channel_id: ariChannelId,
                    ari_channel_id: ariChannelId,
                },
                eventPayload: {
                    ari_channel_id: ariChannelId,
                    endpoint,
                },
            });
        }
    }
    catch (err) {
        // ── ARI originate failed: clean up bridge and classify error ────────────
        // Bridge was created before originate — must destroy on failure to not orphan
        await ari_1.ARI.bridges.destroy(callBridgeId).catch(() => { });
        // Return agent to their waiting bridge
        if (waitingBridgeId) {
            await ari_1.ARI.bridges.addChannel(waitingBridgeId, [agentChannelId]).catch(() => { });
        }
        const ariStatus = err instanceof ari_1.AriRequestError ? err.status : 0;
        const errMsg = err instanceof Error ? err.message : String(err);
        const errPayload = err instanceof ari_1.AriRequestError
            ? { message: err.message, status: err.status, response: err.responseText }
            : { message: errMsg };
        const infraFailure = isInfraFailure(err);
        const rejectionSource = err instanceof ari_1.AriRequestError ? 'ari' : 'network';
        const rejectionReason = `${rejectionSource}:${ariStatus || 'error'}:${errMsg.slice(0, 120)}`;
        const currentCall = await (0, callState_1.getDialerCall)(call_id, org_id);
        if (infraFailure) {
            // ── INFRA FAILURE: do NOT mark lead failed, do NOT increment attempts ──
            await recordInfraFailureAudit({
                clId: cl_id, orgId: org_id, campaignId: campaign_id, leadId: lead_id,
                agentId, sessionId, endpoint, rejectionSource, rejectionReason, callId: call_id,
            });
            // Return lead to pending (no attempt increment)
            await releaseCampaignLead(cl_id, org_id, 'pending');
            // Mark call as system_blocked (not FAILED)
            if (currentCall) {
                await (0, callState_1.transitionDialerCallState)(currentCall, 'FAILED', {
                    eventType: 'lead.infra_blocked',
                    metadataPatch: {
                        ari_error: errPayload,
                        infra_blocked: true,
                        rejection_source: rejectionSource,
                        rejection_reason: rejectionReason,
                    },
                    eventPayload: { ari_error: errPayload, infra_blocked: true },
                }).catch(() => undefined);
            }
            await (0, agentState_1.transitionAgentState)(sessionId, org_id, 'READY', { reason: 'infra_blocked' });
            (0, websocket_1.emitOrgEvent)({
                type: 'campaign.infra_blocked',
                org_id,
                campaign_id,
                payload: { call_id, cl_id, rejection_source: rejectionSource,
                    rejection_reason: rejectionReason, lead_state_changed: false },
            });
            // Auto-pause campaign: infra failed, no point burning more leads
            await pauseCampaignOnInfraFailure(org_id, campaign_id, rejectionReason);
            return;
        }
        // ── REAL lead failure (ring no-answer, busy, etc.) ──────────────────────
        if (currentCall) {
            await (0, callState_1.transitionDialerCallState)(currentCall, 'FAILED', {
                eventType: 'lead.originate_failed',
                metadataPatch: {
                    ari_error: errPayload,
                    infra_blocked: false,
                    rejection_source: rejectionSource,
                    rejection_reason: rejectionReason,
                },
                eventPayload: { ari_error: errPayload },
            }).catch(() => undefined);
        }
        await releaseCampaignLead(cl_id, org_id, 'failed');
        await (0, agentState_1.transitionAgentState)(sessionId, org_id, 'READY', { reason: 'originate_failed' });
        logger_1.logger.error({ org_id, campaign_id, cl_id, call_id, err: errPayload,
            rejection_source: rejectionSource, rejection_reason: rejectionReason }, '[LEAD_FAILURE] ARI originate failed (real lead outcome)');
        return;
    }
    // 4. Lead channel is now in Stasis. On StasisStart, ariEvents routes to
    //    handleLeadChannelAnswered() which adds the lead to callBridgeId.
    //    Agent is already in the bridge. Both parties talk with no AMD delay.
    logger_1.logger.info({ org_id, campaign_id, cl_id, call_id, ari_channel_id: ariChannelId,
        agent_id: agentId, call_bridge_id: callBridgeId }, 'Dialer job: call originated, awaiting lead answer');
}
// ── Helpers ───────────────────────────────────────────────────────────────────
async function releaseCampaignLead(clId, orgId, dialState) {
    await supabase_1.supabase
        .from('campaign_leads')
        .update({
        dial_state: dialState,
        updated_at: new Date().toISOString(),
    })
        .eq('cl_id', clId)
        .eq('org_id', orgId);
}
async function resolveCallerId(orgId, campaignId) {
    const { data } = await supabase_1.supabase
        .from('phone_numbers')
        .select('e164')
        .eq('org_id', orgId)
        .eq('campaign_id', campaignId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
    return data?.e164 ?? undefined;
}
async function resolveLeadSnapshot(orgId, contactId, leadId) {
    let contactName = null;
    if (contactId) {
        const { data: contact } = await supabase_1.supabase
            .from('contacts')
            .select('first_name, last_name')
            .eq('contact_id', contactId)
            .eq('org_id', orgId)
            .maybeSingle();
        contactName = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ').trim() || null;
    }
    const { data: lead } = await supabase_1.supabase
        .from('leads')
        .select('metadata')
        .eq('lead_id', leadId)
        .eq('org_id', orgId)
        .maybeSingle();
    const leadMeta = (lead?.metadata || {});
    const leadNameValue = leadMeta.lead_name ?? leadMeta.name;
    const leadName = typeof leadNameValue === 'string' && leadNameValue.trim() ? leadNameValue : null;
    return {
        lead_name: leadName,
        contact_name: contactName,
    };
}
