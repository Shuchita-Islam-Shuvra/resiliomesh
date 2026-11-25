-- =====================================================================
-- ResilioMesh — 013 NGO coordinator: finish the aid lifecycle
-- Before: a coordinator could only RESERVE stock for a need. Nothing could mark it
-- delivered, give the stock back, or cancel a need, and any coordinator could edit
-- another NGO's needs directly. Now:
--   reserved -> dispatched -> consumed (delivered)      ngo_update_allocation()
--   reserved | dispatched -> released (stock returned)  ngo_update_allocation()
--   open / partially_fulfilled -> cancelled             cancel_need()
-- Idempotent: safe to re-run.
-- =====================================================================

create or replace function public.ngo_update_allocation(
  p_allocation_id uuid, p_action text, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role  app_role := rm_role();
  v_alloc allocations;
  v_res   resources;
  v_need  community_needs;
  v_new   text;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can update an allocation' using errcode = '42501';
  end if;
  if p_action not in ('dispatch','deliver','cancel') then
    raise exception 'VALIDATION: action must be dispatch, deliver or cancel' using errcode = '22023';
  end if;

  select * into v_alloc from allocations where id = p_allocation_id for update;
  if not found then raise exception 'NOT_FOUND: allocation' using errcode = 'P0002'; end if;
  if v_alloc.need_id is null then
    raise exception 'VALIDATION: only allocations made to a community need can be managed here' using errcode = '22023';
  end if;

  select * into v_res from resources where id = v_alloc.resource_id;
  if v_role <> 'admin' and v_res.organization_id is distinct from rm_org() then
    raise exception 'FORBIDDEN: allocation belongs to another organization' using errcode = '42501';
  end if;

  v_new := case p_action when 'dispatch' then 'dispatched' when 'deliver' then 'consumed' else 'released' end;

  -- idempotent replay: already in the requested end state
  if v_alloc.status = v_new then
    return jsonb_build_object('ok', true, 'replayed', true, 'allocation', to_jsonb(v_alloc));
  end if;

  if p_action = 'dispatch' and v_alloc.status <> 'reserved' then
    raise exception 'INVALID_STATE: allocation is %', v_alloc.status using errcode = '23514';
  end if;
  if p_action = 'deliver' and v_alloc.status not in ('reserved','dispatched') then
    raise exception 'INVALID_STATE: allocation is %', v_alloc.status using errcode = '23514';
  end if;
  if p_action = 'cancel' and v_alloc.status not in ('reserved','dispatched') then
    raise exception 'INVALID_STATE: a % allocation cannot be cancelled', v_alloc.status using errcode = '23514';
  end if;

  if p_action = 'cancel' then
    -- lock order matches allocate_to_need: need row first, then the stock row inside the release
    select * into v_need from community_needs where id = v_alloc.need_id for update;
    v_alloc := rm_release_allocation(p_allocation_id, coalesce(nullif(trim(p_reason), ''), 'cancelled by coordinator'));
    update community_needs
       set fulfilled_qty = greatest(0, fulfilled_qty - v_alloc.quantity),
           status = case
                      when status in ('cancelled','duplicate') then status
                      when greatest(0, fulfilled_qty - v_alloc.quantity) = 0 then 'open'::need_status
                      else 'partially_fulfilled'::need_status end
     where id = v_alloc.need_id;
  else
    update allocations set status = v_new, updated_at = now() where id = p_allocation_id returning * into v_alloc;
  end if;

  return jsonb_build_object('ok', true, 'replayed', false, 'allocation', to_jsonb(v_alloc));
end $$;

create or replace function public.cancel_need(p_need_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_need community_needs;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can cancel a need' using errcode = '42501';
  end if;
  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;
  if v_role <> 'admin' and v_need.organization_id is not null and v_need.organization_id is distinct from rm_org() then
    raise exception 'FORBIDDEN: need is being served by another organization' using errcode = '42501';
  end if;
  if v_need.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_need.status not in ('open','partially_fulfilled') then
    raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
  end if;
  if exists (select 1 from allocations where need_id = p_need_id and status in ('reserved','dispatched')) then
    raise exception 'INVALID_STATE: cancel or deliver the active allocations of this need first' using errcode = '23514';
  end if;
  update community_needs set status = 'cancelled' where id = p_need_id;
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

grant execute on function public.ngo_update_allocation(uuid,text,text) to authenticated;
grant execute on function public.cancel_need(uuid,text) to authenticated;

-- Direct edits of a need by coordinators were unrestricted (any NGO, any column). Everything the
-- UI does now goes through RPCs, so direct updates are limited to the coordinator's own / unclaimed needs.
drop policy if exists needs_update on community_needs;
create policy needs_update on community_needs for update to authenticated
  using (rm_role() = 'admin'
         or (rm_role() = 'ngo_coordinator' and (organization_id is null or organization_id = rm_org())))
  with check (rm_role() = 'admin'
         or (rm_role() = 'ngo_coordinator' and (organization_id is null or organization_id = rm_org())));
