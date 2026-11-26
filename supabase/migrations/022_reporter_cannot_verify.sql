-- Four-eyes rule (maker-checker): whoever filed a report cannot verify it themselves.
-- An officer who files a report from the field, or an admin logging a call-in, needs a second
-- person (another officer of that area, or an admin) to verify it. Covers both "reported -> verified"
-- and "duplicate -> verified" ("not a duplicate"). The reporter can still mark it duplicate or
-- withdraw (reject) it with a reason. Enforced as a trigger, so the RPC and raw REST updates both hit it.

create or replace function public.rm_no_self_verify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'verified'
     and old.status is distinct from 'verified'
     and not rm_is_system()
     and new.reporter_id = auth.uid() then
    raise exception 'FORBIDDEN: you filed this report, so another officer of this area or an admin must verify it (four-eyes rule)'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_incident_no_self_verify on incidents;
create trigger trg_incident_no_self_verify before update of status on incidents
  for each row execute function rm_no_self_verify();
