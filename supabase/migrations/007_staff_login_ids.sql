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
