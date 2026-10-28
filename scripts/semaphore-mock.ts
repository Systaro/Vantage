/**
 * DEV ONLY: a stand-in for Semaphore's API on 127.0.0.1:5465 with ten days of fictional Ansible
 * runs (updates, disk checks, a runner cleanup that sometimes cannot reach its server), so the
 * Wartung tab can be built and checked without a real Semaphore.
 * In Vantage: Verwaltung → Integrationen → Ansible (Semaphore), Adresse http://127.0.0.1:5465,
 * Projekt-ID 1, API-Token dev-semaphore-token-0001.
 *   bun run scripts/semaphore-mock.ts
 */
if (process.env.NODE_ENV === "production") throw new Error("semaphore-mock is a development tool");

const TOKEN = "dev-semaphore-token-0001";
const HOUR = 3_600_000;

interface Run {
  id: number;
  template_id: number;
  name: string;
  playbook: string;
  scheduled: boolean;
  at: number;
  minutes: number;
  running?: boolean;
  /** host → [ok, changed, unreachable, failed, failedTask?] */
  hosts: Record<string, [number, number, number, number, string?]>;
}

const templates = {
  shop: { id: 1, name: "Weekly Nordwind Updates", playbook: "monthly-updates.yml", hosts: ["shop.nordwind.example", "db-01.nordwind.example", "stage.shop.nordwind.example"] },
  disk: { id: 2, name: "disk-alert (Nordwind)", playbook: "disk-alert.yml", hosts: ["shop.nordwind.example", "db-01.nordwind.example", "stage.shop.nordwind.example", "localhost"] },
  mine: { id: 3, name: "Weekly Bergbau Updates", playbook: "monthly-updates.yml", hosts: ["portal.bergbau.example"] },
  keys: { id: 4, name: "SSH Key Sync (Nordwind)", playbook: "manage-users.yml", hosts: ["shop.nordwind.example", "db-01.nordwind.example"] },
  runner: { id: 5, name: "gitlab docker cleanup", playbook: "cleanup-docker-volumes.yml", hosts: ["gitlab-runner-1", "gitlab-runner-2"] },
};

const runs: Run[] = [];
let id = 100;
const now = Date.now();
for (let day = 10; day >= 0; day--) {
  const base = now - day * 24 * HOUR;
  runs.push({ id: id++, template_id: templates.disk.id, name: templates.disk.name, playbook: templates.disk.playbook, scheduled: true, at: base - 6 * HOUR, minutes: 1,
    hosts: Object.fromEntries(templates.disk.hosts.map((h) => [h, [h === "localhost" ? 5 : 2, 0, 0, 0]])) });
  for (const hour of [18, 12, 6]) {
    const down = (day + hour) % 7 === 0;
    runs.push({ id: id++, template_id: templates.runner.id, name: templates.runner.name, playbook: templates.runner.playbook, scheduled: true, at: base - hour * HOUR, minutes: 1,
      hosts: { "gitlab-runner-1": [3, 1, 0, 0], "gitlab-runner-2": down ? [0, 0, 1, 0, "Gathering Facts"] : [3, 0, 0, 0] } });
  }
  if (day % 7 === 2) {
    runs.push({ id: id++, template_id: templates.shop.id, name: templates.shop.name, playbook: templates.shop.playbook, scheduled: true, at: base - 9 * HOUR, minutes: 4,
      hosts: { "shop.nordwind.example": [6, 3, 0, 0], "db-01.nordwind.example": day === 2 ? [4, 1, 0, 1, "Upgrade all packages"] : [6, 2, 0, 0], "stage.shop.nordwind.example": [6, 3, 0, 0] } });
    runs.push({ id: id++, template_id: templates.keys.id, name: templates.keys.name, playbook: templates.keys.playbook, scheduled: true, at: base - 9 * HOUR + 60_000, minutes: 1,
      hosts: { "shop.nordwind.example": [8, 0, 0, 0], "db-01.nordwind.example": [8, 1, 0, 0] } });
    runs.push({ id: id++, template_id: templates.mine.id, name: templates.mine.name, playbook: templates.mine.playbook, scheduled: true, at: base - 7 * HOUR, minutes: 3,
      hosts: { "portal.bergbau.example": [6, 4, 0, 0] } });
  }
}
runs.push({ id: id++, template_id: templates.shop.id, name: templates.shop.name, playbook: templates.shop.playbook, scheduled: false, at: now - 20 * 60_000, minutes: 3,
  hosts: { "shop.nordwind.example": [6, 0, 0, 0], "db-01.nordwind.example": [6, 1, 0, 0], "stage.shop.nordwind.example": [6, 0, 0, 0] } });
