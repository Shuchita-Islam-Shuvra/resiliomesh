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
