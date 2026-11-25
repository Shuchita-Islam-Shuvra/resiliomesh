create or replace function public.rm_task_transition_allowed(p_from task_status, p_to task_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'pending'     then p_to in ('assigned','cancelled')
    when 'assigned'    then p_to in ('accepted','in_progress','cancelled')
    when 'accepted'    then p_to in ('in_progress','failed','cancelled')
    when 'in_progress' then p_to in ('completed','failed','cancelled')
    when 'failed'      then p_to in ('assigned','in_progress')
    else false
  end
$$;
