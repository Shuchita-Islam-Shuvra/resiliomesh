-- ResilioMesh: 002 + 003 + 004 + 005 + seed in ONE file (run after 001_schema.sql)

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
