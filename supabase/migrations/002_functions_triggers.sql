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
