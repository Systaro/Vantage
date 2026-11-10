import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { parseVariables, triggerPipeline } from "../src/ops/pipelines/gitlab";
import { createOpsHarness, flashOf, outboxRows, type OpsHarness } from "./helpers/ops";

// A local stand-in for GitLab's trigger API. Never the real GitLab.
interface Seen {
  path: string;
  form: Record<string, string>;
}
let seen: Seen[] = [];
let answer: () => Response = () => Response.json({ id: 4711, web_url: "https://git.example/g/p/-/pipelines/4711", status: "created" }, { status: 201 });
let gitlab: Server<undefined>;

beforeAll(() => {
  gitlab = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      seen.push({ path: url.pathname + url.search, form });
      return answer();
    },
  });
});
afterAll(() => gitlab.stop(true));

describe("variables", () => {
  test("KEY=value lines; keys must match ^[A-Z_][A-Z0-9_]*$", () => {
    expect(parseVariables("TEST_ENV=prod\n\nSUITE=smoke=all\nEMPTY=")).toEqual({
      ok: true,
      variables: [
        { key: "TEST_ENV", value: "prod" },
        { key: "SUITE", value: "smoke=all" },
        { key: "EMPTY", value: "" },
      ],
    });
    expect(parseVariables("lower=1").ok).toBe(false);
    expect(parseVariables("1ABC=1").ok).toBe(false);
    expect(parseVariables("A-B=1").ok).toBe(false);
    expect(parseVariables("NOVALUE").ok).toBe(false);
    expect(parseVariables("A=1\nA=2").ok).toBe(false);
  });
});

describe("GitLab trigger against a stub", () => {
  test("posts token, ref and variables[KEY] as form fields to the URL-encoded project", async () => {
    seen = [];
    const r = await triggerPipeline(`http://127.0.0.1:${gitlab.port}`, {
      project: "nordwind/shop/shop-e2e",
      ref: "main",
      token: "glptt-secret",
      variables: [{ key: "TEST_ENV", value: "prod & more" }],
    });
    expect(r).toEqual({ ok: true, httpStatus: 201, pipelineId: 4711, webUrl: "https://git.example/g/p/-/pipelines/4711" });
    expect(seen[0]!.path).toBe("/api/v4/projects/nordwind%2Fshop%2Fshop-e2e/trigger/pipeline");
    expect(seen[0]!.form).toEqual({ token: "glptt-secret", ref: "main", "variables[TEST_ENV]": "prod & more" });
  });

  test("errors keep GitLab's message; unsafe web_url values are dropped", async () => {
    answer = () => Response.json({ message: "404 Not Found" }, { status: 404 });
    expect(await triggerPipeline(`http://127.0.0.1:${gitlab.port}`, { project: "42", ref: "main", token: "t", variables: [] })).toEqual({
      ok: false,
      httpStatus: 404,
      error: "GitLab antwortet 404: 404 Not Found",
    });
    answer = () => Response.json({ id: 1, web_url: "javascript:alert(1)" }, { status: 201 });
    expect(await triggerPipeline(`http://127.0.0.1:${gitlab.port}`, { project: "42", ref: "main", token: "t", variables: [] })).toMatchObject({ ok: true, webUrl: null });
    const down = await triggerPipeline("http://127.0.0.1:9", { project: "42", ref: "main", token: "t", variables: [] });
    expect(down).toMatchObject({ ok: false, httpStatus: null });
  });
});

