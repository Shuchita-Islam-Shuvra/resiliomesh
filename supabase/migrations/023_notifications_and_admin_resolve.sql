-- 023: Notifications (in-app + e-mail + SMS) and admin resolve-at-any-stage.
--
-- 1. An admin can resolve an open report at any stage (with a reason). Open field tasks are cancelled,
--    pumps / crews / boats / tanks go back to stock, unused reservations are released, pending plans
--    are closed. Because status lives on one row, everyone sees "resolved" at once.
-- 2. In-app notifications (`notifications`, realtime, recipient-only RLS). E-mail / SMS copies go to
--    an outbox (`notification_deliveries`) that the backend worker sends outside any DB transaction,
--    with retry and backoff.
--      new report            -> officers of that area (critical: + e-mail; critical from staff/admin: + SMS)
--      admin / officer alert -> chosen audience: officers, NGO coordinators, field crew (+ e-mail, urgent: + SMS)
--      relief need logged    -> NGO coordinators of that area (+ e-mail; 100+ households: + SMS)
--      NGO backup asked      -> NGO coordinators of the other area (+ e-mail)
--      field task assigned   -> that field worker (+ e-mail + SMS)
--      field task cancelled  -> that crew (+ SMS)
--      report resolved       -> reporter (+ e-mail), officers of the area, crew, NGO coordinators on it
-- Re-runnable.

-- ---------------------------------------------------------------- tables
create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  kind         text not null check (kind in ('new_report','alert','relief_need','ngo_backup',
                                             'task_assigned','task_cancelled','incident_resolved')),
  severity     text not null default 'normal' check (severity in ('normal','high','critical')),
  title        text not null check (char_length(title) between 1 and 160),
  body         text not null check (char_length(body) between 1 and 1000),
  incident_id  uuid references incidents(id) on delete cascade,
  link         text check (link is null or link ~ '^/'),
  dedup_key    text,
  created_by   uuid references profiles(id) on delete set null,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_notifications_recipient on notifications(recipient_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient_id) where read_at is null;
create index if not exists idx_notifications_sender on notifications(created_by, incident_id, created_at desc);
create unique index if not exists uq_notifications_dedup on notifications(recipient_id, dedup_key)
  where dedup_key is not null;
alter table notifications enable row level security;
drop policy if exists notifications_read on notifications;
create policy notifications_read on notifications for select to authenticated
  using (recipient_id = auth.uid());
-- no insert / update / delete policies: rows come from triggers and RPCs; "read" goes through mark_notifications_read()

create table if not exists notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  channel         text not null check (channel in ('email','sms')),
  destination     text not null check (char_length(destination) between 3 and 254),
  status          text not null default 'queued' check (status in ('queued','sending','sent','failed','skipped')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  provider        text,
  provider_ref    text,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (notification_id, channel)
);
create index if not exists idx_deliveries_due on notification_deliveries(next_attempt_at)
  where status in ('queued','sending');
alter table notification_deliveries enable row level security;
drop policy if exists deliveries_admin_read on notification_deliveries;
create policy deliveries_admin_read on notification_deliveries for select to authenticated
  using (rm_role() = 'admin');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and tablename = 'notifications') then
    execute 'alter publication supabase_realtime add table notifications';
  end if;
end $$;

-- ---------------------------------------------------------------- who gets told
create or replace function public.rm_role_label(p_role text) returns text
language sql immutable as $$
  select case p_role
    when 'admin' then 'Admin' when 'city_officer' then 'Water Resilience Officer'
    when 'ngo_coordinator' then 'NGO Coordinator' when 'field_worker' then 'Field Worker'
    else 'Citizen' end
$$;

-- Officers whose authority serves the ward's area; if the area has none, the admins.
create or replace function public.rm_officers_for_ward(p_ward text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array_agg(p.id) from profiles p join organizations o on o.id = p.organization_id
      where p.role = 'city_officer' and p.is_active
        and o.city_corporation = (select city_corporation from wards where id = p_ward)),
    (select array_agg(id) from profiles where role = 'admin' and is_active),
    '{}'::uuid[])
$$;

