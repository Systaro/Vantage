-- Health monitors: the application's own status page (Cortex /api/health, Spring /actuator/health).
-- Besides up/down they record the components and numeric figures the page reports, per check, in
-- `details` ({"components": [...], "metrics": {"diskSpace.usedPercentage": 77, ...}}). Same
-- visibility as every other check (overview level); the worker drops details after 14 days.

alter table monitors drop constraint monitors_kind_check;
alter table monitors add constraint monitors_kind_check
  check (kind in ('http', 'tcp', 'dns', 'tls', 'heartbeat', 'kuma', 'health'));

alter table monitor_checks add column details jsonb;
