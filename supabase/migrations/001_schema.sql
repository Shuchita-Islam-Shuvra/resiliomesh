create extension if not exists postgis;
create extension if not exists pgcrypto;

do $$ begin
  create type app_role as enum ('citizen','city_officer','ngo_coordinator','field_worker','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type org_type as enum ('city_authority','ngo','community','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type incident_category as enum ('waterlogging','blocked_drain','overflow','road_flooded','relief_need');
exception when duplicate_object then null; end $$;

do $$ begin
  create type incident_status as enum ('reported','verified','assessed','approved','in_progress','resolved','rejected','duplicate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type risk_level as enum ('low','moderate','high','critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type resource_type as enum ('pump','crew','relief_kit','boat','sandbag','water_tank','medical_kit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type asset_type as enum ('canal','drain','culvert','pump_station','retention_pond','sluice_gate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type asset_status as enum ('operational','degraded','blocked','under_maintenance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum ('pending','assigned','accepted','in_progress','completed','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_status as enum ('pending_approval','approved','rejected','executing','executed','failed','superseded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_status as enum ('queued','running','retrying','succeeded','failed','compensating','compensated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type need_status as enum ('open','partially_fulfilled','fulfilled','cancelled','duplicate');
exception when duplicate_object then null; end $$;

create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (char_length(name) between 3 and 120),
  type        org_type not null,
  contact_phone text,
  created_at  timestamptz not null default now()
);

create table if not exists wards (
  id                 text primary key,
  name               text not null,
  city_corporation   text not null check (city_corporation in ('DNCC','DSCC')),
  lat                double precision not null,
  lng                double precision not null,
  location           geography(Point,4326) generated always as (st_setsrid(st_makepoint(lng,lat),4326)::geography) stored,
  population         integer not null check (population > 0),
  area_km2           numeric(6,2) not null check (area_km2 > 0),
  elevation_m        numeric(5,2) not null,
  impervious_pct     numeric(5,2) not null check (impervious_pct between 0 and 100),
  drainage_capacity_mm_hr numeric(6,2) not null check (drainage_capacity_mm_hr > 0),
  historical_events_10y integer not null default 0,
  current_risk_score numeric(5,2),
  current_risk_level risk_level,
  risk_updated_at    timestamptz
);

create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null check (char_length(full_name) between 2 and 100),
  email           text,
  phone           text check (phone is null or phone ~ '^\+?[0-9]{10,14}$'),
  role            app_role not null default 'citizen',
  organization_id uuid references organizations(id) on delete set null,
  ward_id         text references wards(id) on delete set null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_profiles_role on profiles(role);
create index if not exists idx_profiles_org on profiles(organization_id);

create table if not exists drainage_assets (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  asset_type       asset_type not null,
  ward_id          text not null references wards(id),
  owner_org_id     uuid references organizations(id),
  lat              double precision not null check (lat between 20 and 27),
  lng              double precision not null check (lng between 88 and 93),
  location         geography(Point,4326) generated always as (st_setsrid(st_makepoint(lng,lat),4326)::geography) stored,
  capacity_m3s     numeric(8,2) check (capacity_m3s >= 0),
  condition_score  integer not null default 70 check (condition_score between 0 and 100),
  status           asset_status not null default 'operational',
  last_maintained_at timestamptz,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_assets_ward on drainage_assets(ward_id);
create index if not exists idx_assets_geo on drainage_assets using gist(location);

create sequence if not exists incident_ref_seq start 1001;

create table if not exists incidents (
  id               uuid primary key default gen_random_uuid(),
  reference_code   text not null unique default ('RM-' || to_char(now(),'YYMM') || '-' || nextval('incident_ref_seq')),
  client_id        uuid unique,
  reporter_id      uuid not null references profiles(id),
  ward_id          text not null references wards(id),
  asset_id         uuid references drainage_assets(id) on delete set null,
  category         incident_category not null,
  title            text not null check (char_length(title) between 5 and 120),
  description      text not null check (char_length(description) between 10 and 2000),
  severity_reported smallint not null check (severity_reported between 1 and 5),
  water_depth_cm   integer check (water_depth_cm between 0 and 300),
  people_affected  integer not null default 0 check (people_affected between 0 and 100000),
  lat              double precision not null check (lat between 20 and 27),
  lng              double precision not null check (lng between 88 and 93),
  location         geography(Point,4326) generated always as (st_setsrid(st_makepoint(lng,lat),4326)::geography) stored,
  status           incident_status not null default 'reported',
  risk_score       numeric(5,2),
  risk_level       risk_level,
  priority         integer,
  duplicate_of     uuid references incidents(id),
  verified_by      uuid references profiles(id),
  resolved_at      timestamptz,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_duplicate_has_parent check (status <> 'duplicate' or duplicate_of is not null)
);
create index if not exists idx_incidents_status on incidents(status);
create index if not exists idx_incidents_ward_created on incidents(ward_id, created_at desc);
create index if not exists idx_incidents_reporter on incidents(reporter_id);
create index if not exists idx_incidents_geo on incidents using gist(location);
create index if not exists idx_incidents_risk on incidents(risk_score desc nulls last);

create table if not exists incident_status_history (
  id          bigserial primary key,
  incident_id uuid not null references incidents(id) on delete cascade,
  from_status incident_status,
  to_status   incident_status not null,
  changed_by  uuid references profiles(id),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ish_incident on incident_status_history(incident_id, created_at);

create table if not exists risk_assessments (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid references incidents(id) on delete cascade,
  ward_id        text not null references wards(id),
  score          numeric(5,2) not null check (score between 0 and 100),
  level          risk_level not null,
  model_version  text not null,
  features       jsonb not null,
  contributions  jsonb not null,
  rules_fired    jsonb not null default '[]'::jsonb,
  weather_source text not null,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);
create index if not exists idx_risk_incident on risk_assessments(incident_id, created_at desc);
create index if not exists idx_risk_ward on risk_assessments(ward_id, created_at desc);

create table if not exists resources (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  resource_type      resource_type not null,
  name               text not null check (char_length(name) between 3 and 120),
  unit               text not null default 'unit',
  quantity_total     integer not null check (quantity_total >= 0),
  quantity_available integer not null check (quantity_available >= 0),
  base_ward_id       text references wards(id),
  lat                double precision not null,
  lng                double precision not null,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint chk_available_le_total check (quantity_available <= quantity_total),
  constraint uq_resource_name_per_org unique (organization_id, name)
);
create index if not exists idx_resources_type on resources(resource_type);
create index if not exists idx_resources_org on resources(organization_id);

create table if not exists community_needs (
  id              uuid primary key default gen_random_uuid(),
  ward_id         text not null references wards(id),
  incident_id     uuid references incidents(id) on delete set null,
  need_type       resource_type not null,
  quantity        integer not null check (quantity between 1 and 100000),
  households      integer not null check (households between 1 and 50000),
  contact_name    text,
  contact_phone   text check (contact_phone is null or contact_phone ~ '^\+?[0-9]{10,14}$'),
  notes           text,
  status          need_status not null default 'open',
  fulfilled_qty   integer not null default 0 check (fulfilled_qty >= 0),
  dedup_key       text not null,
  duplicate_of    uuid references community_needs(id),
  submitted_by    uuid references profiles(id),
  organization_id uuid references organizations(id),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_fulfilled_le_qty check (fulfilled_qty <= quantity)
);
create index if not exists idx_needs_dedup on community_needs(dedup_key, created_at desc);
create index if not exists idx_needs_ward_status on community_needs(ward_id, status);

create table if not exists allocation_plans (
  id            uuid primary key default gen_random_uuid(),
  incident_ids  uuid[] not null,
  status        plan_status not null default 'pending_approval',
  feasible      boolean not null,
  relaxed       boolean not null default false,
  objective     numeric,
  assignments   jsonb not null,
  explanation   jsonb not null,
  constraints   jsonb not null,
  created_by    uuid references profiles(id),
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  rejection_reason text,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_plans_status on allocation_plans(status, created_at desc);

create table if not exists allocations (
  id               uuid primary key default gen_random_uuid(),
  resource_id      uuid not null references resources(id),
  incident_id      uuid references incidents(id),
  need_id          uuid references community_needs(id),
  plan_id          uuid references allocation_plans(id),
  quantity         integer not null check (quantity > 0),
  status           text not null default 'reserved' check (status in ('reserved','dispatched','consumed','released')),
  idempotency_key  text not null unique,
  allocated_by     uuid references profiles(id),
  released_reason  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_alloc_target check (incident_id is not null or need_id is not null)
);
create index if not exists idx_alloc_resource on allocations(resource_id, status);
create index if not exists idx_alloc_plan on allocations(plan_id);

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references incidents(id) on delete cascade,
  plan_id       uuid references allocation_plans(id),
  run_id        uuid,
  title         text not null,
  task_type     text not null check (task_type in ('drain_clearing','pump_deployment','relief_distribution','inspection','evacuation_support')),
  assigned_to   uuid references profiles(id),
  status        task_status not null default 'pending',
  notes         text,
  due_at        timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  idempotency_key text unique,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_tasks_assignee on tasks(assigned_to, status);
create index if not exists idx_tasks_incident on tasks(incident_id);

create table if not exists workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references allocation_plans(id),
  workflow        text not null default 'dispatch_plan',
  status          run_status not null default 'queued',
  current_step    text,
  attempts        integer not null default 0,
  max_attempts    integer not null default 3,
  last_error      text,
  inject_failure  text,
  idempotency_key text not null unique,
  next_run_at     timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  created_by      uuid references profiles(id),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table workflow_runs add column if not exists generation integer not null default 1;
create index if not exists idx_runs_queue on workflow_runs(status, next_run_at);

create table if not exists workflow_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references workflow_runs(id) on delete cascade,
  step_name   text not null,
  step_order  integer not null,
  status      text not null default 'pending' check (status in ('pending','running','succeeded','failed','compensated','skipped')),
  attempts    integer not null default 0,
  output      jsonb,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  constraint uq_run_step unique (run_id, step_name)
);

create table if not exists weather_cache (
  ward_id     text primary key references wards(id),
  payload     jsonb not null,
  source      text not null,
  fetched_at  timestamptz not null default now()
);

create table if not exists historical_flood_events (
  id               bigserial primary key,
  ward_id          text not null references wards(id),
  event_date       date not null,
  rainfall_mm      numeric(6,1),
  max_depth_cm     integer,
  duration_hr      numeric(5,1),
  households_affected integer,
  source           text not null default 'import',
  record_hash      text not null unique,
  imported_at      timestamptz not null default now()
);
create index if not exists idx_hfe_ward_date on historical_flood_events(ward_id, event_date);
create index if not exists idx_hfe_date on historical_flood_events(event_date);

create table if not exists audit_logs (
  id          bigserial primary key,
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  table_name  text not null,
  record_id   text,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_logs(created_at desc);
create index if not exists idx_audit_table on audit_logs(table_name, created_at desc);
create index if not exists idx_audit_actor on audit_logs(actor_id, created_at desc);
