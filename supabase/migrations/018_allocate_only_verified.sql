create or replace function public.allocate_to_need(
  p_need_id uuid, p_resource_id uuid, p_qty integer, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := rm_role();
  v_need community_needs;
  v_res  resources;
  v_alloc allocations;
  v_existing boolean;
  v_access text;
  v_inc_status incident_status;
begin
  if v_role not in ('ngo_coordinator','admin') then
    raise exception 'FORBIDDEN: only NGO coordinators can allocate aid' using errcode = '42501';
  end if;

  select * into v_need from community_needs where id = p_need_id for update;
  if not found then raise exception 'NOT_FOUND: need' using errcode = 'P0002'; end if;

  select exists(select 1 from allocations where idempotency_key = p_idempotency_key) into v_existing;

  if not v_existing then
    v_access := rm_assert_ngo_access(p_need_id);
    if v_need.status not in ('open','partially_fulfilled') then
      raise exception 'INVALID_STATE: need is %', v_need.status using errcode = '23514';
    end if;
    if v_need.incident_id is not null then
      select status into v_inc_status from incidents where id = v_need.incident_id;
      if v_inc_status = 'reported' then
        raise exception 'INVALID_STATE: the linked report has not been verified by an officer yet' using errcode = '23514';
      end if;
    end if;
    if p_qty > v_need.quantity - v_need.fulfilled_qty then
      raise exception 'VALIDATION: only % units still required', v_need.quantity - v_need.fulfilled_qty
        using errcode = '22023';
    end if;
  end if;

  select * into v_res from resources where id = p_resource_id;
  if not found then raise exception 'NOT_FOUND: resource' using errcode = 'P0002'; end if;
  if v_role <> 'admin' and v_res.organization_id is distinct from rm_org() then
    raise exception 'FORBIDDEN: resource belongs to another organization' using errcode = '42501';
  end if;
  if v_res.resource_type <> v_need.need_type then
    raise exception 'VALIDATION: resource type % does not match need %', v_res.resource_type, v_need.need_type
      using errcode = '22023';
  end if;

  v_alloc := rm_reserve_resource(p_resource_id, p_qty, p_idempotency_key, null, p_need_id, null, auth.uid());

  if not v_existing then
    update community_needs
       set fulfilled_qty = fulfilled_qty + p_qty,
           status = case when fulfilled_qty + p_qty >= quantity then 'fulfilled'::need_status
                         else 'partially_fulfilled'::need_status end,
           organization_id = coalesce(organization_id, v_res.organization_id),
           backup_requested_at = case when fulfilled_qty + p_qty >= quantity then null else backup_requested_at end
     where id = p_need_id;
  end if;

  return jsonb_build_object('ok', true, 'replayed', v_existing, 'access', v_access, 'allocation', to_jsonb(v_alloc));
end $$;

grant execute on function public.allocate_to_need(uuid,uuid,integer,text) to authenticated;
