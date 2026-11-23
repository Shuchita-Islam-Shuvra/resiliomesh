-- =====================================================================
-- ResilioMesh — 005 Supabase Realtime publication
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['incidents','tasks','resources','allocation_plans','workflow_runs',
                           'workflow_steps','community_needs','wards','drainage_assets',
                           'profiles','allocations'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;           -- already published
      when undefined_object then
        raise notice 'publication supabase_realtime missing (not a Supabase DB?)';
    end;
  end loop;
end $$;

-- full row images so UPDATE events carry the previous version for conflict UI
alter table incidents replica identity full;
alter table tasks replica identity full;
alter table resources replica identity full;
