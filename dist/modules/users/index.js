"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usersModule = void 0;
const supabase_1 = require("../../core/supabase");
function canManageUsers(role) {
    return role === 'owner' || role === 'admin';
}
const usersModule = async (app) => {
    app.post('/', async (req, reply) => {
        if (!canManageUsers(req.role)) {
            return reply.status(403).send({ error: 'Insufficient role' });
        }
        const body = (req.body || {});
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        if (!body.user_id || !body.email) {
            return reply.status(400).send({ error: 'user_id and email are required' });
        }
        const targetOrgId = body.org_id || req.org_id;
        if (targetOrgId !== req.org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        const { data, error } = await supabase_1.supabase
            .from('users')
            .upsert({
            user_id: body.user_id,
            org_id: targetOrgId,
            email: body.email,
            full_name: body.full_name || null,
            role: body.role || 'agent',
            status: body.status || 'active',
            metadata: body.metadata || {},
            created_by: req.user_id,
            updated_by: req.user_id,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })
            .select('*')
            .single();
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send(data);
    });
    app.get('/', async (req, reply) => {
        const { org_id } = req.query;
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        if (!org_id) {
            return reply.status(400).send({ error: 'org_id is required' });
        }
        if (org_id !== req.org_id) {
            return reply.status(403).send({ error: 'Cross-tenant access denied' });
        }
        // owner/admin can list the org; agent can only read their own user row.
        let query = supabase_1.supabase.from('users').select('*').eq('org_id', req.org_id);
        if (req.role === 'agent') {
            query = query.eq('user_id', req.user_id || '');
        }
        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send(data || []);
    });
    app.patch('/:id', async (req, reply) => {
        const { id } = req.params;
        const body = (req.body || {});
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        const isSelf = id === req.user_id;
        if (!canManageUsers(req.role) && !isSelf) {
            return reply.status(403).send({ error: 'Insufficient role' });
        }
        if (req.role === 'agent' && typeof body.role !== 'undefined') {
            return reply.status(403).send({ error: 'Agent cannot change roles' });
        }
        const patch = {
            updated_by: req.user_id,
            updated_at: new Date().toISOString(),
        };
        if (typeof body.full_name !== 'undefined')
            patch.full_name = body.full_name;
        if (typeof body.status !== 'undefined')
            patch.status = body.status;
        if (typeof body.metadata !== 'undefined')
            patch.metadata = body.metadata;
        if (typeof body.role !== 'undefined' && canManageUsers(req.role)) {
            patch.role = body.role;
        }
        const { data, error } = await supabase_1.supabase
            .from('users')
            .update(patch)
            .eq('user_id', id)
            .eq('org_id', req.org_id)
            .select('*')
            .maybeSingle();
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        if (!data) {
            return reply.status(404).send({ error: 'User not found' });
        }
        return reply.send(data);
    });
    app.delete('/:id', async (req, reply) => {
        const { id } = req.params;
        if (!canManageUsers(req.role)) {
            return reply.status(403).send({ error: 'Insufficient role' });
        }
        if (!req.org_id) {
            return reply.status(401).send({ error: 'Missing org scope' });
        }
        const { error } = await supabase_1.supabase
            .from('users')
            .delete()
            .eq('user_id', id)
            .eq('org_id', req.org_id);
        if (error) {
            return reply.status(500).send({ error: error.message });
        }
        return reply.send({ success: true });
    });
};
exports.usersModule = usersModule;
