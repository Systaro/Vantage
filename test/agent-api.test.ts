import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newToken, sha256Hex } from "../src/shared/crypto";
import { API_TOKEN_PATTERN, handleRpc } from "../src/hub/modules/agent/routes";
import { TOOLS } from "../src/hub/modules/agent/tools";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
});
afterAll(() => db.drop());

async function token(user: number, extra: { expires?: Date; revoked?: boolean } = {}) {
  const t = newToken("vpat");
  await db.owner`insert into api_tokens (user_id, name, token_hash, token_prefix, expires_at, revoked_at)
                 values (${user}, 'test', ${sha256Hex(t)}, ${t.slice(0, 9)}, ${extra.expires ?? null}, ${extra.revoked ? new Date() : null})`;
  return t;
}
const who = async (t: string) => ((await db.hub`select user_id from auth_api_token(${sha256Hex(t)})`) as { user_id: number }[])[0]?.user_id ?? null;

describe("personal API tokens", () => {
  test("format: vpat_ plus 43 characters", async () => {
    expect(API_TOKEN_PATTERN.test(newToken("vpat"))).toBe(true);
    expect(API_TOKEN_PATTERN.test(newToken("vs"))).toBe(false);
  });

  test("a valid token names its user; revoked, expired and disabled ones name nobody", async () => {
    expect(await who(await token(w.aliceNordwindShopOverview))).toBe(w.aliceNordwindShopOverview);
    expect(await who(await token(w.aliceNordwindShopOverview, { revoked: true }))).toBeNull();
    expect(await who(await token(w.aliceNordwindShopOverview, { expires: new Date(Date.now() - 1000) }))).toBeNull();
    const bobs = await token(w.bobBergbauDiagnostics);
    await db.owner`update users set disabled_at = now() where id = ${w.bobBergbauDiagnostics}`;
    expect(await who(bobs)).toBeNull();
    await db.owner`update users set disabled_at = null where id = ${w.bobBergbauDiagnostics}`;
    expect(await who(bobs)).toBe(w.bobBergbauDiagnostics);
    expect(await who("vpat_unknown")).toBeNull();
  });

  test("users see and revoke only their own tokens, never create one for someone else", async () => {
    const own = await asUser(db.hub, w.carolStageOnly, (tx) => tx`select user_id from api_tokens`);
    expect(own).toHaveLength(0);
    const alices = (await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select user_id from api_tokens`)) as any[];
    expect(alices.every((r) => r.user_id === w.aliceNordwindShopOverview)).toBe(true);
    expect(await asUser(db.hub, w.carolStageOnly, (tx) => tx`update api_tokens set revoked_at = now() returning id`)).toHaveLength(0);
    await expect(asUser(db.hub, w.carolStageOnly, (tx) => tx`insert into api_tokens (user_id, name, token_hash, token_prefix) values (${w.aliceNordwindShopOverview}, 'x', 'h', 'p')`)).rejects.toThrow();
    // The hash never leaves the database.
    await expect(asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select token_hash from api_tokens`)).rejects.toThrow();
  });

  test("resetting an account revokes its tokens", async () => {
    const t = await token(w.carolStageOnly);
    await asUser(db.hub, w.admin, (tx) => tx`select admin_reset_user(${w.carolStageOnly})`);
    expect(await who(t)).toBeNull();
  });
});

describe("MCP protocol", () => {
  const c = {} as any;
  test("initialize agrees on a version and announces tools only", async () => {
    const r: any = await handleRpc(c, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    const unknown: any = await handleRpc(c, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/list: every tool read-only with a schema", async () => {
    const r: any = await handleRpc(c, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(r.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(r.result.tools.every((t: any) => t.annotations.readOnlyHint && t.inputSchema.type === "object")).toBe(true);
  });

  test("notifications get no answer, unknown methods and tools an error", async () => {
    expect(await handleRpc(c, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleRpc(c, { jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleRpc(c, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "drop_database" } })).toMatchObject({ error: { code: -32602 } });
    expect(await handleRpc(c, { id: 6, method: "ping" } as any)).toMatchObject({ error: { code: -32600 } });
  });
});
