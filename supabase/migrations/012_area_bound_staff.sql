-- =====================================================================
-- ResilioMesh — 012 North / South everywhere (area-bound staff)
-- ---------------------------------------------------------------------
-- 011 limited what Water Resilience Officers SEE to their area. This migration makes
-- the North / South split consistent across the whole project:
--
--   * "Area-bound" staff = people of a city corporation:
--       - Water Resilience Officers (always; an officer whose authority has no area
--         sees nothing area-bound — fail-safe), and
--       - Field Workers of Dhaka North / Dhaka South City Corporation.
--     NGO field workers, NGO coordinators, admins and citizens stay city-wide.
--   * Area-bound staff see only their area (every read policy of 011 and the
--     dashboard RPCs, plus the per-ward weather cache).
--   * Area-bound staff can only file reports and log community needs in their
--     area. A place belongs to the area of its nearest ward centre — the same
--     rule that already decides a report's ward (migration 008).
--   * ward_areas(): public ward centres + area, so maps can shade the other
--     city corporation as "not your area". No risk, report or people data.
--
-- Requires 009 and 011. Re-runnable. If you re-run 011, run this file again.
-- =====================================================================

-- ---------- 1. Who is bound to an area -----------------------------------
-- null = city-wide; 'DNCC' / 'DSCC' = only that area; '-' = nothing (officer without area)
create or replace function public.rm_view_area() returns text
language sql stable security definer set search_path = public as $$
  select case rm_role()
           when 'city_officer' then coalesce(rm_area(), '-')
           when 'field_worker' then rm_area()        -- authority crews: their area; NGO crews: null
         end
$$;
grant execute on function public.rm_view_area() to authenticated;

-- area of a point = area of the nearest ward centre (same rule as report → ward in 008)
create or replace function public.rm_area_at(p_lat double precision, p_lng double precision) returns text
language sql stable security definer set search_path = public as $$
  select city_corporation from wards
   order by st_distance(location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography)
   limit 1
$$;
grant execute on function public.rm_area_at(double precision, double precision) to anon, authenticated;

-- ---------- 2. Visibility helpers (same names as 011, now for all area-bound staff)
create or replace function public.rm_sees_ward(p_ward text) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or exists (select 1 from wards w where w.id = p_ward and w.city_corporation = rm_view_area())
$$;

create or replace function public.rm_sees_incidents(p_incident_ids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or (coalesce(array_length(p_incident_ids, 1), 0) > 0
          and not exists (select 1 from incidents i
                           where i.id = any(p_incident_ids) and not rm_sees_ward(i.ward_id)))
$$;

create or replace function public.rm_sees_incident(p_incident_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or exists (select 1 from incidents i where i.id = p_incident_id and rm_sees_ward(i.ward_id))
$$;

create or replace function public.rm_sees_need(p_need_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or exists (select 1 from community_needs n where n.id = p_need_id and rm_sees_ward(n.ward_id))
$$;

create or replace function public.rm_sees_plan(p_plan_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or exists (select 1 from allocation_plans p where p.id = p_plan_id and rm_sees_incidents(p.incident_ids))
$$;

create or replace function public.rm_sees_run(p_run_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rm_view_area() is null
      or exists (select 1 from workflow_runs r where r.id = p_run_id and rm_sees_plan(r.plan_id))
$$;

-- ---------- 3. Policies not covered by 011 --------------------------------
drop policy if exists weather_read on weather_cache;
create policy weather_read on weather_cache for select to authenticated
  using (rm_sees_ward(ward_id));

-- ---------- 4. Area-bound staff report / log needs only in their area ----
create or replace function public.rm_area_write_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_area text := rm_view_area(); v_ward_area text; v_pin_area text;
begin
  if rm_is_system() or v_area is null then return new; end if;
  select city_corporation into v_ward_area from wards where id = new.ward_id;
  if TG_TABLE_NAME = 'incidents' then v_pin_area := rm_area_at(new.lat, new.lng); end if;
  if v_area = '-' or v_ward_area is distinct from v_area
     or (v_pin_area is not null and v_pin_area is distinct from v_area) then
    raise exception 'FORBIDDEN: this place is in %, outside your area (%)',
      rm_area_label(coalesce(v_pin_area, v_ward_area)), rm_area_label(nullif(v_area, '-')) using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_area_guard on incidents;
create trigger trg_incident_area_guard before insert on incidents
  for each row execute function rm_area_write_guard();
drop trigger if exists trg_need_area_guard on community_needs;
create trigger trg_need_area_guard before insert on community_needs
  for each row execute function rm_area_write_guard();

-- ---------- 5. Public ward centres + area (for map shading) ---------------
create or replace function public.ward_areas()
returns table(ward_id text, city_corporation text, lat double precision, lng double precision)
language sql stable security definer set search_path = public as $$
  select id, city_corporation, lat, lng from wards order by id
$$;
grant execute on function public.ward_areas() to anon, authenticated;

-- ---------- 6. Analytics: resources filter for every area-bound role ------
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

  with vw as (                       -- wards the caller may see (area-bound staff: own area only)
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
                where organization_id = rm_org() or rm_sees_ward(base_ward_id)
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
