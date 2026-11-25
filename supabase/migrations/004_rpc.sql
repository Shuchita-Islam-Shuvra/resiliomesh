create or replace function public.rm_reserve_resource(
  p_resource_id uuid, p_qty integer, p_idempotency_key text,
  p_incident_id uuid default null, p_need_id uuid default null,
  p_plan_id uuid default null, p_actor uuid default null
) returns allocations
language plpgsql security definer set search_path = public as $$
declare
  v_res   resources;
  v_alloc allocations;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'VALIDATION: quantity must be positive' using errcode = '22023';
  end if;
  if coalesce(trim(p_idempotency_key), '') = '' then
    raise exception 'VALIDATION: idempotency key required' using errcode = '22023';
  end if;

  select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  if found then return v_alloc; end if;

  select * into v_res from resources where id = p_resource_id for update;
  if not found then
    raise exception 'NOT_FOUND: resource %', p_resource_id using errcode = 'P0002';
  end if;

  select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  if found then return v_alloc; end if;

  if v_res.quantity_available < p_qty then
    raise exception 'INSUFFICIENT_STOCK: % requested, % available for %',
      p_qty, v_res.quantity_available, v_res.name using errcode = 'P0001';
  end if;

  update resources set quantity_available = quantity_available - p_qty
  where id = p_resource_id;

  begin
    insert into allocations(resource_id, incident_id, need_id, plan_id, quantity, idempotency_key, allocated_by)
    values (p_resource_id, p_incident_id, p_need_id, p_plan_id, p_qty, p_idempotency_key, coalesce(p_actor, rm_actor()))
    returning * into v_alloc;
  exception when unique_violation then
    update resources set quantity_available = quantity_available + p_qty where id = p_resource_id;
    select * into v_alloc from allocations where idempotency_key = p_idempotency_key;
  end;
  return v_alloc;
end $$;

create or replace function public.rm_release_allocation(p_allocation_id uuid, p_reason text default 'released')
returns allocations
language plpgsql security definer set search_path = public as $$
declare v_alloc allocations;
begin
  select * into v_alloc from allocations where id = p_allocation_id for update;
  if not found then raise exception 'NOT_FOUND: allocation' using errcode = 'P0002'; end if;
  if v_alloc.status in ('released','consumed') then return v_alloc; end if;

  perform 1 from resources where id = v_alloc.resource_id for update;
  update resources set quantity_available = least(quantity_total, quantity_available + v_alloc.quantity)
  where id = v_alloc.resource_id;
  update allocations set status = 'released', released_reason = p_reason
  where id = p_allocation_id returning * into v_alloc;
  return v_alloc;
end $$;

