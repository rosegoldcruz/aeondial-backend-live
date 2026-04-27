"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.websocketPlugin = void 0;
exports.emitOrgEvent = emitOrgEvent;
const orgSockets = new Map();
const orgPresence = new Map();
function emitToOrg(org_id, event) {
    const sockets = orgSockets.get(org_id);
    if (!sockets)
        return;
    const message = JSON.stringify(event);
    for (const socket of sockets) {
        if (socket.readyState === 1) {
            socket.send(message);
        }
    }
}
function emitOrgEvent(event) {
    emitToOrg(event.org_id, event);
}
const websocketPlugin = async (app) => {
    app.get('/ws', { websocket: true }, (socket, req) => {
        const headerOrg = req.org_id || req.headers['x-org-id'];
        const query = req.query;
        const org_id = query.org_id || headerOrg;
        if (!org_id) {
            socket.send(JSON.stringify({ error: 'org_id is required' }));
            socket.close();
            return;
        }
        const sockets = orgSockets.get(org_id) || new Set();
        sockets.add(socket);
        orgSockets.set(org_id, sockets);
        socket.send(JSON.stringify({
            type: 'ws.connected',
            org_id,
            payload: { active_clients: sockets.size },
        }));
        socket.on('message', (raw) => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            }
            catch {
                socket.send(JSON.stringify({ error: 'Invalid JSON message' }));
                return;
            }
            if (!event.org_id) {
                socket.send(JSON.stringify({ error: 'All events must include org_id' }));
                return;
            }
            if (event.org_id !== org_id) {
                socket.send(JSON.stringify({ error: 'Cross-tenant websocket event denied' }));
                return;
            }
            switch (event.type) {
                case 'agent.presence': {
                    const payload = event.payload || {};
                    const agent_id = payload.agent_id;
                    const status = payload.status;
                    if (!agent_id || !status) {
                        socket.send(JSON.stringify({ error: 'agent_id and status are required' }));
                        return;
                    }
                    const presenceByOrg = orgPresence.get(org_id) || new Map();
                    presenceByOrg.set(agent_id, { agent_id, status });
                    orgPresence.set(org_id, presenceByOrg);
                    emitToOrg(org_id, {
                        type: 'agent.presence',
                        org_id,
                        campaign_id: event.campaign_id,
                        payload: {
                            agent_id,
                            status,
                            total_agents: presenceByOrg.size,
                        },
                    });
                    return;
                }
                case 'agent.state':
                case 'agent.leg_live':
                case 'agent.leg_dropped':
                case 'call.event':
                case 'call.amd_result':
                case 'call.human_ready':
                case 'call.bridged':
                case 'call.wrap':
                case 'queue.metrics':
                case 'queue.lead_dialing':
                case 'queue.lead_answered':
                case 'queue.lead_abandoned':
                case 'ai.whisper':
                case 'supervisor.control':
                case 'campaign.paused':
                case 'campaign.infra_blocked':
                case 'wrap_up.started':
                case 'wrap_up.expiring':
                case 'wrap_up.expired': {
                    emitToOrg(org_id, {
                        type: event.type,
                        org_id,
                        campaign_id: event.campaign_id,
                        payload: event.payload || {},
                    });
                    return;
                }
                default:
                    socket.send(JSON.stringify({ error: 'Unsupported event type' }));
            }
        });
        socket.on('close', () => {
            const current = orgSockets.get(org_id);
            if (!current)
                return;
            current.delete(socket);
            if (current.size === 0) {
                orgSockets.delete(org_id);
            }
            emitToOrg(org_id, {
                type: 'queue.metrics',
                org_id,
                payload: { active_clients: current.size },
            });
        });
    });
};
exports.websocketPlugin = websocketPlugin;
