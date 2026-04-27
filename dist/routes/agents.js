import { supabase } from '../lib/supabase.js';
export async function agentRoutes(app) {
    app.get('/', { onRequest: [app.authenticate] }, async (_req, reply) => {
        const { data, error } = await supabase
            .from('agents')
            .select('id, name, username, role, is_active, telnyx_sip_username')
            .order('name');
        if (error)
            return reply.status(500).send({ error: error.message });
        const today = new Date().toISOString().slice(0, 10);
        const { data: callCounts } = await supabase
            .from('calls')
            .select('agent_id, duration_seconds')
            .gte('started_at', today)
            .not('agent_id', 'is', null);
        const agentMap = {};
        for (const c of (callCounts ?? [])) {
            if (!agentMap[c.agent_id])
                agentMap[c.agent_id] = { calls: 0, totalSecs: 0 };
            agentMap[c.agent_id].calls++;
            agentMap[c.agent_id].totalSecs += c.duration_seconds ?? 0;
        }
        const { data: sessions } = await supabase
            .from('agent_sessions')
            .select('agent_id, state, telnyx_client_state, active_call_id');
        const sessionMap = new Map((sessions ?? []).map((s) => [s.agent_id, s]));
        const onDialerStates = new Set(['READY', 'RESERVED', 'IN_CALL', 'WRAP_UP']);
        const agents = (data ?? []).map((a) => {
            const session = sessionMap.get(a.id);
            return {
                id: a.id,
                name: a.name,
                username: a.username,
                role: a.role,
                active: onDialerStates.has(session?.state ?? ''),
                enabled: a.is_active,
                session_state: session?.state ?? 'OFFLINE',
                telnyx_client_state: session?.telnyx_client_state ?? null,
                active_call_id: session?.active_call_id ?? null,
                telnyx_sip_username: a.telnyx_sip_username,
                calls_today: agentMap[a.id]?.calls ?? 0,
                talk_time_seconds: agentMap[a.id]?.totalSecs ?? 0,
            };
        });
        return reply.send({ agents });
    });
    app.get('/stats', { onRequest: [app.authenticate] }, async (_req, reply) => {
        const today = new Date().toISOString().slice(0, 10);
        const { data: agents, error: agentError } = await supabase
            .from('agents')
            .select('id, name, role, is_active')
            .order('name');
        if (agentError)
            return reply.status(500).send({ error: agentError.message });
        const { data: calls } = await supabase
            .from('calls')
            .select('agent_id, duration_seconds, disposition')
            .gte('started_at', today)
            .not('agent_id', 'is', null);
        const map = {};
        for (const c of (calls ?? [])) {
            if (!map[c.agent_id])
                map[c.agent_id] = { calls: 0, demos: 0, secs: 0 };
            map[c.agent_id].calls++;
            map[c.agent_id].secs += c.duration_seconds ?? 0;
            if (c.disposition === 'Interested')
                map[c.agent_id].demos++;
        }
        const { data: sessions } = await supabase
            .from('agent_sessions')
            .select('agent_id, state, telnyx_client_state, active_call_id');
        const sessionMap = new Map((sessions ?? []).map((s) => [s.agent_id, s]));
        const onDialerStates = new Set(['READY', 'RESERVED', 'IN_CALL', 'WRAP_UP']);
        const enriched = (agents ?? []).map((a) => {
            const session = sessionMap.get(a.id);
            return {
                id: a.id,
                name: a.name,
                role: a.role,
                active: onDialerStates.has(session?.state ?? ''),
                enabled: a.is_active,
                session_state: session?.state ?? 'OFFLINE',
                telnyx_client_state: session?.telnyx_client_state ?? null,
                active_call_id: session?.active_call_id ?? null,
                calls_today: map[a.id]?.calls ?? 0,
                demos_today: map[a.id]?.demos ?? 0,
                talk_time_seconds: map[a.id]?.secs ?? 0,
                conversion_rate: map[a.id]?.calls
                    ? `${((map[a.id].demos / map[a.id].calls) * 100).toFixed(1)}%`
                    : '0.0%',
            };
        });
        const totalCalls = enriched.reduce((s, a) => s + a.calls_today, 0);
        const totalDemos = enriched.reduce((s, a) => s + a.demos_today, 0);
        const totalSecs = enriched.reduce((s, a) => s + a.talk_time_seconds, 0);
        return reply.send({
            agents: enriched,
            totals: {
                calls: totalCalls,
                demos: totalDemos,
                avg_talk_seconds: enriched.length ? Math.round(totalSecs / enriched.length) : 0,
                utilization: totalCalls > 0 && enriched.length ? Math.min(99, Math.round((totalSecs / (enriched.length * 28800)) * 100)) : 0,
            },
        });
    });
}