revoke execute on function public.rm_reserve_resource(uuid,integer,text,uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.rm_release_allocation(uuid,text) from public, anon, authenticated;

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
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can allocate aid' using errcode = '42501';
  end if;

  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;

  select exists(select 1 from allocations where idempotency_key = p_idempotency_key) into v_existing;

  if not v_existing then
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

  v_alloc := rm_reserve_resource(p_resource_id, p_qty, p_idempotency_key, v_need.incident_id, p_need_id, null, auth.uid());

  if not v_existing then
    update community_needs
       set fulfilled_qty = fulfilled_qty + p_qty,
           status = case when fulfilled_qty + p_qty >= quantity then 'fulfilled'::need_status
                         else 'partially_fulfilled'::need_status end,
           organization_id = coalesce(organization_id, v_res.organization_id)
     where id = p_need_id;
  end if;

  return jsonb_build_object('ok', true, 'replayed', v_existing, 'allocation', to_jsonb(v_alloc));
end $$;

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

create or replace function public.rm_claim_workflow_run(p_worker text)
returns workflow_runs language plpgsql security definer set search_path = public as $$
declare v_run workflow_runs;
begin
  select * into v_run from workflow_runs
  where (status in ('queued','retrying') and next_run_at <= now())
     or (status in ('running','compensating') and locked_at < now() - interval '5 minutes')
  order by next_run_at
  limit 1
  for update skip locked;
  if not found then return null; end if;
  update workflow_runs
     set status = case when status = 'compensating' then 'compensating'::run_status else 'running'::run_status end,
         locked_by = p_worker, locked_at = now(),
         attempts = attempts + 1, started_at = coalesce(started_at, now())
   where id = v_run.id returning * into v_run;
  return v_run;
end $$;
revoke execute on function public.rm_claim_workflow_run(text) from public, anon, authenticated;

create or replace function public.rm_task_transition_allowed(p_from task_status, p_to task_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'pending'     then p_to in ('assigned','cancelled')
    when 'assigned'    then p_to in ('accepted','in_progress','cancelled')
    when 'accepted'    then p_to in ('in_progress','cancelled')
    when 'in_progress' then p_to in ('completed','failed','cancelled')
    when 'failed'      then p_to in ('assigned','in_progress')
    else false
  end
$$;

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

create or replace function public.nearby_incidents(p_lat double precision, p_lng double precision, p_radius_m integer default 500)
returns table(id uuid, reference_code text, category incident_category, status incident_status, distance_m double precision, created_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select i.id, i.reference_code, i.category, i.status,
         st_distance(i.location, st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography) as distance_m,
         i.created_at
  from incidents i
  where st_dwithin(i.location, st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography, least(p_radius_m, 5000))
  order by distance_m
  limit 50
$$;

create or replace function public.ward_risk_summary()
returns table(ward_id text, name text, city_corporation text, lat double precision, lng double precision,
              population integer, risk_score numeric, risk_level risk_level, risk_updated_at timestamptz,
              active_incidents bigint, critical_incidents bigint)
language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.city_corporation, w.lat, w.lng, w.population,
         w.current_risk_score, w.current_risk_level, w.risk_updated_at,
         count(i.id) filter (where i.status in ('reported','verified','assessed','approved','in_progress')),
         count(i.id) filter (where i.status in ('verified','assessed','approved','in_progress') and i.risk_level = 'critical')
  from wards w
  left join incidents i on i.ward_id = w.id
  group by w.id
  order by w.current_risk_score desc nulls last
$$;
revoke execute on function public.ward_risk_summary() from anon;

create or replace function public.analytics_dashboard(p_days integer default 30, p_ward text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz;
  v_out  jsonb;
begin
  if not rm_is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'VALIDATION: days must be between 1 and 3650' using errcode = '22023';
  end if;
  v_from := now() - make_interval(days => p_days);

  with inc as (
    select * from incidents
    where created_at >= v_from and (p_ward is null or ward_id = p_ward)
  )
  select jsonb_build_object(
    'generated_at', now(),
    'window_days', p_days,
    'totals', (select jsonb_build_object(
        'incidents', count(*),
        'active', count(*) filter (where status in ('reported','verified','assessed','approved','in_progress')),
        'resolved', count(*) filter (where status = 'resolved'),
        'duplicates', count(*) filter (where status = 'duplicate'),
        'critical', count(*) filter (where risk_level = 'critical'),
        'people_affected', coalesce(sum(people_affected) filter (where status <> 'duplicate'), 0),
        'avg_risk', round(avg(risk_score)::numeric, 1),
        'avg_resolution_hours', round((extract(epoch from avg(resolved_at - created_at)) / 3600)::numeric, 1),
        'p90_resolution_hours', round((percentile_cont(0.9) within group (order by extract(epoch from resolved_at - created_at)) / 3600)::numeric, 1)
      ) from inc),
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from inc group by status) s),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', c) order by c desc), '[]'::jsonb)
                    from (select category, count(*) c from inc where status <> 'duplicate' group by category) s),
    'by_ward', (select coalesce(jsonb_agg(row_to_json(s) order by s.incidents desc), '[]'::jsonb) from (
                  select w.id as ward_id, w.name, count(inc.id) as incidents,
                         round(avg(inc.risk_score)::numeric,1) as avg_risk,
                         count(inc.id) filter (where inc.risk_level in ('high','critical')) as high_risk,
                         w.current_risk_score
                  from wards w left join inc on inc.ward_id = w.id
                  where p_ward is null or w.id = p_ward
                  group by w.id) s),
    'daily', (select coalesce(jsonb_agg(row_to_json(d) order by d.day), '[]'::jsonb) from (
                select g::date as day,
                       count(inc.id) filter (where inc.status <> 'duplicate') as reported,
                       count(inc.id) filter (where inc.status = 'resolved') as resolved
                from generate_series(date_trunc('day', v_from), date_trunc('day', now()), interval '1 day') g
                left join inc on date_trunc('day', inc.created_at) = g
                group by g) d),
    'resources', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (
                select resource_type, sum(quantity_total) as total, sum(quantity_available) as available,
                       round(100.0 * (sum(quantity_total) - sum(quantity_available)) / nullif(sum(quantity_total),0), 1) as utilization_pct
                from resources group by resource_type order by resource_type) r),
    'workflows', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from workflow_runs where created_at >= v_from group by status) s),
    'historical', jsonb_build_object(
        'total_records', (select count(*) from historical_flood_events where p_ward is null or ward_id = p_ward),
        'monthly', (select coalesce(jsonb_agg(row_to_json(m) order by m.month), '[]'::jsonb) from (
            select extract(month from event_date)::int as month,
                   count(*) as events,
                   round(avg(rainfall_mm)::numeric,1) as avg_rainfall_mm,
                   round(avg(max_depth_cm)::numeric,1) as avg_depth_cm
            from historical_flood_events
            where p_ward is null or ward_id = p_ward
            group by 1) m),
        'yearly', (select coalesce(jsonb_agg(row_to_json(y) order by y.year), '[]'::jsonb) from (
            select extract(year from event_date)::int as year, count(*) as events,
                   coalesce(sum(households_affected),0) as households
            from historical_flood_events
            where p_ward is null or ward_id = p_ward
            group by 1) y)
    )
  ) into v_out;
  return v_out;
end $$;

grant execute on function public.allocate_to_need(uuid,uuid,integer,text) to authenticated;
grant execute on function public.transition_incident(uuid,incident_status,integer,text,uuid) to authenticated;
grant execute on function public.approve_plan(uuid,integer,text) to authenticated;
grant execute on function public.reject_plan(uuid,text) to authenticated;
grant execute on function public.retry_workflow_run(uuid) to authenticated;
grant execute on function public.update_task_status(uuid,task_status,integer,text) to authenticated;
grant execute on function public.nearby_incidents(double precision,double precision,integer) to authenticated;
grant execute on function public.ward_risk_summary() to authenticated;
grant execute on function public.analytics_dashboard(integer,text) to authenticated;
