/**
 * Login with password + mandatory TOTP, invite acceptance, sessions. Shared by hub and ops; each
 * brings its own AuthStore (the hub's goes through SECURITY DEFINER functions, ops' through its own
 * tables). Accounts are only ever created by an admin; there is no sign-up and no e-mail reset.
 * The hub adds a Cortex login (src/hub/modules/cortex, a link on Mein Konto, not on this page),
 * which ends like the password path: in `completeLogin`, or in `secondFactor` when Cortex cannot
 * vouch for the second factor. A store with `devices` (the hub) offers „Diesem Gerät vertrauen“ on
 * the code step: such a browser skips the code for TRUST_DAYS, never the password.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { renderSVG } from "uqr";
import {
  decryptString,
  encryptString,
  hashPassword,
  hmacHex,
  newToken,
  sha256Hex,
  timingSafeEqualStr,
  verifyPassword,
} from "./crypto";
import { clientIp, configureCookies, cookieName, cookieOptions, formData, redirectWith, takeFlash } from "./http";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp";
import { Empty, Field, UsernameHint } from "./ui/components";
import { Icon } from "./ui/icons";
import { AuthLayout, PlainLayout, type AuthPitch, type Flash } from "./ui/layout";

export interface SessionUser {
  sessionId: number;
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  role: string;
}

export interface AuthStore {
  userForLogin(email: string): Promise<{ id: number; passwordHash: string | null; totpSecretEnc: string | null; disabled: boolean } | null>;
  userForLoginById(id: number): Promise<{ email: string; totpSecretEnc: string | null; disabled: boolean } | null>;
  recordAttempt(email: string, ip: string, ok: boolean): Promise<void>;
  recentFailures(email: string, ip: string, windowSeconds: number): Promise<{ byEmail: number; byIp: number }>;
  createSession(userId: number, tokenHash: string, expiresAt: Date, ip: string, userAgent: string): Promise<void>;
  sessionUser(tokenHash: string, idleSeconds: number): Promise<SessionUser | null>;
  revokeSession(tokenHash: string): Promise<void>;
  invite(tokenHash: string): Promise<{ userId: number; email: string; name: string; pendingTotpEnc: string | null } | null>;
  setInvitePendingTotp(tokenHash: string, totpEnc: string): Promise<void>;
  acceptInvite(tokenHash: string, passwordHash: string): Promise<number | null>;
  audit(userId: number | null, action: string, detail: Record<string, unknown>, ip: string, label?: string): Promise<void>;
  /** Trusted devices; a store without them (ops) asks for the code at every login. */
  devices?: {
    trust(userId: number, tokenHash: string, expiresAt: Date, ip: string, userAgent: string): Promise<number>;
    /** The device id when the token is a live device of this user (and notes the use), else null. */
    use(userId: number, tokenHash: string, ip: string): Promise<number | null>;
    revoke(tokenHash: string): Promise<void>;
  };
}

/** How the first factor was proven; the login history on Mein Konto shows it. */
export type LoginMethod = "password" | "cortex";

export interface AuthOptions {
  product: string;
  /** Left panel of the login pages. */
  pitch: AuthPitch;
  cookieName: string;
  publicUrl: string;
  secret: string;
  store: AuthStore;
  idleSeconds?: number;
  absoluteSeconds?: number;
}

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;
const PRE_AUTH_SECONDS = 5 * 60;
export const MIN_PASSWORD_LENGTH = 12;
export const TRUST_DAYS = 30;

/** The cookie that holds a trusted device's token; Mein Konto reads it to mark „dieses Gerät“. */
export const deviceCookieName = (sessionCookie: string) => cookieName(`${sessionCookie}_device`);

// Verifying against this when the e-mail is unknown keeps response times the same for both cases.
const DUMMY_HASH = await hashPassword("dummy-password-for-timing-only");

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
  }
}

