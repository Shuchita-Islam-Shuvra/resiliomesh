alter table organizations add column if not exists city_corporation text;
alter table organizations drop constraint if exists organizations_area_check;
alter table organizations add constraint organizations_area_check
  check (city_corporation is null
         or (city_corporation in ('DNCC','DSCC') and type = 'city_authority'));

update organizations set city_corporation = 'DNCC'
 where id = '11111111-1111-1111-1111-111111111101' and city_corporation is null;
update organizations set city_corporation = 'DSCC'
 where id = '11111111-1111-1111-1111-111111111102' and city_corporation is null;

create or replace function public.rm_org_area_guard() returns trigger
language plpgsql as $$
begin
  if old.city_corporation is not null
     and new.city_corporation is distinct from old.city_corporation
     and not rm_is_system() then
    raise exception 'FORBIDDEN: an authority''s area cannot be changed once set' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_org_area_guard on organizations;
create trigger trg_org_area_guard before update on organizations
  for each row execute function rm_org_area_guard();

create or replace function public.rm_area_label(p_area text) returns text
language sql immutable as $$
  select case p_area when 'DNCC' then 'Dhaka North' when 'DSCC' then 'Dhaka South' else 'no area' end
$$;

create or replace function public.rm_area() returns text
language sql stable security definer set search_path = public as $$
  select o.city_corporation from organizations o where o.id = rm_org()
$$;

create or replace function public.rm_can_manage_ward(p_ward text) returns boolean
language sql stable security definer set search_path = public as $$
  select case rm_role()
           when 'admin' then true
           when 'city_officer' then exists (select 1 from wards w
                                             where w.id = p_ward and w.city_corporation = rm_area())
           else false
         end
$$;

create or replace function public.rm_assert_officer_area(p_ward text) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_ward_area text;
begin
  if rm_role() is distinct from 'city_officer' or rm_can_manage_ward(p_ward) then return; end if;
  select city_corporation into v_ward_area from wards where id = p_ward;
  raise exception 'FORBIDDEN: this is in %, outside your area (%)',
    rm_area_label(v_ward_area), rm_area_label(rm_area()) using errcode = '42501';
end $$;

grant execute on function public.rm_area_label(text) to anon, authenticated;
grant execute on function public.rm_area() to authenticated;
grant execute on function public.rm_can_manage_ward(text) to authenticated;
grant execute on function public.rm_assert_officer_area(text) to authenticated;

drop policy if exists incidents_update on incidents;
create policy incidents_update on incidents for update to authenticated
  using ((reporter_id = auth.uid() and status = 'reported') or rm_can_manage_ward(ward_id))
  with check ((reporter_id = auth.uid()) or rm_can_manage_ward(ward_id));

drop policy if exists assets_write on drainage_assets;
create policy assets_write on drainage_assets for insert to authenticated
  with check (rm_role() = 'admin'
              or (rm_role() = 'city_officer' and owner_org_id = rm_org() and rm_can_manage_ward(ward_id)));
drop policy if exists assets_update on drainage_assets;
create policy assets_update on drainage_assets for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() = 'city_officer' and owner_org_id = rm_org() and rm_can_manage_ward(ward_id)))
  with check (rm_role() = 'admin'
         or (rm_role() = 'city_officer' and owner_org_id = rm_org() and rm_can_manage_ward(ward_id)));

create or replace function public.transition_incident(
  p_incident_id uuid, p_to incident_status, p_expected_version integer,
  p_note text default null, p_duplicate_of uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_inc incidents;
begin
  if v_role is null then raise exception 'FORBIDDEN: not authenticated' using errcode = '42501'; end if;

  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then raise exception 'NOT_FOUND: incident' using errcode = 'P0002'; end if;

  if v_inc.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_inc));
  end if;

  if p_to in ('verified','rejected','duplicate','resolved','assessed') and v_role not in ('city_officer','admin') then
    raise exception 'FORBIDDEN: % cannot move an incident to %', v_role, p_to using errcode = '42501';
  end if;
  perform rm_assert_officer_area(v_inc.ward_id);
  if p_to in ('approved','in_progress') then
    raise exception 'FORBIDDEN: % is set by plan approval / workflow only', p_to using errcode = '42501';
  end if;
  if p_to = 'assessed' and v_inc.risk_score is null then
    raise exception 'INVALID_STATE: run AI risk assessment before marking assessed' using errcode = '23514';
  end if;
  if p_to = 'rejected' and coalesce(trim(p_note), '') = '' then
    raise exception 'VALIDATION: a reason is required to reject' using errcode = '22023';
  end if;
  if p_to = 'duplicate' then
    if p_duplicate_of is null or p_duplicate_of = p_incident_id then
      raise exception 'VALIDATION: choose a different parent incident' using errcode = '22023';
    end if;
  end if;
  if p_to = 'resolved' and exists (
      select 1 from tasks where incident_id = p_incident_id and status not in ('completed','cancelled','failed')) then
    raise exception 'INVALID_STATE: open field tasks must be completed first' using errcode = '23514';
  end if;

  perform set_config('rm.note', coalesce(p_note, ''), true);
  update incidents
     set status = p_to,
         duplicate_of = case when p_to = 'duplicate' then p_duplicate_of else duplicate_of end,
         verified_by = case when p_to = 'verified' then auth.uid() else verified_by end
   where id = p_incident_id
   returning * into v_inc;

  return jsonb_build_object('ok', true, 'incident', to_jsonb(v_inc));
end $$;

