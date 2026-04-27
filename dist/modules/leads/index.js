"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.leadsModule = void 0;
const supabase_1 = require("../../core/supabase");
const leadsModule = async (app) => {
    app.get('/', async (req, reply) => {
        const { org_id, status, limit } = req.query;
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        if (!org_id) {
            return reply.status(400).send({ error: 'org_id is required' });
        }
        if (org_id !== req.org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        let query = supabase_1.supabase.from('leads').select('*').eq('org_id', req.org_id);
        if (status) {
            query = query.eq('status', status);
        }
        const parsedLimit = Number.parseInt(limit || '100', 10);
        const safeLimit = Number.isFinite(parsedLimit)
            ? Math.min(Math.max(parsedLimit, 1), 500)
            : 100;
        const { data, error } = await query
            .order('created_at', { ascending: false })
            .limit(safeLimit);
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send(data || []);
    });
};
exports.leadsModule = leadsModule;
