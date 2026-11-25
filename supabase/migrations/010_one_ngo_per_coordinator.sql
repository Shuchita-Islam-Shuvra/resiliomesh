do $$
declare missing text[] := '{}';
begin
  if to_regclass('public.security_settings')      is null then missing := missing || 'security_settings'::text; end if;
  if to_regclass('public.staff_roster')           is null then missing := missing || 'staff_roster'::text; end if;
  if to_regclass('public.ngo_registry')           is null then missing := missing || 'ngo_registry'::text; end if;
  if to_regclass('public.role_request_documents') is null then missing := missing || 'role_request_documents'::text; end if;
  if to_regprocedure('public.rm_is_freemail(text)') is null then missing := missing || 'rm_is_freemail()'::text; end if;
  if cardinality(missing) > 0 then
    raise exception 'Run 006_role_requests.sql, 007_staff_login_ids.sql and 008_identity_verification.sql first, then 009 and 010 (missing: %)',
      array_to_string(missing, ', ');
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'organizations' and column_name = 'city_corporation') then
    raise notice '009_officer_areas.sql has not been run yet: Dhaka North / South officer areas are not active. Run it too.';
  end if;
end $$;

create or replace function public.rm_ngo_seat_conflict(p_user uuid, p_role app_role, p_phone text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_role app_role; v_org text;
begin
  if p_phone is null or p_role is null or p_role not in ('ngo_coordinator','city_officer','field_worker') then
    return null;
  end if;
  select x.role, coalesce(o.name, 'no organisation') into v_role, v_org
    from profiles x left join organizations o on o.id = x.organization_id
   where x.id is distinct from p_user
     and x.is_active
     and x.phone = p_phone
     and x.role in ('ngo_coordinator','city_officer','field_worker')
     and (p_role = 'ngo_coordinator' or x.role = 'ngo_coordinator')
   order by (x.role = 'ngo_coordinator') desc, x.created_at
   limit 1;
  if v_role is null then return null; end if;
  return format('this mobile number already belongs to the %s of %s on another account. One person can hold only one NGO Coordinator post',
                case v_role when 'ngo_coordinator' then 'NGO Coordinator'
                            when 'city_officer'    then 'Water Resilience Officer'
                            else 'Field Worker' end,
                v_org);
end $$;
revoke execute on function public.rm_ngo_seat_conflict(uuid, app_role, text) from anon, authenticated, public;

create or replace function public.rm_ngo_seat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_msg text;
begin
  if not new.is_active or new.phone is null
     or new.role not in ('ngo_coordinator','city_officer','field_worker') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.role = old.role and new.phone is not distinct from old.phone
     and new.is_active = old.is_active then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rm_staff_phone:' || new.phone, 0));
  v_msg := rm_ngo_seat_conflict(new.id, new.role, new.phone);
  if v_msg is not null then
    if rm_is_system() or coalesce(rm_role()::text, '') = 'admin' then
      raise exception 'CONFLICT: %', v_msg using errcode = '23505';
    end if;
    raise exception 'CONFLICT: this mobile number is already registered to another staff account' using errcode = '23505';
  end if;
  return new;
end $$;

drop trigger if exists trg_ngo_seat_guard on profiles;
create trigger trg_ngo_seat_guard before insert or update of role, phone, is_active on profiles
  for each row execute function rm_ngo_seat_guard();

do $$
declare d record; n int := 0;
begin
  for d in
    select phone, string_agg(coalesce(email, id::text), ', ') as accounts
      from profiles where role = 'ngo_coordinator' and is_active and phone is not null
     group by phone having count(*) > 1
  loop
    n := n + 1;
    raise notice 'one mobile, several active NGO coordinators: % → %. Deactivate all but one.', d.phone, d.accounts;
  end loop;
  if n = 0 then
    create unique index if not exists uq_profiles_active_ngo_coordinator_phone
      on profiles(phone) where role = 'ngo_coordinator' and is_active and phone is not null;
  else
    raise notice 'uq_profiles_active_ngo_coordinator_phone not created: fix the % case(s) above and re-run 010', n;
  end if;
end $$;

create or replace function public.rm_request_checks(r role_requests, p_org uuid default null, p_reviewer uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s security_settings; p profiles; o organizations; v_org uuid := coalesce(p_org, r.organization_id);
  v_email text; v_domain text; v_dstatus text; v_email_ok boolean := true; v_email_msg text;
  v_roster text := 'n/a'; v_roster_by uuid; rr staff_roster;
  v_ngo text := 'n/a'; v_reg text; ng ngo_registry; v_ngo_by uuid;
  v_emp text; v_taken boolean := false; v_docs int; v_mail_ok boolean;
  v_seat text; v_transfer_from text;
  flags text[] := '{}'; blockers text[] := '{}'; v_required int; v_approvals jsonb;
begin
  select * into s from security_settings where id;
  select * into p from profiles where id = r.user_id;
  select * into o from organizations where id = v_org;
  v_email   := lower(coalesce(p.email, r.email));
  v_domain  := rm_email_domain(v_email);
  v_mail_ok := p.email_verified_at is not null;

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

  v_seat := rm_ngo_seat_conflict(r.user_id, r.requested_role, p.phone);
  if r.requested_role = 'ngo_coordinator' and p.role = 'ngo_coordinator' and p.is_active
     and p.organization_id is not null and p.organization_id is distinct from v_org then
    select name into v_transfer_from from organizations where id = p.organization_id;
  end if;

  if v_dstatus <> 'official' and r.requested_role <> 'admin' then flags := array_append(flags, 'email_domain'); end if;
  if v_roster not in ('verified','id_only','n/a') then flags := array_append(flags, 'roster'); end if;
  if v_ngo not in ('verified','n/a') then flags := array_append(flags, 'ngoab'); end if;
  if p_reviewer is not null and v_roster in ('verified','id_only') and v_roster_by = p_reviewer then
    flags := array_append(flags, 'roster_uploaded_by_reviewer');
  end if;
  if p_reviewer is not null and v_ngo = 'verified' and v_ngo_by = p_reviewer then
    flags := array_append(flags, 'ngoab_uploaded_by_reviewer');
  end if;
  if v_transfer_from is not null then flags := array_append(flags, 'ngo_transfer'); end if;

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
  if r.requested_role = 'ngo_coordinator' and p.phone is null then blockers := array_append(blockers, 'phone_missing'); end if;
  if v_seat is not null then blockers := array_append(blockers, 'ngo_seat_taken'); end if;
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
    'ngo_seat', v_seat, 'ngo_transfer_from', v_transfer_from,
    'flags', to_jsonb(flags), 'blockers', to_jsonb(blockers),
    'required_approvals', v_required, 'approvals', v_approvals);
end $$;
revoke execute on function public.rm_request_checks(role_requests, uuid, uuid) from anon, authenticated, public;
