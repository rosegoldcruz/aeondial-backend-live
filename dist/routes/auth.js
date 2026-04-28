import bcrypt from 'bcrypt';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
const loginSchema = z.object({
    email: z.string().email().optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(6),
}).refine((data) => Boolean(data.email || data.username), {
    message: 'username or email is required',
    path: ['username'],
});
export async function authRoutes(app) {
    // POST /login
    app.post('/login', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: 60 * 1000,
                ban: 5,
                errorResponseBuilder: () => ({
                    statusCode: 429,
                    error: 'Too Many Requests',
                    message: 'Too many login attempts. Try again later.',
                }),
            },
        },
    }, async (req, reply) => {
        const body = loginSchema.safeParse(req.body);
        if (!body.success) {
            return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() });
        }
        const { email, username, password } = body.data;
        const loginValue = (username ?? email ?? '').toLowerCase();
        const agentQuery = supabase
            .from('agents')
            .select('id, name, email, username, password_hash, role, telnyx_sip_username, telnyx_sip_password, is_active');
        const { data: agent, error } = username
            ? await agentQuery.eq('username', loginValue).single()
            : await agentQuery.eq('email', loginValue).single();
        if (error || !agent) {
            return reply.status(401).send({ error: 'Invalid credentials' });
        }
        if (!agent.is_active) {
            return reply.status(403).send({ error: 'Account disabled' });
        }
        const valid = await bcrypt.compare(password, agent.password_hash);
        if (!valid) {
            return reply.status(401).send({ error: 'Invalid credentials' });
        }
        // Upsert agent session
        await supabase.from('agent_sessions').upsert({
            agent_id: agent.id,
            state: 'REGISTERED',
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent_id' });
        const token = app.jwt.sign({ agentId: agent.id, email: agent.email, role: agent.role }, { expiresIn: '12h' });
        return reply.send({
            token,
            agent: {
                id: agent.id,
                name: agent.name,
                email: agent.email,
                username: agent.username,
                role: agent.role,
                telnyx_sip_username: agent.telnyx_sip_username,
                telnyx_sip_password: agent.telnyx_sip_password,
            },
        });
    });
    // POST /register — admin only or first-time setup
    app.post('/register', async (req, reply) => {
        const schema = z.object({
            name: z.string().min(2),
            email: z.string().email(),
            password: z.string().min(6),
            role: z.enum(['agent', 'admin']).default('agent'),
            telnyx_sip_username: z.string().optional(),
            telnyx_sip_password: z.string().optional(),
        });
        const body = schema.safeParse(req.body);
        if (!body.success) {
            return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() });
        }
        const password_hash = await bcrypt.hash(body.data.password, 10);
        const { data, error } = await supabase
            .from('agents')
            .insert({
            name: body.data.name,
            email: body.data.email.toLowerCase(),
            password_hash,
            role: body.data.role,
            telnyx_sip_username: body.data.telnyx_sip_username ?? null,
            telnyx_sip_password: body.data.telnyx_sip_password ?? null,
        })
            .select('id, name, email, role')
            .single();
        if (error) {
            if (error.code === '23505') {
                return reply.status(409).send({ error: 'Email already exists' });
            }
            throw error;
        }
        return reply.status(201).send({ agent: data });
    });
}
