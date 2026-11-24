-- ResilioMesh: 002 + 003 + 004 + 005 + seed + 006 + 007 + 008 in ONE file (run after 001_schema.sql)

-- ================= migrations/002_functions_triggers.sql =================
-- =====================================================================
-- ResilioMesh — 002 helper functions, triggers, business-rule guards
-- =====================================================================

-- ---------- Identity helpers (used by RLS) --------------------------
create or replace function public.rm_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and is_active
$$;

create or replace function public.rm_org() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid() and is_active
$$;

create or replace function public.rm_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('city_officer','ngo_coordinator','field_worker','admin')
                   from profiles where id = auth.uid() and is_active), false)
$$;

-- System context = trusted backend connection (no end-user JWT).
create or replace function public.rm_is_system() returns boolean
language sql stable as $$
  select auth.uid() is null
     and coalesce(auth.role(), '') not in ('anon','authenticated')
$$;

-- Actor for audit: JWT user, or backend-provided actor via set_config('rm.actor', ...)
create or replace function public.rm_actor() returns uuid
language sql stable as $$
  select coalesce(auth.uid(), nullif(current_setting('rm.actor', true), '')::uuid)
$$;

-- ---------- Generic touch / optimistic-lock version bump ------------
create or replace function public.rm_touch_versioned() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create or replace function public.rm_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['drainage_assets','incidents','resources','community_needs','allocation_plans','tasks'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format('create trigger trg_touch_%1$s before update on %1$s for each row execute function rm_touch_versioned()', t);
  end loop;
  foreach t in array array['profiles','allocations','workflow_runs'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format('create trigger trg_touch_%1$s before update on %1$s for each row execute function rm_touch()', t);
  end loop;
end $$;

-- ---------- New auth user -> profile (always citizen) ---------------
-- Privilege escalation protection: self-registration can never pick a role.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ward text;
begin
  v_ward := nullif(new.raw_user_meta_data->>'ward_id', '');
  if v_ward is not null and not exists (select 1 from wards where id = v_ward) then
    v_ward := null;
  end if;
  insert into profiles (id, full_name, email, phone, role, ward_id)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(new.raw_user_meta_data->>'phone', ''),
    'citizen',
    v_ward
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins (or the backend/system) may change role / org / active flag.
create or replace function public.rm_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if rm_is_system() then return new; end if;
  if (new.role is distinct from old.role
      or new.organization_id is distinct from old.organization_id
      or new.is_active is distinct from old.is_active)
     and coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can change role, organization or account status'
      using errcode = '42501';
  end if;
  if new.id = auth.uid() and new.role is distinct from old.role then
    raise exception 'FORBIDDEN: admins cannot change their own role' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_profile on profiles;
create trigger trg_guard_profile before update on profiles
  for each row execute function rm_guard_profile();

-- ---------- Incident state machine ----------------------------------
create or replace function public.rm_incident_transition_allowed(p_from incident_status, p_to incident_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'reported'    then p_to in ('verified','rejected','duplicate')
    when 'verified'    then p_to in ('assessed','rejected','duplicate')
    when 'assessed'    then p_to in ('approved','verified','rejected')
    when 'approved'    then p_to in ('in_progress','assessed')
    when 'in_progress' then p_to in ('resolved','assessed')
    when 'duplicate'   then p_to in ('verified')
    else false            -- resolved / rejected are terminal
  end
$$;

create or replace function public.rm_incident_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_dup uuid;
begin
  -- clients can never forge reporter, status, or AI fields
  if not rm_is_system() then
    new.reporter_id := auth.uid();
    new.status := 'reported';
    new.risk_score := null; new.risk_level := null; new.priority := null;
    new.verified_by := null; new.duplicate_of := null;
  end if;

  -- Geospatial duplicate detection: same category within 150 m in the last 6 h
  select i.id into v_dup
  from incidents i
  where i.category = new.category
    and i.status not in ('resolved','rejected','duplicate')
    and i.created_at > now() - interval '6 hours'
    and st_dwithin(i.location, st_setsrid(st_makepoint(new.lng, new.lat),4326)::geography, 150)
  order by i.created_at asc
  limit 1;

  if v_dup is not null then
    new.status := 'duplicate';
    new.duplicate_of := v_dup;
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_before_insert on incidents;
create trigger trg_incident_before_insert before insert on incidents
  for each row execute function rm_incident_before_insert();

create or replace function public.rm_incident_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into incident_status_history(incident_id, from_status, to_status, changed_by, note)
  values (new.id, null, new.status, new.reporter_id,
          case when new.status = 'duplicate' then 'Auto-flagged as duplicate of ' || new.duplicate_of else 'Report submitted' end);
  if new.status = 'duplicate' and new.people_affected > 0 then
    perform set_config('rm.internal', 'on', true);
    update incidents set people_affected = least(100000, people_affected + new.people_affected)
    where id = new.duplicate_of;
    perform set_config('rm.internal', 'off', true);
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_after_insert on incidents;
create trigger trg_incident_after_insert after insert on incidents
  for each row execute function rm_incident_after_insert();

create or replace function public.rm_incident_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if not rm_incident_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_TRANSITION: % -> % is not allowed', old.status, new.status
        using errcode = '23514';
    end if;
    if new.status = 'duplicate' and new.duplicate_of is null then
      raise exception 'VALIDATION: duplicate_of is required' using errcode = '23514';
    end if;
    if new.status = 'resolved' then new.resolved_at := now(); end if;
  end if;

  -- citizens may only edit text of their own report while it is still 'reported'
  if not rm_is_system()
     and coalesce(current_setting('rm.internal', true), 'off') <> 'on'
     and coalesce(rm_role()::text,'citizen') = 'citizen' then
    if old.status <> 'reported'
       or new.status is distinct from old.status
       or new.risk_score is distinct from old.risk_score
       or new.priority is distinct from old.priority
       or new.ward_id is distinct from old.ward_id then
      raise exception 'FORBIDDEN: citizens can only edit description of reports awaiting review'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_before_update on incidents;
create trigger trg_incident_before_update before update on incidents
  for each row execute function rm_incident_before_update();

create or replace function public.rm_incident_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into incident_status_history(incident_id, from_status, to_status, changed_by, note)
    values (new.id, old.status, new.status, rm_actor(), current_setting('rm.note', true));
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_after_update on incidents;
create trigger trg_incident_after_update after update on incidents
  for each row execute function rm_incident_after_update();

-- ---------- Community-need duplicate detection ----------------------
create or replace function public.rm_need_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_dup uuid;
begin
  new.dedup_key := md5(
    new.ward_id || '|' || new.need_type::text || '|' ||
    coalesce(regexp_replace(new.contact_phone, '[^0-9]', '', 'g'), lower(trim(coalesce(new.contact_name,''))), '') || '|' ||
    coalesce(new.incident_id::text, '')
  );
  if not rm_is_system() then
    new.submitted_by := auth.uid();
    new.status := 'open';
    new.fulfilled_qty := 0;
    new.duplicate_of := null;
  end if;

  select id into v_dup from community_needs
  where dedup_key = new.dedup_key
    and status in ('open','partially_fulfilled')
    and created_at > now() - interval '48 hours'
  order by created_at limit 1;

  if v_dup is not null then
    new.status := 'duplicate';
    new.duplicate_of := v_dup;
  end if;
  return new;
end $$;

drop trigger if exists trg_need_before_insert on community_needs;
create trigger trg_need_before_insert before insert on community_needs
  for each row execute function rm_need_before_insert();

-- ---------- Audit logging (append-only) -----------------------------
create or replace function public.rm_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  v_id := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id');
  insert into audit_logs(actor_id, actor_role, action, table_name, record_id, old_data, new_data)
  values (
    rm_actor(),
    coalesce(rm_role()::text, case when rm_is_system() then 'system' else null end),
    tg_op, tg_table_name, v_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','incidents','drainage_assets','resources','community_needs',
                           'allocation_plans','allocations','tasks','workflow_runs','organizations'] loop
    execute format('drop trigger if exists trg_audit_%1$s on %1$s', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on %1$s for each row execute function rm_audit()', t);
  end loop;
end $$;

-- audit_logs is immutable even for table owners going through the API
create or replace function public.rm_block_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'FORBIDDEN: audit log is append-only' using errcode = '42501';
end $$;

drop trigger if exists trg_audit_immutable on audit_logs;
create trigger trg_audit_immutable before update or delete on audit_logs
  for each row execute function rm_block_audit_mutation();

-- ================= migrations/003_rls.sql =================
-- =====================================================================
-- ResilioMesh — 003 Row Level Security (organisation + role isolation)
-- =====================================================================

-- Explicit grants (works even if "Grant API access to new tables automatically" is off).
-- Real access control is enforced by the RLS policies below.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- anon gets nothing except ward geography
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select on wards to anon;

alter table organizations           enable row level security;
alter table wards                   enable row level security;
alter table profiles                enable row level security;
alter table drainage_assets         enable row level security;
alter table incidents               enable row level security;
alter table incident_status_history enable row level security;
alter table risk_assessments        enable row level security;
alter table resources               enable row level security;
alter table community_needs         enable row level security;
alter table allocation_plans        enable row level security;
alter table allocations             enable row level security;
alter table tasks                   enable row level security;
alter table workflow_runs           enable row level security;
alter table workflow_steps          enable row level security;
alter table weather_cache           enable row level security;
alter table historical_flood_events enable row level security;
alter table audit_logs              enable row level security;

-- helper: drop all existing policies so this file is re-runnable
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------- organizations / wards (reference data) ------------------
create policy org_read on organizations for select to authenticated using (true);
create policy org_admin_write on organizations for all to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');

create policy wards_read on wards for select to anon, authenticated using (true);
create policy wards_admin_write on wards for update to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');

-- ---------- profiles ------------------------------------------------
create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid() or rm_is_staff());
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid() or rm_role() = 'admin')
  with check (id = auth.uid() or rm_role() = 'admin');
-- (role/org changes are additionally blocked by trg_guard_profile)

-- ---------- drainage assets -----------------------------------------
create policy assets_read on drainage_assets for select to authenticated using (true);
create policy assets_write on drainage_assets for insert to authenticated
  with check (rm_role() in ('city_officer','admin'));
create policy assets_update on drainage_assets for update to authenticated
  using (rm_role() = 'admin' or (rm_role() = 'city_officer' and owner_org_id = rm_org()))
  with check (rm_role() = 'admin' or (rm_role() = 'city_officer' and owner_org_id = rm_org()));
create policy assets_delete on drainage_assets for delete to authenticated
  using (rm_role() = 'admin');

-- ---------- incidents -----------------------------------------------
-- citizens: only their own reports; staff: everything
create policy incidents_read on incidents for select to authenticated
  using (reporter_id = auth.uid() or rm_is_staff());
create policy incidents_insert on incidents for insert to authenticated
  with check (reporter_id = auth.uid());
create policy incidents_update on incidents for update to authenticated
  using ((reporter_id = auth.uid() and status = 'reported') or rm_role() in ('city_officer','admin'))
  with check ((reporter_id = auth.uid()) or rm_role() in ('city_officer','admin'));
create policy incidents_delete on incidents for delete to authenticated
  using (rm_role() = 'admin');

create policy ish_read on incident_status_history for select to authenticated
  using (rm_is_staff() or exists (select 1 from incidents i where i.id = incident_id and i.reporter_id = auth.uid()));

create policy risk_read on risk_assessments for select to authenticated
  using (rm_is_staff());

-- ---------- resources (org-scoped writes) ---------------------------
create policy resources_read on resources for select to authenticated using (rm_is_staff());
create policy resources_insert on resources for insert to authenticated
  with check (rm_role() = 'admin'
              or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()));
create policy resources_update on resources for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()))
  with check (rm_role() = 'admin'
         or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()));
create policy resources_delete on resources for delete to authenticated
  using (rm_role() = 'admin' or (rm_role() = 'ngo_coordinator' and organization_id = rm_org()));

-- ---------- community needs -----------------------------------------
create policy needs_read on community_needs for select to authenticated
  using (rm_is_staff() or submitted_by = auth.uid());
create policy needs_insert on community_needs for insert to authenticated
  with check (true);           -- trigger forces submitted_by/status
create policy needs_update on community_needs for update to authenticated
  using (rm_role() in ('ngo_coordinator','admin'))
  with check (rm_role() in ('ngo_coordinator','admin'));

-- ---------- plans / allocations / tasks / workflows -----------------
create policy plans_read on allocation_plans for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));
-- writes only through RPC / backend

create policy alloc_read on allocations for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy tasks_read on tasks for select to authenticated
  using (assigned_to = auth.uid() or rm_role() in ('city_officer','ngo_coordinator','admin'));
-- task updates only through update_task_status() RPC (version-checked)

create policy runs_read on workflow_runs for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));
create policy steps_read on workflow_steps for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy weather_read on weather_cache for select to authenticated using (true);

create policy hfe_read on historical_flood_events for select to authenticated using (rm_is_staff());

create policy audit_read on audit_logs for select to authenticated using (rm_role() = 'admin');
-- no insert/update/delete policies: only SECURITY DEFINER trigger writes audit rows

-- ================= migrations/004_rpc.sql =================
-- =====================================================================
-- ResilioMesh — 004 transactional RPCs (concurrency, workflow, analytics)
-- =====================================================================

-- =====================================================================
-- A05: atomic, idempotent stock reservation with row-level locking
-- Internal (system) function: called by backend workflow + wrapper RPCs.
-- =====================================================================
create or replace function public.rm_reserve_resource(
  p_resource_id uuid, p_qty integer, p_idempotency_key text,
  p_incident_id uuid default null, p_need_id uuid default null,
  p_plan_id uuid default null, p_actor uuid default null
) returns allocations
language plpgsql security definer set search_path = public as $$
declare
  v_res   resources;
  v_alloc allocations;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'VALIDATION: quantity must be positive' using errcode = '22023';
  end if;
  if coalesce(trim(p_idempotency_key), '') = '' then
    raise exception 'VALIDATION: idempotency key required' using errcode = '22023';
  end if;

  -- fast path: replayed request returns the original result (idempotency)
  select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  if found then return v_alloc; end if;

  -- serialize all reservations of this resource row
  select * into v_res from resources where id = p_resource_id for update;
  if not found then
    raise exception 'NOT_FOUND: resource %', p_resource_id using errcode = 'P0002';
  end if;

  -- re-check after acquiring the lock: a concurrent duplicate may have committed
  select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  if found then return v_alloc; end if;

  if v_res.quantity_available < p_qty then
    raise exception 'INSUFFICIENT_STOCK: % requested, % available for %',
      p_qty, v_res.quantity_available, v_res.name using errcode = 'P0001';
  end if;

  update resources set quantity_available = quantity_available - p_qty
  where id = p_resource_id;

  begin
    insert into allocations(resource_id, incident_id, need_id, plan_id, quantity, idempotency_key, allocated_by)
    values (p_resource_id, p_incident_id, p_need_id, p_plan_id, p_qty, p_idempotency_key, coalesce(p_actor, rm_actor()))
    returning * into v_alloc;
  exception when unique_violation then
    -- lost an idempotency race on another resource row: undo our decrement, return winner
    update resources set quantity_available = quantity_available + p_qty where id = p_resource_id;
    select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  end;
  return v_alloc;
