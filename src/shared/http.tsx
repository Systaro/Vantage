import { join } from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import type { Child } from "hono/jsx";
import { DialogStep } from "./ui/components";
import { Icon, type IconName } from "./ui/icons";
import { PlainLayout, type Flash } from "./ui/layout";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");
const HTMX_FILE = Bun.resolveSync("htmx.org/dist/htmx.min.js", import.meta.dir);
const FONT_FILES: Record<string, string> = {
  "inter-latin-wght-normal.woff2": Bun.resolveSync("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", import.meta.dir),
  "inter-latin-ext-wght-normal.woff2": Bun.resolveSync("@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2", import.meta.dir),
  "jetbrains-mono-latin-wght-normal.woff2": Bun.resolveSync("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", import.meta.dir),
};

/** CSP without inline scripts or styles; htmx is served from our own origin. */
/** Loaded by mail clients from their own origin (webmail, Mailpit), so not same-origin only. */
const MAIL_ASSETS = new Set(["/static/mail-logo.png"]);

export function securityHeaders(): MiddlewareHandler {
  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "same-origin",
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  });
  return async (c, next) => {
    await headers(c, next);
    c.res.headers.set("Cross-Origin-Resource-Policy", MAIL_ASSETS.has(c.req.path) ? "cross-origin" : "same-origin");
  };
}

/**
 * Origin check for browser form posts. `/api/` is excluded on purpose: those routes take Bearer
 * tokens only and never read the session cookie, so there is nothing for a cross-site post to ride on.
 */
export function csrfProtection(publicUrl: string): MiddlewareHandler {
  const origin = new URL(publicUrl).origin;
  const check = csrf({ origin });
  return async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return check(c, next);
  };
}

export function mountStatic(app: Hono<any>) {
  app.get("/static/htmx.min.js", () =>
    new Response(Bun.file(HTMX_FILE), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
    }),
  );
  // Fonts are self-hosted (CSP font-src 'self'); file names are versioned by the package.
  app.get("/static/fonts/:file", (c) => {
    const path = FONT_FILES[c.req.param("file")];
    if (!path) return c.notFound();
    return new Response(Bun.file(path), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
  });
  app.get("/static/:file{[a-z0-9._-]+}", async (c) => {
    const file = Bun.file(join(PUBLIC_DIR, c.req.param("file")));
    if (!(await file.exists())) return c.notFound();
    return new Response(file, { headers: { "cache-control": "public, max-age=3600" } });
  });
}

/**
 * The client address. Behind a proxy (TRUST_PROXY=true) it is taken from the right end of
 * X-Forwarded-For: the leftmost entries are whatever the client sent and can be forged; the entry
 * our own proxy appended sits TRUST_PROXY_HOPS (default 1) from the right.
 */
export function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === "true") {
    const hops = Math.max(1, Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10) || 1);
    const entries = (c.req.header("x-forwarded-for") ?? "").split(",").map((e) => e.trim()).filter(Boolean);
    const ip = entries[entries.length - hops];
    if (ip) return ip;
  }
  const info = (c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined)?.requestIP?.(c.req.raw);
  return info?.address ?? "unknown";
}

let secureCookies = false;

/**
 * Called once per app with its public URL. Over HTTPS every cookie gets the __Host- prefix: such a
 * cookie can only be set by this exact host, Secure, for path /, so a page on a sibling subdomain
 * (e.g. an uploaded test report) cannot plant or overwrite it.
 */
export function configureCookies(publicUrl: string) {
  secureCookies = isSecureUrl(publicUrl);
}

export function cookieName(base: string): string {
  return secureCookies ? `__Host-${base}` : base;
}

export function cookieOptions(maxAge: number) {
  return { path: "/", httpOnly: true, sameSite: "Lax" as const, secure: secureCookies, maxAge };
}

export function setFlash(c: Context, flash: Flash) {
  setCookie(c, cookieName("vantage_flash"), Buffer.from(JSON.stringify(flash)).toString("base64url"), cookieOptions(60));
}

export function takeFlash(c: Context): Flash | null {
  const name = cookieName("vantage_flash");
  const raw = getCookie(c, name);
  if (!raw) return null;
  deleteCookie(c, name, { path: "/", secure: secureCookies });
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Flash;
    if ((parsed.kind === "ok" || parsed.kind === "bad" || parsed.kind === "info") && typeof parsed.text === "string") {
      return { kind: parsed.kind, text: parsed.text.slice(0, 500) };
    }
  } catch {}
  return null;
}

/** Forms inside a FormDialog post with htmx (vantage.js); everything else is a plain form post. */
export function isHtmx(c: Context): boolean {
  return c.req.header("hx-request") === "true";
}

/**
 * Post/redirect/get with a flash message. For a dialog form (htmx) a problem stays in the open
 * dialog, next to the values the user typed: the message is the response body, which htmx swaps into
 * the dialog's error slot (200 on purpose: a 4xx would be logged as a red console error in every
 * browser). Success navigates like a normal redirect. When the target is the page the dialog sits on,
 * only the hash differs and assigning location.href would not reload it, so htmx refreshes as well.
 */
export function redirectWith(c: Context, location: string, flash?: Flash) {
  if (isHtmx(c)) {
    if (flash?.kind === "bad") {
      return c.html(<div class="form-error"><Icon name="circle-alert" size="sm" /><span>{flash.text}</span></div>);
    }
    if (flash) setFlash(c, flash);
    c.header("HX-Redirect", location);
    const current = c.req.header("hx-current-url");
    if (current) {
      const from = new URL(current);
      const to = new URL(location, from);
      if (from.pathname + from.search === to.pathname + to.search) c.header("HX-Refresh", "true");
    }
    return c.body(null, 204);
  }
  if (flash) setFlash(c, flash);
  return c.redirect(location, 303);
}

/**
 * Answers a dialog form with a follow-up step (a token shown once, the next thing to do) in place of
 * the form. Without htmx the step is rendered as a page of its own.
 */
export function showDialogStep(c: Context, step: { title: string; icon?: IconName; next?: { href: string; label: string }; body: Child }) {
  const content = <DialogStep title={step.title} icon={step.icon} next={step.next}>{step.body}</DialogStep>;
  if (!isHtmx(c)) return c.html(<PlainLayout product="Vantage" title={step.title}><div class="modal-panel">{content}</div></PlainLayout>);
  c.header("HX-Retarget", "closest .modal-panel");
  c.header("HX-Reswap", "innerHTML");
  return c.html(content);
}

/** Form values as trimmed strings; arrays for repeated keys. */
export async function formData(c: Context): Promise<{ get(k: string): string; all(k: string): string[]; has(k: string): boolean }> {
  const body = await c.req.parseBody({ all: true });
  return {
    get(k) {
      const v = body[k];
      const first = Array.isArray(v) ? v[0] : v;
      return typeof first === "string" ? first.trim() : "";
    },
    all(k) {
      const v = body[k];
      const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
      return list.filter((x): x is string => typeof x === "string").map((x) => x.trim());
    },
    has(k) {
      return body[k] !== undefined;
    },
  };
}

export function isSecureUrl(url: string): boolean {
  return new URL(url).protocol === "https:";
}

export function parseId(value: string | undefined): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}
