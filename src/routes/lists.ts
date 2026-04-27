import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';

export async function listRoutes(app: FastifyInstance) {
  app.get('/', { onRequest: [app.authenticate] } as any, async (_req, reply) => {
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, name, status, created_at')
      .order('created_at', { ascending: false });

    if (error) return reply.status(500).send({ error: error.message });

    const countMap: Record<string, number> = {};
    for (const campaign of campaigns ?? []) {
      const { count } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id);
      countMap[campaign.id] = count ?? 0;
    }

    const lists = (campaigns ?? []).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      source: 'campaign',
      status: campaign.status,
      created_at: campaign.created_at,
      imported_at: campaign.created_at,
      record_count: countMap[campaign.id] ?? 0,
      campaign_name: campaign.name,
    }));

    return reply.send({ lists });
  });
}