end $$;

-- compensation: idempotent release (returns stock exactly once)
create or replace function public.rm_release_allocation(p_allocation_id uuid, p_reason text default 'released')
returns allocations
language plpgsql security definer set search_path = public as $$
declare v_alloc allocations;
begin
  select * into v_alloc from allocations where id = p_allocation_id for update;
  if not found then raise exception 'NOT_FOUND: allocation' using errcode = 'P0002'; end if;
  if v_alloc.status in ('released','consumed') then return v_alloc; end if;

  perform 1 from resources where id = v_alloc.resource_id for update;
  update resources set quantity_available = least(quantity_total, quantity_available + v_alloc.quantity)
  where id = v_alloc.resource_id;
  update allocations set status = 'released', released_reason = p_reason
  where id = p_allocation_id returning * into v_alloc;
  return v_alloc;
end $$;

revoke execute on function public.rm_reserve_resource(uuid,integer,text,uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.rm_release_allocation(uuid,text) from public, anon, authenticated;

-- =====================================================================
-- NGO direct allocation to a community need (user-facing RPC)
-- "Multiple coordinators request the final available relief kit"
-- =====================================================================
create or replace function public.allocate_to_need(
  p_need_id uuid, p_resource_id uuid, p_qty integer, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_need community_needs;
  v_res  resources;
  v_alloc allocations;
  v_existing boolean;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can allocate aid' using errcode = '42501';
  end if;

  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;

  select exists(select 1 from allocations where idempotency_key = p_idempotency_key) into v_existing;

  if not v_existing then
    if v_need.status not in ('open','partially_fulfilled') then
      raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
    end if;
    if p_qty > v_need.quantity - v_need.fulfilled_qty then
      raise exception 'VALIDATION: only % units still required', v_need.quantity - v_need.fulfilled_qty
        using errcode = '22023';
    end if;
  end if;

  select * into v_res from resources where id = p_resource_id;
  if not found then raise exception 'NOT_FOUND: resource' using errcode = 'P0002'; end if;
  if v_role <> 'admin' and v_res.organization_id is distinct from rm_org() then
    raise exception 'FORBIDDEN: resource belongs to another organization' using errcode = '42501';
  end if;
  if v_res.resource_type <> v_need.need_type then
    raise exception 'VALIDATION: resource type % does not match need %', v_res.resource_type, v_need.need_type
      using errcode = '22023';
  end if;

  v_alloc := rm_reserve_resource(p_resource_id, p_qty, p_idempotency_key, v_need.incident_id, p_need_id, null, auth.uid());

  if not v_existing then
    update community_needs
       set fulfilled_qty = fulfilled_qty + p_qty,
           status = case when fulfilled_qty + p_qty >= quantity then 'fulfilled'::need_status
                         else 'partially_fulfilled'::need_status end,
           organization_id = coalesce(organization_id, v_res.organization_id)
     where id = p_need_id;
  end if;

  return jsonb_build_object('ok', true, 'replayed', v_existing, 'allocation', to_jsonb(v_alloc));
end $$;

-- =====================================================================
-- Incident transitions with optimistic locking (A01) + role rules (M04)
-- =====================================================================
create or replace function public.transition_incident(
  p_incident_id uuid, p_to incident_status, p_expected_version integer,
  p_note text default null, p_duplicate_of uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_inc incidents;
begin
  if v_role is null then raise exception 'FORBIDDEN: not authenticated' using errcode = '42501'; end if;

  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then raise exception 'NOT_FOUND: incident' using errcode = 'P0002'; end if;

  if v_inc.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_inc));
  end if;

  -- role rules per target state
  if p_to in ('verified','rejected','duplicate','resolved','assessed') and v_role not in ('city_officer','admin') then
    raise exception 'FORBIDDEN: % cannot move an incident to %', v_role, p_to using errcode = '42501';
  end if;
  if p_to in ('approved','in_progress') then
    raise exception 'FORBIDDEN: % is set by plan approval / workflow only', p_to using errcode = '42501';
  end if;
  if p_to = 'assessed' and v_inc.risk_score is null then
    raise exception 'INVALID_STATE: run AI risk assessment before marking assessed' using errcode = '23514';
  end if;
  if p_to = 'rejected' and coalesce(trim(p_note), '') = '' then
    raise exception 'VALIDATION: a reason is required to reject' using errcode = '22023';
  end if;
  if p_to = 'duplicate' then
    if p_duplicate_of is null or p_duplicate_of = p_incident_id then
      raise exception 'VALIDATION: choose a different parent incident' using errcode = '22023';
    end if;
  end if;
  if p_to = 'resolved' and exists (
      select 1 from tasks where incident_id = p_incident_id and status not in ('completed','cancelled','failed')) then
    raise exception 'INVALID_STATE: open field tasks must be completed first' using errcode = '23514';
  end if;

  perform set_config('rm.note', coalesce(p_note, ''), true);
  update incidents
     set status = p_to,
         duplicate_of = case when p_to = 'duplicate' then p_duplicate_of else duplicate_of end,
         verified_by = case when p_to = 'verified' then auth.uid() else verified_by end
   where id = p_incident_id
   returning * into v_inc;

  return jsonb_build_object('ok', true, 'incident', to_jsonb(v_inc));
end $$;

-- =====================================================================
-- Plan approval: atomically approve + transition incidents + enqueue run
-- =====================================================================
create or replace function public.approve_plan(
  p_plan_id uuid, p_expected_version integer, p_inject_failure text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_plan allocation_plans;
  v_run  workflow_runs;
  v_bad  integer;
begin
  if v_role not in ('city_officer','ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only coordinators can approve plans' using errcode = '42501';
  end if;
  if p_inject_failure is not null and v_role <> 'admin' then
    raise exception 'FORBIDDEN: fault injection is admin-only' using errcode = '42501';
  end if;
  if p_inject_failure is not null and p_inject_failure not in ('reserve_resources','create_tasks','notify_teams','activate_incidents') then
    raise exception 'VALIDATION: unknown step %', p_inject_failure using errcode = '22023';
  end if;

  select * into v_plan from allocation_plans where id = p_plan_id for update;
  if not found then raise exception 'NOT_FOUND: plan' using errcode = 'P0002'; end if;

  -- idempotent approve: second click returns the same run
  if v_plan.status in ('approved','executing','executed') then
    select * into v_run from workflow_runs where plan_id = p_plan_id;
    return jsonb_build_object('ok', true, 'replayed', true, 'run_id', v_run.id);
  end if;
  if v_plan.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_plan));
  end if;
  if v_plan.status <> 'pending_approval' then
    raise exception 'INVALID_STATE: plan is %', v_plan.status using errcode = '23514';
  end if;
  if jsonb_array_length(v_plan.assignments) = 0 then
    raise exception 'INFEASIBLE: plan has no assignments and cannot be approved' using errcode = '23514';
  end if;
  if v_plan.created_at < now() - interval '2 hours' then
    raise exception 'STALE_PLAN: plan is older than 2 hours, re-run optimization' using errcode = '23514';
  end if;

  select count(*) into v_bad from incidents
  where id = any(v_plan.incident_ids) and status <> 'assessed';
  if v_bad > 0 then
    raise exception 'INVALID_STATE: % incident(s) in this plan are no longer in assessed state', v_bad
      using errcode = '23514';
  end if;

  update allocation_plans set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_plan_id;

  -- supersede other pending plans touching the same incidents
  update allocation_plans set status = 'superseded'
  where id <> p_plan_id and status = 'pending_approval' and incident_ids && v_plan.incident_ids;

  perform set_config('rm.note', 'Plan approved', true);
  update incidents set status = 'approved' where id = any(v_plan.incident_ids);

  insert into workflow_runs(plan_id, idempotency_key, inject_failure, created_by)
  values (p_plan_id, 'plan:' || p_plan_id, p_inject_failure, auth.uid())
  on conflict (idempotency_key) do nothing
  returning * into v_run;
  if v_run.id is null then
    select * into v_run from workflow_runs where idempotency_key = 'plan:' || p_plan_id;
  end if;

  perform pg_notify('workflow_runs', v_run.id::text);
  return jsonb_build_object('ok', true, 'replayed', false, 'run_id', v_run.id);
end $$;

create or replace function public.reject_plan(p_plan_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan allocation_plans;
begin
  if rm_role() not in ('city_officer','ngo_coordinator','admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: reason required' using errcode = '22023';
  end if;
  update allocation_plans set status = 'rejected', rejection_reason = p_reason
  where id = p_plan_id and status = 'pending_approval' returning * into v_plan;
  if v_plan.id is null then raise exception 'INVALID_STATE: plan is not pending' using errcode = '23514'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- admin: retry a failed / compensated run
create or replace function public.retry_workflow_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run workflow_runs;
begin
  if rm_role() not in ('admin','city_officer') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_run from workflow_runs where id = p_run_id for update;
  if v_run.status not in ('failed','compensated') then
    raise exception 'INVALID_STATE: only failed runs can be retried' using errcode = '23514';
  end if;
  -- incidents were rolled back to 'assessed' by compensation; re-approve them
  perform set_config('rm.note', 'Workflow retry', true);
  update incidents i set status = 'approved'
    from allocation_plans p
   where p.id = v_run.plan_id and i.id = any(p.incident_ids) and i.status = 'assessed';
  update allocation_plans set status = 'approved' where id = v_run.plan_id;
  update workflow_runs set status = 'queued', attempts = 0, last_error = null, inject_failure = null,
         generation = generation + 1,
         next_run_at = now(), finished_at = null, locked_by = null
   where id = p_run_id;
  update workflow_steps set status = 'pending', error = null where run_id = p_run_id and status in ('failed','compensated');
  perform pg_notify('workflow_runs', p_run_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- worker: claim one runnable job (SKIP LOCKED queue; stale locks are reclaimed)
create or replace function public.rm_claim_workflow_run(p_worker text)
returns workflow_runs language plpgsql security definer set search_path = public as $$
declare v_run workflow_runs;
begin
  select * into v_run from workflow_runs
  where (status in ('queued','retrying') and next_run_at <= now())
     or (status in ('running','compensating') and locked_at < now() - interval '5 minutes')
  order by next_run_at
  limit 1
  for update skip locked;
  if not found then return null; end if;
  update workflow_runs
     set status = case when status = 'compensating' then 'compensating'::run_status else 'running'::run_status end,
         locked_by = p_worker, locked_at = now(),
         attempts = attempts + 1, started_at = coalesce(started_at, now())
   where id = v_run.id returning * into v_run;
  return v_run;
end $$;
revoke execute on function public.rm_claim_workflow_run(text) from public, anon, authenticated;

-- =====================================================================
-- Field task updates: version-checked, offline-sync friendly
-- =====================================================================
create or replace function public.rm_task_transition_allowed(p_from task_status, p_to task_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'pending'     then p_to in ('assigned','cancelled')
    when 'assigned'    then p_to in ('accepted','in_progress','cancelled')
    when 'accepted'    then p_to in ('in_progress','cancelled')
    when 'in_progress' then p_to in ('completed','failed','cancelled')
    when 'failed'      then p_to in ('assigned','in_progress')
    else false
  end
$$;

create or replace function public.update_task_status(
  p_task_id uuid, p_status task_status, p_expected_version integer,
  p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_task tasks;
  v_open integer;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;

  if not (v_role in ('city_officer','admin') or (v_role = 'field_worker' and v_task.assigned_to = auth.uid())) then
    raise exception 'FORBIDDEN: task is assigned to another worker' using errcode = '42501';
  end if;
  if p_status = 'cancelled' and v_role = 'field_worker' then
    raise exception 'FORBIDDEN: field workers cannot cancel tasks' using errcode = '42501';
  end if;

  if v_task.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_task));
  end if;

  if p_status <> v_task.status and not rm_task_transition_allowed(v_task.status, p_status) then
    raise exception 'INVALID_TRANSITION: task % -> %', v_task.status, p_status using errcode = '23514';
  end if;
  if p_status = 'failed' and coalesce(trim(p_notes), '') = '' then
    raise exception 'VALIDATION: describe why the task failed' using errcode = '22023';
  end if;

  update tasks set
    status = p_status,
    notes = case when p_notes is null then notes
                 when notes is null then p_notes
                 when position(p_notes in notes) > 0 then notes
                 else notes || E'\n' || p_notes end,
    started_at = case when p_status = 'in_progress' and started_at is null then now() else started_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_task_id returning * into v_task;

  -- all tasks of the incident completed -> resolve incident, return reusable equipment
  if p_status = 'completed' then
    select count(*) into v_open from tasks
     where incident_id = v_task.incident_id and status not in ('completed','cancelled');
    if v_open = 0 then
      perform set_config('rm.note', 'All field tasks completed', true);
      update incidents set status = 'resolved' where id = v_task.incident_id and status = 'in_progress';
      perform rm_release_allocation(a.id, 'incident resolved — equipment returned')
        from allocations a join resources r on r.id = a.resource_id
       where a.incident_id = v_task.incident_id and a.status in ('reserved','dispatched')
         and r.resource_type in ('pump','crew','boat','water_tank');
      update allocations a set status = 'consumed'
        from resources r
       where r.id = a.resource_id and a.incident_id = v_task.incident_id
         and a.status in ('reserved','dispatched')
         and r.resource_type in ('relief_kit','sandbag','medical_kit');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_task));
end $$;

-- =====================================================================
-- Geospatial helpers
-- =====================================================================
create or replace function public.nearby_incidents(p_lat double precision, p_lng double precision, p_radius_m integer default 500)
returns table(id uuid, reference_code text, category incident_category, status incident_status, distance_m double precision, created_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select i.id, i.reference_code, i.category, i.status,
         st_distance(i.location, st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography) as distance_m,
         i.created_at
  from incidents i
  where st_dwithin(i.location, st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography, least(p_radius_m, 5000))
  order by distance_m
  limit 50
$$;

-- Public ward-level aggregate (no personal data) — visible to every signed-in user
create or replace function public.ward_risk_summary()
returns table(ward_id text, name text, city_corporation text, lat double precision, lng double precision,
              population integer, risk_score numeric, risk_level risk_level, risk_updated_at timestamptz,
              active_incidents bigint, critical_incidents bigint)
language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.city_corporation, w.lat, w.lng, w.population,
         w.current_risk_score, w.current_risk_level, w.risk_updated_at,
         count(i.id) filter (where i.status in ('reported','verified','assessed','approved','in_progress')),
         count(i.id) filter (where i.status in ('verified','assessed','approved','in_progress') and i.risk_level = 'critical')
  from wards w
  left join incidents i on i.ward_id = w.id
  group by w.id
  order by w.current_risk_score desc nulls last
$$;
revoke execute on function public.ward_risk_summary() from anon;

-- =====================================================================
-- A08 analytics: indexed aggregates over live + large historical data
-- =====================================================================
create or replace function public.analytics_dashboard(p_days integer default 30, p_ward text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz;
  v_out  jsonb;
begin
  if not rm_is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'VALIDATION: days must be between 1 and 3650' using errcode = '22023';
  end if;
  v_from := now() - make_interval(days => p_days);

  with inc as (
    select * from incidents
    where created_at >= v_from and (p_ward is null or ward_id = p_ward)
  )
  select jsonb_build_object(
    'generated_at', now(),
    'window_days', p_days,
    'totals', (select jsonb_build_object(
        'incidents', count(*),
        'active', count(*) filter (where status in ('reported','verified','assessed','approved','in_progress')),
        'resolved', count(*) filter (where status = 'resolved'),
        'duplicates', count(*) filter (where status = 'duplicate'),
        'critical', count(*) filter (where risk_level = 'critical'),
        'people_affected', coalesce(sum(people_affected) filter (where status <> 'duplicate'), 0),
        'avg_risk', round(avg(risk_score)::numeric, 1),
        'avg_resolution_hours', round((extract(epoch from avg(resolved_at - created_at)) / 3600)::numeric, 1),
        'p90_resolution_hours', round((percentile_cont(0.9) within group (order by extract(epoch from resolved_at - created_at)) / 3600)::numeric, 1)
      ) from inc),
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from inc group by status) s),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', c) order by c desc), '[]'::jsonb)
                    from (select category, count(*) c from inc where status <> 'duplicate' group by category) s),
    'by_ward', (select coalesce(jsonb_agg(row_to_json(s) order by s.incidents desc), '[]'::jsonb) from (
                  select w.id as ward_id, w.name, count(inc.id) as incidents,
                         round(avg(inc.risk_score)::numeric,1) as avg_risk,
                         count(inc.id) filter (where inc.risk_level in ('high','critical')) as high_risk,
                         w.current_risk_score
                  from wards w left join inc on inc.ward_id = w.id
                  where p_ward is null or w.id = p_ward
                  group by w.id) s),
    'daily', (select coalesce(jsonb_agg(row_to_json(d) order by d.day), '[]'::jsonb) from (
                select g::date as day,
                       count(inc.id) filter (where inc.status <> 'duplicate') as reported,
                       count(inc.id) filter (where inc.status = 'resolved') as resolved
                from generate_series(date_trunc('day', v_from), date_trunc('day', now()), interval '1 day') g
                left join inc on date_trunc('day', inc.created_at) = g
                group by g) d),
    'resources', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (
                select resource_type, sum(quantity_total) as total, sum(quantity_available) as available,
                       round(100.0 * (sum(quantity_total) - sum(quantity_available)) / nullif(sum(quantity_total),0), 1) as utilization_pct
                from resources group by resource_type order by resource_type) r),
    'workflows', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from workflow_runs where created_at >= v_from group by status) s),
    'historical', jsonb_build_object(
        'total_records', (select count(*) from historical_flood_events where p_ward is null or ward_id = p_ward),
        'monthly', (select coalesce(jsonb_agg(row_to_json(m) order by m.month), '[]'::jsonb) from (
            select extract(month from event_date)::int as month,
                   count(*) as events,
                   round(avg(rainfall_mm)::numeric,1) as avg_rainfall_mm,
                   round(avg(max_depth_cm)::numeric,1) as avg_depth_cm
            from historical_flood_events
            where p_ward is null or ward_id = p_ward
            group by 1) m),
        'yearly', (select coalesce(jsonb_agg(row_to_json(y) order by y.year), '[]'::jsonb) from (
            select extract(year from event_date)::int as year, count(*) as events,
                   coalesce(sum(households_affected),0) as households
            from historical_flood_events
            where p_ward is null or ward_id = p_ward
            group by 1) y)
    )
  ) into v_out;
  return v_out;
