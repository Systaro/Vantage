-- ISMS checks on security data (#69764): open vulnerabilities from Dependency-Track and Wazuh
-- against fixing deadlines, and Ansible maintenance runs from Semaphore on the environment's
-- servers. Both read level-3 data, so viewers below that see the control without its verdict.
alter table isms_controls drop constraint isms_controls_kind_check;
alter table isms_controls add constraint isms_controls_kind_check
  check (kind in ('uptime', 'tls', 'servers', 'logs', 'vulns', 'maintenance', 'record'));
