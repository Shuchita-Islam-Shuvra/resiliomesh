-- =====================================================================
-- ResilioMesh — 011 officers SEE only their own area
-- ---------------------------------------------------------------------
-- Migration 009 limited what a Water Resilience Officer (role `city_officer`) may
-- CHANGE to their area (Dhaka North = DNCC, Dhaka South = DSCC) but let them
-- read the whole city. From this migration an officer also only SEES their
-- own area: wards, incidents (+ history, risk assessments), drainage assets,
-- community needs, resources, plans, allocations, tasks, workflow runs and
-- steps, historical flood events, and the two dashboard RPCs.
--
--   * An officer always sees their own reports and their own authority's
--     resources, wherever they are.
--   * An officer whose authority has no area sees nothing area-bound (fail-safe).
--   * Admins, NGO coordinators, field workers and citizens are unchanged.
--
-- Requires 009. Re-runnable. If you re-run 003_rls.sql or 004_rpc.sql,
-- run 009 and then this file again.
-- =====================================================================

-- ---------- 1. Helpers ----------------------------------------------------
-- May the caller SEE rows of this ward? true for every role except officers.
create or replace function public.rm_sees_ward(p_ward text) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or exists (select 1 from wards w where w.id = p_ward and w.city_corporation = rm_area())
$$;

-- every incident of the list is in the caller's view (plans, workflow runs)
create or replace function public.rm_sees_incidents(p_incident_ids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or (coalesce(array_length(p_incident_ids, 1), 0) > 0
          and not exists (select 1 from incidents i
                           where i.id = any(p_incident_ids) and not rm_sees_ward(i.ward_id)))
$$;

create or replace function public.rm_sees_incident(p_incident_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or exists (select 1 from incidents i where i.id = p_incident_id and rm_sees_ward(i.ward_id))
$$;

create or replace function public.rm_sees_need(p_need_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or exists (select 1 from community_needs n where n.id = p_need_id and rm_sees_ward(n.ward_id))
$$;

create or replace function public.rm_sees_plan(p_plan_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or exists (select 1 from allocation_plans p where p.id = p_plan_id and rm_sees_incidents(p.incident_ids))
$$;

create or replace function public.rm_sees_run(p_run_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_role() is distinct from 'city_officer'
      or exists (select 1 from workflow_runs r where r.id = p_run_id and rm_sees_plan(r.plan_id))
$$;

grant execute on function public.rm_sees_ward(text) to anon, authenticated;
grant execute on function public.rm_sees_incidents(uuid[]) to authenticated;
grant execute on function public.rm_sees_incident(uuid) to authenticated;
grant execute on function public.rm_sees_need(uuid) to authenticated;
grant execute on function public.rm_sees_plan(uuid) to authenticated;
grant execute on function public.rm_sees_run(uuid) to authenticated;

-- ---------- 2. Read policies ---------------------------------------------
drop policy if exists wards_read on wards;
create policy wards_read on wards for select to anon, authenticated
  using (rm_sees_ward(id));

drop policy if exists assets_read on drainage_assets;
create policy assets_read on drainage_assets for select to authenticated
  using (rm_sees_ward(ward_id));

drop policy if exists incidents_read on incidents;
create policy incidents_read on incidents for select to authenticated
  using (reporter_id = auth.uid() or (rm_is_staff() and rm_sees_ward(ward_id)));

drop policy if exists ish_read on incident_status_history;
create policy ish_read on incident_status_history for select to authenticated
  using (exists (select 1 from incidents i where i.id = incident_id
                   and (i.reporter_id = auth.uid() or (rm_is_staff() and rm_sees_ward(i.ward_id)))));

drop policy if exists risk_read on risk_assessments;
create policy risk_read on risk_assessments for select to authenticated
  using (rm_is_staff() and rm_sees_ward(ward_id));

drop policy if exists resources_read on resources;
create policy resources_read on resources for select to authenticated
  using (rm_is_staff() and (organization_id = rm_org() or rm_sees_ward(base_ward_id)));

drop policy if exists needs_read on community_needs;
create policy needs_read on community_needs for select to authenticated
  using (submitted_by = auth.uid() or (rm_is_staff() and rm_sees_ward(ward_id)));

drop policy if exists plans_read on allocation_plans;
create policy plans_read on allocation_plans for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_incidents(incident_ids));

drop policy if exists alloc_read on allocations;
create policy alloc_read on allocations for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin')
         and (case when incident_id is not null then rm_sees_incident(incident_id)
                   else rm_sees_need(need_id) end));

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select to authenticated
  using (assigned_to = auth.uid()
         or (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_incident(incident_id)));

drop policy if exists runs_read on workflow_runs;
create policy runs_read on workflow_runs for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_plan(plan_id));

drop policy if exists steps_read on workflow_steps;
create policy steps_read on workflow_steps for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin') and rm_sees_run(run_id));

drop policy if exists hfe_read on historical_flood_events;
create policy hfe_read on historical_flood_events for select to authenticated
  using (rm_is_staff() and rm_sees_ward(ward_id));

-- ---------- 3. Dashboard RPCs (SECURITY DEFINER, so they filter themselves) --
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
  where rm_sees_ward(w.id)
  group by w.id
  order by w.current_risk_score desc nulls last
$$;
revoke execute on function public.ward_risk_summary() from anon;
grant execute on function public.ward_risk_summary() to authenticated;

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

  with vw as (                       -- wards the caller may see (officers: own area only)
    select * from wards where rm_sees_ward(id) and (p_ward is null or id = p_ward)
  ), inc as (
    select * from incidents
    where created_at >= v_from and ward_id in (select id from vw)
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
                  from vw w left join inc on inc.ward_id = w.id
                  group by w.id, w.name, w.current_risk_score) s),
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
                from resources
                where rm_role() is distinct from 'city_officer' or organization_id = rm_org() or rm_sees_ward(base_ward_id)
                group by resource_type order by resource_type) r),
    'workflows', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from workflow_runs
                         where created_at >= v_from and rm_sees_plan(plan_id) group by status) s),
    'historical', jsonb_build_object(
        'total_records', (select count(*) from historical_flood_events where ward_id in (select id from vw)),
        'monthly', (select coalesce(jsonb_agg(row_to_json(m) order by m.month), '[]'::jsonb) from (
            select extract(month from event_date)::int as month,
                   count(*) as events,
                   round(avg(rainfall_mm)::numeric,1) as avg_rainfall_mm,
                   round(avg(max_depth_cm)::numeric,1) as avg_depth_cm
            from historical_flood_events
            where ward_id in (select id from vw)
            group by 1) m),
        'yearly', (select coalesce(jsonb_agg(row_to_json(y) order by y.year), '[]'::jsonb) from (
            select extract(year from event_date)::int as year, count(*) as events,
                   coalesce(sum(households_affected),0) as households
            from historical_flood_events
            where ward_id in (select id from vw)
            group by 1) y)
    )
  ) into v_out;
  return v_out;
end $$;
grant execute on function public.analytics_dashboard(integer,text) to authenticated;