describe("pipeline schedules through the UI", () => {
  let h: OpsHarness;
  let id = 0;

  beforeAll(async () => {
    h = await createOpsHarness({ config: () => ({ gitlabUrl: `http://127.0.0.1:${gitlab.port}` }) });
  });
  afterAll(() => h.close());

  const create = (form: Record<string, string>, cookie = h.users.admin.cookie) =>
    h.request("/schedules", { cookie, form: { name: "E2E nachts", project: "nordwind/shop/shop-e2e", ref: "main", token: "glptt-abcdef123456", variables: "TEST_ENV=prod", schedule: "0 3 * * *", enabled: "1", ...form } });

  test("only admins create schedules; the trigger token is encrypted and never shown again", async () => {
    expect((await create({}, h.users.operator.cookie)).status).toBe(403);
    expect(flashOf(await create({ project: "../x" }))?.kind).toBe("bad");
    expect(flashOf(await create({ variables: "bad key=1" }))?.kind).toBe("bad");
    expect(flashOf(await create({ ref: "-x" }))?.kind).toBe("bad");
    const res = await create({});
    expect(res.status).toBe(303);
    id = Number(res.headers.get("location")!.split("/").pop());
    const [row] = (await h.sql`select token_enc, token_hint, variables from pipeline_schedules where id = ${id}`) as any[];
    expect(row.token_enc).toStartWith("v1.");
    expect(row.token_enc).not.toContain("glptt");
    expect(row.token_hint).toBe("3456");
    expect(row.variables).toEqual([{ key: "TEST_ENV", value: "prod" }]);
    const page = await (await h.request(`/schedules/${id}`, { cookie: h.users.admin.cookie })).text();
    expect(page).not.toContain("glptt-abcdef123456");
    const audit = (await h.sql`select detail from audit_log where action = 'schedule.created'`) as any[];
    expect(JSON.stringify(audit)).not.toContain("glptt");
    expect(h.ops.scheduler.keys()).toContain(`pipeline:${id}`);
  });

  test("viewers cannot trigger; operators can, and the result is recorded", async () => {
    answer = () => Response.json({ id: 4711, web_url: "https://git.example/p/-/pipelines/4711" }, { status: 201 });
    seen = [];
    expect((await h.request(`/schedules/${id}/trigger`, { cookie: h.users.viewer.cookie, method: "POST" })).status).toBe(403);
    expect(seen).toHaveLength(0);
    const res = await h.request(`/schedules/${id}/trigger`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(flashOf(res)).toEqual({ kind: "ok", text: "Pipeline ausgelöst (#4711)." });
    expect(seen[0]!.form.token).toBe("glptt-abcdef123456");
    const [t] = (await h.sql`select trigger, started_by_label, status, http_status, pipeline_id, web_url from pipeline_triggers where schedule_id = ${id}`) as any[];
    expect(t).toEqual({ trigger: "manual", started_by_label: "operator@systaro.de", status: "ok", http_status: 201, pipeline_id: "4711", web_url: "https://git.example/p/-/pipelines/4711" });
  });

  test("a failed trigger raises an alert for the hub; the next success resolves it", async () => {
    await h.sql`delete from outbox`;
    answer = () => Response.json({ message: "403 Forbidden" }, { status: 403 });
    await h.ops.scheduler.fire(`pipeline:${id}`);
    await h.ops.scheduler.fire(`pipeline:${id}`);
    let rows = await outboxRows(h.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "pipeline:E2E nachts", state: "firing", severity: "warning" });
    const triggers = (await h.sql`select trigger, status, error from pipeline_triggers where schedule_id = ${id} order by id`) as any[];
    expect(triggers.at(-1)).toEqual({ trigger: "schedule", status: "failed", error: "GitLab antwortet 403: 403 Forbidden" });
    answer = () => Response.json({ id: 4712, web_url: "https://git.example/p/-/pipelines/4712" }, { status: 201 });
    await h.ops.scheduler.fire(`pipeline:${id}`);
    rows = await outboxRows(h.sql);
    expect(rows[1]).toMatchObject({ subject: "pipeline:E2E nachts", state: "resolved" });
  });

  test("editing keeps the token when the field is empty and replaces it when filled", async () => {
    const form = { name: "E2E nachts", project: "4242", ref: "release/1.4", token: "", variables: "", schedule: "", enabled: "1" };
    expect((await h.request(`/schedules/${id}`, { cookie: h.users.admin.cookie, form })).status).toBe(303);
    seen = [];
    await h.request(`/schedules/${id}/trigger`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(seen[0]).toEqual({ path: "/api/v4/projects/4242/trigger/pipeline", form: { token: "glptt-abcdef123456", ref: "release/1.4" } });
    expect(h.ops.scheduler.keys()).not.toContain(`pipeline:${id}`);
    await h.request(`/schedules/${id}`, { cookie: h.users.admin.cookie, form: { ...form, token: "glptt-new-token-9999" } });
    seen = [];
    await h.request(`/schedules/${id}/trigger`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(seen[0]!.form.token).toBe("glptt-new-token-9999");
  });

  test("disabled schedules do not trigger", async () => {
    await h.sql`update pipeline_schedules set enabled = false where id = ${id}`;
    seen = [];
    const res = await h.request(`/schedules/${id}/trigger`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(flashOf(res)?.kind).toBe("bad");
    expect(seen).toHaveLength(0);
  });
});
