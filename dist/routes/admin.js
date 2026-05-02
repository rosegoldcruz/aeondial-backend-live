import { readFile } from 'fs/promises';
import { supabase } from '../lib/supabase.js';
const LOG_FILES = {
    apiOut: '/var/log/aeondial/api-out.log',
    apiErr: '/var/log/aeondial/api-error.log',
    workerOut: '/var/log/aeondial/worker-out-1.log',
    workerErr: '/var/log/aeondial/worker-error-1.log',
};
const TERMS = [
    'webhook',
    'AGENT_ANSWERED',
    'LEAD_DIAL',
    'OVERFLOW_IVR',
    'IVR_START_RESULT',
    'bridge',
    'bridged',
    'answered',
    'hangup',
    'TICKER',
    'WORKER',
    'Dialing agent',
    'Agent dial failed',
    'READY',
    'RESERVED',
    'D11',
    '480',
    'error',
    'failed',
];
function sanitize(line) {
    return line
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
        .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED]"')
        .replace(/"password"\s*:\s*"[^"]+"/gi, '"password":"[REDACTED]"')
        .replace(/TELNYX_API_KEY=[^\s]+/g, 'TELNYX_API_KEY=[REDACTED]')
        .slice(0, 2000);
}
async function readFiltered(path, limit = 120) {
    try {
        const raw = await readFile(path, 'utf8');
        return raw
            .split('\n')
            .filter(Boolean)
            .filter((line) => TERMS.some((term) => line.includes(term)))
            .slice(-limit)
            .map(sanitize);
    }
    catch (err) {
        return [`[live-trace] unable to read ${path}: ${err?.message ?? String(err)}`];
    }
}
async function requireAdmin(req, reply) {
    await req.jwtVerify();
    if (req.user?.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin only' });
    }
}
export async function adminRoutes(app) {
    app.get('/live-trace/snapshot', { onRequest: [requireAdmin] }, async () => {
        const [apiOut, apiErr, workerOut, workerErr, sessions, calls] = await Promise.all([
            readFiltered(LOG_FILES.apiOut),
            readFiltered(LOG_FILES.apiErr, 60),
            readFiltered(LOG_FILES.workerOut),
            readFiltered(LOG_FILES.workerErr, 60),
            supabase
                .from('agent_sessions')
                .select('agent_id,state,active_call_id,telnyx_client_state,last_ready_at,updated_at')
                .order('updated_at', { ascending: false })
                .limit(12),
            supabase
                .from('calls')
                .select('id,status,agent_id,lead_id,agent_leg_id,lead_leg_id,group_id,created_at,answered_at,bridged_at,ended_at,wrapped_at,disposition')
                .order('created_at', { ascending: false })
                .limit(12),
        ]);
        return {
            ts: new Date().toISOString(),
            api: [...apiOut, ...apiErr].slice(-160),
            worker: [...workerOut, ...workerErr].slice(-160),
            sessions: sessions.data ?? [],
            calls: calls.data ?? [],
        };
    });
}
