import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';

export async function campaignStatsRoute(app: FastifyInstance) {
  app.get('/stats', { onRequest: [app.authenticate] } as any, async (_req, reply) => {
    const today = new Date().toISOString().slice(0, 10);

    const { data: campaigns, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, name, status');

    if (campaignError) return reply.status(500).send({ error: campaignError.message });

    const { data: calls } = await supabase
      .from('calls')
      .select('campaign_id, answered_at, disposition')
      .gte('started_at', today);

    const map: Record<string, { attempts: number; connected: number; wraps: number }> = {};
    for (const c of (calls ?? [])) {
      if (!c.campaign_id) continue;
      if (!map[c.campaign_id]) map[c.campaign_id] = { attempts: 0, connected: 0, wraps: 0 };
      map[c.campaign_id].attempts++;
      if (c.answered_at) map[c.campaign_id].connected++;
      if (!c.disposition) map[c.campaign_id].wraps++;
    }

    const enriched = (campaigns ?? []).map((c) => {
      const s = map[c.id] ?? { attempts: 0, connected: 0, wraps: 0 };
      return {
        id: c.id,
        name: c.name,
        type: 'progressive',
        status: c.status,
        attempts_today: s.attempts,
        connected_today: s.connected,
        wraps_needed: s.wraps,
        connect_rate: s.attempts ? parseFloat(((s.connected / s.attempts) * 100).toFixed(1)) : 0,
      };
    });

    const totAttempts = enriched.reduce((s, c) => s + c.attempts_today, 0);
    const totConnected = enriched.reduce((s, c) => s + c.connected_today, 0);
    const totWraps = enriched.reduce((s, c) => s + c.wraps_needed, 0);
    const best = [...enriched].sort((a, b) => b.connect_rate - a.connect_rate)[0];

    return reply.send({
      campaigns: enriched,
      totals: {
        attempts: totAttempts,
        connected: totConnected,
        wraps: totWraps,
        best_campaign: best?.name ?? '—',
        best_rate: best?.connect_rate ?? 0,
      },
    });
  });
}
