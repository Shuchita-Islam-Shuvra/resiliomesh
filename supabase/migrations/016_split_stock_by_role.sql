-- =====================================================================
-- ResilioMesh — 016 who sees and manages which stock
-- ---------------------------------------------------------------------
-- After 015 the plan / dispatch JOB was split, but the STOCK was still shared: an NGO
-- coordinator saw (and the Resources page listed) every authority's pumps and crews,
-- and an officer saw every NGO's relief stock. Now:
--
--   NGO Coordinator          : sees and edits ONLY their own NGO's stock, and may not
--                              register pumps or maintenance crews (authority equipment).
--   Water Resilience Officer : sees city-authority stock (own authority + authority stock
--                              based in their area). NGO relief stock is not theirs.
--   Field worker             : unchanged (own organisation + their area).
--   Admin                    : everything.
--
-- Requires 011 and 012. Re-runnable. If you re-run 003 or 011, run this file again.
-- =====================================================================

create or replace function public.rm_is_authority_org(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations o where o.id = p_org and o.type = 'city_authority')
$$;
grant execute on function public.rm_is_authority_org(uuid) to authenticated;

drop policy if exists resources_read on resources;
create policy resources_read on resources for select to authenticated
  using (case rm_role()
           when 'admin'           then true
           when 'ngo_coordinator' then organization_id = rm_org()
           when 'city_officer'    then organization_id = rm_org()
                                       or (rm_is_authority_org(organization_id) and rm_sees_ward(base_ward_id))
           when 'field_worker'    then organization_id = rm_org() or rm_sees_ward(base_ward_id)
           else false
         end);

drop policy if exists resources_insert on resources;
create policy resources_insert on resources for insert to authenticated
  with check (rm_role() = 'admin'
              or (rm_role() = 'city_officer' and organization_id = rm_org())
              or (rm_role() = 'ngo_coordinator' and organization_id = rm_org()
                  and resource_type not in ('pump','crew')));

drop policy if exists resources_update on resources;
create policy resources_update on resources for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()))
  with check (rm_role() = 'admin'
         or (rm_role() = 'city_officer' and organization_id = rm_org())
         or (rm_role() = 'ngo_coordinator' and organization_id = rm_org()
             and resource_type not in ('pump','crew')));
