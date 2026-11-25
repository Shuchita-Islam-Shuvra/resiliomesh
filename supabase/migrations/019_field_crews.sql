alter table profiles add column if not exists field_team text
  check (field_team is null or char_length(field_team) <= 60);
alter table profiles add column if not exists on_duty boolean not null default true;

do $$
begin
  if to_regclass('public.role_requests') is not null then
    update profiles p set field_team = r.team
      from (select distinct on (user_id) user_id, team from role_requests
             where status = 'approved' and requested_role = 'field_worker' and team is not null
             order by user_id, reviewed_at desc nulls last) r
     where p.id = r.user_id and p.field_team is null;
  end if;
end $$;

update profiles p set field_team = v.team
  from (values ('field1@resiliomesh.demo', 'Drainage crew'),
               ('field2@resiliomesh.demo', 'Pump operator'),
               ('field3@resiliomesh.demo', 'Relief distribution'),
               ('field4@resiliomesh.demo', 'Pump operator'),
               ('field5@resiliomesh.demo', 'Drainage crew'),
               ('field6@resiliomesh.demo', 'Drainage crew'),
               ('field7@resiliomesh.demo', 'Medical / first aid')) v(mail, team)
 where lower(p.email) = v.mail and p.field_team is null;

do $$
begin
  if to_regclass('public.staff_roster') is not null then
    insert into staff_roster(organization_id, employee_id, official_email, full_name, role)
    select o.id, v.emp, v.mail, v.name, 'field_worker'::app_role
      from (values
        ('11111111-1111-1111-1111-111111111102'::uuid, 'FW-004', 'field4@resiliomesh.demo', 'Jahangir Alam'),
        ('11111111-1111-1111-1111-111111111101'::uuid, 'FW-005', 'field5@resiliomesh.demo', 'Rubina Khatun'),
        ('11111111-1111-1111-1111-111111111102'::uuid, 'FW-006', 'field6@resiliomesh.demo', 'Sohel Rana'),
        ('11111111-1111-1111-1111-111111111104'::uuid, 'FW-007', 'field7@resiliomesh.demo', 'Nasima Akter')
      ) v(org, emp, mail, name)
      join organizations o on o.id = v.org
     where not exists (select 1 from staff_roster s where s.organization_id = v.org
                         and (upper(s.employee_id) = v.emp or lower(s.official_email) = v.mail));
  end if;
end $$;

create or replace function public.rm_guard_field_team() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.field_team is distinct from old.field_team
     and not rm_is_system() and coalesce(rm_role()::text, '') <> 'admin' then
    raise exception 'FORBIDDEN: only an admin can change a field worker''s team' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_field_team on profiles;
create trigger trg_guard_field_team before update of field_team on profiles
  for each row execute function rm_guard_field_team();

create or replace function public.rm_role_request_team() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.requested_role = 'field_worker' and new.team is not null then
    update profiles set field_team = new.team where id = new.user_id;
  end if;
  return new;
end $$;
do $$
begin
  if to_regclass('public.role_requests') is not null then
    execute 'drop trigger if exists trg_role_request_team on role_requests';
    execute 'create trigger trg_role_request_team after update of status on role_requests
               for each row execute function rm_role_request_team()';
  end if;
end $$;

create or replace function public.rm_team_task_types(p_team text) returns text[]
language sql immutable as $$
  select case lower(trim(coalesce(p_team, '')))
    when 'drainage crew'       then array['drain_clearing','inspection']
    when 'pump operator'       then array['pump_deployment','inspection']
    when 'relief distribution' then array['relief_distribution','evacuation_support']
    when 'damage survey'       then array['inspection']
    when 'medical / first aid' then array['relief_distribution','evacuation_support']
    else null
  end
$$;

create table if not exists task_assignees (
  task_id     uuid not null references tasks(id) on delete cascade,
  worker_id   uuid not null references profiles(id) on delete cascade,
  is_lead     boolean not null default false,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references profiles(id) on delete set null,
  primary key (task_id, worker_id)
);
create index if not exists idx_task_assignees_worker on task_assignees(worker_id);
create unique index if not exists uq_task_assignees_one_lead on task_assignees(task_id) where is_lead;
alter table task_assignees enable row level security;

create table if not exists task_declines (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  worker_id  uuid not null references profiles(id) on delete cascade,
  reason     text not null check (char_length(reason) between 3 and 300),
  created_at timestamptz not null default now()
);
create index if not exists idx_task_declines_task on task_declines(task_id);
alter table task_declines enable row level security;
drop trigger if exists trg_audit_task_declines on task_declines;
create trigger trg_audit_task_declines after insert or update or delete on task_declines
  for each row execute function rm_audit();

