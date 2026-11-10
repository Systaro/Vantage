import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { redirectWith, showDialogStep } from "../src/shared/http";

const app = new Hono();
app.post("/bad", (c) => redirectWith(c, "/settings#monitors", { kind: "bad", text: "Die URL fehlt." }));
app.post("/ok", (c) => redirectWith(c, "/settings#monitors", { kind: "ok", text: "Angelegt." }));
app.post("/step", (c) => showDialogStep(c, { title: "Token erzeugt", body: <p>geheim</p> }));

const htmx = (current: string) => ({ "hx-request": "true", "hx-current-url": current });

describe("dialog forms (htmx)", () => {
  test("a problem stays in the dialog: 200 with the message, no flash, no redirect", async () => {
    const res = await app.request("/bad", { method: "POST", headers: htmx("http://localhost/settings") });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Die URL fehlt.");
    expect(res.headers.get("hx-redirect")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("success redirects with a flash, and refreshes when only the hash changes", async () => {
    const same = await app.request("/ok", { method: "POST", headers: htmx("http://localhost/settings") });
    expect(same.status).toBe(204);
    expect(same.headers.get("hx-redirect")).toBe("/settings#monitors");
    expect(same.headers.get("hx-refresh")).toBe("true");
    expect(same.headers.get("set-cookie")).toContain("vantage_flash=");

    const other = await app.request("/ok", { method: "POST", headers: htmx("http://localhost/admin") });
    expect(other.headers.get("hx-redirect")).toBe("/settings#monitors");
    expect(other.headers.get("hx-refresh")).toBeNull();
  });

  test("a follow-up step replaces the dialog panel", async () => {
    const res = await app.request("/step", { method: "POST", headers: htmx("http://localhost/admin/tokens") });
    expect(res.headers.get("hx-retarget")).toBe("closest .modal-panel");
    expect(res.headers.get("hx-reswap")).toBe("innerHTML");
    const html = await res.text();
    expect(html).toContain("Token erzeugt");
    expect(html).toContain("data-reload-on-close");
    expect(html).not.toContain("<html");
  });
});

describe("plain form posts are unchanged", () => {
  test("problems and success both redirect with 303", async () => {
    for (const path of ["/bad", "/ok"]) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/settings#monitors");
    }
  });

  test("a step without htmx is a page of its own", async () => {
    const html = await (await app.request("/step", { method: "POST" })).text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Token erzeugt");
  });
});