-- NGO coordinators whose home area is the ward's area; if the area has none, every coordinator.
create or replace function public.rm_ngo_coordinators_for_ward(p_ward text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array_agg(p.id) from profiles p join wards w on w.id = p.ward_id
      where p.role = 'ngo_coordinator' and p.is_active
        and w.city_corporation = (select city_corporation from wards where id = p_ward)),
    (select array_agg(id) from profiles where role = 'ngo_coordinator' and is_active),
    '{}'::uuid[])
$$;

-- NGO coordinators who are NOT home in the ward's area (the ones a backup request is for).
create or replace function public.rm_ngo_backup_coordinators(p_area text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.id), '{}'::uuid[])
    from profiles p left join wards w on w.id = p.ward_id
   where p.role = 'ngo_coordinator' and p.is_active and w.city_corporation is distinct from p_area
$$;

-- The crew on the report's open tasks; if nobody is on it yet, on-duty field workers allowed in its area.
create or replace function public.rm_field_workers_for_incident(p_incident_id uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array_agg(distinct ta.worker_id) from task_assignees ta join tasks t on t.id = ta.task_id
      where t.incident_id = p_incident_id and t.status in ('pending','assigned','accepted','in_progress')),
    (select array_agg(p.id) from profiles p left join organizations o on o.id = p.organization_id
      where p.role = 'field_worker' and p.is_active and p.on_duty
        and (o.city_corporation is null
             or o.city_corporation = (select w.city_corporation from incidents i join wards w on w.id = i.ward_id
                                       where i.id = p_incident_id))),
    '{}'::uuid[])
$$;

-- Writes one in-app notification per active recipient (never to the person who caused it) and queues
-- the e-mail / SMS copies. Returns how many people were notified.
create or replace function public.rm_notify(
  p_recipients uuid[], p_kind text, p_severity text, p_title text, p_body text,
  p_incident_id uuid default null, p_link text default null,
  p_email boolean default false, p_sms boolean default false, p_dedup text default null
) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_actor uuid := rm_actor();
  v_n integer := 0;
  r record;
begin
  if coalesce(cardinality(p_recipients), 0) = 0 then return 0; end if;
  for r in
    insert into notifications(recipient_id, kind, severity, title, body, incident_id, link, dedup_key, created_by)
    select p.id, p_kind, p_severity, left(p_title, 160), left(p_body, 1000), p_incident_id, p_link, p_dedup, v_actor
      from profiles p
     where p.id = any(p_recipients) and p.is_active and p.id is distinct from v_actor
    on conflict (recipient_id, dedup_key) where dedup_key is not null do nothing
    returning id, recipient_id
  loop
    v_n := v_n + 1;
    if p_email then
      insert into notification_deliveries(notification_id, channel, destination)
      select r.id, 'email', lower(btrim(coalesce(nullif(p.email, ''), u.email)))
        from profiles p left join auth.users u on u.id = p.id
       where p.id = r.recipient_id and coalesce(nullif(p.email, ''), u.email) like '%_@_%'
      on conflict do nothing;
    end if;
    if p_sms then
      insert into notification_deliveries(notification_id, channel, destination)
      select r.id, 'sms', p.phone from profiles p
       where p.id = r.recipient_id and p.phone is not null
      on conflict do nothing;
    end if;
  end loop;
  if v_n > 0 and (p_email or p_sms) then
    perform pg_notify('notification_deliveries', '');
  end if;
  return v_n;
end $$;

-- True for bulk/system writes (seed, CSV import) that have no acting person: those never notify.
create or replace function public.rm_silent_write() returns boolean
language sql stable as $$
  select rm_is_system() and coalesce(current_setting('rm.actor', true), '') = ''
$$;