alter table tasks add column if not exists crew_size integer not null default 1
  check (crew_size between 1 and 10);
alter table tasks add column if not exists started_lat  double precision;
alter table tasks add column if not exists started_lng  double precision;
alter table tasks add column if not exists finished_lat double precision;
alter table tasks add column if not exists finished_lng double precision;
alter table tasks add column if not exists finished_by  uuid references profiles(id) on delete set null;

insert into task_assignees(task_id, worker_id, is_lead, assigned_at)
select id, assigned_to, true, created_at from tasks where assigned_to is not null
on conflict do nothing;

create or replace function public.rm_is_task_member(p_task_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from task_assignees where task_id = p_task_id and worker_id = auth.uid())
$$;
grant execute on function public.rm_is_task_member(uuid) to authenticated;

create or replace function public.rm_task_incident(p_task_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select incident_id from tasks where id = p_task_id
$$;
grant execute on function public.rm_task_incident(uuid) to authenticated;

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select to authenticated
  using (assigned_to = auth.uid() or rm_is_task_member(id)
         or (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_incident(incident_id)));

drop policy if exists task_assignees_read on task_assignees;
create policy task_assignees_read on task_assignees for select to authenticated
  using (worker_id = auth.uid() or rm_is_task_member(task_id)
         or (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_incident(rm_task_incident(task_id))));

drop policy if exists task_declines_read on task_declines;
create policy task_declines_read on task_declines for select to authenticated
  using (worker_id = auth.uid()
         or (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_incident(rm_task_incident(task_id))));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and tablename = 'task_assignees') then
    execute 'alter publication supabase_realtime add table task_assignees';
  end if;
end $$;
alter table task_assignees replica identity full;

create or replace function public.rm_pick_field_crew(
  p_incident_id uuid, p_task_type text, p_owner_orgs uuid[] default null,
  p_n integer default 1, p_exclude uuid[] default null
) returns table(worker_id uuid, pick_rank integer)
language sql stable security definer set search_path = public as $$
  with inc as (
    select i.ward_id, w.city_corporation as area
      from incidents i join wards w on w.id = i.ward_id where i.id = p_incident_id
  ), cand as (
    select p.id, p.ward_id, p.created_at, p.organization_id,
           (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id
             where ta.worker_id = p.id and t.status in ('assigned','accepted','in_progress')) as open_tasks
      from profiles p
      left join organizations o on o.id = p.organization_id
      cross join inc
     where p.role = 'field_worker' and p.is_active and p.on_duty
       and (o.city_corporation is null or o.city_corporation = inc.area)
       and (rm_team_task_types(p.field_team) is null or p_task_type = any(rm_team_task_types(p.field_team)))
       and (p_exclude is null or not (p.id = any(p_exclude)))
  ), ranked as (
    select c.id, row_number() over (order by
             (p_owner_orgs is not null and c.organization_id = any(p_owner_orgs)) desc,
             c.open_tasks asc,
             (c.ward_id = (select ward_id from inc)) desc nulls last,
             c.created_at, c.id)::integer as rk
      from cand c
  )
  select id, rk from ranked where rk <= greatest(coalesce(p_n, 1), 1) order by rk
$$;
revoke all on function public.rm_pick_field_crew(uuid, text, uuid[], integer, uuid[]) from public, anon, authenticated;

create or replace function public.rm_task_owner_orgs(p_task tasks) returns uuid[]
language sql stable security definer set search_path = public as $$
  select array_agg(distinct r.organization_id)
    from allocations a join resources r on r.id = a.resource_id
   where a.incident_id = p_task.incident_id
     and (p_task.plan_id is null or a.plan_id = p_task.plan_id)
$$;
revoke all on function public.rm_task_owner_orgs(tasks) from public, anon, authenticated;

