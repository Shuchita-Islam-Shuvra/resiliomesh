-- 025: Analytics that mean what their labels say.
--  * Days are Dhaka days (Asia/Dhaka), not UTC days.
--  * "Resolved" per day is counted on the day it was RESOLVED, not the day it was reported.
--  * "Open now" counts every open report the caller can see, however old.
--  * Resolution rate leaves out duplicates and rejected (false) reports.
--  * "Reports" totals leave out duplicates everywhere (cards, daily chart, per ward), so numbers agree.
--  * Stock totals follow the same rules as the stock screens (NGO: own NGO; officer: authority stock
--    of the area + own; admin: all).
--  * New "relief" block for NGO coordinators: needs logged / open / served, units requested vs
--    delivered, households waiting, time to first relief, by need type.
-- Area rules are unchanged: officers see their own area only; admins and NGO coordinators see all Dhaka.
-- Re-runnable.

create or replace function public.analytics_dashboard(p_days integer default 30, p_ward text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role  app_role := rm_role();
  v_from  timestamptz;
  v_day0  date;
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_out   jsonb;
begin
  if not rm_is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'VALIDATION: days must be between 1 and 3650' using errcode = '22023';
  end if;
  -- window = the last p_days Dhaka calendar days, today included
  v_day0 := v_today - (p_days - 1);
  v_from := v_day0::timestamp at time zone 'Asia/Dhaka';

  with vw as (
    select * from wards where rm_sees_ward(id) and (p_ward is null or id = p_ward)
  ), allinc as (
    select * from incidents where ward_id in (select id from vw)
  ), inc as (                       -- reported in the window (duplicates included; filtered where needed)
    select * from allinc where created_at >= v_from
  ), genuine as (                      -- genuine reports in the window
    select * from inc where status <> 'duplicate'
  ), res as (                       -- resolved in the window, whenever they were reported
    select * from allinc where status = 'resolved' and resolved_at >= v_from
  ), needs as (
    select n.* from community_needs n where n.ward_id in (select id from vw)
  ), wneeds as (
    select * from needs where created_at >= v_from and status <> 'duplicate'
  ), first_aid as (
    select a.need_id, min(a.created_at) first_at from allocations a
     where a.need_id in (select id from wneeds) group by a.need_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'window_days', p_days,
    'window_from', v_day0,
    'timezone', 'Asia/Dhaka',
    'totals', jsonb_build_object(
        'reports', (select count(*) from genuine),
        'open_now', (select count(*) from allinc where status in ('reported','verified','assessed','approved','in_progress')),
        'resolved', (select count(*) from res),
        'rejected', (select count(*) from genuine where status = 'rejected'),
        'duplicates', (select count(*) from inc where status = 'duplicate'),
        'critical', (select count(*) from genuine where risk_level = 'critical'),
        'people_affected', (select coalesce(sum(people_affected), 0) from genuine),
        'avg_risk', (select round(avg(risk_score)::numeric, 1) from genuine),
        -- of this window's genuine reports (not duplicate, not rejected), the share already resolved
        'resolution_rate', (select round(100.0 * count(*) filter (where status = 'resolved') / nullif(count(*), 0), 0)
                              from genuine where status <> 'rejected'),
        'avg_resolution_hours', (select round((extract(epoch from avg(resolved_at - created_at)) / 3600)::numeric, 1) from res),
        'p90_resolution_hours', (select round((percentile_cont(0.9) within group (order by extract(epoch from resolved_at - created_at)) / 3600)::numeric, 1) from res)
      ),
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from inc group by status) s),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', c) order by c desc), '[]'::jsonb)
                    from (select category, count(*) c from genuine group by category) s),
    'by_ward', (select coalesce(jsonb_agg(row_to_json(s) order by s.incidents desc), '[]'::jsonb) from (
                  select w.id as ward_id, w.name, count(r.id) as incidents,
                         round(avg(r.risk_score)::numeric,1) as avg_risk,
                         count(r.id) filter (where r.risk_level in ('high','critical')) as high_risk,
                         w.current_risk_score
                  from vw w left join genuine r on r.ward_id = w.id
                  group by w.id, w.name, w.current_risk_score) s),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day, 'reported', coalesce(r.c, 0), 'resolved', coalesce(x.c, 0))
                                        order by g.day), '[]'::jsonb)
                from (select generate_series(v_day0, v_today, interval '1 day')::date as day) g
                left join (select (created_at at time zone 'Asia/Dhaka')::date d, count(*) c from genuine group by 1) r on r.d = g.day
                left join (select (resolved_at at time zone 'Asia/Dhaka')::date d, count(*) c from res group by 1) x on x.d = g.day),
    'resources', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (
                select resource_type, sum(quantity_total) as total, sum(quantity_available) as available,
                       round(100.0 * (sum(quantity_total) - sum(quantity_available)) / nullif(sum(quantity_total),0), 1) as utilization_pct
                from resources
                where case v_role
                        when 'admin' then true
                        when 'ngo_coordinator' then organization_id = rm_org()
                        when 'city_officer' then organization_id = rm_org()
                                                 or (rm_is_authority_org(organization_id) and rm_sees_ward(base_ward_id))
                        else organization_id = rm_org() or rm_sees_ward(base_ward_id)
                      end
                group by resource_type order by resource_type) r),
    'workflows', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                  from (select status, count(*) c from workflow_runs
                         where created_at >= v_from and rm_sees_plan(plan_id) group by status) s),
    'relief', jsonb_build_object(
        'needs_logged', (select count(*) from wneeds),
        'needs_open_now', (select count(*) from needs where status in ('open','partially_fulfilled')),
        'households_waiting', (select coalesce(sum(households), 0) from needs where status in ('open','partially_fulfilled')),
        'needs_fulfilled', (select count(*) from wneeds where status = 'fulfilled'),
        'households_served', (select coalesce(sum(households), 0) from wneeds where status = 'fulfilled'),
        'units_requested', (select coalesce(sum(quantity), 0) from wneeds where status <> 'cancelled'),
        'units_delivered', (select coalesce(sum(fulfilled_qty), 0) from wneeds),
        'duplicates_blocked', (select count(*) from needs where status = 'duplicate' and created_at >= v_from),
        'awaiting_confirmation', (select count(*) from needs where status in ('open','partially_fulfilled') and confirmed_at is null),
        'avg_hours_to_first_relief', (select round((extract(epoch from avg(f.first_at - n.created_at)) / 3600)::numeric, 1)
                                        from first_aid f join wneeds n on n.id = f.need_id),
        'by_type', (select coalesce(jsonb_agg(row_to_json(t) order by t.requested desc), '[]'::jsonb) from (
                      select need_type, coalesce(sum(quantity) filter (where status <> 'cancelled'), 0) as requested,
                             coalesce(sum(fulfilled_qty), 0) as delivered, count(*) as needs
                        from wneeds group by need_type) t)
      ),
    'historical', jsonb_build_object(
        'synthetic', true,
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
