-- =====================================================================
-- ResilioMesh — 014 NGO coordinators: home area (Dhaka North / South) + cross-area backup
-- ---------------------------------------------------------------------
-- Until now every NGO coordinator acted on needs anywhere in Dhaka, so nobody in
-- particular was responsible for an area. From this migration:
--
--   * Every NGO coordinator has a HOME AREA: the city corporation (DNCC / DSCC) of
--     their "main operating area" ward (profiles.ward_id, asked at sign-up).
--   * A need in Dhaka North is the responsibility of the Dhaka North coordinators;
--     same for South. Only they allocate to it, cancel it, or ask for help.
--   * BACKUP, both ways. A coordinator of the other area may act on a need when
--       - the home coordinator asked for backup on that need          (need.backup_requested_at), or
--       - the home coordinators asked for backup for their whole area (ngo_area_backup row), or
--       - the area has NO active coordinator at all (nobody to wait for).
--   * Everyone still SEES all needs city-wide, and anyone may log a need anywhere.
--   * A coordinator's home area changes only by an admin (or the approval flow).
--     A coordinator without a home area acts only as backup.
--
-- Requires 009, 012 and 013. Re-runnable. If you re-run 004 or 013, run this file again.
-- =====================================================================

-- ---------- 1. Home area of a coordinator ---------------------------------
create or replace function public.rm_ngo_area(p_user uuid default null) returns text
language sql stable security definer set search_path = public as $$
  select w.city_corporation
    from profiles p join wards w on w.id = p.ward_id
   where p.id = coalesce(p_user, auth.uid()) and p.role = 'ngo_coordinator'
$$;
grant execute on function public.rm_ngo_area(uuid) to authenticated;

-- Moving a coordinator to the other area changes who is responsible: admin only.
create or replace function public.rm_ngo_area_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_old text; v_new text;
begin
  if rm_is_system() or coalesce(current_setting('rm.role_grant', true), 'off') = 'on'
     or coalesce(rm_role()::text, '') = 'admin' then
    return new;
  end if;
  if new.role <> 'ngo_coordinator' or new.ward_id is not distinct from old.ward_id then return new; end if;
  select city_corporation into v_old from wards where id = old.ward_id;
  select city_corporation into v_new from wards where id = new.ward_id;
  if v_old is distinct from v_new then
    raise exception 'FORBIDDEN: an NGO coordinator''s home area (Dhaka North / South) is changed by an admin'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_ngo_area_guard on profiles;
create trigger trg_ngo_area_guard before update of ward_id on profiles
  for each row execute function rm_ngo_area_guard();

-- ---------- 2. Backup requests --------------------------------------------
alter table community_needs add column if not exists backup_requested_at timestamptz;
alter table community_needs add column if not exists backup_requested_by uuid references profiles(id);
alter table community_needs add column if not exists backup_note text check (backup_note is null or char_length(backup_note) <= 300);

create table if not exists ngo_area_backup (
  area          text primary key check (area in ('DNCC','DSCC')),
  requested_by  uuid references profiles(id),
  requested_at  timestamptz not null default now(),
  note          text check (note is null or char_length(note) <= 300)
);
alter table ngo_area_backup enable row level security;
drop policy if exists ngo_area_backup_read on ngo_area_backup;
create policy ngo_area_backup_read on ngo_area_backup for select to authenticated using (rm_is_staff());
-- writes only through the RPCs below