end $$;

grant execute on function public.allocate_to_need(uuid,uuid,integer,text) to authenticated;
grant execute on function public.transition_incident(uuid,incident_status,integer,text,uuid) to authenticated;
grant execute on function public.approve_plan(uuid,integer,text) to authenticated;
grant execute on function public.reject_plan(uuid,text) to authenticated;
grant execute on function public.retry_workflow_run(uuid) to authenticated;
grant execute on function public.update_task_status(uuid,task_status,integer,text) to authenticated;
grant execute on function public.nearby_incidents(double precision,double precision,integer) to authenticated;
grant execute on function public.ward_risk_summary() to authenticated;
grant execute on function public.analytics_dashboard(integer,text) to authenticated;

-- ================= migrations/005_realtime.sql =================
-- =====================================================================
-- ResilioMesh — 005 Supabase Realtime publication
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['incidents','tasks','resources','allocation_plans','workflow_runs',
                           'workflow_steps','community_needs','wards','drainage_assets',
                           'profiles','allocations'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;           -- already published
      when undefined_object then
        raise notice 'publication supabase_realtime missing (not a Supabase DB?)';
    end;
  end loop;
end $$;

-- full row images so UPDATE events carry the previous version for conflict UI
alter table incidents replica identity full;
alter table tasks replica identity full;
alter table resources replica identity full;

-- ================= seed.sql =================
-- =====================================================================
-- ResilioMesh — reference seed data (run AFTER migrations 001-005)
-- Demo users + sample incidents are created by scripts/seed_demo.py
-- Organisation names are fictional demo entities.
-- =====================================================================

insert into organizations (id, name, type, contact_phone) values
  ('11111111-1111-1111-1111-111111111101', 'North Dhaka Drainage Authority',  'city_authority', '+8801700000101'),
  ('11111111-1111-1111-1111-111111111102', 'South Dhaka Drainage Authority',  'city_authority', '+8801700000102'),
  ('11111111-1111-1111-1111-111111111103', 'Shobar Jonno Relief Network',     'ngo',            '+8801700000103'),
  ('11111111-1111-1111-1111-111111111104', 'Nodi Humanitarian Foundation',    'ngo',            '+8801700000104'),
  ('11111111-1111-1111-1111-111111111105', 'ResilioMesh Platform Ops',        'system',         '+8801700000105')
on conflict (id) do nothing;

-- Dhaka wards / localities (approximate centroids). Hydrological attributes
-- are modelled estimates for the demo (see README > Data & limitations).
insert into wards (id, name, city_corporation, lat, lng, population, area_km2, elevation_m, impervious_pct, drainage_capacity_mm_hr, historical_events_10y) values
  ('DNCC-01','Uttara Sector 7',    'DNCC',23.8759,90.3795,182000, 4.10, 7.8, 71, 38, 14),
  ('DNCC-02','Mirpur 10',          'DNCC',23.8069,90.3687,265000, 3.20, 6.1, 86, 26, 41),
  ('DNCC-03','Pallabi',            'DNCC',23.8262,90.3647,231000, 3.60, 6.4, 82, 28, 33),
  ('DNCC-04','Mohammadpur',        'DNCC',23.7662,90.3589,248000, 4.40, 5.9, 80, 27, 29),
  ('DNCC-05','Tejgaon',            'DNCC',23.7590,90.3926,154000, 3.10, 6.3, 88, 30, 22),
  ('DNCC-06','Gulshan',            'DNCC',23.7925,90.4078,118000, 4.60, 6.9, 74, 42, 12),
  ('DNCC-07','Badda',              'DNCC',23.7806,90.4265,276000, 5.20, 5.4, 79, 24, 37),
  ('DNCC-08','Rampura',            'DNCC',23.7613,90.4206,221000, 3.40, 5.2, 84, 23, 39),
  ('DNCC-09','Kawran Bazar',       'DNCC',23.7509,90.3935,96000,  1.60, 5.6, 93, 25, 44),
  ('DNCC-10','Mohakhali',          'DNCC',23.7780,90.4005,134000, 2.30, 6.6, 85, 33, 18),
  ('DSCC-01','Dhanmondi',          'DSCC',23.7461,90.3742,168000, 3.90, 6.8, 78, 36, 21),
  ('DSCC-02','Shantinagar',        'DSCC',23.7392,90.4140,141000, 1.40, 4.9, 92, 21, 52),
  ('DSCC-03','Malibagh',           'DSCC',23.7487,90.4130,158000, 1.80, 5.0, 90, 22, 47),
  ('DSCC-04','Motijheel',          'DSCC',23.7330,90.4172,87000,  1.70, 5.3, 94, 29, 35),
  ('DSCC-05','Mugda',              'DSCC',23.7310,90.4310,203000, 2.60, 4.6, 83, 19, 49),
  ('DSCC-06','Jatrabari',          'DSCC',23.7104,90.4349,295000, 3.80, 4.4, 81, 18, 46),
  ('DSCC-07','Bangshal (Old Dhaka)','DSCC',23.7176,90.4060,192000, 1.50, 5.1, 95, 20, 38),
  ('DSCC-08','Lalbagh',            'DSCC',23.7186,90.3880,176000, 1.90, 5.5, 91, 24, 31),
  ('DSCC-09','Hazaribagh',         'DSCC',23.7340,90.3650,149000, 2.20, 4.8, 76, 23, 28),
  ('DSCC-10','Kamrangirchar',      'DSCC',23.7130,90.3720,214000, 3.70, 3.9, 72, 16, 43)
on conflict (id) do nothing;

-- Drainage assets
insert into drainage_assets (code, name, asset_type, ward_id, owner_org_id, lat, lng, capacity_m3s, condition_score, status, last_maintained_at) values
  ('DR-MRP-001','Mirpur 10 Roundabout Box Culvert','culvert','DNCC-02','11111111-1111-1111-1111-111111111101',23.8072,90.3684,4.5,38,'blocked',  now()-interval '210 days'),
  ('DR-MRP-002','Begum Rokeya Sarani Storm Drain','drain','DNCC-02','11111111-1111-1111-1111-111111111101',23.8001,90.3702,2.2,55,'degraded',   now()-interval '120 days'),
  ('DR-PLB-001','Pallabi Sector 12 Drain',      'drain','DNCC-03','11111111-1111-1111-1111-111111111101',23.8270,90.3655,1.8,61,'operational',now()-interval '75 days'),
  ('CN-MHP-001','Ramchandrapur Canal',           'canal','DNCC-04','11111111-1111-1111-1111-111111111101',23.7650,90.3520,9.0,44,'degraded',   now()-interval '300 days'),
  ('PS-TEJ-001','Tejgaon Industrial Pump Station','pump_station','DNCC-05','11111111-1111-1111-1111-111111111101',23.7602,90.3990,12.0,72,'operational',now()-interval '40 days'),
  ('CN-GUL-001','Gulshan Lake Outfall',          'sluice_gate','DNCC-06','11111111-1111-1111-1111-111111111101',23.7950,90.4130,7.5,80,'operational',now()-interval '30 days'),
  ('CN-BAD-001','Begunbari Canal Section B',     'canal','DNCC-07','11111111-1111-1111-1111-111111111101',23.7790,90.4300,14.0,35,'blocked',  now()-interval '400 days'),
  ('DR-RAM-001','DIT Road Storm Drain',          'drain','DNCC-08','11111111-1111-1111-1111-111111111101',23.7620,90.4190,2.0,42,'degraded',   now()-interval '190 days'),
  ('DR-KWB-001','Kawran Bazar Kitchen Market Drain','drain','DNCC-09','11111111-1111-1111-1111-111111111101',23.7512,90.3928,1.5,29,'blocked',now()-interval '260 days'),
  ('PS-KWB-001','Panthapath Pump Station',       'pump_station','DNCC-09','11111111-1111-1111-1111-111111111101',23.7525,90.3870,8.0,58,'degraded',now()-interval '90 days'),
  ('DR-MHK-001','Mohakhali Bus Terminal Drain',  'drain','DNCC-10','11111111-1111-1111-1111-111111111101',23.7785,90.4010,1.9,63,'operational',now()-interval '60 days'),
  ('DR-DHN-001','Satmasjid Road Storm Drain',    'drain','DSCC-01','11111111-1111-1111-1111-111111111102',23.7455,90.3720,2.4,66,'operational',now()-interval '55 days'),
  ('RP-DHN-001','Dhanmondi Lake Retention',      'retention_pond','DSCC-01','11111111-1111-1111-1111-111111111102',23.7470,90.3780,20.0,77,'operational',now()-interval '45 days'),
  ('DR-SHN-001','Shantinagar Bazar Drain',       'drain','DSCC-02','11111111-1111-1111-1111-111111111102',23.7395,90.4138,1.2,24,'blocked',  now()-interval '330 days'),
  ('DR-SHN-002','Kakrail Box Culvert',           'culvert','DSCC-02','11111111-1111-1111-1111-111111111102',23.7378,90.4085,3.8,47,'degraded',now()-interval '150 days'),
  ('DR-MLB-001','Malibagh Railgate Drain',       'drain','DSCC-03','11111111-1111-1111-1111-111111111102',23.7490,90.4150,1.4,33,'blocked',  now()-interval '280 days'),
  ('DR-MTJ-001','Motijheel C/A Storm Drain',     'drain','DSCC-04','11111111-1111-1111-1111-111111111102',23.7325,90.4180,2.6,58,'operational',now()-interval '100 days'),
  ('PS-MUG-001','Manda Canal Pump Station',      'pump_station','DSCC-05','11111111-1111-1111-1111-111111111102',23.7290,90.4360,10.0,51,'degraded',now()-interval '140 days'),
  ('CN-MUG-001','Manda Canal',                   'canal','DSCC-05','11111111-1111-1111-1111-111111111102',23.7280,90.4400,16.0,39,'degraded',now()-interval '365 days'),
  ('CN-JAT-001','Jatrabari–Shyampur Canal',      'canal','DSCC-06','11111111-1111-1111-1111-111111111102',23.7080,90.4380,11.0,31,'blocked',now()-interval '420 days'),
  ('PS-JAT-001','Dholaikhal Pump Station',       'pump_station','DSCC-06','11111111-1111-1111-1111-111111111102',23.7120,90.4250,9.0,64,'operational',now()-interval '70 days'),
  ('DR-BNG-001','Nayabazar Storm Drain',         'drain','DSCC-07','11111111-1111-1111-1111-111111111102',23.7180,90.4045,1.1,36,'degraded',now()-interval '240 days'),
  ('DR-LAL-001','Lalbagh Fort Road Drain',       'drain','DSCC-08','11111111-1111-1111-1111-111111111102',23.7190,90.3885,1.3,52,'operational',now()-interval '110 days'),
  ('SG-HAZ-001','Hazaribagh Sluice Gate',        'sluice_gate','DSCC-09','11111111-1111-1111-1111-111111111102',23.7330,90.3600,6.0,46,'degraded',now()-interval '200 days'),
  ('CN-KMR-001','Kamrangirchar Embankment Drain','canal','DSCC-10','11111111-1111-1111-1111-111111111102',23.7120,90.3700,5.0,27,'blocked',now()-interval '500 days')
on conflict (code) do nothing;

-- Resource inventory (city authorities own pumps & crews, NGOs own relief)
insert into resources (organization_id, resource_type, name, unit, quantity_total, quantity_available, base_ward_id, lat, lng) values
  ('11111111-1111-1111-1111-111111111101','pump','North Mobile Dewatering Pumps (6")','pump',8,8,'DNCC-05',23.7602,90.3990),
  ('11111111-1111-1111-1111-111111111101','pump','Mirpur Depot Portable Pumps','pump',4,4,'DNCC-02',23.8050,90.3690),
  ('11111111-1111-1111-1111-111111111101','crew','North Drain Clearing Crew','crew',6,6,'DNCC-05',23.7600,90.3950),
  ('11111111-1111-1111-1111-111111111101','sandbag','North Sandbag Stock','bag',1500,1500,'DNCC-05',23.7595,90.3960),
  ('11111111-1111-1111-1111-111111111102','pump','South Heavy Pumps (8")','pump',6,6,'DSCC-06',23.7120,90.4250),
  ('11111111-1111-1111-1111-111111111102','pump','Motijheel Emergency Pump','pump',1,1,'DSCC-04',23.7330,90.4172),
  ('11111111-1111-1111-1111-111111111102','crew','South Drain Clearing Crew','crew',7,7,'DSCC-04',23.7320,90.4170),
  ('11111111-1111-1111-1111-111111111102','boat','South Rescue Boats','boat',3,3,'DSCC-10',23.7130,90.3720),
  ('11111111-1111-1111-1111-111111111103','relief_kit','Family Dry-Food Kit (7 days)','kit',420,420,'DSCC-01',23.7461,90.3742),
  ('11111111-1111-1111-1111-111111111103','water_tank','Mobile Drinking Water Tank','tank',5,5,'DSCC-01',23.7461,90.3742),
  ('11111111-1111-1111-1111-111111111103','medical_kit','Waterborne Disease Kit (ORS/Zinc)','kit',300,300,'DNCC-04',23.7662,90.3589),
  ('11111111-1111-1111-1111-111111111104','relief_kit','Emergency Hygiene + Food Kit','kit',260,260,'DSCC-05',23.7310,90.4310),
  ('11111111-1111-1111-1111-111111111104','medical_kit','First-Aid Kit','kit',150,150,'DNCC-07',23.7806,90.4265)
on conflict (organization_id, name) do nothing;

-- ---------------------------------------------------------------------
-- Historical flood events: ~10 years x 20 wards, deterministic synthetic
-- record generated from ward vulnerability + monsoon seasonality.
-- (~12-18k rows; /api/analytics/import can load 100k+ more for A08.)
-- ---------------------------------------------------------------------
select setseed(0.42);
insert into historical_flood_events (ward_id, event_date, rainfall_mm, max_depth_cm, duration_hr, households_affected, source, record_hash)
select w.id, d::date,
       round((rain)::numeric, 1),
       greatest(5, round(rain * (0.35 + (100 - w.drainage_capacity_mm_hr)/180.0) + random()*15))::int,
       round((1 + rain / greatest(w.drainage_capacity_mm_hr,1) * 2.2 + random()*3)::numeric, 1),
       round(w.population / 4.3 * least(0.25, rain / 900.0) * (0.6 + random()*0.8))::int,
       'seed:synthetic-v1',
       md5(w.id || d::date::text)
from wards w
cross join generate_series('2015-01-01'::date, '2024-12-31'::date, interval '1 day') d
cross join lateral (
  select case
    when extract(month from d) between 6 and 9 then  power(random(), 3) * 190
    when extract(month from d) in (5,10)       then  power(random(), 3) * 120
    else power(random(), 4) * 60 end as rain
) r
where rain > w.drainage_capacity_mm_hr * 1.15
on conflict (record_hash) do nothing;

-- initial ward risk baseline (refreshed by backend /api/risk/wards/refresh)
update wards set
  current_risk_score = least(95, round((historical_events_10y * 1.1 + (100 - drainage_capacity_mm_hr) * 0.35 + impervious_pct * 0.15)::numeric, 1)),
  risk_updated_at = now();
update wards set current_risk_level = case
  when current_risk_score >= 75 then 'critical'::risk_level
  when current_risk_score >= 55 then 'high'::risk_level
  when current_risk_score >= 35 then 'moderate'::risk_level
  else 'low'::risk_level end;

-- ================= migrations/006_role_requests.sql =================
-- =====================================================================
-- ResilioMesh — 006 role-based registration (staff access requests)
-- ---------------------------------------------------------------------
-- Every self-registered account still starts as 'citizen' (no privilege
-- escalation). If the sign-up form asked for a staff role, a pending
-- role_request is filed with the role-specific details; an admin approves
-- it from Admin → Access requests, which then grants the role + org.
-- Admin accounts can never be requested from the public form.
-- =====================================================================

create table if not exists role_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  requested_role    app_role not null check (requested_role in ('city_officer','ngo_coordinator','field_worker')),
  organization_id   uuid references organizations(id) on delete set null,
  organization_name text check (organization_name is null or char_length(organization_name) between 3 and 120),
  employee_id       text check (employee_id is null or employee_id ~ '^[A-Za-z0-9/-]{3,30}$'),
  designation       text check (designation is null or char_length(designation) between 2 and 80),
  registration_no   text check (registration_no is null or char_length(registration_no) between 3 and 40),
  team              text check (team is null or char_length(team) <= 60),
  ward_id           text references wards(id) on delete set null,
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note       text check (review_note is null or char_length(review_note) <= 300),
  reviewed_by       uuid references profiles(id),
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);
create unique index if not exists uq_role_requests_one_pending on role_requests(user_id) where status = 'pending';
create index if not exists idx_role_requests_status on role_requests(status, created_at desc);

