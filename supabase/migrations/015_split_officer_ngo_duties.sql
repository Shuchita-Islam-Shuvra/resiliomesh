-- =====================================================================
-- ResilioMesh — 015 separate the Water Resilience Officer and NGO Coordinator jobs
-- ---------------------------------------------------------------------
--   Water Resilience Officer : the WATER. Verify / assess / resolve reports, plan and
--                              approve pump & crew dispatch in their own area.
--   NGO Coordinator          : the PEOPLE. Community needs and the NGO's own relief stock.
--
-- Until now approve_plan / reject_plan also accepted NGO coordinators, and the officer
-- area check did not apply to them, so a coordinator could dispatch a city corporation's
-- pumps and crews anywhere in Dhaka. All three plan / workflow RPCs (approve_plan,
-- reject_plan, retry_workflow_run) call rm_assert_officer_plan first, so the rule is
-- enforced there. Coordinators keep READ access to reports, plans and tasks.
--
-- Requires 009. Re-runnable. If you re-run 009, run this file again.
-- =====================================================================

create or replace function public.rm_assert_officer_plan(p_incident_ids uuid[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_ward text;
begin
  if rm_role() = 'ngo_coordinator' then
    raise exception 'FORBIDDEN: pump and crew plans are approved by Water Resilience Officers; NGO coordinators handle relief on the NGO page'
      using errcode = '42501';
  end if;
  if rm_role() is distinct from 'city_officer' then return; end if;
  select i.ward_id into v_ward from incidents i
   where i.id = any(p_incident_ids) and not rm_can_manage_ward(i.ward_id) limit 1;
  if v_ward is not null then perform rm_assert_officer_area(v_ward); end if;
end $$;
grant execute on function public.rm_assert_officer_plan(uuid[]) to authenticated;