create or replace function public.rm_sync_task_lead(p_task_id uuid, p_note text default null) returns tasks
language plpgsql security definer set search_path = public as $$
declare v_lead uuid; v_task tasks;
begin
  if not exists (select 1 from task_assignees where task_id = p_task_id and is_lead) then
    update task_assignees set is_lead = true
     where task_id = p_task_id
       and worker_id = (select worker_id from task_assignees where task_id = p_task_id
                         order by assigned_at, worker_id limit 1);
  end if;
  select worker_id into v_lead from task_assignees where task_id = p_task_id and is_lead;
  update tasks set
    assigned_to = v_lead,
    status = case when v_lead is null and status = 'assigned' then 'pending'::task_status
                  when v_lead is not null and status in ('pending','failed') then 'assigned'::task_status
                  else status end,
    notes = case when p_note is null then notes else coalesce(notes || E'\n', '') || p_note end
  where id = p_task_id returning * into v_task;
  return v_task;
end $$;
revoke all on function public.rm_sync_task_lead(uuid, text) from public, anon, authenticated;

create or replace function public.rm_stamp(p_text text) returns text
language sql stable as $$
  select '[' || to_char(now() at time zone 'Asia/Dhaka', 'DD/MM/YYYY, HH24:MI') || '] ' || p_text
$$;

