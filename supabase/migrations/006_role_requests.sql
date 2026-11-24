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
