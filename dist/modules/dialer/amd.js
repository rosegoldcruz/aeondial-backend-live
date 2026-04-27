"use strict";
/**
 * AMD (Answering Machine Detection) classifier.
 *
 * Integration model
 * ─────────────────
 * Asterisk's built-in AMD() dialplan app runs during call setup.
 * The dialplan posts results here via:
 *   CURL(${BACKEND_URL}/dialer/calls/${call_id}/amd_result, ...)
 *
 * This module:
 *   1. Validates and persists the AMD result to `call_events`.
 *   2. Updates the `calls` row with `amd_result`.
 *   3. Emits a `call.amd_result` WebSocket event to the org.
 *   4. Returns the classification so the dialer engine can route the call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAmdResult = parseAmdResult;
exports.recordAmdResult = recordAmdResult;
exports.amdDispatchAction = amdDispatchAction;
const supabase_1 = require("../../core/supabase");
const websocket_1 = require("../../core/websocket");
const logger_1 = require("../../core/logger");
const VALID_AMD_RESULTS = new Set(['HUMAN', 'MACHINE', 'NOTSURE', 'FAILED', 'TIMEOUT']);
function parseAmdResult(raw) {
    const upper = String(raw ?? '').toUpperCase().trim();
    return VALID_AMD_RESULTS.has(upper) ? upper : 'NOTSURE';
}
/**
 * Persist an AMD result and broadcast it over WebSocket.
 * Called from the `POST /dialer/calls/:id/amd_result` route.
 */
async function recordAmdResult(classification) {
    const { call_id, org_id, result, cause, duration_ms } = classification;
    // Fetch call to check org scope and get campaign_id
    const { data: call, error: fetchErr } = await supabase_1.supabase
        .from('calls')
        .select('call_id, org_id, campaign_id, status, metadata')
        .eq('call_id', call_id)
        .eq('org_id', org_id)
        .maybeSingle();
    if (fetchErr)
        throw new Error(`AMD result fetch error: ${fetchErr.message}`);
    if (!call)
        throw new Error(`Call ${call_id} not found`);
    const occurredAt = new Date().toISOString();
    // Persist call_event
    await supabase_1.supabase.from('call_events').insert({
        event_id: crypto.randomUUID(),
        org_id,
        call_id,
        event_type: 'amd_result',
        payload: { result, cause, duration_ms },
        occurred_at: occurredAt,
    });
    // Update calls.amd_result
    await supabase_1.supabase
        .from('calls')
        .update({
        amd_result: result,
        updated_at: occurredAt,
    })
        .eq('call_id', call_id)
        .eq('org_id', org_id);
    // Broadcast
    (0, websocket_1.emitOrgEvent)({
        type: 'call.amd_result',
        org_id,
        campaign_id: call.campaign_id ?? undefined,
        payload: {
            call_id,
            result,
            cause,
            duration_ms,
            occurred_at: occurredAt,
        },
    });
    logger_1.logger.info({ org_id, call_id, result, cause }, 'AMD result recorded');
}
/**
 * Determine how the dialer should handle a call after AMD runs.
 * Returns an action string consumed by the dialer engine.
 */
function amdDispatchAction(result) {
    switch (result) {
        case 'HUMAN':
            return 'bridge';
        case 'MACHINE':
            return 'voicemail';
        case 'NOTSURE':
            // Treat ambiguous result conservatively: bridge the agent and let them decide
            return 'bridge';
        case 'FAILED':
        case 'TIMEOUT':
            return 'hangup';
    }
}