create or replace function public.rm_assert_officer_plan(p_incident_ids uuid[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_ward text;
begin
  if rm_role() is distinct from 'city_officer' then return; end if;
  select i.ward_id into v_ward from incidents i
   where i.id = any(p_incident_ids) and not rm_can_manage_ward(i.ward_id) limit 1;
  if v_ward is not null then perform rm_assert_officer_area(v_ward); end if;
end $$;
grant execute on function public.rm_assert_officer_plan(uuid[]) to authenticated;

create or replace function public.approve_plan(
  p_plan_id uuid, p_expected_version integer, p_inject_failure text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_plan allocation_plans;
  v_run  workflow_runs;
  v_bad  integer;
begin
  if v_role not in ('city_officer','ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only coordinators can approve plans' using errcode = '42501';
  end if;
  if p_inject_failure is not null and v_role <> 'admin' then
    raise exception 'FORBIDDEN: fault injection is admin-only' using errcode = '42501';
  end if;
  if p_inject_failure is not null and p_inject_failure not in ('reserve_resources','create_tasks','notify_teams','activate_incidents') then
    raise exception 'VALIDATION: unknown step %', p_inject_failure using errcode = '22023';
  end if;

  select * into v_plan from allocation_plans where id = p_plan_id for update;
  if not found then raise exception 'NOT_FOUND: plan' using errcode = 'P0002'; end if;
  perform rm_assert_officer_plan(v_plan.incident_ids);

  if v_plan.status in ('approved','executing','executed') then
    select * into v_run from workflow_runs where plan_id = p_plan_id;
    return jsonb_build_object('ok', true, 'replayed', true, 'run_id', v_run.id);
  end if;
  if v_plan.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(v_plan));
  end if;
  if v_plan.status <> 'pending_approval' then
    raise exception 'INVALID_STATE: plan is %', v_plan.status using errcode = '23514';
  end if;
  if jsonb_array_length(v_plan.assignments) = 0 then
    raise exception 'INFEASIBLE: plan has no assignments and cannot be approved' using errcode = '23514';
  end if;
  if v_plan.created_at < now() - interval '2 hours' then
    raise exception 'STALE_PLAN: plan is older than 2 hours, re-run optimization' using errcode = '23514';
  end if;

  select count(*) into v_bad from incidents
  where id = any(v_plan.incident_ids) and status <> 'assessed';
  if v_bad > 0 then
    raise exception 'INVALID_STATE: % incident(s) in this plan are no longer in assessed state', v_bad
      using errcode = '23514';
  end if;

  update allocation_plans set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_plan_id;

  update allocation_plans set status = 'superseded'
  where id <> p_plan_id and status = 'pending_approval' and incident_ids && v_plan.incident_ids;

  perform set_config('rm.note', 'Plan approved', true);
  update incidents set status = 'approved' where id = any(v_plan.incident_ids);

  insert into workflow_runs(plan_id, idempotency_key, inject_failure, created_by)
  values (p_plan_id, 'plan:' || p_plan_id, p_inject_failure, auth.uid())
  on conflict (idempotency_key) do nothing
  returning * into v_run;
  if v_run.id is null then
    select * into v_run from workflow_runs where idempotency_key = 'plan:' || p_plan_id;
  end if;

  perform pg_notify('workflow_runs', v_run.id::text);
  return jsonb_build_object('ok', true, 'replayed', false, 'run_id', v_run.id);
end $$;

create or replace function public.reject_plan(p_plan_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan allocation_plans;
begin
  if rm_role() not in ('city_officer','ngo_coordinator','admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: reason required' using errcode = '22023';
  end if;
  perform rm_assert_officer_plan((select incident_ids from allocation_plans where id = p_plan_id));
  update allocation_plans set status = 'rejected', rejection_reason = p_reason
  where id = p_plan_id and status = 'pending_approval' returning * into v_plan;
  if v_plan.id is null then raise exception 'INVALID_STATE: plan is not pending' using errcode = '23514'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.retry_workflow_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run workflow_runs;
begin
  if rm_role() not in ('admin','city_officer') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_run from workflow_runs where id = p_run_id for update;
  if not found then raise exception 'NOT_FOUND: workflow run' using errcode = 'P0002'; end if;
  perform rm_assert_officer_plan((select incident_ids from allocation_plans where id = v_run.plan_id));
  if v_run.status not in ('failed','compensated') then
    raise exception 'INVALID_STATE: only failed runs can be retried' using errcode = '23514';
  end if;
  perform set_config('rm.note', 'Workflow retry', true);
  update incidents i set status = 'approved'
    from allocation_plans p
   where p.id = v_run.plan_id and i.id = any(p.incident_ids) and i.status = 'assessed';
  update allocation_plans set status = 'approved' where id = v_run.plan_id;
  update workflow_runs set status = 'queued', attempts = 0, last_error = null, inject_failure = null,
         generation = generation + 1,
         next_run_at = now(), finished_at = null, locked_by = null
   where id = p_run_id;
  update workflow_steps set status = 'pending', error = null where run_id = p_run_id and status in ('failed','compensated');
  perform pg_notify('workflow_runs', p_run_id::text);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.update_task_status(
  p_task_id uuid, p_status task_status, p_expected_version integer,
  p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_task tasks;
  v_open integer;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;

  if not (v_role in ('city_officer','admin') or (v_role = 'field_worker' and v_task.assigned_to = auth.uid())) then
    raise exception 'FORBIDDEN: task is assigned to another worker' using errcode = '42501';
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
    completed_at = case when p_status = 'completed' then now() else completed_at end
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