drop function if exists public.update_task_status(uuid, task_status, integer, text);
create or replace function public.update_task_status(
  p_task_id uuid, p_status task_status, p_expected_version integer,
  p_notes text default null, p_lat double precision default null, p_lng double precision default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_task tasks;
  v_open integer;
  v_gps boolean := coalesce(p_lat between 20 and 27 and p_lng between 88 and 93, false);
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;

  if not (v_role in ('city_officer','admin')
          or (v_role = 'field_worker' and (v_task.assigned_to = auth.uid() or rm_is_task_member(p_task_id)))) then
    raise exception 'FORBIDDEN: task is assigned to another crew' using errcode = '42501';
  end if;
  if v_role = 'city_officer' then
    perform rm_assert_officer_area((select ward_id from incidents where id = v_task.incident_id));
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
    started_lat = case when p_status = 'in_progress' and v_gps and started_lat is null then p_lat else started_lat end,
    started_lng = case when p_status = 'in_progress' and v_gps and started_lng is null then p_lng else started_lng end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    finished_lat = case when p_status in ('completed','failed') and v_gps then p_lat else finished_lat end,
    finished_lng = case when p_status in ('completed','failed') and v_gps then p_lng else finished_lng end,
    finished_by  = case when p_status in ('completed','failed') then auth.uid() else finished_by end
  where id = p_task_id returning * into v_task;

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
grant execute on function public.update_task_status(uuid, task_status, integer, text, double precision, double precision) to authenticated;

create or replace function public.decline_task(p_task_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_task tasks;
  v_next uuid;
  v_excl uuid[];
begin
  if rm_role() is distinct from 'field_worker' then
    raise exception 'FORBIDDEN: only field workers decline tasks' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'VALIDATION: say why you cannot take this task' using errcode = '22023';
  end if;
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;
  if not exists (select 1 from task_assignees where task_id = p_task_id and worker_id = v_me) then
    raise exception 'FORBIDDEN: you are not on this task''s crew' using errcode = '42501';
  end if;
  if v_task.status <> 'assigned' then
    raise exception 'INVALID_TRANSITION: only a task not yet accepted can be declined; once started, report a failure instead'
      using errcode = '23514';
  end if;

  insert into task_declines(task_id, worker_id, reason) values (p_task_id, v_me, left(v_reason, 300));
  delete from task_assignees where task_id = p_task_id and worker_id = v_me;

  select array_agg(x) into v_excl from (
    select worker_id x from task_declines where task_id = p_task_id
    union select worker_id from task_assignees where task_id = p_task_id) s;
  select c.worker_id into v_next
    from rm_pick_field_crew(v_task.incident_id, v_task.task_type, rm_task_owner_orgs(v_task), 1, v_excl) c;
  if v_next is not null then
    insert into task_assignees(task_id, worker_id, is_lead) values (p_task_id, v_next, false);
  end if;

  v_task := rm_sync_task_lead(p_task_id, rm_stamp(format('%s declined: %s%s',
              (select full_name from profiles where id = v_me), v_reason,
              case when v_next is null then ' — no replacement on duty, officer must assign'
                   else ' — replaced by ' || (select full_name from profiles where id = v_next) end)));
  return jsonb_build_object('ok', true, 'replacement', v_next, 'task', to_jsonb(v_task));
end $$;
grant execute on function public.decline_task(uuid, text) to authenticated;

create or replace function public.rm_assert_task_manager(p_task tasks) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if rm_role() = 'admin' then return; end if;
  if rm_role() is distinct from 'city_officer' then
    raise exception 'FORBIDDEN: only a Water Resilience Officer or admin manages crews' using errcode = '42501';
  end if;
  perform rm_assert_officer_area((select ward_id from incidents where id = p_task.incident_id));
end $$;
revoke all on function public.rm_assert_task_manager(tasks) from public, anon, authenticated;

create or replace function public.eligible_field_workers(p_task_id uuid)
returns table(id uuid, full_name text, phone text, field_team text, organization text,
              on_duty boolean, open_tasks integer, skill_match boolean, owner_org boolean,
              in_crew boolean, is_lead boolean, declined boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_task tasks; v_area text; v_owner uuid[];
begin
  select * into v_task from tasks where tasks.id = p_task_id;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;
  perform rm_assert_task_manager(v_task);
  select w.city_corporation into v_area from incidents i join wards w on w.id = i.ward_id where i.id = v_task.incident_id;
  v_owner := rm_task_owner_orgs(v_task);
  return query
  select p.id, p.full_name, p.phone, p.field_team, o.name, p.on_duty,
         (select count(*)::integer from task_assignees ta join tasks t on t.id = ta.task_id
           where ta.worker_id = p.id and t.status in ('assigned','accepted','in_progress')),
         (rm_team_task_types(p.field_team) is null or v_task.task_type = any(rm_team_task_types(p.field_team))),
         coalesce(p.organization_id = any(v_owner), false),
         ta.worker_id is not null, coalesce(ta.is_lead, false),
         exists (select 1 from task_declines d where d.task_id = p_task_id and d.worker_id = p.id)
    from profiles p
    left join organizations o on o.id = p.organization_id
    left join task_assignees ta on ta.task_id = p_task_id and ta.worker_id = p.id
   where p.role = 'field_worker' and p.is_active
     and (o.city_corporation is null or o.city_corporation = v_area)
   order by 10 desc, 6 desc, 8 desc, 9 desc, 7 asc, 2;
end $$;
grant execute on function public.eligible_field_workers(uuid) to authenticated;

create or replace function public.assign_task_crew(p_task_id uuid, p_workers uuid[], p_lead uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_task tasks;
  v_area text;
  v_lead uuid := coalesce(p_lead, p_workers[1]);
  v_bad integer;
  v_names text;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;
  perform rm_assert_task_manager(v_task);
  if v_task.status in ('completed','cancelled') then
    raise exception 'INVALID_TRANSITION: task is already %', v_task.status using errcode = '23514';
  end if;
  if coalesce(array_length(p_workers, 1), 0) = 0 then
    raise exception 'VALIDATION: pick at least one field worker' using errcode = '22023';
  end if;
  if array_length(p_workers, 1) > 10 then
    raise exception 'VALIDATION: a crew has at most 10 people' using errcode = '22023';
  end if;
  if not (v_lead = any(p_workers)) then
    raise exception 'VALIDATION: the lead must be on the crew' using errcode = '22023';
  end if;

  select w.city_corporation into v_area from incidents i join wards w on w.id = i.ward_id where i.id = v_task.incident_id;
  select count(*) into v_bad
    from unnest(p_workers) u(w)
    left join profiles p on p.id = u.w
    left join organizations o on o.id = p.organization_id
   where p.id is null or p.role <> 'field_worker' or not p.is_active
      or (o.city_corporation is not null and o.city_corporation <> v_area);
  if v_bad > 0 then
    raise exception 'VALIDATION: every crew member must be an active field worker allowed in this area' using errcode = '22023';
  end if;

  delete from task_assignees where task_id = p_task_id and not (worker_id = any(p_workers));
  update task_assignees set is_lead = false where task_id = p_task_id and is_lead and worker_id <> v_lead;
  insert into task_assignees(task_id, worker_id, is_lead, assigned_by)
  select p_task_id, u.w, u.w = v_lead, auth.uid() from (select distinct unnest(p_workers) w) u
  on conflict (task_id, worker_id) do update set is_lead = excluded.is_lead;

  select string_agg(p.full_name || case when p.id = v_lead then ' (lead)' else '' end, ', ' order by p.id <> v_lead, p.full_name)
    into v_names from profiles p where p.id = any(p_workers);
  v_task := rm_sync_task_lead(p_task_id, rm_stamp(format('Crew set by %s: %s',
              (select full_name from profiles where id = auth.uid()), v_names)));
  return jsonb_build_object('ok', true, 'task', to_jsonb(v_task));
end $$;
grant execute on function public.assign_task_crew(uuid, uuid[], uuid) to authenticated;
