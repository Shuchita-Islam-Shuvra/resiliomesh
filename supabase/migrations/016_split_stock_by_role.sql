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
