alter table profiles add column if not exists admin_scope text
  check (admin_scope is null or admin_scope in ('owner', 'reviewer'));

update profiles set admin_scope = 'reviewer'
 where role = 'admin' and lower(email) = 'admin2@resiliomesh.demo' and admin_scope is distinct from 'reviewer';
update profiles set admin_scope = 'owner'
 where role = 'admin' and admin_scope is null;

create or replace function public.rm_admin_scope_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from 'admin' then
    new.admin_scope := null;
    return new;
  end if;
  if rm_is_system() then
    new.admin_scope := coalesce(new.admin_scope, 'owner');
    return new;
  end if;
  if tg_op = 'INSERT' or old.role is distinct from 'admin' then
    new.admin_scope := 'reviewer';
  elsif new.admin_scope is distinct from old.admin_scope then
    raise exception 'FORBIDDEN: an admin''s duties are set by the platform team, not from the app'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_admin_scope_guard on profiles;
create trigger trg_admin_scope_guard before insert or update of role, admin_scope on profiles
  for each row execute function rm_admin_scope_guard();

create or replace function public.rm_is_system_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(rm_role() = 'admin'
                  and (select admin_scope from profiles where id = auth.uid()) = 'owner', false)
$$;
grant execute on function public.rm_is_system_owner() to authenticated;

drop policy if exists org_admin_write on organizations;
drop policy if exists org_owner_write on organizations;
create policy org_owner_write on organizations for all to authenticated
  using (rm_is_system_owner()) with check (rm_is_system_owner());

drop policy if exists wards_admin_write on wards;
drop policy if exists wards_owner_write on wards;
create policy wards_owner_write on wards for update to authenticated
  using (rm_is_system_owner()) with check (rm_is_system_owner());

create or replace function public.rm_owner_only_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not rm_is_system() and not rm_is_system_owner() then
    raise exception 'FORBIDDEN: only the system owner changes the % (ask them, or the platform team)',
      replace(tg_table_name, '_', ' ') using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_owner_only_staff_roster on staff_roster;
create trigger trg_owner_only_staff_roster before insert or update or delete on staff_roster
  for each row execute function rm_owner_only_write();
drop trigger if exists trg_owner_only_ngo_registry on ngo_registry;
create trigger trg_owner_only_ngo_registry before insert or update or delete on ngo_registry
  for each row execute function rm_owner_only_write();

create or replace function public.rm_owner_only_fault_injection() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.inject_failure is not null and not rm_is_system() and not rm_is_system_owner() then
    raise exception 'FORBIDDEN: fault injection is for the system owner only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_owner_only_fault_injection on workflow_runs;
create trigger trg_owner_only_fault_injection before insert on workflow_runs
  for each row execute function rm_owner_only_fault_injection();

create or replace function public.rm_import_staff_roster(p_org uuid, p_rows jsonb, p_replace boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r jsonb; i int := 0; v_emp text; v_mail text; v_role text; v_name text;
  n_ins int := 0; n_upd int := 0; n_off int := 0; errs jsonb := '[]'::jsonb; seen text[] := '{}'; v_id uuid; v_new boolean;
begin
  if not rm_is_system_owner() then
    raise exception 'FORBIDDEN: only the system owner can import the staff roster' using errcode = '42501';
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
  if not rm_is_system_owner() then
    raise exception 'FORBIDDEN: only the system owner can import the NGOAB registry' using errcode = '42501';
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