export function passwordProblem(password: string, repeat: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`;
  if (password.length > 200) return "Das Passwort ist zu lang.";
  if (password !== repeat) return "Die beiden Passwörter stimmen nicht überein.";
  return null;
}

export function createAuth(opts: AuthOptions) {
  const idle = opts.idleSeconds ?? 8 * 3600;
  const absolute = opts.absoluteSeconds ?? 7 * 86400;
  configureCookies(opts.publicUrl);
  const sessionCookie = cookieName(opts.cookieName);
  const preCookie = cookieName(`${opts.cookieName}_pre`);
  const deviceCookie = deviceCookieName(opts.cookieName);
  const devices = opts.store.devices;
  // A TOTP code is valid for ±30 s; remembering used ones stops a captured code being replayed.
  const usedCodes = new Map<string, number>();

  function signPreAuth(userId: number, method: LoginMethod): string {
    const expires = Math.floor(Date.now() / 1000) + PRE_AUTH_SECONDS;
    const payload = `${userId}.${expires}.${method}`;
    return `${payload}.${hmacHex(opts.secret, `pre-auth:${payload}`)}`;
  }

  function readPreAuth(value: string | undefined): { userId: number; method: LoginMethod } | null {
    if (!value) return null;
    const [id, expires, method, sig] = value.split(".");
    if (!id || !expires || !sig || (method !== "password" && method !== "cortex")) return null;
    if (!timingSafeEqualStr(sig, hmacHex(opts.secret, `pre-auth:${id}.${expires}.${method}`))) return null;
    if (Number(expires) < Date.now() / 1000) return null;
    return { userId: Number(id), method };
  }

  /** Login audit rows also carry the browser, for the login history on Mein Konto. */
  function loginDetail(c: Context, detail: Record<string, unknown>): Record<string, unknown> {
    return { ...detail, user_agent: (c.req.header("user-agent") ?? "").slice(0, 300) };
  }

  async function startSession(c: Context, userId: number) {
    const token = newToken("vs");
    await opts.store.createSession(
      userId,
      sha256Hex(token),
      new Date(Date.now() + absolute * 1000),
      clientIp(c),
      c.req.header("user-agent") ?? "",
    );
    setCookie(c, sessionCookie, token, cookieOptions(absolute));
  }

  /** Both factors are proven: the session starts and the login is recorded. */
  async function completeLogin(c: Context, userId: number, next: string, detail: Record<string, unknown>) {
    await startSession(c, userId);
    await opts.store.audit(userId, "login.ok", loginDetail(c, detail), clientIp(c));
    return c.redirect(safeNext(next), 303);
  }

  /** A browser trusted for another account loses that token here: one cookie, one account. */
  async function trustDevice(c: Context, userId: number): Promise<number | null> {
    if (!devices) return null;
    const previous = getCookie(c, deviceCookie);
    if (previous) await devices.revoke(sha256Hex(previous));
    const token = newToken("vd");
    const id = await devices.trust(userId, sha256Hex(token), new Date(Date.now() + TRUST_DAYS * 86_400_000), clientIp(c), c.req.header("user-agent") ?? "");
    setCookie(c, deviceCookie, token, cookieOptions(TRUST_DAYS * 86_400));
    return id;
  }

  const loadUser: MiddlewareHandler = async (c, next) => {
    const token = getCookie(c, sessionCookie);
    if (token) {
      const user = await opts.store.sessionUser(sha256Hex(token), idle);
      if (user) c.set("user", user);
    }
    await next();
  };

  const requireUser: MiddlewareHandler = async (c, next) => {
    if (!c.get("user")) {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not authenticated" }, 401);
      const target = c.req.method === "GET" ? c.req.path + (new URL(c.req.url).search || "") : "/";
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 303);
    }
    await next();
  };

  const requireAdmin: MiddlewareHandler = async (c, next) => {
    if (!c.get("user")?.isAdmin) return c.text("Nur für Administratoren.", 403);
    await next();
  };

  /** Only same-origin targets; parsing like a browser does catches "/\\t/evil" and friends. */
  function safeNext(value: string | undefined): string {
    if (!value || !value.startsWith("/")) return "/";
    try {
      const base = new URL(opts.publicUrl);
      const url = new URL(value, base);
      return url.origin === base.origin ? url.pathname + url.search + url.hash : "/";
    } catch {
      return "/";
    }
  }

  function codeAlreadyUsed(userId: number, code: string): boolean {
    const now = Date.now();
    for (const [k, until] of usedCodes) if (until < now) usedCodes.delete(k);
    const key = `${userId}:${code.replace(/\s+/g, "")}`;
    if (usedCodes.has(key)) return true;
    usedCodes.set(key, now + 120_000);
    return false;
  }

  function LoginPage(p: { flash?: Flash | null; next: string; email?: string }) {
    return (
      <AuthLayout product={opts.product} title="Anmelden" pitch={opts.pitch} flash={p.flash}>
        <h1>Willkommen zurück</h1>
        <p class="lead">Melden Sie sich mit Ihrem Vantage-Zugang an.</p>
        <form method="post" action="/login" class="stack">
          <input type="hidden" name="next" value={p.next} />
          <Field label="E-Mail" for="email"><input id="email" name="email" type="email" autocomplete="username" required value={p.email ?? ""} autofocus placeholder="name@firma.de" /></Field>
          <Field label="Passwort" for="password"><input id="password" name="password" type="password" autocomplete="current-password" required /></Field>
          <button class="btn primary block" type="submit">Weiter <Icon name="arrow-right" size="sm" /></button>
        </form>
        <p class="help">Kein Zugang oder Passwort vergessen? Ihr Ansprechpartner bei Systaro richtet ihn ein.</p>
      </AuthLayout>
    );
  }

  function TotpPage(p: { flash?: Flash | null; next: string; remember?: boolean }) {
    return (
      <AuthLayout product={opts.product} title="Bestätigungscode" pitch={opts.pitch} flash={p.flash}>
        <span class="head-icon auth-step-icon"><Icon name="shield-check" size="lg" /></span>
        <h1>Bestätigungscode</h1>
        <p class="lead">Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.</p>
        <form method="post" action="/login/totp" class="stack">
          <input type="hidden" name="next" value={p.next} />
          <Field label="Code" for="code"><input id="code" class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength={7} required autofocus placeholder="000000" /></Field>
          {devices && (
            <div>
              <label class="check"><input type="checkbox" name="remember" value="1" checked={p.remember} /> Diesem Gerät {TRUST_DAYS} Tage vertrauen</label>
              <p class="muted small">Dann fragt {opts.product} hier nur nach dem Passwort, nicht nach dem Code. Nicht auf Geräten, die andere mitbenutzen.</p>
            </div>
          )}
          <button class="btn primary block" type="submit">Anmelden</button>
        </form>
        <p class="help"><a href="/login"><Icon name="arrow-left" size="sm" /> Andere Anmeldung</a></p>
      </AuthLayout>
    );
  }

  function loginPage(c: Context, p: { flash?: Flash | null; next: string; email?: string }, status: 200 | 401 | 429 = 200) {
    return c.html(<LoginPage {...p} />, status);
  }

  /**
   * The first factor is proven (password, or a Cortex login without its code). A trusted device of
   * this user is logged in right away; everyone else goes on to the TOTP step.
   */
  async function secondFactor(c: Context, userId: number, next: string, method: LoginMethod) {
    const device = getCookie(c, deviceCookie);
    const deviceId = device && devices ? await devices.use(userId, sha256Hex(device), clientIp(c)) : null;
    if (deviceId) return completeLogin(c, userId, next, { method, second_factor: "device", device_id: deviceId });
    setCookie(c, preCookie, signPreAuth(userId, method), cookieOptions(PRE_AUTH_SECONDS));
    return c.redirect(`/login/totp?next=${encodeURIComponent(safeNext(next))}`, 303);
  }

  async function tooManyFailures(email: string, ip: string): Promise<boolean> {
    const f = await opts.store.recentFailures(email, ip, WINDOW_SECONDS);
    return f.byEmail >= MAX_FAILURES_PER_EMAIL || f.byIp >= MAX_FAILURES_PER_IP;
  }

  function mount(app: Hono<any>) {
    app.get("/login", async (c) => {
      if (c.get("user")) return c.redirect(safeNext(c.req.query("next")), 303);
      return loginPage(c, { flash: takeFlash(c), next: safeNext(c.req.query("next")) });
    });

    app.post("/login", async (c) => {
      const form = await formData(c);
      const email = form.get("email").toLowerCase().slice(0, 254);
      const password = form.get("password");
      const next = safeNext(form.get("next"));
      const ip = clientIp(c);
      const blocked: Flash = { kind: "bad", text: "Zu viele Fehlversuche. Bitte warten Sie 15 Minuten." };

      if (await tooManyFailures(email, ip)) {
        return loginPage(c, { flash: blocked, next, email }, 429);
      }
      const user = email ? await opts.store.userForLogin(email) : null;
      const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !user.passwordHash || !ok || user.disabled || !user.totpSecretEnc) {
        await opts.store.recordAttempt(email, ip, false);
        await opts.store.audit(null, "login.failed", loginDetail(c, { email, step: "password" }), ip, email || "unbekannt");
        return loginPage(c, { flash: { kind: "bad", text: "E-Mail oder Passwort ist falsch." }, next, email }, 401);
      }
      return secondFactor(c, user.id, next, "password");
    });

    app.get("/login/totp", (c) => {
      if (!readPreAuth(getCookie(c, preCookie))) return c.redirect("/login", 303);
      return c.html(<TotpPage flash={takeFlash(c)} next={safeNext(c.req.query("next"))} />);
    });

    app.post("/login/totp", async (c) => {
      const form = await formData(c);
      const next = safeNext(form.get("next"));
      const ip = clientIp(c);
      const pre = readPreAuth(getCookie(c, preCookie));
      if (!pre) return redirectWith(c, "/login", { kind: "info", text: "Die Anmeldung ist abgelaufen. Bitte noch einmal." });
      const { userId, method } = pre;
      const remember = form.get("remember") === "1";
      const login = await opts.store.userForLoginById(userId);
      if (!login || login.disabled || !login.totpSecretEnc) return c.redirect("/login", 303);
      if (await tooManyFailures(login.email, ip)) {
        deleteCookie(c, preCookie, { path: "/", secure: cookieOptions(0).secure });
        return redirectWith(c, "/login", { kind: "bad", text: "Zu viele Fehlversuche. Bitte warten Sie 15 Minuten." });
      }
      const secret = await decryptString(opts.secret, login.totpSecretEnc);
      if (!(await verifyTotp(secret, form.get("code"))) || codeAlreadyUsed(userId, form.get("code"))) {
        await opts.store.recordAttempt(login.email, ip, false);
        await opts.store.audit(null, "login.failed", loginDetail(c, { email: login.email, step: "totp" }), ip, login.email);
        return c.html(<TotpPage flash={{ kind: "bad", text: "Der Code stimmt nicht." }} next={next} remember={remember} />, 401);
      }
      await opts.store.recordAttempt(login.email, ip, true);
      deleteCookie(c, preCookie, { path: "/", secure: cookieOptions(0).secure });
      const trusted = remember ? await trustDevice(c, userId) : null;
      return completeLogin(c, userId, next, { method, second_factor: "totp", ...(trusted ? { trusted_device: trusted } : {}) });
    });

    app.post("/logout", async (c) => {
      const token = getCookie(c, sessionCookie);
      if (token) await opts.store.revokeSession(sha256Hex(token));
      deleteCookie(c, sessionCookie, { path: "/", secure: cookieOptions(0).secure });
      return redirectWith(c, "/login", { kind: "info", text: "Sie sind abgemeldet." });
    });

    app.get("/invite/:token", async (c) => {
      const token = c.req.param("token");
      const hash = sha256Hex(token);
      let invite = await opts.store.invite(hash);
      if (!invite) return c.html(<InviteInvalid />, 404);
      if (!invite.pendingTotpEnc) {
        await opts.store.setInvitePendingTotp(hash, await encryptString(opts.secret, newTotpSecret()));
        invite = await opts.store.invite(hash);
        if (!invite?.pendingTotpEnc) return c.html(<InviteInvalid />, 404);
      }
      const secret = await decryptString(opts.secret, invite.pendingTotpEnc);
      return c.html(<InvitePage token={token} email={invite.email} name={invite.name} secret={secret} flash={takeFlash(c)} />);
    });

    app.post("/invite/:token", async (c) => {
      const token = c.req.param("token");
      const hash = sha256Hex(token);
      const invite = await opts.store.invite(hash);
      if (!invite?.pendingTotpEnc) return c.html(<InviteInvalid />, 404);
      const form = await formData(c);
      const problem = passwordProblem(form.get("password"), form.get("password_repeat"));
      const secret = await decryptString(opts.secret, invite.pendingTotpEnc);
      if (problem) {
        return c.html(<InvitePage token={token} email={invite.email} name={invite.name} secret={secret} flash={{ kind: "bad", text: problem }} />, 400);
      }
      if (!(await verifyTotp(secret, form.get("code")))) {
        return c.html(
          <InvitePage token={token} email={invite.email} name={invite.name} secret={secret} flash={{ kind: "bad", text: "Der Code aus der Authenticator-App stimmt nicht. Prüfen Sie die Uhrzeit des Telefons und versuchen Sie es noch einmal." }} />,
          400,
        );
      }
      const userId = await opts.store.acceptInvite(hash, await hashPassword(form.get("password")));
      if (!userId) return c.html(<InviteInvalid />, 404);
      await opts.store.audit(userId, "invite.accepted", loginDetail(c, {}), clientIp(c));
      await startSession(c, userId);
      return redirectWith(c, "/", { kind: "ok", text: "Willkommen! Ihr Zugang ist eingerichtet." });
    });
  }

  function InviteInvalid() {
    return (
      <PlainLayout product={opts.product} title="Einladung ungültig">
        <div class="card">
          <Empty title="Einladung ungültig" icon="circle-x" action={<a class="btn primary" href="/login">Zur Anmeldung</a>}>
            Dieser Link ist abgelaufen, wurde schon benutzt oder zurückgezogen. Bitte fordern Sie bei Systaro einen neuen an.
          </Empty>
        </div>
      </PlainLayout>
    );
  }

  function InvitePage(p: { token: string; email: string; name: string; secret: string; flash?: Flash | null }) {
    const uri = otpauthUri(opts.product, p.email, p.secret);
    const qr = renderSVG(uri, { border: 1 });
    const grouped = p.secret.match(/.{1,4}/g)?.join(" ") ?? p.secret;
    return (
      <AuthLayout product={opts.product} title="Zugang einrichten" pitch={opts.pitch} flash={p.flash}>
        <h1>Zugang einrichten</h1>
        <p class="lead">Hallo {p.name}! Ihr Zugang für <strong>{p.email}</strong> braucht ein Passwort und eine Authenticator-App, zum Beispiel Microsoft Authenticator, Google Authenticator oder 1Password.</p>
        <form method="post" action={`/invite/${p.token}`} class="stack">
          <UsernameHint email={p.email} />
          <div class="step"><span class="step-no">1</span><h3>Passwort festlegen</h3></div>
          <Field label="Passwort" for="password" hint={`Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`}>
            <input id="password" name="password" type="password" autocomplete="new-password" minlength={MIN_PASSWORD_LENGTH} required />
          </Field>
          <Field label="Passwort wiederholen" for="password_repeat">
            <input id="password_repeat" name="password_repeat" type="password" autocomplete="new-password" required />
          </Field>
          <div class="step"><span class="step-no">2</span><h3>Authenticator verbinden</h3></div>
          <div class="qr-block">
            <div class="qr" dangerouslySetInnerHTML={{ __html: qr }} />
            <div class="stack-sm">
              <p class="small muted">QR-Code mit der App scannen, oder den Schlüssel von Hand eingeben:</p>
              <div class="secret">{grouped}</div>
            </div>
          </div>
          <div class="step"><span class="step-no">3</span><h3>Code bestätigen</h3></div>
          <Field label="Code aus der App" for="code">
            <input id="code" class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength={7} required placeholder="000000" />
          </Field>
          <button class="btn primary block" type="submit">Zugang aktivieren</button>
        </form>
      </AuthLayout>
    );
  }

  return { mount, loadUser, requireUser, requireAdmin, completeLogin, secondFactor, safeNext, audit: opts.store.audit };
}

export type Auth = ReturnType<typeof createAuth>;