alter table role_requests enable row level security;
grant select on role_requests to authenticated;
drop policy if exists role_requests_read on role_requests;
create policy role_requests_read on role_requests for select to authenticated
  using (user_id = auth.uid() or rm_role() = 'admin');
-- no insert/update/delete policies: rows are created by the sign-up trigger and
-- changed only through rm_review_role_request() below.

drop trigger if exists trg_audit_role_requests on role_requests;
create trigger trg_audit_role_requests after insert or update or delete on role_requests
  for each row execute function rm_audit();

-- Public (anon) list of organisations for the sign-up form: id / name / type only.
create or replace function public.rm_public_organizations()
returns table (id uuid, name text, type org_type)
language sql stable security definer set search_path = public as $$
  select id, name, type from organizations where type in ('city_authority','ngo') order by name
$$;
grant execute on function public.rm_public_organizations() to anon, authenticated;

-- ---------- New auth user -> citizen profile (+ optional role request) ----
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_ward text;
  v_role text;
  v_org  uuid;
begin
  v_ward := nullif(m->>'ward_id', '');
  if v_ward is not null and not exists (select 1 from wards where id = v_ward) then
    v_ward := null;
  end if;

  insert into profiles (id, full_name, email, phone, role, ward_id)
  values (
    new.id,
    coalesce(nullif(trim(m->>'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(m->>'phone', ''),
    'citizen',                      -- always citizen; staff roles need admin approval
    v_ward
  )
  on conflict (id) do nothing;

  v_role := nullif(m->>'requested_role', '');
  if v_role in ('city_officer','ngo_coordinator','field_worker') then
    begin
      v_org := nullif(m->>'organization_id', '')::uuid;
    exception when others then v_org := null;
    end;
    if v_org is not null and not exists (select 1 from organizations where id = v_org) then
      v_org := null;
    end if;
    begin
      insert into role_requests (user_id, requested_role, organization_id, organization_name,
                                 employee_id, designation, registration_no, team, ward_id)
      values (
        new.id, v_role::app_role, v_org,
        left(nullif(trim(m->>'organization_name'), ''), 120),
        left(nullif(trim(m->>'employee_id'), ''), 30),
        left(nullif(trim(m->>'designation'), ''), 80),
        left(nullif(trim(m->>'registration_no'), ''), 40),
        left(nullif(trim(m->>'team'), ''), 60),
        v_ward
      );
    exception when check_violation or unique_violation then
      null;   -- malformed staff details must never block account creation (profile is kept)
    end;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Admin review --------------------------------------------
create or replace function public.rm_review_role_request(
  p_id uuid, p_approve boolean, p_org_id uuid default null, p_note text default null)
returns role_requests
language plpgsql security definer set search_path = public as $$
declare r role_requests;
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can review access requests' using errcode = '42501';
  end if;
  select * into r from role_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: access request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then
    raise exception 'CONFLICT: this request was already %', r.status using errcode = '40001';
  end if;

  if p_approve then
    update profiles
       set role = r.requested_role,
           organization_id = coalesce(p_org_id, r.organization_id, organization_id),
           ward_id = coalesce(r.ward_id, ward_id)
     where id = r.user_id;
  end if;

  update role_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         organization_id = coalesce(p_org_id, organization_id),
         review_note = left(nullif(trim(p_note), ''), 300),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_id
  returning * into r;
  return r;
end $$;
grant execute on function public.rm_review_role_request(uuid, boolean, uuid, text) to authenticated;

-- realtime: the requester's login screen / admin queue update live
do $$ begin
  alter publication supabase_realtime add table role_requests;
exception when others then null; end $$;

-- ================= migrations/007_staff_login_ids.sql =================
-- =====================================================================
-- ResilioMesh — 007 role-specific sign-in identifiers
-- ---------------------------------------------------------------------
-- Staff sign in with email + password + their role identifier:
--   City Officer → Employee ID · Field Worker → Staff ID · Admin → Admin ID
--   NGO Coordinator → their NGO (profiles.organization_id)
-- The identifier lives on the profile, is set when an admin approves an
-- access request (or by an admin directly) and cannot be self-edited.
-- Run after 006_role_requests.sql.
-- =====================================================================

alter table profiles add column if not exists employee_id text
  check (employee_id is null or employee_id ~ '^[A-Za-z0-9/-]{3,30}$');
create unique index if not exists uq_profiles_employee_id on profiles (upper(employee_id)) where employee_id is not null;

-- Only admins (or the backend/system) may change role / org / active flag / staff ID.
create or replace function public.rm_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if rm_is_system() then return new; end if;
  if (new.role is distinct from old.role
      or new.organization_id is distinct from old.organization_id
      or new.is_active is distinct from old.is_active
      or new.employee_id is distinct from old.employee_id)
     and coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can change role, organization, staff ID or account status'
      using errcode = '42501';
  end if;
  if new.id = auth.uid() and new.role is distinct from old.role then
    raise exception 'FORBIDDEN: admins cannot change their own role' using errcode = '42501';
  end if;
  return new;
end $$;

-- Approving an access request now also copies the Employee / Staff ID to the profile.
create or replace function public.rm_review_role_request(
  p_id uuid, p_approve boolean, p_org_id uuid default null, p_note text default null)
returns role_requests
language plpgsql security definer set search_path = public as $$
declare r role_requests;
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can review access requests' using errcode = '42501';
  end if;
  select * into r from role_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: access request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then
    raise exception 'CONFLICT: this request was already %', r.status using errcode = '40001';
  end if;

  if p_approve then
    if r.employee_id is not null and exists (
         select 1 from profiles where upper(employee_id) = upper(r.employee_id) and id <> r.user_id) then
      raise exception 'CONFLICT: staff ID % is already used by another account', r.employee_id using errcode = '23505';
    end if;
    update profiles
       set role = r.requested_role,
           organization_id = coalesce(p_org_id, r.organization_id, organization_id),
           ward_id = coalesce(r.ward_id, ward_id),
           employee_id = coalesce(r.employee_id, employee_id)
     where id = r.user_id;
  end if;

  update role_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         organization_id = coalesce(p_org_id, organization_id),
         review_note = left(nullif(trim(p_note), ''), 300),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_id
  returning * into r;
  return r;
end $$;
grant execute on function public.rm_review_role_request(uuid, boolean, uuid, text) to authenticated;

-- Demo accounts (judges): give every staff account its sign-in ID.
update profiles p set employee_id = d.eid
from (values
  ('admin@resiliomesh.demo',    'ADM-001'),
  ('officer@resiliomesh.demo',  'DSCC-OFF-01'),
  ('officer2@resiliomesh.demo', 'DNCC-OFF-02'),
  ('field1@resiliomesh.demo',   'FW-001'),
  ('field2@resiliomesh.demo',   'FW-002'),
  ('field3@resiliomesh.demo',   'FW-003')
) as d(email, eid)
where p.email = d.email and p.employee_id is null;

-- ================= migrations/008_identity_verification.sql =================
-- =====================================================================
-- ResilioMesh — 008 identity verification & anti-impersonation
-- ---------------------------------------------------------------------
-- Closes the gaps in the staff / citizen identity model:
--   1. Staff ID was only checked in the browser
--        → staff privileges are bound to a server-verified session.
--          A password-only session (e.g. straight to the Supabase API) gets
--          citizen-level access until rm_verify_staff_login() accepts the
--          Employee / Staff / Admin ID (or the NGO), and — when the account
--          has an authenticator app or its role requires one — until the
--          session reaches AAL2 (TOTP).
--   2. Official e-mail domains   → organizations.email_domains, enforced on
--                                  sign-up and again on approval
--   3. Employee ID roster         → staff_roster + live "Verified / flag" check
--   4. NGOAB registration         → ngo_registry + live check
--   5. ID card / appointment letter → private storage bucket + documents table
--   6. Single-admin approval      → role_request_approvals, two different
--                                  admins for sensitive / flagged requests;
--                                  admins can no longer promote directly
--   7. Phone                      → Bangladeshi mobiles only (+8801XXXXXXXXX),
--                                  OTP-verified flag synced from auth.users
--   8. Citizen country / GPS spoofing → Dhaka service area, location ↔ ward
--                                  check, per-citizen rate limits, trust flags
--                                  (foreign / Tor network, outside home area)
-- Tunables live in security_settings (one row, editable only from the SQL
-- editor / service connection, never from the browser).
-- Run after 007_staff_login_ids.sql. Re-runnable.
-- =====================================================================

-- ---------- 0. Security settings -------------------------------------
create table if not exists security_settings (
  id                          boolean primary key default true check (id),
  staff_session_hours         integer not null default 12 check (staff_session_hours between 1 and 168),
  staff_id_max_failures       integer not null default 5  check (staff_id_max_failures between 3 and 20),
  staff_id_lock_minutes       integer not null default 15 check (staff_id_lock_minutes between 1 and 1440),
  mfa_required_roles          app_role[] not null default '{}',
  require_phone_verification  boolean not null default false,   -- turn on once an SMS provider is configured
  require_official_email      boolean not null default true,
  require_email_confirmed     boolean not null default true,
  require_documents           boolean not null default true,
  two_person_roles            app_role[] not null default '{city_officer,admin}',
  citizen_reports_per_hour    integer not null default 5  check (citizen_reports_per_hour between 1 and 1000),
  citizen_reports_per_day     integer not null default 20 check (citizen_reports_per_day between 1 and 5000),
  citizen_needs_per_day       integer not null default 10 check (citizen_needs_per_day between 1 and 5000),
  report_ward_max_km          numeric(5,2) not null default 4 check (report_ward_max_km > 0),
  home_area_flag_km           numeric(5,2) not null default 8 check (home_area_flag_km > 0),
  updated_at                  timestamptz not null default now()
);
insert into security_settings (id) values (true) on conflict (id) do nothing;
alter table security_settings enable row level security;   -- no policies: browser can neither read nor write it
revoke all on security_settings from anon, authenticated;

drop trigger if exists trg_touch_security_settings on security_settings;
create trigger trg_touch_security_settings before update on security_settings
  for each row execute function rm_touch();
drop trigger if exists trg_audit_security_settings on security_settings;
create trigger trg_audit_security_settings after insert or update or delete on security_settings
  for each row execute function rm_audit();

-- Non-sensitive switches the UI needs (which steps to show).
create or replace function public.rm_public_security_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'require_phone_verification', require_phone_verification,
    'require_official_email',     require_official_email,
    'require_email_confirmed',    require_email_confirmed,
    'require_documents',          require_documents,
    'mfa_required_roles',         mfa_required_roles,
    'two_person_roles',           two_person_roles,
    'citizen_reports_per_hour',   citizen_reports_per_hour,
    'citizen_reports_per_day',    citizen_reports_per_day)
  from security_settings where id
$$;
grant execute on function public.rm_public_security_settings() to anon, authenticated;

-- ---------- 1. Small helpers -----------------------------------------
-- Bangladeshi mobile → E.164 (+8801XXXXXXXXX). NULL when it is not one.
create or replace function public.rm_normalize_bd_phone(p text) returns text
language sql immutable as $$
  select case
    when d ~ '^8801[3-9][0-9]{8}$' then '+' || d
    when d ~ '^01[3-9][0-9]{8}$'   then '+88' || d
    when d ~ '^1[3-9][0-9]{8}$'    then '+880' || d
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

create or replace function public.rm_email_domain(p_email text) returns text
language sql immutable as $$
  select nullif(lower(btrim(split_part(coalesce(p_email, ''), '@', 2))), '')
$$;

create or replace function public.rm_is_freemail(p_domain text) returns boolean
language sql immutable as $$
  select lower(coalesce(p_domain, '')) = any (array[
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','ymail.com','rocketmail.com',
    'hotmail.com','outlook.com','live.com','msn.com','icloud.com','me.com','mac.com','aol.com',
    'proton.me','protonmail.com','pm.me','gmx.com','gmx.net','mail.com','yandex.com','yandex.ru',
    'zoho.com','zohomail.com','tutanota.com','tuta.io','rediffmail.com','mail.ru','qq.com','163.com',
    'hey.com','fastmail.com','inbox.com','hushmail.com','mailinator.com','guerrillamail.com',
    'temp-mail.org','10minutemail.com','yopmail.com','sharklasers.com'])
$$;

-- domain equals an allowed domain or is a sub-domain of it
create or replace function public.rm_domain_matches(p_domain text, p_allowed text[]) returns boolean
language sql immutable as $$
  select p_domain is not null and exists (
    select 1 from unnest(coalesce(p_allowed, '{}')) a
    where p_domain = lower(a) or p_domain like '%.' || lower(a))
$$;

-- Session id / assurance level of the calling JWT (PostgREST & Realtime set request.jwt.claims).
-- (plain SQL, no exception block: this runs inside every RLS check)
create or replace function public.rm_jwt_claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function public.rm_jwt_session() returns uuid
language sql stable as $$
  select case when s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s::uuid end
  from (select rm_jwt_claims()->>'session_id' as s) x
$$;

create or replace function public.rm_jwt_aal() returns text
language sql stable as $$
  select coalesce(nullif(rm_jwt_claims()->>'aal', ''), 'aal1')
$$;

-- Country of the HTTP caller as reported by the CDN in front of Supabase
-- (Cloudflare overwrites cf-ipcountry on ingress, so clients cannot forge it).
-- NULL when not available. 'T1' = Tor exit node.
create or replace function public.rm_request_country() returns text
language plpgsql stable as $$
declare h jsonb;
begin
  h := nullif(current_setting('request.headers', true), '')::jsonb;
  return nullif(upper(btrim(h->>'cf-ipcountry')), '');
exception when others then return null;
end $$;

-- MFA factor / live-session lookups. auth.* is managed by Supabase; if this
-- role cannot read it, the helpers degrade gracefully (MFA still enforced for
-- the roles listed in security_settings.mfa_required_roles via the JWT aal).
do $$
begin
  if to_regclass('auth.mfa_factors') is not null and has_table_privilege('auth.mfa_factors', 'select') then
    execute $f$
      create or replace function public.rm_mfa_enrolled(p_uid uuid) returns boolean
      language sql stable security definer set search_path = public as $b$
        select exists (select 1 from auth.mfa_factors f where f.user_id = p_uid and f.status::text = 'verified')
      $b$ $f$;
  else
    execute $f$
      create or replace function public.rm_mfa_enrolled(p_uid uuid) returns boolean
      language sql stable as $b$ select false $b$ $f$;
  end if;

  if to_regclass('auth.sessions') is not null and has_table_privilege('auth.sessions', 'select') then
    execute $f$
      create or replace function public.rm_session_alive(p_session uuid, p_uid uuid) returns boolean
      language sql stable security definer set search_path = public as $b$
        select exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_uid)
      $b$ $f$;
  else
    execute $f$
      create or replace function public.rm_session_alive(p_session uuid, p_uid uuid) returns boolean
      language sql stable as $b$ select true $b$ $f$;
  end if;
end $$;

-- ---------- 2. Profiles: verified phone / e-mail, BD-only phones ------
alter table profiles add column if not exists phone_verified_at timestamptz;
alter table profiles add column if not exists email_verified_at timestamptz;

-- existing data: normalise to +880…, drop anything that is not a BD mobile
update profiles set phone = rm_normalize_bd_phone(phone)
 where phone is not null and phone is distinct from rm_normalize_bd_phone(phone);
alter table profiles drop constraint if exists profiles_phone_check;
alter table profiles drop constraint if exists chk_profiles_phone_bd;
alter table profiles add constraint chk_profiles_phone_bd
  check (phone is null or phone ~ '^\+8801[3-9][0-9]{8}$');

update community_needs set contact_phone = rm_normalize_bd_phone(contact_phone)
 where contact_phone is not null and contact_phone is distinct from rm_normalize_bd_phone(contact_phone);
alter table community_needs drop constraint if exists community_needs_contact_phone_check;
alter table community_needs drop constraint if exists chk_needs_phone_bd;
alter table community_needs add constraint chk_needs_phone_bd
  check (contact_phone is null or contact_phone ~ '^\+8801[3-9][0-9]{8}$');

-- normalise on the way in, with a readable error for foreign / malformed numbers
create or replace function public.rm_profile_normalize() returns trigger
language plpgsql as $$
declare v text;
begin
  if new.phone is not null and btrim(new.phone) = '' then new.phone := null; end if;
  if new.phone is not null then
    v := rm_normalize_bd_phone(new.phone);
    if v is null then
      raise exception 'VALIDATION: phone must be a Bangladeshi mobile number (+8801XXXXXXXXX)' using errcode = '23514';
    end if;
    new.phone := v;
  end if;
  return new;
end $$;
-- name sorts before trg_guard_profile so the guard compares normalised numbers
drop trigger if exists trg_profile_normalize on profiles;
drop trigger if exists trg_aa_profile_normalize on profiles;
create trigger trg_aa_profile_normalize before insert or update of phone on profiles
  for each row execute function rm_profile_normalize();

-- backfill verification timestamps from auth.users (system context: allowed by the guard)
do $$
begin
  execute $q$
    update profiles p
       set email_verified_at = u.email_confirmed_at,
           phone_verified_at = case when u.phone_confirmed_at is not null
                                     and rm_normalize_bd_phone(u.phone) is not null then u.phone_confirmed_at end,
           phone = case when u.phone_confirmed_at is not null and rm_normalize_bd_phone(u.phone) is not null
                        then rm_normalize_bd_phone(u.phone) else p.phone end
      from auth.users u
     where u.id = p.id
       and (p.email_verified_at is distinct from u.email_confirmed_at or p.phone_verified_at is null)
  $q$;
exception when undefined_column or insufficient_privilege then
  raise notice 'auth.users verification columns not readable — skipping backfill';
end $$;

-- Only admins (or the backend/system) may change role / org / active flag / staff ID.
-- Privilege GRANTS (promotion, org or staff-ID change of a staff account,
-- re-activating a staff account) must go through the two-person request flow.
-- Verification timestamps and e-mail are owned by Supabase Auth (synced by trigger).
create or replace function public.rm_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_grant boolean := coalesce(current_setting('rm.role_grant', true), 'off') = 'on';
begin
  if rm_is_system() then return new; end if;

  if new.email is distinct from old.email
     or new.email_verified_at is distinct from old.email_verified_at
     or (new.phone_verified_at is distinct from old.phone_verified_at
         and new.phone is not distinct from old.phone) then
    raise exception 'FORBIDDEN: e-mail and verification status are managed by sign-in, not editable' using errcode = '42501';
  end if;
  -- a changed number is unverified until the OTP for it is confirmed
  if new.phone is distinct from old.phone then new.phone_verified_at := null; end if;

  if v_grant then return new; end if;     -- inside rm_review_role_request (two-person approved)

  if (new.role is distinct from old.role
      or new.organization_id is distinct from old.organization_id
      or new.is_active is distinct from old.is_active
      or new.employee_id is distinct from old.employee_id)
     and coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can change role, organization, staff ID or account status'
      using errcode = '42501';
  end if;
  if new.id = auth.uid() and (new.role is distinct from old.role or new.is_active is distinct from old.is_active
                              or new.organization_id is distinct from old.organization_id
                              or new.employee_id is distinct from old.employee_id) then
    raise exception 'FORBIDDEN: admins cannot change their own role, organisation, staff ID or status' using errcode = '42501';
  end if;
  if new.role is distinct from old.role and new.role <> 'citizen' then
    raise exception 'FORBIDDEN: granting a staff or admin role needs a second admin — use "Propose access change"'
      using errcode = '42501';
  end if;
  if new.role <> 'citizen' and (new.organization_id is distinct from old.organization_id
                                or new.employee_id is distinct from old.employee_id) then
    raise exception 'FORBIDDEN: changing a staff member''s organisation or staff ID needs a second admin — use "Propose access change"'
      using errcode = '42501';
  end if;
  if new.role <> 'citizen' and new.is_active and not old.is_active then
    raise exception 'FORBIDDEN: re-activating a staff account needs a second admin — use "Propose access change"'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------- 3. Effective role: staff privileges need a verified session ----
create table if not exists staff_sessions (
  session_id      uuid primary key,
  user_id         uuid not null references profiles(id) on delete cascade,
  role            app_role not null,
  organization_id uuid,
  verified_at     timestamptz not null default now(),
  expires_at      timestamptz not null,
  request_country text
);
create index if not exists idx_staff_sessions_user on staff_sessions(user_id);
alter table staff_sessions enable row level security;
revoke all on staff_sessions from anon;
grant select on staff_sessions to authenticated;

create table if not exists staff_login_attempts (
  id              bigserial primary key,
  user_id         uuid not null references profiles(id) on delete cascade,
  attempted_role  app_role,
  succeeded       boolean not null,
  reason          text,
  request_country text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_staff_attempts_user on staff_login_attempts(user_id, created_at desc);
alter table staff_login_attempts enable row level security;
revoke all on staff_login_attempts from anon;
grant select on staff_login_attempts to authenticated;

create or replace function public.rm_effective_role(p_uid uuid, p_session uuid, p_aal text) returns app_role
language plpgsql stable security definer set search_path = public as $$
declare
  v_role app_role; v_active boolean; v_org uuid; v_mfa_roles app_role[];
begin
  if p_uid is null then return null; end if;
  select role, is_active, organization_id into v_role, v_active, v_org from profiles where id = p_uid;
  if v_role is null or not v_active then return null; end if;
  if v_role = 'citizen' then return 'citizen'; end if;

  -- staff: this exact session must have passed the server-side staff-ID check
  if p_session is null or not exists (
       select 1 from staff_sessions s
        where s.session_id = p_session and s.user_id = p_uid and s.role = v_role
          and s.organization_id is not distinct from v_org and s.expires_at > now())
     or not rm_session_alive(p_session, p_uid) then
    return 'citizen';
  end if;

  -- second factor: required when the account has an authenticator or the role demands one
  if coalesce(p_aal, 'aal1') <> 'aal2' then
    select mfa_required_roles into v_mfa_roles from security_settings where id;
    if v_role = any(coalesce(v_mfa_roles, '{}')) or rm_mfa_enrolled(p_uid) then
      return 'citizen';
    end if;
  end if;
  return v_role;
end $$;
revoke execute on function public.rm_effective_role(uuid, uuid, text) from anon, authenticated, public;

create or replace function public.rm_role() returns app_role
language sql stable security definer set search_path = public as $$
  select rm_effective_role(auth.uid(), rm_jwt_session(), rm_jwt_aal())
$$;

create or replace function public.rm_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(rm_role() in ('city_officer','ngo_coordinator','field_worker','admin'), false)
$$;

create or replace function public.rm_org() returns uuid
language sql stable security definer set search_path = public as $$
  select case when rm_role() in ('city_officer','ngo_coordinator','field_worker','admin')
              then (select organization_id from profiles where id = auth.uid()) end
$$;

drop policy if exists staff_sessions_read on staff_sessions;
create policy staff_sessions_read on staff_sessions for select to authenticated
  using (user_id = auth.uid() or rm_role() = 'admin');
drop policy if exists staff_attempts_read on staff_login_attempts;
create policy staff_attempts_read on staff_login_attempts for select to authenticated
  using (user_id = auth.uid() or rm_role() = 'admin');

-- Second sign-in step for staff. Returns JSON (never raises on a wrong ID) so
-- the failed attempt is committed and counts towards the lock-out.
create or replace function public.rm_verify_staff_login(
  p_role app_role, p_staff_id text default null, p_org_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := rm_jwt_session();
  v_country text := rm_request_country();
  p profiles; s security_settings;
  v_fails int; v_ok boolean; v_reason text; v_until timestamptz; v_exp timestamptz; v_n int;
begin
  if v_uid is null or v_sid is null then
    raise exception 'UNAUTHENTICATED: sign in with your e-mail and password first' using errcode = '28000';
  end if;
  if not rm_session_alive(v_sid, v_uid) then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  select * into s from security_settings where id;
  select * into p from profiles where id = v_uid;
  if not found then return jsonb_build_object('ok', false, 'code', 'NO_PROFILE'); end if;
  if not p.is_active then return jsonb_build_object('ok', false, 'code', 'INACTIVE'); end if;
  if p.role = 'citizen' or p.role is distinct from p_role then
    return jsonb_build_object('ok', false, 'code', 'ROLE_MISMATCH', 'actual_role', p.role);
  end if;

  -- lock-out after repeated wrong IDs (per account, sliding window)
  select count(*), max(created_at) into v_fails, v_until from staff_login_attempts
   where user_id = v_uid and not succeeded and reason in ('ID_MISMATCH','ORG_MISMATCH')
     and created_at > now() - make_interval(mins => s.staff_id_lock_minutes)
     and created_at > coalesce((select max(created_at) from staff_login_attempts
                                 where user_id = v_uid and succeeded), '-infinity');
  if v_fails >= s.staff_id_max_failures then
    return jsonb_build_object('ok', false, 'code', 'LOCKED',
      'retry_after_s', greatest(1, ceil(extract(epoch from (v_until + make_interval(mins => s.staff_id_lock_minutes) - now())))::int));
  end if;

  if p.role in ('city_officer','field_worker','admin') then
    if p.employee_id is null then v_ok := false; v_reason := 'ID_MISSING';
    else
      v_ok := upper(btrim(p.employee_id)) = upper(btrim(coalesce(p_staff_id, '')));
      if not v_ok then v_reason := 'ID_MISMATCH'; end if;
    end if;
  else  -- ngo_coordinator: the NGO is the second identifier
    v_ok := p.organization_id is not null and p.organization_id = p_org_id;
    if not v_ok then v_reason := 'ORG_MISMATCH'; end if;
  end if;

  insert into staff_login_attempts(user_id, attempted_role, succeeded, reason, request_country)
  values (v_uid, p_role, v_ok, v_reason, v_country);

  if not v_ok then
    return jsonb_build_object('ok', false, 'code', v_reason,
      'attempts_left', case when v_reason = 'ID_MISSING' then null else greatest(0, s.staff_id_max_failures - v_fails - 1) end);
  end if;

  v_exp := now() + make_interval(hours => s.staff_session_hours);
  delete from staff_sessions where user_id = v_uid and expires_at < now();
  insert into staff_sessions(session_id, user_id, role, organization_id, expires_at, request_country)
  values (v_sid, v_uid, p.role, p.organization_id, v_exp, v_country)
  on conflict (session_id) do update
     set role = excluded.role, organization_id = excluded.organization_id, verified_at = now(),
         expires_at = excluded.expires_at, request_country = excluded.request_country
   where staff_sessions.user_id = excluded.user_id;          -- a session id can never be re-bound to another user
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID'); end if;

  return jsonb_build_object('ok', true, 'role', p.role, 'expires_at', v_exp,
    'mfa_enrolled', rm_mfa_enrolled(v_uid),
    'mfa_required', p.role = any(s.mfa_required_roles) or rm_mfa_enrolled(v_uid),
    'aal', rm_jwt_aal());
end $$;
grant execute on function public.rm_verify_staff_login(app_role, text, uuid) to authenticated;

create or replace function public.rm_end_staff_session() returns void
language sql volatile security definer set search_path = public as $$
  delete from staff_sessions where session_id = rm_jwt_session() and user_id = auth.uid()
$$;
grant execute on function public.rm_end_staff_session() to authenticated;

-- What the UI needs to decide which verification step to show.
create or replace function public.rm_session_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_sid uuid := rm_jwt_session();
  p profiles; s security_settings; ss staff_sessions; v_enrolled boolean;
begin
  if v_uid is null then return null; end if;
  select * into p from profiles where id = v_uid;
  if not found then return null; end if;
  select * into s from security_settings where id;
  select * into ss from staff_sessions where session_id = v_sid and user_id = v_uid;
  v_enrolled := rm_mfa_enrolled(v_uid);
  return jsonb_build_object(
    'account_role', p.role,
    'effective_role', rm_role(),
    'is_active', p.is_active,
    'staff_verified', ss.session_id is not null and ss.expires_at > now() and ss.role = p.role
                      and ss.organization_id is not distinct from p.organization_id,
    'staff_expires_at', ss.expires_at,
    'mfa_enrolled', v_enrolled,
    'mfa_required', p.role <> 'citizen' and (p.role = any(s.mfa_required_roles) or v_enrolled),
    'aal', rm_jwt_aal(),
    'phone', p.phone,
    'phone_verified', p.phone_verified_at is not null,
    'email_verified', p.email_verified_at is not null,
    'require_phone_verification', s.require_phone_verification);
end $$;
grant execute on function public.rm_session_status() to authenticated;

-- ---------- 4. Organisations: official domains, NGOAB number -----------
alter table organizations add column if not exists email_domains text[] not null default '{}';
alter table organizations add column if not exists ngoab_registration_no text;

create or replace function public.rm_org_validate() returns trigger
language plpgsql as $$
declare d text;
begin
  new.email_domains := coalesce((select array_agg(distinct lower(btrim(x))) from unnest(new.email_domains) x
                                  where btrim(x) <> ''), '{}');
  foreach d in array new.email_domains loop
    if d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      raise exception 'VALIDATION: "%" is not a valid e-mail domain', d using errcode = '23514';
    end if;
    if rm_is_freemail(d) then
      raise exception 'VALIDATION: "%" is a public mail provider and cannot be an official domain', d using errcode = '23514';
    end if;
  end loop;
  new.ngoab_registration_no := nullif(upper(btrim(new.ngoab_registration_no)), '');
  return new;
end $$;
drop trigger if exists trg_org_validate on organizations;
create trigger trg_org_validate before insert or update on organizations
  for each row execute function rm_org_validate();

update organizations set email_domains = '{dncc.gov.bd}'
 where id = '11111111-1111-1111-1111-111111111101' and email_domains = '{}';
update organizations set email_domains = '{dscc.gov.bd}'
 where id = '11111111-1111-1111-1111-111111111102' and email_domains = '{}';

-- public org list for the sign-up / sign-in forms now includes official domains
drop function if exists public.rm_public_organizations();
create function public.rm_public_organizations()
returns table (id uuid, name text, type org_type, email_domains text[])
language sql stable security definer set search_path = public as $$
  select id, name, type, email_domains from organizations
   where type in ('city_authority','ngo') order by name
$$;
grant execute on function public.rm_public_organizations() to anon, authenticated;

-- ---------- 5. Official registries: staff roster, NGOAB list ------------
create table if not exists staff_roster (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id     text check (employee_id is null or employee_id ~ '^[A-Za-z0-9/-]{3,30}$'),
  official_email  text check (official_email is null or official_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  full_name       text check (full_name is null or char_length(full_name) between 2 and 100),
  role            app_role check (role is null or role in ('city_officer','ngo_coordinator','field_worker')),
  is_active       boolean not null default true,
  uploaded_by     uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_roster_has_key check (employee_id is not null or official_email is not null)
);
create unique index if not exists uq_roster_org_emp on staff_roster(organization_id, upper(employee_id)) where employee_id is not null;
create unique index if not exists uq_roster_org_email on staff_roster(organization_id, lower(official_email)) where official_email is not null;
create index if not exists idx_roster_emp on staff_roster(upper(employee_id));

create table if not exists ngo_registry (
  id              uuid primary key default gen_random_uuid(),
  registration_no text not null check (registration_no ~ '^[A-Z0-9/-]{1,40}$'),
  name            text not null check (char_length(name) between 2 and 200),
  district        text,
  status          text not null default 'active' check (status in ('active','expired','cancelled')),
  valid_until     date,
  imported_by     uuid references profiles(id) on delete set null,
  imported_at     timestamptz not null default now()
);
create unique index if not exists uq_ngo_registry_no on ngo_registry(registration_no);

create or replace function public.rm_registry_normalize() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'staff_roster' then
    new.employee_id := nullif(upper(btrim(new.employee_id)), '');
    new.official_email := nullif(lower(btrim(new.official_email)), '');
    new.updated_at := now();
  else
    new.registration_no := upper(btrim(new.registration_no));
  end if;
  if not rm_is_system() then
    if tg_table_name = 'staff_roster' then new.uploaded_by := auth.uid(); else new.imported_by := auth.uid(); end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_roster_normalize on staff_roster;
create trigger trg_roster_normalize before insert or update on staff_roster
  for each row execute function rm_registry_normalize();
drop trigger if exists trg_ngo_registry_normalize on ngo_registry;
create trigger trg_ngo_registry_normalize before insert or update on ngo_registry
  for each row execute function rm_registry_normalize();

alter table staff_roster enable row level security;
alter table ngo_registry enable row level security;
revoke all on staff_roster, ngo_registry from anon;
grant select, insert, update, delete on staff_roster, ngo_registry to authenticated;
drop policy if exists roster_admin on staff_roster;
create policy roster_admin on staff_roster for all to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');
drop policy if exists ngo_registry_admin on ngo_registry;
create policy ngo_registry_admin on ngo_registry for all to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');

drop trigger if exists trg_audit_staff_roster on staff_roster;
create trigger trg_audit_staff_roster after insert or update or delete on staff_roster
  for each row execute function rm_audit();
drop trigger if exists trg_audit_ngo_registry on ngo_registry;
create trigger trg_audit_ngo_registry after insert or update or delete on ngo_registry
  for each row execute function rm_audit();

-- Bulk import (CSV parsed in the browser). p_replace deactivates roster rows
-- of this organisation that are not in the new file (kept for the audit trail).
create or replace function public.rm_import_staff_roster(p_org uuid, p_rows jsonb, p_replace boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r jsonb; i int := 0; v_emp text; v_mail text; v_role text; v_name text;
  n_ins int := 0; n_upd int := 0; n_off int := 0; errs jsonb := '[]'::jsonb; seen text[] := '{}'; v_id uuid; v_new boolean;
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can import the staff roster' using errcode = '42501';
  end if;
  if not exists (select 1 from organizations where id = p_org and type in ('city_authority','ngo')) then
    raise exception 'VALIDATION: choose a city authority or NGO' using errcode = '23514';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'VALIDATION: send between 1 and 5000 rows' using errcode = '23514';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_emp  := nullif(upper(btrim(r->>'employee_id')), '');
    v_mail := nullif(lower(btrim(r->>'official_email')), '');
    v_name := nullif(btrim(r->>'full_name'), '');
    v_role := nullif(lower(btrim(r->>'role')), '');
    begin
      if v_emp is null and v_mail is null then raise exception 'needs an employee_id or official_email'; end if;
      if v_role is not null and v_role not in ('city_officer','ngo_coordinator','field_worker') then
        raise exception 'role must be city_officer, ngo_coordinator or field_worker';
      end if;
      select id into v_id from staff_roster
       where organization_id = p_org
         and ((v_emp is not null and upper(employee_id) = v_emp) or (v_emp is null and lower(official_email) = v_mail));
      v_new := v_id is null;
      if v_new then
        insert into staff_roster(organization_id, employee_id, official_email, full_name, role, is_active)
        values (p_org, v_emp, v_mail, v_name, v_role::app_role, true) returning id into v_id;
        n_ins := n_ins + 1;
      else
        update staff_roster set official_email = v_mail, full_name = v_name, role = v_role::app_role, is_active = true
         where id = v_id;
        n_upd := n_upd + 1;
      end if;
      seen := seen || v_id::text;
    exception when others then
      errs := errs || jsonb_build_object('row', i, 'message', regexp_replace(sqlerrm, '^[A-Z_]+: ', ''));
    end;
  end loop;

  if p_replace then
    update staff_roster set is_active = false
     where organization_id = p_org and is_active and not (id::text = any(seen));
    get diagnostics n_off = row_count;
  end if;
  return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'deactivated', n_off, 'errors', errs);
end $$;
grant execute on function public.rm_import_staff_roster(uuid, jsonb, boolean) to authenticated;

create or replace function public.rm_import_ngo_registry(p_rows jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r jsonb; i int := 0; n int := 0; errs jsonb := '[]'::jsonb; v_status text;
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can import the NGOAB registry' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then
    raise exception 'VALIDATION: send between 1 and 20000 rows' using errcode = '23514';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_status := coalesce(nullif(lower(btrim(r->>'status')), ''), 'active');
      insert into ngo_registry(registration_no, name, district, status, valid_until)
      values (upper(btrim(r->>'registration_no')), btrim(r->>'name'), nullif(btrim(r->>'district'), ''),
              v_status, nullif(btrim(r->>'valid_until'), '')::date)
      on conflict (registration_no) do update
         set name = excluded.name, district = excluded.district, status = excluded.status,
             valid_until = excluded.valid_until, imported_at = now();
      n := n + 1;
    exception when others then
      errs := errs || jsonb_build_object('row', i, 'message', regexp_replace(sqlerrm, '^[A-Z_]+: ', ''));
    end;
  end loop;
  return jsonb_build_object('upserted', n, 'errors', errs);
end $$;
grant execute on function public.rm_import_ngo_registry(jsonb) to authenticated;

-- demo registry rows (fictional organisations from seed.sql)
insert into ngo_registry(registration_no, name, district, status)
select v.reg, v.name, 'Dhaka', 'active'
  from (values ('DEMO-0103', 'Shobar Jonno Relief Network'), ('DEMO-0104', 'Nodi Humanitarian Foundation')) v(reg, name)
on conflict (registration_no) do nothing;
update organizations set ngoab_registration_no = 'DEMO-0103'
 where id = '11111111-1111-1111-1111-111111111103' and ngoab_registration_no is null;
update organizations set ngoab_registration_no = 'DEMO-0104'
 where id = '11111111-1111-1111-1111-111111111104' and ngoab_registration_no is null;

insert into staff_roster(organization_id, employee_id, official_email, full_name, role)
select o.id, v.emp, v.mail, v.name, v.role::app_role
  from (values
    ('11111111-1111-1111-1111-111111111102'::uuid, 'DSCC-OFF-01', 'officer@resiliomesh.demo',  'Tanvir Hasan',  'city_officer'),
    ('11111111-1111-1111-1111-111111111101'::uuid, 'DNCC-OFF-02', 'officer2@resiliomesh.demo', 'Nusrat Jahan',  'city_officer'),
    ('11111111-1111-1111-1111-111111111102'::uuid, 'FW-001',      'field1@resiliomesh.demo',   'Rafiqul Islam', 'field_worker'),
    ('11111111-1111-1111-1111-111111111101'::uuid, 'FW-002',      'field2@resiliomesh.demo',   'Shahidul Alam', 'field_worker'),
    ('11111111-1111-1111-1111-111111111103'::uuid, 'FW-003',      'field3@resiliomesh.demo',   'Mitu Begum',    'field_worker'),
    ('11111111-1111-1111-1111-111111111103'::uuid, null,          'ngo@resiliomesh.demo',      'Sabrina Akter', 'ngo_coordinator'),
    ('11111111-1111-1111-1111-111111111104'::uuid, null,          'ngo2@resiliomesh.demo',     'Mahmud Karim',  'ngo_coordinator')
  ) v(org, emp, mail, name, role)
  join organizations o on o.id = v.org
 where not exists (select 1 from staff_roster s where s.organization_id = v.org
                     and (upper(s.employee_id) = v.emp or lower(s.official_email) = v.mail));

-- ---------- 6. Role requests: checks, documents, two-person approval -----
alter table role_requests add column if not exists email text;
alter table role_requests add column if not exists source text not null default 'self';
alter table role_requests add column if not exists requested_by uuid references profiles(id) on delete set null;
alter table role_requests add column if not exists required_approvals smallint not null default 1;
alter table role_requests drop constraint if exists role_requests_source_check;
alter table role_requests add constraint role_requests_source_check check (source in ('self','admin'));
alter table role_requests drop constraint if exists role_requests_requested_role_check;
alter table role_requests drop constraint if exists chk_role_requests_role;
alter table role_requests add constraint chk_role_requests_role
  check (requested_role in ('city_officer','ngo_coordinator','field_worker','admin')
         and (requested_role <> 'admin' or source = 'admin'));
alter table role_requests drop constraint if exists role_requests_review_note_check;
alter table role_requests add constraint role_requests_review_note_check
  check (review_note is null or char_length(review_note) <= 500);
update role_requests rr set email = p.email from profiles p where p.id = rr.user_id and rr.email is null;

create table if not exists role_request_approvals (
  request_id  uuid not null references role_requests(id) on delete cascade,
  admin_id    uuid not null references profiles(id),
  note        text check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  primary key (request_id, admin_id)
);
alter table role_request_approvals enable row level security;
revoke all on role_request_approvals from anon;
grant select on role_request_approvals to authenticated;
drop policy if exists rra_read on role_request_approvals;
create policy rra_read on role_request_approvals for select to authenticated using (rm_role() = 'admin');
drop trigger if exists trg_audit_role_request_approvals on role_request_approvals;
create trigger trg_audit_role_request_approvals after insert or update or delete on role_request_approvals
  for each row execute function rm_audit();

create table if not exists role_request_documents (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references role_requests(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  kind         text not null check (kind in ('id_card','appointment_letter','ngo_certificate','other')),
  storage_path text not null unique check (char_length(storage_path) between 5 and 400),
  file_name    text check (file_name is null or char_length(file_name) <= 200),
  mime_type    text check (mime_type is null or mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes   integer check (size_bytes is null or size_bytes between 1 and 5242880),
  created_at   timestamptz not null default now()
);
create index if not exists idx_rrd_request on role_request_documents(request_id);
alter table role_request_documents enable row level security;
revoke all on role_request_documents from anon;
grant select, insert, delete on role_request_documents to authenticated;
drop trigger if exists trg_audit_role_request_documents on role_request_documents;
create trigger trg_audit_role_request_documents after insert or update or delete on role_request_documents
  for each row execute function rm_audit();

create or replace function public.rm_document_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_found boolean;
begin
  if rm_is_system() then return new; end if;
  new.user_id := auth.uid();
  if not exists (select 1 from role_requests where id = new.request_id and user_id = new.user_id and status = 'pending') then
    raise exception 'FORBIDDEN: documents can only be added to your own pending request' using errcode = '42501';
  end if;
  if split_part(new.storage_path, '/', 1) <> new.user_id::text then
    raise exception 'FORBIDDEN: documents must be stored in your own folder' using errcode = '42501';
  end if;
  if (select count(*) from role_request_documents where request_id = new.request_id) >= 10 then
    raise exception 'VALIDATION: at most 10 documents per request' using errcode = '23514';
  end if;
  -- the file must really exist in the private bucket (when Supabase Storage is present)
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
      into v_found using 'staff-documents', new.storage_path;
    if not v_found then
      raise exception 'VALIDATION: upload the file before registering it' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_document_before_insert on role_request_documents;
create trigger trg_document_before_insert before insert on role_request_documents
  for each row execute function rm_document_before_insert();

drop policy if exists rrd_read on role_request_documents;
create policy rrd_read on role_request_documents for select to authenticated
  using (user_id = auth.uid() or rm_role() = 'admin');
drop policy if exists rrd_insert on role_request_documents;
create policy rrd_insert on role_request_documents for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists rrd_delete on role_request_documents;
create policy rrd_delete on role_request_documents for delete to authenticated
  using (user_id = auth.uid() and exists (select 1 from role_requests r where r.id = request_id and r.status = 'pending'));

-- Private bucket for ID cards / appointment letters (Supabase Storage only).
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — skipping bucket setup';
    return;
  end if;
  begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('staff-documents', 'staff-documents', false, 5242880,
            array['image/jpeg','image/png','image/webp','application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;
  exception when undefined_column then
    insert into storage.buckets (id, name, public) values ('staff-documents', 'staff-documents', false)
    on conflict (id) do update set public = false;
  end;
  execute 'drop policy if exists rm_staff_docs_insert on storage.objects';
  execute 'drop policy if exists rm_staff_docs_read on storage.objects';
  execute 'drop policy if exists rm_staff_docs_delete on storage.objects';
  execute $p$create policy rm_staff_docs_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'staff-documents' and split_part(name, '/', 1) = auth.uid()::text)$p$;
  execute $p$create policy rm_staff_docs_read on storage.objects for select to authenticated
    using (bucket_id = 'staff-documents' and (split_part(name, '/', 1) = auth.uid()::text or public.rm_role() = 'admin'))$p$;
  execute $p$create policy rm_staff_docs_delete on storage.objects for delete to authenticated
    using (bucket_id = 'staff-documents' and split_part(name, '/', 1) = auth.uid()::text)$p$;
exception when insufficient_privilege then
  raise notice 'no permission on storage schema — create bucket "staff-documents" (private) and its policies in the dashboard';
end $$;

-- Live verification of one request (roster may be uploaded after the request).
create or replace function public.rm_request_checks(r role_requests, p_org uuid default null, p_reviewer uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s security_settings; p profiles; o organizations; v_org uuid := coalesce(p_org, r.organization_id);
  v_email text; v_domain text; v_dstatus text; v_email_ok boolean := true; v_email_msg text;
  v_roster text := 'n/a'; v_roster_by uuid; rr staff_roster;
  v_ngo text := 'n/a'; v_reg text; ng ngo_registry; v_ngo_by uuid;
  v_emp text; v_taken boolean := false; v_docs int; v_mail_ok boolean;
  flags text[] := '{}'; blockers text[] := '{}'; v_required int; v_approvals jsonb;
begin
  select * into s from security_settings where id;
  select * into p from profiles where id = r.user_id;
  select * into o from organizations where id = v_org;
  v_email   := lower(coalesce(p.email, r.email));
  v_domain  := rm_email_domain(v_email);
  v_mail_ok := p.email_verified_at is not null;

  -- e-mail domain
  if o.id is not null and cardinality(o.email_domains) > 0 and rm_domain_matches(v_domain, o.email_domains) then
    v_dstatus := 'official';
  elsif o.id is null and r.requested_role = 'city_officer' and exists (
          select 1 from organizations x where x.type = 'city_authority' and rm_domain_matches(v_domain, x.email_domains)) then
    v_dstatus := 'official';
  elsif rm_is_freemail(v_domain) then v_dstatus := 'freemail';
  else v_dstatus := 'unlisted';
  end if;
  if r.requested_role = 'city_officer' and v_dstatus <> 'official' then
    v_email_ok := false; v_email_msg := 'City officers must use their city corporation e-mail address';
  elsif r.requested_role = 'ngo_coordinator' and o.id is not null and cardinality(o.email_domains) > 0 and v_dstatus <> 'official' then
    v_email_ok := false; v_email_msg := 'NGO coordinators must use their NGO''s e-mail domain';
  elsif r.requested_role = 'ngo_coordinator' and v_dstatus = 'freemail' then
    v_email_ok := false; v_email_msg := 'NGO coordinators must use an organisation e-mail, not a public mail provider';
  end if;

  -- staff roster
  v_emp := nullif(upper(btrim(coalesce(r.employee_id, p.employee_id))), '');
  if r.requested_role <> 'admin' then
    if v_emp is not null then
      select * into rr from staff_roster where organization_id = v_org and upper(employee_id) = v_emp;
    else
      select * into rr from staff_roster where organization_id = v_org and lower(official_email) = v_email;
    end if;
    if rr.id is null then
      v_roster := case when v_emp is not null and exists (select 1 from staff_roster where upper(employee_id) = v_emp)
                       then 'other_org' else 'not_found' end;
    elsif not rr.is_active then v_roster := 'inactive';
    elsif rr.role is not null and rr.role <> r.requested_role then v_roster := 'role_mismatch';
    elsif rr.official_email is null then v_roster := 'id_only';
    elsif lower(rr.official_email) = v_email then v_roster := 'verified';
    else v_roster := 'email_mismatch';
    end if;
    v_roster_by := rr.uploaded_by;
  end if;

  -- NGOAB registration
  if r.requested_role = 'ngo_coordinator' then
    v_reg := nullif(upper(btrim(coalesce(r.registration_no, o.ngoab_registration_no))), '');
    if v_reg is null then v_ngo := 'missing';
    else
      select * into ng from ngo_registry where registration_no = v_reg;
      if ng.id is null then v_ngo := 'not_found';
      elsif ng.status <> 'active' or (ng.valid_until is not null and ng.valid_until < current_date) then v_ngo := 'inactive';
      else v_ngo := 'verified'; v_ngo_by := ng.imported_by;
      end if;
    end if;
  end if;

  if v_emp is not null then
    v_taken := exists (select 1 from profiles x where upper(x.employee_id) = v_emp and x.id <> r.user_id);
  end if;
  select count(*) into v_docs from role_request_documents d where d.request_id = r.id;

  -- red flags: allowed only with two approvals and a written note
  if v_dstatus <> 'official' and r.requested_role <> 'admin' then flags := array_append(flags, 'email_domain'); end if;
  if v_roster not in ('verified','id_only','n/a') then flags := array_append(flags, 'roster'); end if;
  if v_ngo not in ('verified','n/a') then flags := array_append(flags, 'ngoab'); end if;
  if p_reviewer is not null and v_roster in ('verified','id_only') and v_roster_by = p_reviewer then
    flags := array_append(flags, 'roster_uploaded_by_reviewer');
  end if;
  if p_reviewer is not null and v_ngo = 'verified' and v_ngo_by = p_reviewer then
    flags := array_append(flags, 'ngoab_uploaded_by_reviewer');
  end if;

  -- hard blockers
  if r.requested_role <> 'admin' and v_org is null then blockers := array_append(blockers, 'organisation_missing'); end if;
  if o.id is not null and not (
       (r.requested_role = 'city_officer'    and o.type = 'city_authority') or
       (r.requested_role = 'ngo_coordinator' and o.type = 'ngo') or
       (r.requested_role = 'field_worker'    and o.type in ('city_authority','ngo')) or
        r.requested_role = 'admin') then
    blockers := array_append(blockers, 'organisation_type');
  end if;
  if r.requested_role in ('city_officer','field_worker','admin') and v_emp is null then blockers := array_append(blockers, 'staff_id_missing'); end if;
  if v_taken then blockers := array_append(blockers, 'staff_id_taken'); end if;
  if s.require_official_email and not v_email_ok then blockers := array_append(blockers, 'email_domain'); end if;
  if s.require_email_confirmed and not v_mail_ok then blockers := array_append(blockers, 'email_unconfirmed'); end if;
  if s.require_phone_verification and p.phone_verified_at is null then blockers := array_append(blockers, 'phone_unverified'); end if;
  if s.require_documents and r.source = 'self' and v_docs = 0 then blockers := array_append(blockers, 'documents_missing'); end if;
  if not coalesce(p.is_active, false) then blockers := array_append(blockers, 'account_inactive'); end if;

  v_required := case when r.source = 'admin' or r.requested_role = any(s.two_person_roles) or cardinality(flags) > 0
                     then 2 else 1 end;
  select coalesce(jsonb_agg(jsonb_build_object('admin_id', a.admin_id, 'name', ap.full_name, 'at', a.created_at, 'note', a.note)
                            order by a.created_at), '[]'::jsonb)
    into v_approvals
    from role_request_approvals a left join profiles ap on ap.id = a.admin_id where a.request_id = r.id;

  return jsonb_build_object(
    'email', v_email, 'email_domain', v_dstatus, 'email_policy_ok', v_email_ok, 'email_policy_message', v_email_msg,
    'email_confirmed', v_mail_ok,
    'phone', p.phone, 'phone_verified', p.phone_verified_at is not null,
    'roster', v_roster, 'ngoab', v_ngo, 'registration_no', v_reg,
    'staff_id', v_emp, 'staff_id_taken', v_taken, 'documents', v_docs,
    'flags', to_jsonb(flags), 'blockers', to_jsonb(blockers),
    'required_approvals', v_required, 'approvals', v_approvals);
end $$;
revoke execute on function public.rm_request_checks(role_requests, uuid, uuid) from anon, authenticated, public;

-- PostgREST computed column: select=*,verification  (admins only)
create or replace function public.verification(r role_requests) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(rm_role()::text, '') <> 'admin' then return null; end if;
  return rm_request_checks(r, null, auth.uid());
end $$;
grant execute on function public.verification(role_requests) to authenticated;

-- ---------- 7. Sign-up trigger: official domain, BD phone, snapshot -----
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_ward text; v_role text; v_org uuid; v_dom text; o organizations; s security_settings;
begin
  select * into s from security_settings where id;
  v_ward := nullif(m->>'ward_id', '');
  if v_ward is not null and not exists (select 1 from wards where id = v_ward) then v_ward := null; end if;

  insert into profiles (id, full_name, email, phone, role, ward_id, email_verified_at, phone_verified_at)
  values (
    new.id,
    coalesce(nullif(left(trim(m->>'full_name'), 100), ''), split_part(new.email, '@', 1)),
    new.email,
    coalesce(case when new.phone_confirmed_at is not null then rm_normalize_bd_phone(new.phone) end,
             rm_normalize_bd_phone(m->>'phone')),        -- non-BD numbers are dropped, never stored
    'citizen',                                            -- always citizen; staff roles need admin approval
    v_ward,
    new.email_confirmed_at,
    case when new.phone_confirmed_at is not null and rm_normalize_bd_phone(new.phone) is not null then new.phone_confirmed_at end
  )
  on conflict (id) do nothing;

  v_role := nullif(m->>'requested_role', '');
  if v_role in ('city_officer','ngo_coordinator','field_worker') then
    begin
      v_org := nullif(m->>'organization_id', '')::uuid;
    exception when others then v_org := null;
    end;
    select * into o from organizations where id = v_org;
    if o.id is null then v_org := null; end if;

    -- official e-mail domain is enforced at sign-up: the account is not created at all
    v_dom := rm_email_domain(new.email);
    if s.require_official_email then
      if v_role = 'city_officer' and not (
           (o.id is not null and rm_domain_matches(v_dom, o.email_domains)) or
           (o.id is null and exists (select 1 from organizations x where x.type = 'city_authority'
                                       and rm_domain_matches(v_dom, x.email_domains)))) then
        raise exception 'VALIDATION: City Officers must register with their city corporation e-mail address'
          using errcode = '23514';
      end if;
      if v_role = 'ngo_coordinator' and (
           rm_is_freemail(v_dom) or
           (o.id is not null and cardinality(o.email_domains) > 0 and not rm_domain_matches(v_dom, o.email_domains))) then
        raise exception 'VALIDATION: NGO Coordinators must register with their organisation''s e-mail domain'
          using errcode = '23514';
      end if;
    end if;

    begin
      insert into role_requests (user_id, requested_role, organization_id, organization_name, email,
                                 employee_id, designation, registration_no, team, ward_id)
      values (
        new.id, v_role::app_role, v_org,
        left(nullif(trim(m->>'organization_name'), ''), 120),
        lower(new.email),
        nullif(upper(left(trim(m->>'employee_id'), 30)), ''),
        left(nullif(trim(m->>'designation'), ''), 80),
        nullif(upper(left(trim(m->>'registration_no'), 40)), ''),
        left(nullif(trim(m->>'team'), ''), 60),
        v_ward
      );
    exception when check_violation or unique_violation then
      null;   -- malformed staff details must never block a citizen account (profile is kept)
    end;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- auth.users → profiles: e-mail, confirmed e-mail, OTP-verified phone
create or replace function public.rm_sync_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_phone text := rm_normalize_bd_phone(new.phone);
begin
  update profiles p
     set email = new.email,
         email_verified_at = new.email_confirmed_at,
         phone = case when new.phone_confirmed_at is not null and v_phone is not null then v_phone else p.phone end,
         phone_verified_at = case when new.phone_confirmed_at is not null and v_phone is not null then new.phone_confirmed_at
                                  when new.phone is distinct from old.phone then null
                                  else p.phone_verified_at end
   where p.id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update of email, email_confirmed_at, phone, phone_confirmed_at on auth.users
  for each row execute function public.rm_sync_auth_user();

-- ---------- 8. Review: two different admins for sensitive / flagged ------
drop function if exists public.rm_review_role_request(uuid, boolean, uuid, text);
create function public.rm_review_role_request(
  p_id uuid, p_approve boolean, p_org_id uuid default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r role_requests; v_me uuid := auth.uid(); v_org uuid; v_note text := left(nullif(btrim(p_note), ''), 500);
  c jsonb; v_required int; v_count int;
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can review access requests' using errcode = '42501';
  end if;
  select * into r from role_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: access request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then
    raise exception 'CONFLICT: this request was already %', r.status using errcode = '40001';
  end if;
  if r.user_id = v_me then
    raise exception 'FORBIDDEN: you cannot review your own access request' using errcode = '42501';
  end if;

  -- any single admin may refuse (fail-safe)
  if not p_approve then
    if v_note is null or char_length(v_note) < 3 then
      raise exception 'VALIDATION: give the applicant a short reason' using errcode = '23514';
    end if;
    update role_requests set status = 'rejected', review_note = v_note, reviewed_by = v_me, reviewed_at = now()
     where id = p_id returning * into r;
    return jsonb_build_object('status', r.status, 'approvals', 0, 'required', r.required_approvals);
  end if;

  if exists (select 1 from role_request_approvals where request_id = p_id and admin_id = v_me) then
    raise exception 'CONFLICT: you already approved this request — a different admin must give the second approval'
      using errcode = '40001';
  end if;
  if r.source = 'admin' and r.requested_by = v_me then
    raise exception 'CONFLICT: you proposed this change — a different admin must approve it' using errcode = '40001';
  end if;

  -- the organisation is fixed by the first approver; later approvers confirm the same one
  v_org := coalesce(p_org_id, r.organization_id);
  if exists (select 1 from role_request_approvals where request_id = p_id)
     and r.organization_id is distinct from v_org then
    raise exception 'CONFLICT: the first approver assigned a different organisation — reject the request if it is wrong'
      using errcode = '40001';
  end if;

  c := rm_request_checks(r, v_org, v_me);
  if jsonb_array_length(c->'blockers') > 0 then
    raise exception 'VALIDATION: cannot approve yet — %',
      (select string_agg(replace(b, '_', ' '), ', ') from jsonb_array_elements_text(c->'blockers') b)
      using errcode = '23514';
  end if;
  if jsonb_array_length(c->'flags') > 0 and (v_note is null or char_length(v_note) < 10) then
    raise exception 'VALIDATION: this request has failed checks (%) — explain in the note (10+ characters) why it is genuine',
      (select string_agg(replace(f, '_', ' '), ', ') from jsonb_array_elements_text(c->'flags') f)
      using errcode = '23514';
  end if;

  v_required := greatest((c->>'required_approvals')::int, r.required_approvals);
  insert into role_request_approvals(request_id, admin_id, note) values (p_id, v_me, v_note);
  select count(*) into v_count from role_request_approvals where request_id = p_id;

  if v_count < v_required then
    update role_requests set organization_id = v_org, required_approvals = v_required where id = p_id returning * into r;
    return jsonb_build_object('status', 'pending', 'approvals', v_count, 'required', v_required);
  end if;

  perform set_config('rm.role_grant', 'on', true);
  update profiles
     set role = r.requested_role,
         organization_id = case when r.requested_role = 'admin' then coalesce(v_org, organization_id) else v_org end,
         ward_id = coalesce(r.ward_id, ward_id),
         employee_id = coalesce(r.employee_id, employee_id),
         is_active = true
   where id = r.user_id;
  perform set_config('rm.role_grant', 'off', true);
  delete from staff_sessions where user_id = r.user_id;      -- the new role needs a fresh staff sign-in

  update role_requests
     set status = 'approved', organization_id = v_org, required_approvals = v_required,
         review_note = coalesce(v_note, review_note), reviewed_by = v_me, reviewed_at = now()
   where id = p_id returning * into r;
  return jsonb_build_object('status', 'approved', 'approvals', v_count, 'required', v_required);
end $$;
grant execute on function public.rm_review_role_request(uuid, boolean, uuid, text) to authenticated;

-- An admin who wants to grant / change staff access files a request that a
-- DIFFERENT admin must approve (the proposer counts as the first approval).
create or replace function public.rm_admin_propose_role_change(
  p_user uuid, p_role app_role, p_org_id uuid default null, p_employee_id text default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_me uuid := auth.uid(); p profiles; v_id uuid; v_note text := left(nullif(btrim(p_note), ''), 500);
        v_emp text := nullif(upper(btrim(p_employee_id)), '');
begin
  if coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can propose access changes' using errcode = '42501';
  end if;
  if p_user = v_me then raise exception 'FORBIDDEN: you cannot change your own access' using errcode = '42501'; end if;
  if p_role = 'citizen' then
    raise exception 'VALIDATION: revoking to Citizen does not need approval — use "Revoke"' using errcode = '23514';
  end if;
  if v_note is null or char_length(v_note) < 10 then
    raise exception 'VALIDATION: explain the change in the note (10+ characters)' using errcode = '23514';
  end if;
  if v_emp is not null and v_emp !~ '^[A-Z0-9/-]{3,30}$' then
    raise exception 'VALIDATION: staff ID must be 3–30 letters, numbers, / or -' using errcode = '23514';
  end if;
  select * into p from profiles where id = p_user;
  if not found then raise exception 'NOT_FOUND: user not found' using errcode = 'P0002'; end if;
  if exists (select 1 from role_requests where user_id = p_user and status = 'pending') then
    raise exception 'CONFLICT: this user already has a pending access request — review that one first' using errcode = '40001';
  end if;

  insert into role_requests(user_id, requested_role, organization_id, email, employee_id, ward_id,
                            source, requested_by, required_approvals, designation)
  values (p_user, p_role, p_org_id, lower(p.email), coalesce(v_emp, p.employee_id), p.ward_id,
          'admin', v_me, 2, 'Proposed by an administrator')
  returning id into v_id;
  insert into role_request_approvals(request_id, admin_id, note) values (v_id, v_me, v_note);
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'approvals', 1, 'required', 2);
end $$;
grant execute on function public.rm_admin_propose_role_change(uuid, app_role, uuid, text, text) to authenticated;

-- ---------- 9. Reports: service area, location ↔ ward, rate limit, flags --
alter table incidents add column if not exists trust_flags text[] not null default '{}';
alter table incidents add column if not exists reporter_country text;

create or replace function public.rm_in_dhaka(p_lat double precision, p_lng double precision) returns boolean
language sql immutable as $$
  select p_lat between 23.6 and 23.95 and p_lng between 90.25 and 90.55
$$;

create or replace function public.rm_incident_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_dup uuid; s security_settings; p profiles; v_role text;
  v_pt geography; v_km double precision; v_ward_name text; v_nearest text; v_home_km double precision;
  v_country text; n_hour int; n_day int; v_flags text[] := '{}';
begin
  -- clients can never forge reporter, status, AI or trust fields
  if not rm_is_system() then
    new.reporter_id := auth.uid();
    new.status := 'reported';
    new.risk_score := null; new.risk_level := null; new.priority := null;
    new.verified_by := null; new.duplicate_of := null;

    select * into s from security_settings where id;
    select * into p from profiles where id = new.reporter_id;
    v_role := coalesce(rm_role()::text, 'citizen');
    if p.id is null or not p.is_active then
      raise exception 'FORBIDDEN: this account is deactivated' using errcode = '42501';
    end if;

    if not rm_in_dhaka(new.lat, new.lng) then
      raise exception 'VALIDATION: the location must be inside the Dhaka service area' using errcode = '23514';
    end if;

    if v_role = 'citizen' then
      if s.require_phone_verification and p.phone_verified_at is null then
        raise exception 'PHONE_NOT_VERIFIED: verify your Bangladeshi mobile number before submitting a report'
          using errcode = '42501';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('rm_report:' || new.reporter_id::text, 0));
      select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
        into n_hour, n_day
        from incidents where reporter_id = new.reporter_id and created_at > now() - interval '24 hours';
      if n_hour >= s.citizen_reports_per_hour or n_day >= s.citizen_reports_per_day then
        raise exception 'RATE_LIMITED: you can send % reports per hour and % per day — please try again later',
          s.citizen_reports_per_hour, s.citizen_reports_per_day using errcode = '54000';
      end if;
      if p.phone_verified_at is null then v_flags := array_append(v_flags, 'phone_unverified'); end if;
      if p.created_at > now() - interval '24 hours' then v_flags := array_append(v_flags, 'new_account'); end if;
    end if;

    -- the pin must belong to the chosen ward (nearest ward centroid wins)
    v_pt := st_setsrid(st_makepoint(new.lng, new.lat), 4326)::geography;
    select st_distance(location, v_pt) / 1000.0, name into v_km, v_ward_name from wards where id = new.ward_id;
    select id into v_nearest from wards order by st_distance(location, v_pt) limit 1;
    if v_km is not null and v_km > s.report_ward_max_km then
      if v_nearest is distinct from new.ward_id then
        raise exception 'VALIDATION: the map pin is % km from %. Choose the area where the problem is.',
          round(v_km::numeric, 1), v_ward_name using errcode = '23514';
      end if;
      v_flags := array_append(v_flags, 'far_from_ward_centre');
    end if;
    if p.ward_id is not null and p.ward_id <> new.ward_id then
      select st_distance(location, v_pt) / 1000.0 into v_home_km from wards where id = p.ward_id;
      if v_home_km > s.home_area_flag_km then v_flags := array_append(v_flags, 'outside_home_area'); end if;
    end if;

    v_country := rm_request_country();
    new.reporter_country := v_country;
    if v_country = 'T1' then v_flags := array_append(v_flags, 'tor_network');
    elsif v_country is not null and v_country not in ('BD','XX') then v_flags := array_append(v_flags, 'foreign_network');
    end if;
    new.trust_flags := v_flags;
  end if;

  -- Geospatial duplicate detection: same category within 150 m in the last 6 h
  select i.id into v_dup
  from incidents i
  where i.category = new.category
    and i.status not in ('resolved','rejected','duplicate')
    and i.created_at > now() - interval '6 hours'
    and st_dwithin(i.location, st_setsrid(st_makepoint(new.lng, new.lat),4326)::geography, 150)
  order by i.created_at asc
  limit 1;

  if v_dup is not null then
    new.status := 'duplicate';
    new.duplicate_of := v_dup;
  end if;
  return new;
end $$;

create or replace function public.rm_incident_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if not rm_incident_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_TRANSITION: % -> % is not allowed', old.status, new.status
        using errcode = '23514';
    end if;
    if new.status = 'duplicate' and new.duplicate_of is null then
      raise exception 'VALIDATION: duplicate_of is required' using errcode = '23514';
    end if;
    if new.status = 'resolved' then new.resolved_at := now(); end if;
  end if;

  if not rm_is_system() and coalesce(current_setting('rm.internal', true), 'off') <> 'on' then
    if new.reporter_id is distinct from old.reporter_id
       or new.trust_flags is distinct from old.trust_flags
       or new.reporter_country is distinct from old.reporter_country then
      raise exception 'FORBIDDEN: reporter and trust signals cannot be edited' using errcode = '42501';
    end if;
    if (new.lat is distinct from old.lat or new.lng is distinct from old.lng) and not rm_in_dhaka(new.lat, new.lng) then
      raise exception 'VALIDATION: the location must be inside the Dhaka service area' using errcode = '23514';
    end if;
    -- citizens may only edit text of their own report while it is still 'reported'
    if coalesce(rm_role()::text, 'citizen') = 'citizen' then
      if old.status <> 'reported'
         or new.status is distinct from old.status
         or new.risk_score is distinct from old.risk_score
         or new.priority is distinct from old.priority
         or new.ward_id is distinct from old.ward_id
         or new.lat is distinct from old.lat
         or new.lng is distinct from old.lng then
        raise exception 'FORBIDDEN: citizens can only edit description of reports awaiting review'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

-- community needs: BD contact phone, citizen phone check + daily limit
create or replace function public.rm_need_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_dup uuid; s security_settings; v_n int;
begin
  if new.contact_phone is not null and btrim(new.contact_phone) = '' then new.contact_phone := null; end if;
  if new.contact_phone is not null then
    if rm_normalize_bd_phone(new.contact_phone) is null then
      raise exception 'VALIDATION: contact phone must be a Bangladeshi mobile number (+8801XXXXXXXXX)' using errcode = '23514';
    end if;
    new.contact_phone := rm_normalize_bd_phone(new.contact_phone);
  end if;
  new.dedup_key := md5(
    new.ward_id || '|' || new.need_type::text || '|' ||
    coalesce(regexp_replace(new.contact_phone, '[^0-9]', '', 'g'), lower(trim(coalesce(new.contact_name,''))), '') || '|' ||
    coalesce(new.incident_id::text, '')
  );
  if not rm_is_system() then
    new.submitted_by := auth.uid();
    new.status := 'open';
    new.fulfilled_qty := 0;
    new.duplicate_of := null;
    if coalesce(rm_role()::text, 'citizen') = 'citizen' then
      select * into s from security_settings where id;
      if s.require_phone_verification and not exists (
           select 1 from profiles where id = auth.uid() and phone_verified_at is not null) then
        raise exception 'PHONE_NOT_VERIFIED: verify your Bangladeshi mobile number first' using errcode = '42501';
      end if;
      select count(*) into v_n from community_needs
       where submitted_by = auth.uid() and created_at > now() - interval '24 hours';
      if v_n >= s.citizen_needs_per_day then
        raise exception 'RATE_LIMITED: daily limit of % requests reached', s.citizen_needs_per_day using errcode = '54000';
      end if;
    end if;
  end if;

  select id into v_dup from community_needs
  where dedup_key = new.dedup_key
    and status in ('open','partially_fulfilled')
    and created_at > now() - interval '48 hours'
  order by created_at limit 1;

  if v_dup is not null then
    new.status := 'duplicate';
    new.duplicate_of := v_dup;
  end if;
  return new;
end $$;

-- realtime for the admin queue (approvals) — optional
do $$ begin
  alter publication supabase_realtime add table role_request_approvals;
exception when others then null; end $$;
