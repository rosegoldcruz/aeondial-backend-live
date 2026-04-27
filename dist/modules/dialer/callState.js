"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVE_PROGRESSIVE_CALL_STATES = void 0;
exports.isProgressiveCallState = isProgressiveCallState;
exports.getDialerCall = getDialerCall;
exports.recordDialerCallEvent = recordDialerCallEvent;
exports.transitionDialerCallState = transitionDialerCallState;
const supabase_1 = require("../../core/supabase");
const websocket_1 = require("../../core/websocket");
exports.ACTIVE_PROGRESSIVE_CALL_STATES = [
    'QUEUED',
    'DIALING_LEAD',
    'ANSWERED',
    'AMD_HUMAN',
    'AMD_MACHINE',
    'BRIDGED',
];
const TRANSITIONS = {
    QUEUED: ['DIALING_LEAD', 'FAILED', 'ABANDONED'],
    DIALING_LEAD: ['ANSWERED', 'FAILED', 'ABANDONED'],
    ANSWERED: ['AMD_HUMAN', 'AMD_MACHINE', 'FAILED', 'ABANDONED'],
    AMD_HUMAN: ['BRIDGED', 'FAILED', 'ENDED'],
    AMD_MACHINE: ['ENDED'],
    BRIDGED: ['ENDED', 'FAILED'],
    ENDED: ['DISPOSITIONED'],
    DISPOSITIONED: [],
    FAILED: [],
    ABANDONED: [],
};
function isProgressiveCallState(value) {
    return typeof value === 'string' && value in TRANSITIONS;
}
async function getDialerCall(callId, orgId) {
    const { data } = await supabase_1.supabase
        .from('calls')
        .select('call_id, org_id, campaign_id, lead_id, contact_id, assigned_agent, cl_id, status, started_at, ended_at, metadata')
        .eq('call_id', callId)
        .eq('org_id', orgId)
        .maybeSingle();
    return data ?? null;
}
async function recordDialerCallEvent(call, eventType, payload = {}, occurredAt = new Date().toISOString()) {
    await supabase_1.supabase.from('call_events').insert({
        event_id: crypto.randomUUID(),
        org_id: call.org_id,
        call_id: call.call_id,
        event_type: eventType,
        payload,
        occurred_at: occurredAt,
    });
    (0, websocket_1.emitOrgEvent)({
        type: 'call.event',
        org_id: call.org_id,
        campaign_id: call.campaign_id ?? undefined,
        payload: {
            action: eventType,
            call_id: call.call_id,
            ...payload,
            occurred_at: occurredAt,
        },
    });
}
async function transitionDialerCallState(call, toState, options = {}) {
    const fromState = isProgressiveCallState(call.status) ? call.status : null;
    if (fromState === toState && !options.allowSameState) {
        return call;
    }
    if (fromState && !TRANSITIONS[fromState].includes(toState) && !options.allowSameState) {
        throw new Error(`Invalid dialer call state transition: ${fromState} -> ${toState}`);
    }
    const occurredAt = options.occurredAt ?? new Date().toISOString();
    const mergedMetadata = {
        ...(call.metadata || {}),
        ...(options.metadataPatch || {}),
    };
    const patch = {
        status: toState,
        metadata: mergedMetadata,
        updated_at: occurredAt,
        ...(options.extraUpdates || {}),
    };
    if (toState === 'BRIDGED' && !call.started_at) {
        patch.started_at = occurredAt;
    }
    if ((toState === 'ENDED' || toState === 'FAILED' || toState === 'ABANDONED') && !call.ended_at) {
        patch.ended_at = occurredAt;
    }
    const { data, error } = await supabase_1.supabase
        .from('calls')
        .update(patch)
        .eq('call_id', call.call_id)
        .eq('org_id', call.org_id)
        .select('call_id, org_id, campaign_id, lead_id, contact_id, assigned_agent, cl_id, status, started_at, ended_at, metadata')
        .single();
    if (error) {
        throw new Error(`Failed updating dialer call ${call.call_id}: ${error.message}`);
    }
    const updated = data;
    await recordDialerCallEvent(updated, options.eventType ?? 'state.changed', {
        from_state: fromState,
        to_state: toState,
        ...(options.eventPayload || {}),
    }, occurredAt);
    return updated;
}
