"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactsModule = void 0;
const supabase_1 = require("../../core/supabase");
const contactsModule = async (app) => {
    app.get('/', async (req, reply) => {
        const { org_id, limit } = req.query;
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        if (!org_id) {
            return reply.status(400).send({ error: 'org_id is required' });
        }
        if (org_id !== req.org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        const parsedLimit = Number.parseInt(limit || '100', 10);
        const safeLimit = Number.isFinite(parsedLimit)
            ? Math.min(Math.max(parsedLimit, 1), 500)
            : 100;
        const { data, error } = await supabase_1.supabase
            .from('contacts')
            .select('*')
            .eq('org_id', req.org_id)
            .order('created_at', { ascending: false })
            .limit(safeLimit);
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send(data || []);
    });
};
exports.contactsModule = contactsModule;
