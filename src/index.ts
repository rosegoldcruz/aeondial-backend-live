import "dotenv/config";
import Fastify from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { authRoutes } from './routes/auth.js';
import { sessionRoutes } from './routes/session.js';
import { callRoutes } from './routes/calls.js';
import { campaignRoutes } from './routes/campaigns.js';
import { agentRoutes } from './routes/agents.js';
import { leadRoutes } from './routes/leads.js';
import { listRoutes } from './routes/lists.js';
import { campaignStatsRoute } from './routes/campaignStats.js';
import { telnyxWebhookRoutes } from './routes/webhooks.js';

const app = Fastify({ logger: true, bodyLimit: 52428800 });

app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});

// ── Plugins ──────────────────────────────────────────────
await app.register(cors, {
  origin: (_origin, cb) => cb(null, true),
  credentials: true,
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'changeme',
});

// ── Auth decorator ────────────────────────────────────────
app.decorate('authenticate', async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
});

// ── Routes ────────────────────────────────────────────────
await app.register(authRoutes,          { prefix: '/auth' });
await app.register(sessionRoutes,       { prefix: '/session' });
await app.register(callRoutes,          { prefix: '/calls' });
await app.register(campaignRoutes,      { prefix: '/campaigns' });
await app.register(campaignStatsRoute,  { prefix: '/campaigns' });
await app.register(agentRoutes,         { prefix: '/agents' });
await app.register(leadRoutes,          { prefix: '/leads' });
await app.register(listRoutes,          { prefix: '/lists' });
await app.register(telnyxWebhookRoutes, { prefix: '/webhooks' });

const STATIC_DIR = join(process.cwd(), 'public', 'static');

app.get('/static/:filename', async (req: any, reply) => {
  const filename = String(req.params.filename ?? '');
  if (filename !== 'Voicemailmessage.wav') {
    return reply.status(404).send({ error: 'Not found' });
  }

  const filePath = join(STATIC_DIR, filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) {
    return reply.status(404).send({ error: 'Not found' });
  }

  reply.header('Content-Type', 'audio/wav');
  reply.header('Content-Length', fileStat.size);
  reply.header('Cache-Control', 'public, max-age=86400');
  return reply.send(createReadStream(filePath));
});

// ── Health ────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[AEON DIAL] API running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
