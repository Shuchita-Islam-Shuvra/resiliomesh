-- 024: Who may register a community (relief) need, and confirm-before-stock.
--
-- 1. Only staff register needs (officer, NGO coordinator, field worker, admin). Citizens report the
--    problem instead; staff turn it into a need. Officers and field workers stay bound to their own
--    area (trigger from 012).
-- 2. A need must be CONFIRMED before any stock is reserved for it. Needs registered by an NGO
--    coordinator, officer or admin are confirmed by that person at once. A need a field worker
--    reports from the ground waits until an NGO coordinator of the area, an officer of the area or an
--    admin confirms it (confirm_need). Enforced on the allocations table, so every path is covered.
--    The existing rule stays too: if the need is linked to a report, that report must be verified.
-- 3. Coordinators are told when a field worker reports a need; the field worker is told once it is
--    confirmed.
-- Re-runnable.

-- ---------------------------------------------------------------- columns (+ one-time backfill)
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'community_needs' and column_name = 'confirmed_at') then
    alter table community_needs add column confirmed_at timestamptz;
    alter table community_needs add column confirmed_by uuid references profiles(id) on delete set null;
    -- needs that existed before this rule were all logged by coordinators/officers: keep them usable
    update community_needs set confirmed_at = created_at, confirmed_by = submitted_by;
  end if;
end $$;

-- ---------------------------------------------------------------- 1. staff only
drop policy if exists needs_insert on community_needs;
create policy needs_insert on community_needs for insert to authenticated
  with check (rm_is_staff());

-- ---------------------------------------------------------------- 2. confirmation
create or replace function public.rm_need_confirm_on_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if rm_is_system() then
    new.confirmed_at := coalesce(new.confirmed_at, now());
    return new;
  end if;
  if rm_role() in ('ngo_coordinator','city_officer','admin') then
    new.confirmed_at := now();
    new.confirmed_by := auth.uid();
  else
    new.confirmed_at := null;
    new.confirmed_by := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_need_confirm_on_insert on community_needs;
create trigger trg_need_confirm_on_insert before insert on community_needs
  for each row execute function rm_need_confirm_on_insert();

create or replace function public.rm_need_confirm_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.confirmed_at is distinct from old.confirmed_at or new.confirmed_by is distinct from old.confirmed_by)
     and not rm_is_system()
     and coalesce(current_setting('rm.need_confirm', true), 'off') <> 'on' then
    raise exception 'FORBIDDEN: use "Confirm" to confirm a need' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_need_confirm_guard on community_needs;
create trigger trg_need_confirm_guard before update on community_needs
  for each row execute function rm_need_confirm_guard();

-- No stock for an unconfirmed need, whichever way the reservation is made.
create or replace function public.rm_allocation_need_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.need_id is not null
     and exists (select 1 from community_needs where id = new.need_id and confirmed_at is null) then
    raise exception 'INVALID_STATE: this need was reported from the field and is not confirmed yet; an NGO coordinator or officer of the area must confirm it first'
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_allocation_need_confirmed on allocations;
create trigger trg_allocation_need_confirmed before insert on allocations
  for each row execute function rm_allocation_need_confirmed();

create or replace function public.confirm_need(p_need_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_need community_needs;
  v_ok boolean;
  v_ward text;
begin
  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;

  v_ok := case v_role
            when 'admin' then true
            when 'city_officer' then rm_can_manage_ward(v_need.ward_id)
            when 'ngo_coordinator' then rm_ngo_access(p_need_id) in ('home','uncovered','backup')
            else false end;
  if not coalesce(v_ok, false) then
    raise exception 'FORBIDDEN: an NGO coordinator or officer of this area (or an admin) confirms needs' using errcode = '42501';
  end if;
  if v_need.confirmed_at is not null then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_need.submitted_by = auth.uid() then
    raise exception 'FORBIDDEN: you reported this need, so someone else must confirm it' using errcode = '42501';
  end if;
  if v_need.status not in ('open','partially_fulfilled') then
    raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
  end if;

  perform set_config('rm.need_confirm', 'on', true);
  update community_needs set confirmed_at = now(), confirmed_by = auth.uid() where id = p_need_id
  returning * into v_need;
  perform set_config('rm.need_confirm', 'off', true);

  select name into v_ward from wards where id = v_need.ward_id;
  perform rm_notify(
    array[v_need.submitted_by], 'relief_need', 'normal',
    format('Need confirmed: %s × %s in %s', v_need.quantity, replace(v_need.need_type::text, '_', ' '), coalesce(v_ward, v_need.ward_id)),
    format('%s (%s) confirmed the need you reported. Relief can now be sent.',
           (select full_name from profiles where id = auth.uid()), rm_role_label(v_role::text)),
    v_need.incident_id, '/field', false, false, 'need-confirmed:' || v_need.id);
  return jsonb_build_object('ok', true, 'replayed', false, 'need', to_jsonb(v_need));
end $$;
grant execute on function public.confirm_need(uuid) to authenticated;

-- ---------------------------------------------------------------- 3. notification wording
create or replace function public.rm_notify_need() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ward text; v_ref text; v_by text; v_role text;
begin
  if new.status <> 'open' or rm_silent_write() then return new; end if;
  select name into v_ward from wards where id = new.ward_id;
  select reference_code into v_ref from incidents where id = new.incident_id;
  select full_name, role::text into v_by, v_role from profiles where id = new.submitted_by;
  perform rm_notify(
    rm_ngo_coordinators_for_ward(new.ward_id), 'relief_need',
    case when new.households >= 100 or new.confirmed_at is null then 'high' else 'normal' end,
    case when new.confirmed_at is null then 'Confirm a need from the field: ' else 'Relief needed: ' end
      || format('%s × %s in %s', new.quantity, replace(new.need_type::text, '_', ' '), coalesce(v_ward, new.ward_id)),
    format('%s households need %s × %s in %s%s. Logged by %s (%s).%s',
           new.households, new.quantity, replace(new.need_type::text, '_', ' '), coalesce(v_ward, new.ward_id),
           coalesce(' (report ' || v_ref || ')', ''), coalesce(v_by, 'staff'), rm_role_label(v_role),
           case when new.confirmed_at is null
                then ' Check it and press Confirm on the NGO page before sending stock.'
                else ' Serve it from your NGO''s stock on the NGO page.' end),
    new.incident_id, '/ngo', true, new.households >= 100, 'need:' || new.id);
  return new;
end $$;
