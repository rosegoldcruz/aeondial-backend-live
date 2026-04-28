import "dotenv/config";
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { authRoutes } from './routes/auth.js';
import { sessionRoutes } from './routes/session.js';
import { callRoutes } from './routes/calls.js';
import { campaignRoutes } from './routes/campaigns.js';
import { agentRoutes } from './routes/agents.js';
import { leadRoutes } from './routes/leads.js';
import { listRoutes } from './routes/lists.js';
import { campaignStatsRoute } from './routes/campaignStats.js';
import { telnyxWebhookRoutes } from './routes/webhooks.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, bodyLimit: 52428800 });
if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set');
}
const ALLOWED_ORIGINS = [
    'https://ivsol.aeondial.com',
    'https://crm.aeondial.com',
    'http://localhost:3000',
    'http://localhost:3001',
];
app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
});
// ── Plugins ──────────────────────────────────────────────
await app.register(cors, {
    origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            cb(null, true);
        }
        else {
            cb(new Error(`CORS: origin ${origin} not allowed`), false);
        }
    },
    credentials: true,
});
const helmetPlugin = await import('@fastify/helmet');
await app.register(helmetPlugin.default, {
    contentSecurityPolicy: false,
});
const rateLimitPlugin = await import('@fastify/rate-limit');
await app.register(rateLimitPlugin.default, {
    global: false,
});
await app.register(jwt, {
    secret: process.env.JWT_SECRET,
});
await app.register(fastifyStatic, {
    root: '/var/www/aeondial',
    prefix: '/static/',
    decorateReply: false,
});
await app.register(async (audioScope) => {
    await audioScope.register(fastifyStatic, {
        root: join(__dirname, '../public/audio'),
        prefix: '/audio/',
        decorateReply: false,
    });
});
// ── Auth decorator ────────────────────────────────────────
app.decorate('authenticate', async (req, reply) => {
    try {
        await req.jwtVerify();
    }
    catch {
        reply.status(401).send({ error: 'Unauthorized' });
    }
});
// ── Routes ────────────────────────────────────────────────
await app.register(authRoutes, { prefix: '/auth' });
await app.register(sessionRoutes, { prefix: '/session' });
await app.register(callRoutes, { prefix: '/calls' });
await app.register(campaignRoutes, { prefix: '/campaigns' });
await app.register(campaignStatsRoute, { prefix: '/campaigns' });
await app.register(agentRoutes, { prefix: '/agents' });
await app.register(leadRoutes, { prefix: '/leads' });
await app.register(listRoutes, { prefix: '/lists' });
await app.register(telnyxWebhookRoutes);
const ALLOWED_AUDIO_FILES = new Set(['HoldMusic.mp3', 'LiveAnswerIVR.mp3', 'VoicemailDrop.mp3']);
app.get('/audio/:file', async (req, reply) => {
    const file = String(req.params?.file ?? '');
    if (!ALLOWED_AUDIO_FILES.has(file)) {
        return reply.status(404).send({ error: 'Not Found' });
    }
    const fullPath = join(__dirname, '../public/audio', file);
    if (!existsSync(fullPath)) {
        return reply.status(404).send({ error: 'Not Found' });
    }
    reply.type('audio/mpeg');
    return reply.send(createReadStream(fullPath));
});
// ── Health ────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));
// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);
try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[AEON DIAL] API running on port ${PORT}`);
}
catch (err) {
    app.log.error(err);
    process.exit(1);
}
