-- Lets lists sort open incidents ahead of finished ones (resolved / rejected / duplicate),
-- so a resolved "Critical 100" no longer outranks an open one.
alter table incidents
  add column if not exists is_closed boolean
  generated always as (status in ('resolved'::incident_status, 'rejected'::incident_status, 'duplicate'::incident_status)) stored;

create index if not exists idx_incidents_closed_risk on incidents(is_closed, risk_score desc nulls last);
