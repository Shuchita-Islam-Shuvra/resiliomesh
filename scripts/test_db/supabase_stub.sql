-- Minimal Supabase-compatible environment for running migrations on plain Postgres+PostGIS
-- (CI / local verification only — NOT needed on a real Supabase project).
do $$ begin
  create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text unique,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
-- live sessions (session_id claim) and MFA factors, as in Supabase Auth
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  aal text default 'aal1',
  created_at timestamptz default now()
);
create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  factor_type text not null default 'totp',
  status text not null default 'unverified',
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role') $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
