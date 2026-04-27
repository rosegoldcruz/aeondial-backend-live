"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAriEventService = startAriEventService;
const config_1 = require("./config");
const logger_1 = require("./logger");
const ws_1 = __importDefault(require("ws"));
const orchestrator_1 = require("../modules/dialer/orchestrator");
const callState_1 = require("../modules/dialer/callState");
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
function scheduleReconnect() {
    if (reconnectTimer)
        return;
    const delayMs = Math.min(30000, 1000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectAriEventSocket();
    }, delayMs);
}
function buildEventsUrl() {
    const base = config_1.config.ariUrl.replace(/\/$/, '');
    const url = new URL(`${base}/events`);
    url.searchParams.set('app', config_1.config.ariApp);
    url.searchParams.set('subscribeAll', 'true');
    url.searchParams.set('api_key', `${config_1.config.ariUsername}:${config_1.config.ariPassword}`);
    return url.toString().replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}
async function recordChannelEvent(event, eventType) {
    const channelId = event.channel?.id;
    if (!channelId)
        return;
    const call = await (0, orchestrator_1.findCallByChannelId)(channelId);
    if (!call)
        return;
    await (0, callState_1.recordDialerCallEvent)(call, eventType, {
        channel_id: channelId,
        channel_state: event.channel?.state || null,
        channel_name: event.channel?.name || null,
        ari_event: event.type || null,
    });
}
async function recordPlaybackEvent(event, eventType) {
    const playbackId = event.playback?.id;
    if (!playbackId)
        return;
    const call = await (0, orchestrator_1.findCallByPlaybackId)(playbackId);
    if (!call)
        return;
    await (0, callState_1.recordDialerCallEvent)(call, eventType, {
        playback_id: playbackId,
        target_uri: event.playback?.target_uri || null,
        media_uri: event.playback?.media_uri || null,
        ari_event: event.type || null,
    });
}
async function recordBridgeEvent(event, eventType) {
    const bridgeId = event.bridge?.id;
    if (!bridgeId)
        return;
    const call = await (0, orchestrator_1.findCallByBridgeId)(bridgeId);
    if (!call)
        return;
    await (0, callState_1.recordDialerCallEvent)(call, eventType, {
        bridge_id: bridgeId,
        bridge_type: event.bridge?.bridge_type || null,
        ari_event: event.type || null,
    });
}
async function handleAriEvent(event) {
    switch (event.type) {
        case 'StasisStart': {
            await recordChannelEvent(event, 'ari.stasis_start');
            const channelId = event.channel?.id;
            if (!channelId)
                return;
            // Determine channel role from appArgs
            const args = event.args || [];
            const role = typeof args[0] === 'string' ? args[0] : '';
            if (role === 'agent-leg') {
                // Agent answered their SIP phone — args: [agent-leg, session_id, org_id]
                const sessionId = typeof args[1] === 'string' ? args[1] : '';
                const orgId = typeof args[2] === 'string' ? args[2] : '';
                if (sessionId && orgId) {
                    await (0, orchestrator_1.handleAgentLegAnswered)(channelId, sessionId, orgId).catch((err) => {
                        logger_1.logger.error({ err, channel_id: channelId, session_id: sessionId }, 'Failed handling agent-leg StasisStart');
                    });
                }
                else {
                    logger_1.logger.warn({ channel_id: channelId, args }, 'agent-leg StasisStart missing session_id/org_id in appArgs');
                }
                return;
            }
            if (role === 'lead-leg' || role === 'dialer') {
                // Lead answered — args: [lead-leg, call_id, org_id, bridge_id]
                if (event.channel?.state === 'Up') {
                    await (0, orchestrator_1.handleLeadChannelAnswered)(channelId).catch((err) => {
                        logger_1.logger.error({ err, channel_id: channelId }, 'Failed handling lead-leg StasisStart');
                    });
                }
                return;
            }
            // Unknown role — attempt both handlers (graceful fallback for unlabeled channels)
            if (event.channel?.state === 'Up') {
                await (0, orchestrator_1.handleLeadChannelAnswered)(channelId).catch(() => undefined);
            }
            return;
        }
        case 'ChannelStateChange': {
            await recordChannelEvent(event, 'ari.channel_state');
            return;
        }
        case 'ChannelEnteredBridge':
            await recordChannelEvent(event, 'ari.channel_entered_bridge');
            return;
        case 'ChannelLeftBridge':
            await recordChannelEvent(event, 'ari.channel_left_bridge');
            return;
        case 'PlaybackFinished': {
            await recordPlaybackEvent(event, 'ari.playback_finished');
            // Note: PlaybackFinished/beep bridge finalization removed in agent-first model
            // AMD alert beep is no longer used in progressive mode
            return;
        }
        case 'ChannelHangupRequest': {
            await recordChannelEvent(event, 'ari.hangup_request');
            if (event.channel?.id) {
                const channelId = event.channel.id;
                // Call-side hangup fires on HangupRequest to start wrap-up promptly.
                // Agent-leg cleanup is intentionally deferred to ChannelDestroyed — the
                // agent SIP channel is still physically alive when a HangupRequest fires
                // (BYE is in-flight). Clearing DB state here causes the UI to spin even
                // though the call is still connected.
                await (0, orchestrator_1.handleCallChannelHangup)(channelId, event.cause_txt || 'hangup_request').catch((err) => {
                    logger_1.logger.error({ err, channel_id: channelId }, 'Failed handling call channel hangup (HangupRequest)');
                });
            }
            return;
        }
        case 'ChannelDestroyed': {
            await recordChannelEvent(event, 'ari.channel_destroyed');
            if (event.channel?.id) {
                const channelId = event.channel.id;
                // Agent-leg cleanup: channel is definitively gone.
                await (0, orchestrator_1.handleAgentLegHangup)(channelId).catch((err) => {
                    logger_1.logger.error({ err, channel_id: channelId }, 'Failed handling agent-leg hangup (ChannelDestroyed)');
                });
                // Call-side cleanup: idempotent if already handled on HangupRequest.
                await (0, orchestrator_1.handleCallChannelHangup)(channelId, event.cause_txt || 'channel_destroyed').catch((err) => {
                    logger_1.logger.error({ err, channel_id: channelId }, 'Failed handling call channel hangup (ChannelDestroyed)');
                });
            }
            return;
        }
        case 'BridgeDestroyed':
            await recordBridgeEvent(event, 'ari.bridge_destroyed');
            return;
        default:
            return;
    }
}
async function connectAriEventSocket() {
    if (!config_1.config.ariUrl || !config_1.config.ariUsername || !config_1.config.ariPassword) {
        logger_1.logger.warn('ARI event service disabled: missing ARI configuration');
        return;
    }
    if (socket && socket.readyState === ws_1.default.OPEN) {
        return;
    }
    const url = buildEventsUrl();
    socket = new ws_1.default(url);
    socket.on('open', () => {
        reconnectAttempt = 0;
        logger_1.logger.info({ url, app: config_1.config.ariApp }, 'Connected to ARI event socket');
    });
    socket.on('message', (message) => {
        let event;
        try {
            event = JSON.parse(message.toString());
        }
        catch (error) {
            logger_1.logger.warn({ error }, 'Ignoring malformed ARI websocket message');
            return;
        }
        void handleAriEvent(event).catch((error) => {
            logger_1.logger.error({ error, event_type: event.type }, 'Unhandled ARI event processing error');
        });
    });
    socket.on('error', (error) => {
        logger_1.logger.error({ error }, 'ARI websocket error');
    });
    socket.on('close', () => {
        logger_1.logger.warn('ARI websocket closed; scheduling reconnect');
        scheduleReconnect();
    });
}
function startAriEventService() {
    void connectAriEventSocket();
}
