import { createClient } from '@supabase/supabase-js';
if (!process.env.SUPABASE_URL)
    throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_KEY)
    throw new Error('SUPABASE_SERVICE_KEY is required');
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});
