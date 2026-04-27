alter table public.calls
add column if not exists group_id uuid;
