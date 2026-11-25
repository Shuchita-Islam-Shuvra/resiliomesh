grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select on wards to anon;

alter table organizations           enable row level security;
alter table wards                   enable row level security;
alter table profiles                enable row level security;
alter table drainage_assets         enable row level security;
alter table incidents               enable row level security;
alter table incident_status_history enable row level security;
alter table risk_assessments        enable row level security;
alter table resources               enable row level security;
alter table community_needs         enable row level security;
alter table allocation_plans        enable row level security;
alter table allocations             enable row level security;
alter table tasks                   enable row level security;
alter table workflow_runs           enable row level security;
alter table workflow_steps          enable row level security;
alter table weather_cache           enable row level security;
alter table historical_flood_events enable row level security;
alter table audit_logs              enable row level security;

do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

create policy org_read on organizations for select to authenticated using (true);
create policy org_admin_write on organizations for all to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');

create policy wards_read on wards for select to anon, authenticated using (true);
create policy wards_admin_write on wards for update to authenticated
  using (rm_role() = 'admin') with check (rm_role() = 'admin');

create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid() or rm_is_staff());
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid() or rm_role() = 'admin')
  with check (id = auth.uid() or rm_role() = 'admin');

create policy assets_read on drainage_assets for select to authenticated using (true);
create policy assets_write on drainage_assets for insert to authenticated
  with check (rm_role() in ('city_officer','admin'));
create policy assets_update on drainage_assets for update to authenticated
  using (rm_role() = 'admin' or (rm_role() = 'city_officer' and owner_org_id = rm_org()))
  with check (rm_role() = 'admin' or (rm_role() = 'city_officer' and owner_org_id = rm_org()));
create policy assets_delete on drainage_assets for delete to authenticated
  using (rm_role() = 'admin');

create policy incidents_read on incidents for select to authenticated
  using (reporter_id = auth.uid() or rm_is_staff());
create policy incidents_insert on incidents for insert to authenticated
  with check (reporter_id = auth.uid());
create policy incidents_update on incidents for update to authenticated
  using ((reporter_id = auth.uid() and status = 'reported') or rm_role() in ('city_officer','admin'))
  with check ((reporter_id = auth.uid()) or rm_role() in ('city_officer','admin'));
create policy incidents_delete on incidents for delete to authenticated
  using (rm_role() = 'admin');

create policy ish_read on incident_status_history for select to authenticated
  using (rm_is_staff() or exists (select 1 from incidents i where i.id = incident_id and i.reporter_id = auth.uid()));

create policy risk_read on risk_assessments for select to authenticated
  using (rm_is_staff());

create policy resources_read on resources for select to authenticated using (rm_is_staff());
create policy resources_insert on resources for insert to authenticated
  with check (rm_role() = 'admin'
              or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()));
create policy resources_update on resources for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()))
  with check (rm_role() = 'admin'
         or (rm_role() in ('ngo_coordinator','city_officer') and organization_id = rm_org()));
create policy resources_delete on resources for delete to authenticated
  using (rm_role() = 'admin' or (rm_role() = 'ngo_coordinator' and organization_id = rm_org()));

create policy needs_read on community_needs for select to authenticated
  using (rm_is_staff() or submitted_by = auth.uid());
create policy needs_insert on community_needs for insert to authenticated
  with check (true);
create policy needs_update on community_needs for update to authenticated
  using (rm_role() in ('ngo_coordinator','admin'))
  with check (rm_role() in ('ngo_coordinator','admin'));

create policy plans_read on allocation_plans for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy alloc_read on allocations for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy tasks_read on tasks for select to authenticated
  using (assigned_to = auth.uid() or rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy runs_read on workflow_runs for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));
create policy steps_read on workflow_steps for select to authenticated
  using (rm_role() in ('city_officer','ngo_coordinator','admin'));

create policy weather_read on weather_cache for select to authenticated using (true);

create policy hfe_read on historical_flood_events for select to authenticated using (rm_is_staff());

create policy audit_read on audit_logs for select to authenticated using (rm_role() = 'admin');