runs.push({ id: id++, template_id: templates.mine.id, name: templates.mine.name, playbook: templates.mine.playbook, scheduled: false, at: now - 60_000, minutes: 0, running: true, hosts: {} });
runs.sort((a, b) => a.id - b.id);

const failed = (r: Run) => Object.values(r.hosts).some(([, , u, f]) => u > 0 || f > 0);
const iso = (ms: number) => new Date(ms).toISOString();
function task(r: Run) {
  return {
    id: r.id, template_id: r.template_id, project_id: 1, status: r.running ? "running" : failed(r) ? "error" : "success",
    schedule_id: r.scheduled ? r.template_id : null, created: iso(r.at), start: iso(r.at + 1000), end: r.running ? null : iso(r.at + r.minutes * 60_000 + 5000),
    tpl_alias: r.name, tpl_playbook: r.playbook, tpl_app: "ansible",
  };
}

function output(r: Run): string {
  const hosts = Object.keys(r.hosts);
  const width = Math.max(...hosts.map((h) => h.length), 26);
  const lines = [`Task ${r.name} added to queue`, `Started task #${r.id} of template '${r.name}'`, "", "PLAY [all] ****", ""];
  const stopped = new Set<string>();
  for (const task of ["Gathering Facts", "Upgrade all packages"]) {
    lines.push(`TASK [${task}] ${"*".repeat(60)}`);
    for (const [h, [, , u, f, at]] of Object.entries(r.hosts)) {
      if (stopped.has(h)) continue;
      if (at === task) stopped.add(h);
      if (at !== task) lines.push(`ok: [${h}]`);
      else if (u) lines.push(`fatal: [${h}]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: Connection timed out", "unreachable": true}`);
      else if (f) lines.push(`fatal: [${h}]: FAILED! => {"changed": false, "msg": "E: Could not get lock /var/lib/dpkg/lock-frontend"}`);
    }
    lines.push("");
  }
  lines.push(`PLAY RECAP ${"*".repeat(69)}`);
  for (const [h, [ok, changed, u, f]] of Object.entries(r.hosts)) {
    lines.push(`${h.padEnd(width)} : ok=${ok}    changed=${changed}    unreachable=${u}    failed=${f}    skipped=0    rescued=0    ignored=0   `);
  }
  if (failed(r)) lines.push("", "Failed to run task: exit status 2");
  return lines.join("\n") + "\n";
}

const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 5465,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/ping") return new Response("pong");
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/api/project/1") return Response.json({ id: 1, name: "Nordwind & Bergbau (Mock)" });
    if (url.pathname === "/api/project/1/tasks/last") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 200);
      return Response.json(runs.slice().reverse().slice(0, limit).map(task));
    }
    const m = /^\/api\/project\/1\/tasks\/(\d+)(\/raw_output)?$/.exec(url.pathname);
    const run = m && runs.find((r) => r.id === Number(m[1]));
    if (run && m[2]) return new Response(run.running ? "Task added to queue\n" : output(run), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (run) {
      const { tpl_alias, tpl_playbook, tpl_app, ...rest } = task(run);
      return Response.json(rest);
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`[semaphore-mock] Semaphore stand-in on http://${mock.hostname}:${mock.port}, project 1, token ${TOKEN}, ${runs.length} runs`);