revoke all on function public.rm_officers_for_ward(text) from public, anon, authenticated;
revoke all on function public.rm_ngo_coordinators_for_ward(text) from public, anon, authenticated;
revoke all on function public.rm_ngo_backup_coordinators(text) from public, anon, authenticated;
revoke all on function public.rm_field_workers_for_incident(uuid) from public, anon, authenticated;
revoke all on function public.rm_notify(uuid[], text, text, text, text, uuid, text, boolean, boolean, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- triggers
create or replace function public.rm_notify_new_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; v_role text; v_ward text; v_crit boolean;
begin
  if new.status = 'duplicate' or rm_silent_write() then return new; end if;
  select full_name, role::text into v_name, v_role from profiles where id = new.reporter_id;
  select name into v_ward from wards where id = new.ward_id;
  v_crit := new.severity_reported >= 4 or coalesce(new.water_depth_cm, 0) >= 45;
  perform rm_notify(
    rm_officers_for_ward(new.ward_id), 'new_report',
    case when v_crit then 'critical' when v_role = 'admin' then 'high' else 'normal' end,
    case when v_crit then 'Critical report: ' else 'New report: ' end || new.title,
    format('%s · %s · %s · %s people affected. Filed by %s%s. Please verify and act.',
           new.reference_code, coalesce(v_ward, new.ward_id),
           coalesce(new.water_depth_cm || ' cm water', 'depth not given'), new.people_affected,
           coalesce(v_name, 'a citizen'),
           case when coalesce(v_role, 'citizen') <> 'citizen' then ' (' || rm_role_label(v_role) || ')' else '' end),
    new.id, '/incidents/' || new.id,
    v_crit or v_role = 'admin',
    v_crit and coalesce(v_role, 'citizen') <> 'citizen',
    'report:' || new.id);
  return new;
end $$;
drop trigger if exists trg_notify_new_report on incidents;
create trigger trg_notify_new_report after insert on incidents
  for each row execute function rm_notify_new_report();

create or replace function public.rm_notify_incident_resolved() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ward text; v_note text; v_body text; v_team uuid[];
begin
  if new.status <> 'resolved' or old.status = 'resolved' then return new; end if;
  select name into v_ward from wards where id = new.ward_id;
  v_note := nullif(btrim(current_setting('rm.note', true)), '');
  v_body := format('%s · %s is resolved.%s', new.reference_code, coalesce(v_ward, new.ward_id),
                   coalesce(' ' || v_note, ''));
  perform rm_notify(array[new.reporter_id], 'incident_resolved', 'normal', 'Resolved: ' || new.title, v_body,
                    new.id, '/incidents/' || new.id, true, false, 'resolved:' || new.id);
  select array_agg(distinct x) into v_team from (
    select unnest(rm_officers_for_ward(new.ward_id)) x
    union select ta.worker_id from task_assignees ta join tasks t on t.id = ta.task_id where t.incident_id = new.id
    union select n.submitted_by from community_needs n where n.incident_id = new.id and n.submitted_by is not null
    union select a.allocated_by from allocations a join community_needs n on n.id = a.need_id
           where n.incident_id = new.id and a.allocated_by is not null
  ) s;
  perform rm_notify(v_team, 'incident_resolved', 'normal', 'Resolved: ' || new.title, v_body,
                    new.id, '/incidents/' || new.id, false, false, 'resolved:' || new.id);
  return new;
end $$;
drop trigger if exists trg_notify_incident_resolved on incidents;
create trigger trg_notify_incident_resolved after update of status on incidents
  for each row execute function rm_notify_incident_resolved();

create or replace function public.rm_notify_task_assigned() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_task tasks; v_ref text; v_ward text;
begin
  select * into v_task from tasks where id = new.task_id;
  if v_task.status in ('completed','cancelled','failed') then return new; end if;
  select i.reference_code, w.name into v_ref, v_ward
    from incidents i join wards w on w.id = i.ward_id where i.id = v_task.incident_id;
  perform rm_notify(
    array[new.worker_id], 'task_assigned', 'high', 'New task: ' || v_task.title,
    format('%s at %s (%s)%s.%s Open the Field Portal to accept or decline.',
           v_task.title, coalesce(v_ward, '?'), v_ref,
           case when new.is_lead then ', you are the crew lead' else '' end,
           coalesce(' Due ' || to_char(v_task.due_at at time zone 'Asia/Dhaka', 'DD Mon HH24:MI') || '.', '')),
    v_task.incident_id, '/field', true, true, null);
  return new;
end $$;
drop trigger if exists trg_notify_task_assigned on task_assignees;
create trigger trg_notify_task_assigned after insert on task_assignees
  for each row execute function rm_notify_task_assigned();

create or replace function public.rm_notify_task_cancelled() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ref text; v_ward text; v_crew uuid[]; v_note text;
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then return new; end if;
  select array_agg(worker_id) into v_crew from task_assignees where task_id = new.id;
  if v_crew is null then return new; end if;
  select i.reference_code, w.name into v_ref, v_ward
    from incidents i join wards w on w.id = i.ward_id where i.id = new.incident_id;
  v_note := nullif(btrim(current_setting('rm.note', true)), '');
  perform rm_notify(
    v_crew, 'task_cancelled', 'high', 'Task cancelled: ' || new.title,
    format('%s at %s (%s) is cancelled, stop work on it.%s', new.title, coalesce(v_ward, '?'), v_ref,
           coalesce(' ' || v_note, '')),
    new.incident_id, '/field', false,
    old.status in ('assigned','accepted','in_progress'),
    'task-cancelled:' || new.id);
  return new;
end $$;
drop trigger if exists trg_notify_task_cancelled on tasks;
create trigger trg_notify_task_cancelled after update of status on tasks
  for each row execute function rm_notify_task_cancelled();

create or replace function public.rm_notify_need() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ward text; v_ref text;
begin
  if new.status <> 'open' or rm_silent_write() then return new; end if;
  select name into v_ward from wards where id = new.ward_id;
  select reference_code into v_ref from incidents where id = new.incident_id;
  perform rm_notify(
    rm_ngo_coordinators_for_ward(new.ward_id), 'relief_need',
    case when new.households >= 100 then 'high' else 'normal' end,
    format('Relief needed: %s × %s in %s', new.quantity, replace(new.need_type::text, '_', ' '), coalesce(v_ward, new.ward_id)),
    format('%s households need %s × %s in %s%s. Serve it from your NGO''s stock on the NGO page.',
           new.households, new.quantity, replace(new.need_type::text, '_', ' '), coalesce(v_ward, new.ward_id),
           coalesce(' (report ' || v_ref || ')', '')),
    new.incident_id, '/ngo', true, new.households >= 100, 'need:' || new.id);
  return new;
end $$;
drop trigger if exists trg_notify_need on community_needs;
create trigger trg_notify_need after insert on community_needs
  for each row execute function rm_notify_need();

create or replace function public.rm_notify_need_backup() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ward text; v_area text;
begin
  if new.backup_requested_at is null or old.backup_requested_at is not null then return new; end if;
  select name, city_corporation into v_ward, v_area from wards where id = new.ward_id;
  perform rm_notify(
    rm_ngo_backup_coordinators(v_area), 'ngo_backup', 'high',
    format('Backup asked: %s in %s', replace(new.need_type::text, '_', ' '), coalesce(v_ward, new.ward_id)),
    format('Coordinators of %s asked for help with %s × %s for %s households in %s.%s',
           rm_area_label(v_area), new.quantity - new.fulfilled_qty, replace(new.need_type::text, '_', ' '),
           new.households, coalesce(v_ward, new.ward_id), coalesce(' Note: ' || new.backup_note, '')),
    new.incident_id, '/ngo', true, false, 'need-backup:' || new.id || ':' || extract(epoch from new.backup_requested_at)::bigint);
  return new;
end $$;
drop trigger if exists trg_notify_need_backup on community_needs;
create trigger trg_notify_need_backup after update of backup_requested_at on community_needs
  for each row execute function rm_notify_need_backup();

create or replace function public.rm_notify_area_backup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform rm_notify(
    rm_ngo_backup_coordinators(new.area), 'ngo_backup', 'high',
    'Backup asked for all of ' || rm_area_label(new.area),
    format('NGO coordinators of %s asked other NGOs to help with every open relief need there.%s',
           rm_area_label(new.area), coalesce(' Note: ' || new.note, '')),
    null, '/ngo', true, false, 'area-backup:' || new.area || ':' || extract(epoch from new.requested_at)::bigint);
  return new;
end $$;
drop trigger if exists trg_notify_area_backup on ngo_area_backup;
create trigger trg_notify_area_backup after insert on ngo_area_backup
  for each row execute function rm_notify_area_backup();

-- ---------------------------------------------------------------- admin resolve at any stage
-- The state machine lets an open report jump to "resolved" only inside resolve_incident()
-- (flag set for the transaction) and only for an admin or the system.
create or replace function public.rm_incident_transition_allowed(p_from incident_status, p_to incident_status)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_to = 'resolved' and p_from not in ('resolved','rejected','duplicate')
         and coalesce(current_setting('rm.force_resolve', true), 'off') = 'on'
         and (rm_is_system() or rm_role() = 'admin') then true
    else case p_from
      when 'reported'    then p_to in ('verified','rejected','duplicate')
      when 'verified'    then p_to in ('assessed','rejected','duplicate')
      when 'assessed'    then p_to in ('approved','verified','rejected')
      when 'approved'    then p_to in ('in_progress','assessed')
      when 'in_progress' then p_to in ('resolved','assessed')
      when 'duplicate'   then p_to in ('verified')
      else false
    end
  end
$$;

create or replace function public.resolve_incident(p_incident_id uuid, p_expected_version integer, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inc incidents;
  v_note text := nullif(btrim(p_note), '');
  v_tasks integer;
  v_returned integer := 0;
  v_used integer;
  v_plans integer;
  a record;
begin
  if rm_role() is distinct from 'admin' then
    raise exception 'FORBIDDEN: only an admin can resolve a report at any stage; officers resolve once the field tasks are done'
      using errcode = '42501';
  end if;
  if v_note is null or char_length(v_note) < 5 then
    raise exception 'VALIDATION: say why it is resolved (at least 5 characters)' using errcode = '22023';
  end if;

  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then raise exception 'NOT_FOUND: incident' using errcode = 'P0002'; end if;
  if v_inc.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_inc));
  end if;
  if v_inc.status in ('resolved','rejected','duplicate') then
    raise exception 'INVALID_STATE: this report is already %', v_inc.status using errcode = '23514';
  end if;

  v_note := left(v_note, 400);
  perform set_config('rm.note', 'Resolved by admin: ' || v_note, true);

  -- 1. stop open field work (each crew is told through the task-cancelled trigger)
  with c as (
    update tasks set status = 'cancelled',
           notes = coalesce(notes || E'\n', '') || rm_stamp('Cancelled, report resolved by admin: ' || v_note)
     where incident_id = p_incident_id and status in ('pending','assigned','accepted','in_progress')
    returning 1)
  select count(*) into v_tasks from c;

  -- 2. equipment back to stock: unused reservations, and reusable kit already sent out
  for a in
    select al.id from allocations al join resources r on r.id = al.resource_id
     where al.incident_id = p_incident_id
       and (al.status = 'reserved'
            or (al.status = 'dispatched' and r.resource_type in ('pump','crew','boat','water_tank')))
  loop
    perform rm_release_allocation(a.id, 'report resolved by admin, returned to stock');
    v_returned := v_returned + 1;
  end loop;
  -- relief already handed out stays used
  with c as (
    update allocations al set status = 'consumed'
      from resources r
     where r.id = al.resource_id and al.incident_id = p_incident_id and al.status = 'dispatched'
       and r.resource_type in ('relief_kit','sandbag','medical_kit')
    returning 1)
  select count(*) into v_used from c;

  -- 3. plans still waiting for approval are no longer needed
  with c as (
    update allocation_plans set status = 'superseded'
     where status = 'pending_approval' and p_incident_id = any(incident_ids)
    returning 1)
  select count(*) into v_plans from c;

  -- 4. resolve (history row + "resolved" notifications come from the incident triggers)
  perform set_config('rm.force_resolve', 'on', true);
  update incidents set status = 'resolved' where id = p_incident_id returning * into v_inc;
  perform set_config('rm.force_resolve', 'off', true);

  return jsonb_build_object('ok', true, 'incident', to_jsonb(v_inc), 'tasks_cancelled', v_tasks,
                            'equipment_returned', v_returned, 'relief_kept_as_used', v_used,
                            'plans_closed', v_plans);
