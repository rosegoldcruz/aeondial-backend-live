import { FastifyInstance } from 'fastify';
import { parse } from 'csv-parse/sync';
import { supabase } from '../lib/supabase.js';

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+')) return raw.trim();
  return null;
}

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseCsv(csvText: string): Record<string, string>[] {
  const firstLine = csvText.trim().split('\n')[0] ?? '';
  const firstField = firstLine.split(',')[0]?.replace(/\D/g, '') ?? '';
  const isHeaderless = firstField.length >= 7;

  if (!isHeaderless) {
    return parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  }

  const raw = parse(csvText, { columns: false, skip_empty_lines: true, trim: true }) as string[][];
  return raw.map((row) => ({
    phone_e164: row[0] ?? '',
    fname: row[1] ?? '',
    lname: row[2] ?? '',
    email: row[3] ?? '',
    city: row[4] ?? '',
    state: row[5] ?? '',
    zip: row[6] ?? '',
    address: row[7] ?? '',
  }));
}

async function resolveCampaignId(requestedCampaignId?: string | null): Promise<string | null> {
  if (requestedCampaignId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', requestedCampaignId)
      .single();
    return data?.id ?? null;
  }

  const { data } = await supabase
    .from('campaigns')
    .select('id')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data?.id ?? null;
}

export async function leadRoutes(app: FastifyInstance) {
  app.get('/', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const rawLimit = Number(req.query?.limit ?? 100);
    const limit = [20, 50, 100, 500].includes(rawLimit) ? rawLimit : Math.min(Math.max(rawLimit, 1), 500);
    const page = Math.max(Number(req.query?.page ?? 1), 1);
    const offset = Math.max(Number(req.query?.offset ?? ((page - 1) * limit)), 0);
    const q = String(req.query?.q ?? '').trim().replace(/[%_,]/g, '');

    let query = supabase
      .from('leads')
      .select('id, first_name, last_name, email, phone, quality, city, state, status, created_at, campaign_id, campaigns(name)', { count: 'exact' });

    if (q) {
      query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%,city.ilike.%${q}%,state.ilike.%${q}%`);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return reply.status(500).send({ error: error.message });

    const [{ count: total }, { count: hot }, { count: callbacks }] = await Promise.all([
      supabase.from('leads').select('*', { count: 'exact', head: true }),
      supabase.from('leads').select('*', { count: 'exact', head: true }).or('quality.eq.hot,status.eq.qualified'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'callback'),
    ]);

    return reply.send({
      leads: data ?? [],
      total: total ?? count ?? data?.length ?? 0,
      filtered_total: count ?? data?.length ?? 0,
      page,
      limit,
      offset,
      stats: {
        total: total ?? 0,
        hot: hot ?? 0,
        callbacks: callbacks ?? 0,
      },
    });
  });

  app.get('/search', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const q = String(req.query?.q ?? '').trim();
    const limit = Math.min(Number(req.query?.limit ?? 50), 200);

    if (!q) return reply.status(400).send({ error: 'q param required' });

    const escaped = q.replace(/[%_,]/g, '');
    const { data, count, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, email, phone, quality, city, state, status, last_voicemail_at', { count: 'exact' })
      .or(`first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,phone.ilike.%${escaped}%,email.ilike.%${escaped}%,city.ilike.%${escaped}%`)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ leads: data ?? [], total: count ?? data?.length ?? 0 });
  });

  app.post('/import', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const csvText = typeof req.body === 'string' ? req.body : '';
    if (!csvText.trim()) return reply.status(400).send({ error: 'No CSV body' });

    const campaignId = await resolveCampaignId(req.query?.campaign_id ?? null);
    if (!campaignId) return reply.status(400).send({ error: 'No active campaign found' });

    let records: Record<string, string>[];
    try {
      records = parseCsv(csvText);
    } catch {
      return reply.status(400).send({ error: 'Invalid CSV format' });
    }

    const leads: Record<string, unknown>[] = [];
    const skipped: string[] = [];

    for (const row of records) {
      const rawPhone = pick(row, ['phone_e164', 'phone', 'Phone', 'Cellphone', 'cellphone', 'mobile', 'Mobile']) ?? '';
      const phone = normalizePhone(rawPhone);

      if (!phone) {
        skipped.push(rawPhone);
        continue;
      }

      leads.push({
        campaign_id: campaignId,
        first_name: pick(row, ['fname', 'first_name', 'First Name', 'first', 'First']) ?? null,
        last_name: pick(row, ['lname', 'last_name', 'Last Name', 'last', 'Last']) ?? null,
        email: pick(row, ['email', 'Email']) ?? null,
        phone,
        quality: pick(row, ['quality', 'Quality']) ?? null,
        address: pick(row, ['address', 'Address']) ?? null,
        city: pick(row, ['city', 'City']) ?? null,
        state: pick(row, ['state', 'State']) ?? null,
        country: pick(row, ['country', 'Country']) ?? null,
        zip: pick(row, ['zip', 'Zip', 'ZIP']) ?? null,
        timezone: pick(row, ['timezone', 'Timezone']) ?? null,
        timezone_source: pick(row, ['timezone_source']) ?? null,
        consent_source: pick(row, ['consent_source']) || pick(row, ['source_list']) || 'IVT Crypto Master list - affiliated partner opt-in',
        consent_date: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
      });
    }

    if (leads.length === 0) {
      return reply.status(400).send({ error: 'No valid leads found', skipped });
    }

    const CHUNK = 500;
    let inserted = 0;
    const errors: string[] = [];

    for (let i = 0; i < leads.length; i += CHUNK) {
      const chunk = leads.slice(i, i + CHUNK);
      const { error } = await supabase.from('leads').insert(chunk);
      if (error) {
        errors.push(error.message);
      } else {
        inserted += chunk.length;
      }
    }

    if (inserted === 0 && errors.length) {
      return reply.status(500).send({ error: errors[0], inserted, skipped: skipped.length, total: records.length });
    }

    return reply.send({ success: true, inserted, skipped: skipped.length, total: records.length, campaign_id: campaignId, errors });
  });
}
