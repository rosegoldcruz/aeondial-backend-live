import { supabase } from '../lib/supabase.js';
import { parse } from 'csv-parse/sync';
function normalizePhone(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10)
        return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1'))
        return `+${digits}`;
    return null;
}
export async function campaignRoutes(app) {
    // GET /campaigns — list all
    app.get('/', { onRequest: [app.authenticate] }, async (_req, reply) => {
        const { data, error } = await supabase
            .from('campaigns')
            .select('id, name, status, caller_id, created_at')
            .order('created_at', { ascending: false });
        if (error)
            return reply.status(500).send({ error: error.message });
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const todayIso = today.toISOString();
        const campaigns = [];
        for (const campaign of data ?? []) {
            const [{ count: leadCount }, { count: totalCallsToday }, { count: bridgedCallsToday }] = await Promise.all([
                supabase
                    .from('leads')
                    .select('*', { count: 'exact', head: true })
                    .eq('campaign_id', campaign.id),
                supabase
                    .from('calls')
                    .select('*', { count: 'exact', head: true })
                    .eq('campaign_id', campaign.id)
                    .gte('started_at', todayIso),
                supabase
                    .from('calls')
                    .select('*', { count: 'exact', head: true })
                    .eq('campaign_id', campaign.id)
                    .eq('status', 'bridged')
                    .gte('started_at', todayIso),
            ]);
            const callsToday = totalCallsToday ?? 0;
            const connectedToday = bridgedCallsToday ?? 0;
            campaigns.push({
                ...campaign,
                lead_count: leadCount ?? 0,
                leads_remaining: leadCount ?? 0,
                calls_today: callsToday,
                connect_rate: callsToday > 0 ? parseFloat(((connectedToday / callsToday) * 100).toFixed(1)) : 0,
            });
        }
        return reply.send({ campaigns });
    });
    // GET /campaigns/:id/stats
    app.get('/:id/stats', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { id } = req.params;
        const { count: total } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', id);
        const { count: pending } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', id)
            .eq('status', 'pending');
        const { count: dnc } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', id)
            .eq('status', 'dnc');
        const { count: disposed } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', id)
            .eq('status', 'disposed');
        return reply.send({ total, pending, dnc, disposed });
    });
    // POST /campaigns/:id/import — upload CSV body
    app.post('/:id/import', { onRequest: [app.authenticate] }, async (req, reply) => {
        const { id: campaignId } = req.params;
        // Verify campaign exists
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('id')
            .eq('id', campaignId)
            .single();
        if (!campaign)
            return reply.status(404).send({ error: 'Campaign not found' });
        const csvText = req.body;
        if (!csvText)
            return reply.status(400).send({ error: 'No CSV body' });
        let records;
        try {
            // Auto-detect headerless CSV: if first field of first row looks like a phone number,
            // map columns by position (phone,fname,lname,email,...) instead of using header names
            const firstLine = csvText.trim().split('\n')[0] ?? '';
            const firstField = firstLine.split(',')[0].replace(/\D/g, '');
            const isHeaderless = firstField.length >= 7; // phone digits, not a column name
            if (isHeaderless) {
                const raw = parse(csvText, { columns: false, skip_empty_lines: true, trim: true });
                records = raw.map((row) => ({
                    phone_e164: row[0] ?? '',
                    fname: row[1] ?? '',
                    lname: row[2] ?? '',
                    email: row[3] ?? '',
                    country: row[7] ?? '',
                }));
            }
            else {
                records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
            }
        }
        catch (err) {
            return reply.status(400).send({ error: 'Invalid CSV format' });
        }
        const leads = [];
        const skipped = [];
        for (const row of records) {
            // phone_e164 takes priority over other phone columns
            const rawPhone = row['phone_e164'] ?? row['Cellphone'] ?? row['phone'] ?? row['Phone'] ?? '';
            const phone = rawPhone.startsWith('+') ? rawPhone : normalizePhone(rawPhone);
            if (!phone) {
                skipped.push(rawPhone);
                continue;
            }
            leads.push({
                campaign_id: campaignId,
                first_name: row['fname'] ?? row['First Name'] ?? row['first_name'] ?? null,
                last_name: row['lname'] ?? row['Last Name'] ?? row['last_name'] ?? null,
                email: row['Email'] ?? row['email'] ?? null,
                phone,
                quality: row['quality'] ?? null,
                address: row['Address'] ?? row['address'] ?? null,
                city: row['City'] ?? row['city'] ?? null,
                state: row['State'] ?? row['state'] ?? null,
                country: row['Country'] ?? row['country'] ?? null,
                zip: row['Zip'] ?? row['zip'] ?? null,
                timezone: row['timezone'] ?? null,
                timezone_source: row['timezone_source'] ?? null,
                status: 'pending',
                attempts: 0,
            });
        }
        if (leads.length === 0) {
            return reply.status(400).send({ error: 'No valid leads found', skipped });
        }
        // Batch insert in chunks of 500
        const CHUNK = 500;
        let inserted = 0;
        for (let i = 0; i < leads.length; i += CHUNK) {
            const chunk = leads.slice(i, i + CHUNK);
            const { error } = await supabase.from('leads').insert(chunk);
            if (error) {
                app.log.error(error);
            }
            else {
                inserted += chunk.length;
            }
        }
        return reply.send({
            success: true,
            inserted,
            skipped: skipped.length,
            total: records.length,
        });
    });
}