end $$;
grant execute on function public.resolve_incident(uuid, integer, text) to authenticated;

-- ---------------------------------------------------------------- alerts sent by people
-- Admin: officers / NGO coordinators / field crew. Officer (own area): the same audiences.
create or replace function public.send_incident_alert(
  p_incident_id uuid, p_audience text[], p_message text, p_urgent boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_inc incidents;
  v_msg text := nullif(btrim(p_message), '');
  v_to uuid[] := '{}';
  v_aud text;
  v_by text;
  v_ward text;
  v_n integer;
begin
  if v_role is null or v_role not in ('admin','city_officer') then
    raise exception 'FORBIDDEN: only admins and Water Resilience Officers send alerts' using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id;
  if not found then raise exception 'NOT_FOUND: incident' using errcode = 'P0002'; end if;
  perform rm_assert_officer_area(v_inc.ward_id);
  if v_inc.status in ('resolved','rejected','duplicate') then
    raise exception 'INVALID_STATE: this report is already %', v_inc.status using errcode = '23514';
  end if;
  if v_msg is null or char_length(v_msg) < 5 or char_length(v_msg) > 500 then
    raise exception 'VALIDATION: write a message of 5 to 500 characters' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_audience), 0) = 0 then
    raise exception 'VALIDATION: choose who to alert' using errcode = '22023';
  end if;
  if exists (select 1 from notifications where created_by = auth.uid() and incident_id = p_incident_id
                and kind = 'alert' and created_at > now() - interval '1 minute') then
    raise exception 'RATE_LIMITED: you alerted people about this report less than a minute ago' using errcode = '54000';
  end if;

  foreach v_aud in array p_audience loop
    if v_aud is null or v_aud not in ('officers','ngo','field') then
      raise exception 'VALIDATION: unknown audience %', v_aud using errcode = '22023';
    end if;
    v_to := v_to || case v_aud
      when 'officers' then rm_officers_for_ward(v_inc.ward_id)
      when 'ngo'      then rm_ngo_coordinators_for_ward(v_inc.ward_id)
      else rm_field_workers_for_incident(v_inc.id) end;
  end loop;

  select full_name into v_by from profiles where id = auth.uid();
  select name into v_ward from wards where id = v_inc.ward_id;
  v_n := rm_notify(
    v_to, 'alert', case when p_urgent then 'critical' else 'high' end,
    case when p_urgent then 'URGENT: ' else 'Action needed: ' end || v_inc.title,
    format('%s · %s. %s (%s): %s', v_inc.reference_code, coalesce(v_ward, v_inc.ward_id),
           coalesce(v_by, 'Staff'), rm_role_label(v_role::text), v_msg),
    v_inc.id, '/incidents/' || v_inc.id, true, coalesce(p_urgent, false), null);
  return jsonb_build_object('ok', true, 'sent', v_n);
end $$;
grant execute on function public.send_incident_alert(uuid, text[], text, boolean) to authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN: not signed in' using errcode = '42501'; end if;
  update notifications set read_at = now()
   where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------- outbox, used by the backend worker only
create or replace function public.rm_claim_deliveries(p_worker text, p_limit integer default 20)
returns table(id uuid, channel text, destination text, attempts integer, title text, body text,
              link text, severity text, kind text)
language sql volatile security definer set search_path = public as $$
  with due as (
    select d.id from notification_deliveries d
     where (d.status = 'queued' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.locked_at < now() - interval '5 minutes')
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 20), 100))
     for update skip locked
  ), claimed as (
    update notification_deliveries d
       set status = 'sending', attempts = d.attempts + 1, locked_by = p_worker, locked_at = now()
      from due where d.id = due.id
    returning d.*
  )
  select c.id, c.channel, c.destination, c.attempts, n.title, n.body, n.link, n.severity, n.kind
    from claimed c join notifications n on n.id = c.notification_id
$$;
revoke all on function public.rm_claim_deliveries(text, integer) from public, anon, authenticated;
