"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiModule = void 0;
const supabase_1 = require("../../core/supabase");
const AI_EVENT_TYPES = [
    'transcript',
    'summary',
    'disposition',
    'appointment',
    'transfer',
    'error',
];
const DEFAULT_AI_SETTINGS = {
    llm_provider: 'openai',
    tts_provider: 'elevenlabs',
    stt_provider: 'openai',
    voice_id: 'default',
    model_id: 'gpt-4.1-mini',
};
function isAiEventType(value) {
    return typeof value === 'string' && AI_EVENT_TYPES.includes(value);
}
const aiModule = async (app) => {
    app.get('/settings', async (req, reply) => {
        const { org_id, campaign_id } = req.query;
        if (!org_id) {
            return reply.status(400).send({ error: 'org_id is required' });
        }
        if (!req.org_id || req.org_id !== org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        let settingsRow = null;
        if (campaign_id) {
            const { data: campaignRow, error: campaignErr } = await supabase_1.supabase
                .from('ai_settings')
                .select('llm_provider, tts_provider, stt_provider, voice_id, model_id')
                .eq('org_id', org_id)
                .eq('campaign_id', campaign_id)
                .eq('is_active', true)
                .maybeSingle();
            if (campaignErr) {
                return reply.status(500).send({ error: campaignErr.message });
            }
            settingsRow = campaignRow;
        }
        if (!settingsRow) {
            const { data: orgRow, error: orgErr } = await supabase_1.supabase
                .from('ai_settings')
                .select('llm_provider, tts_provider, stt_provider, voice_id, model_id')
                .eq('org_id', org_id)
                .is('campaign_id', null)
                .eq('is_active', true)
                .maybeSingle();
            if (orgErr) {
                return reply.status(500).send({ error: orgErr.message });
            }
            settingsRow = orgRow;
        }
        return reply.send({
            llm_provider: settingsRow?.llm_provider || DEFAULT_AI_SETTINGS.llm_provider,
            tts_provider: settingsRow?.tts_provider || DEFAULT_AI_SETTINGS.tts_provider,
            stt_provider: settingsRow?.stt_provider || DEFAULT_AI_SETTINGS.stt_provider,
            voice_id: settingsRow?.voice_id || DEFAULT_AI_SETTINGS.voice_id,
            model_id: settingsRow?.model_id || DEFAULT_AI_SETTINGS.model_id,
        });
    });
    app.post('/events', async (req, reply) => {
        const body = (req.body || {});
        if (!body.org_id || !body.type) {
            return reply
                .status(400)
                .send({ error: 'org_id and type are required' });
        }
        if (!req.org_id || req.org_id !== body.org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        if (!isAiEventType(body.type)) {
            return reply.status(400).send({ error: 'Unsupported AI event type' });
        }
        const actorId = req.user_id || body.agent_id || 'ai-worker';
        const { data, error } = await supabase_1.supabase
            .from('ai_events')
            .insert({
            ai_event_id: crypto.randomUUID(),
            org_id: body.org_id,
            campaign_id: body.campaign_id || null,
            call_id: body.call_id || null,
            event_type: body.type,
            payload: {
                agent_id: body.agent_id || actorId,
                ...(body.payload || {}),
            },
            created_by: actorId,
            updated_by: actorId,
        })
            .select('*')
            .single();
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send({ success: true, event: data });
    });
};
exports.aiModule = aiModule;