-- ---------- 3. Who may act on a need? --------------------------------------
-- 'home' | 'backup' | 'uncovered' | 'admin' when allowed, null when not.
create or replace function public.rm_ngo_access(p_need_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role app_role := rm_role(); v_need_area text; v_my_area text; v_backup timestamptz;
begin
  if v_role = 'admin' then return 'admin'; end if;
  if v_role is distinct from 'ngo_coordinator' then return null; end if;
  select w.city_corporation, n.backup_requested_at into v_need_area, v_backup
    from community_needs n join wards w on w.id = n.ward_id where n.id = p_need_id;
  v_my_area := rm_ngo_area();
  if v_my_area is not null and v_my_area = v_need_area then return 'home'; end if;
  if v_backup is not null or exists (select 1 from ngo_area_backup b where b.area = v_need_area) then return 'backup'; end if;
  if not exists (select 1 from profiles p join wards w on w.id = p.ward_id
                  where p.role = 'ngo_coordinator' and p.is_active and w.city_corporation = v_need_area) then
    return 'uncovered';
  end if;
  return null;
end $$;
grant execute on function public.rm_ngo_access(uuid) to authenticated;

create or replace function public.rm_assert_ngo_access(p_need_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_access text := rm_ngo_access(p_need_id); v_area text;
begin
  if v_access is not null then return v_access; end if;
  select w.city_corporation into v_area from community_needs n join wards w on w.id = n.ward_id where n.id = p_need_id;
  raise exception 'FORBIDDEN: this need is in %, handled by its own coordinators. You can act once they ask for backup',
    rm_area_label(v_area) using errcode = '42501';
end $$;

-- ---------- 4. Allocation (004 + area rule) ---------------------------------
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
  v_access text;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can allocate aid' using errcode = '42501';
  end if;

  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;

  select exists(select 1 from allocations where idempotency_key = p_idempotency_key) into v_existing;

  if not v_existing then
    v_access := rm_assert_ngo_access(p_need_id);
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

  -- linked to the NEED only (not the report): the officer's pump / crew workflow resolving the
  -- report must not auto-close NGO relief; the coordinator confirms delivery (013).
  v_alloc := rm_reserve_resource(p_resource_id, p_qty, p_idempotency_key, null, p_need_id, null, auth.uid());

  if not v_existing then
    update community_needs
       set fulfilled_qty = fulfilled_qty + p_qty,
           status = case when fulfilled_qty + p_qty >= quantity then 'fulfilled'::need_status
                         else 'partially_fulfilled'::need_status end,
           organization_id = coalesce(organization_id, v_res.organization_id),
           -- help arrived and the need is covered: the backup request is done
           backup_requested_at = case when fulfilled_qty + p_qty >= quantity then null else backup_requested_at end
     where id = p_need_id;
  end if;

  return jsonb_build_object('ok', true, 'replayed', v_existing, 'access', v_access, 'allocation', to_jsonb(v_alloc));
end $$;

-- ---------- 5. Cancel a need (013 + area rule) -------------------------------
create or replace function public.cancel_need(p_need_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_need community_needs;
  v_access text;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can cancel a need' using errcode = '42501';
  end if;
  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;
  v_access := rm_assert_ngo_access(p_need_id);
  -- closing a need is the home area's decision; backup helpers allocate, they do not close
  if v_access = 'backup' then
    raise exception 'FORBIDDEN: only the coordinators of this area can cancel the need' using errcode = '42501';
  end if;
  if v_role <> 'admin' and v_need.organization_id is not null and v_need.organization_id is distinct from rm_org() then
    raise exception 'FORBIDDEN: need is being served by another organization' using errcode = '42501';
  end if;
  if v_need.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_need.status not in ('open','partially_fulfilled') then
    raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
  end if;
  if exists (select 1 from allocations where need_id = p_need_id and status in ('reserved','dispatched')) then
    raise exception 'INVALID_STATE: cancel or deliver the active allocations of this need first' using errcode = '23514';
  end if;
  update community_needs set status = 'cancelled', backup_requested_at = null where id = p_need_id;
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

-- ---------- 6. Ask the other area for help -----------------------------------
-- one need
create or replace function public.request_ngo_backup(p_need_id uuid, p_on boolean default true, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_need community_needs; v_access text;
begin
  if rm_role() not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can ask for backup' using errcode = '42501';
  end if;
  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;
  v_access := rm_ngo_access(p_need_id);
  if v_access is null or v_access = 'backup' then
    raise exception 'FORBIDDEN: only the coordinators of this need''s area can ask for backup' using errcode = '42501';
  end if;
  if p_on and v_need.status not in ('open','partially_fulfilled') then
    raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
  end if;
  update community_needs
     set backup_requested_at = case when p_on then coalesce(backup_requested_at, now()) end,
         backup_requested_by = case when p_on then coalesce(backup_requested_by, auth.uid()) end,
         backup_note         = case when p_on then nullif(trim(p_note), '') end
   where id = p_need_id;
  return jsonb_build_object('ok', true, 'backup', p_on);
end $$;

-- the whole home area (e.g. Dhaka North is overwhelmed)
create or replace function public.set_ngo_area_backup(p_on boolean, p_note text default null, p_area text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_area text;
begin
  if rm_role() = 'admin' then v_area := coalesce(p_area, rm_ngo_area());
  elsif rm_role() = 'ngo_coordinator' then v_area := rm_ngo_area();
  else raise exception 'FORBIDDEN: only NGO coordinators can ask for backup' using errcode = '42501';
  end if;
  if v_area is null then
    raise exception 'VALIDATION: you have no home area (Dhaka North / South) yet; ask an admin to set it' using errcode = '22023';
  end if;
  if p_on then
    insert into ngo_area_backup(area, requested_by, note) values (v_area, auth.uid(), nullif(trim(p_note), ''))
    on conflict (area) do update set note = excluded.note;
  else
    delete from ngo_area_backup where area = v_area;
  end if;
  return jsonb_build_object('ok', true, 'area', v_area, 'backup', p_on);
end $$;

-- who covers which area (no names: counts only), for the NGO screen
create or replace function public.ngo_area_status()
returns table(area text, label text, coordinators integer, open_needs integer, backup_needs integer,
              area_backup boolean, area_backup_note text, area_backup_since timestamptz)
language sql stable security definer set search_path = public as $$
  select a.area, rm_area_label(a.area),
         (select count(*)::int from profiles p join wards w on w.id = p.ward_id
           where p.role = 'ngo_coordinator' and p.is_active and w.city_corporation = a.area),
         (select count(*)::int from community_needs n join wards w on w.id = n.ward_id
           where w.city_corporation = a.area and n.status in ('open','partially_fulfilled')),
         (select count(*)::int from community_needs n join wards w on w.id = n.ward_id
           where w.city_corporation = a.area and n.status in ('open','partially_fulfilled') and n.backup_requested_at is not null),
         b.area is not null, b.note, b.requested_at
    from (values ('DNCC'), ('DSCC')) a(area)
    left join ngo_area_backup b on b.area = a.area
   where rm_is_staff()
$$;

grant execute on function public.request_ngo_backup(uuid, boolean, text) to authenticated;
grant execute on function public.set_ngo_area_backup(boolean, text, text) to authenticated;
grant execute on function public.ngo_area_status() to authenticated;
revoke execute on function public.rm_assert_ngo_access(uuid) from public, anon, authenticated;

-- ---------- 7. Direct edits of needs follow the same area rule ----------------
drop policy if exists needs_update on community_needs;
create policy needs_update on community_needs for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() = 'ngo_coordinator' and rm_ngo_access(id) in ('home','uncovered')
             and (organization_id is null or organization_id = rm_org())))
  with check (rm_role() = 'admin'
         or (rm_role() = 'ngo_coordinator' and rm_ngo_access(id) in ('home','uncovered')
             and (organization_id is null or organization_id = rm_org())));

do $$ begin
  alter publication supabase_realtime add table ngo_area_backup;
exception when duplicate_object or undefined_object then null; end $$;
