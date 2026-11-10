/**
 * Cortex login for Systaro staff: the round trip to Cortex, and the link between a Vantage account
 * and its Cortex identity (Mein Konto, admin user page). The login page offers no Cortex button
 * (customers see that page too); a linked account finds its sign-in link on Mein Konto.
 *
 * A Cortex login only opens an account that its owner linked before, after a normal login, and it
 * replaces the password, not the second factor: Vantage asks for its own code unless Cortex reports
 * that its authenticator code was typed for this session within the last 12 hours, or the browser is
 * a trusted Vantage device of the account (shared/auth.tsx). The flow's
 * secrets (state, nonce, PKCE verifier) travel in an encrypted cookie that lives ten minutes and is
 * used once.
 */
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Auth } from "../../../shared/auth";
import { decryptString, encryptString, hmacHex, timingSafeEqualStr } from "../../../shared/crypto";
import { clientIp, cookieName, cookieOptions, parseId, redirectWith } from "../../../shared/http";
import { Card, ConfirmAction, CopyButton, formatDate } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { hubConfig } from "../../config";
import { first, hubSql, rls } from "../../db";
import { audit } from "../../ui";
import { cortexConnection } from "../integrations/store";
import { authorizeUrl, cortexCheckedCode, discover, exchangeCode, newFlowSecrets, OidcError, verifyIdToken, type CortexIdentity } from "./oidc";

export const CORTEX_CALLBACK = "/login/cortex/callback";
const FLOW_SECONDS = 10 * 60;

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  mode: "login" | "link";
  /** link: the account that started it; the callback must come back to the same one. */
  userId?: number;
  exp: number;
}

interface CortexLink {
  cortex_username: string;
  linked_at: Date;
}

const flowCookie = () => cookieName("vantage_cortex");
/**
 * Linking starts with a link, not a form: the page's CSP (form-action 'self') would stop a form post
 * on its redirect to Cortex. The token ties the link to the session, so another site cannot start it.
 */
const linkToken = (sessionId: number) => hmacHex(hubConfig.secret, `cortex-link:${sessionId}`);
const publicBase = () => hubConfig.publicUrl.replace(/\/+$/, "");
export const cortexCallbackUrl = () => `${publicBase()}${CORTEX_CALLBACK}`;
const cortexLoginUrl = () => `${publicBase()}/login/cortex`;

async function readFlow(raw: string | undefined): Promise<Flow | null> {
  if (!raw) return null;
  try {
    const flow = JSON.parse(await decryptString(hubConfig.secret, raw)) as Flow;
    return flow.exp > Date.now() / 1000 ? flow : null;
  } catch {
    return null;
  }
}

/** Sends the browser to Cortex; the answer comes back to CORTEX_CALLBACK. */
async function startFlow(c: Context, mode: Flow["mode"], next: string, userId?: number) {
  const back = mode === "link" ? "/account" : "/login";
  const conn = await cortexConnection();
  if (!conn) return redirectWith(c, back, { kind: "bad", text: "Die Anmeldung mit Cortex ist nicht eingerichtet." });
  let url: string;
  const s = newFlowSecrets();
  try {
    url = authorizeUrl(await discover(conn.issuer), conn, { redirectUri: cortexCallbackUrl(), state: s.state, nonce: s.nonce, challenge: s.challenge });
  } catch (err) {
    if (!(err instanceof OidcError)) throw err;
    return redirectWith(c, back, { kind: "bad", text: err.message });
  }
  const flow: Flow = { state: s.state, nonce: s.nonce, verifier: s.verifier, next, mode, userId, exp: Math.floor(Date.now() / 1000) + FLOW_SECONDS };
  setCookie(c, flowCookie(), await encryptString(hubConfig.secret, JSON.stringify(flow)), cookieOptions(FLOW_SECONDS));
  return c.redirect(url, 303);
}

async function finishLogin(c: Context, auth: Auth, flow: Flow, issuer: string, id: CortexIdentity) {
  const ip = clientIp(c);
  const user = await first<{ id: number; email: string }>(hubSql`select * from auth_user_for_cortex(${issuer}, ${id.userId})`);
  if (!user) {
    await auth.audit(null, "login.failed", { step: "cortex", cortex_user: id.username }, ip, id.username || "unbekannt");
    return redirectWith(c, "/login", {
      kind: "bad",
      text: `Das Cortex-Konto „${id.username}“ ist mit keinem Vantage-Zugang verknüpft. Melden Sie sich mit E-Mail und Passwort an und verknüpfen Sie es unter Mein Konto.`,
    });
  }
  if (cortexCheckedCode(id)) return auth.completeLogin(c, user.id, flow.next, { method: "cortex", second_factor: "cortex" });
  await auth.audit(user.id, "login.cortex", { second_factor: "vantage", amr: id.amr }, ip);
  return auth.secondFactor(c, user.id, flow.next, "cortex");
}

async function finishLink(c: Context, flow: Flow, issuer: string, id: CortexIdentity) {
  const me = c.get("user");
  if (!me || me.id !== flow.userId) return redirectWith(c, "/login", { kind: "info", text: "Zum Verknüpfen zuerst bei Vantage anmelden." });
  const row = await rls(c, (tx) => first<{ result: string }>(tx`select account_link_cortex(${issuer}, ${id.userId}, ${id.username}) as result`));
  if (row?.result === "taken") return redirectWith(c, "/account", { kind: "bad", text: `Das Cortex-Konto „${id.username}“ ist schon mit einem anderen Vantage-Zugang verknüpft.` });
  if (row?.result !== "ok") return redirectWith(c, "/account", { kind: "bad", text: "Nur Systaro-Konten können sich mit Cortex anmelden." });
  await audit(c, "account.cortex_linked", id.username, { cortex_user_id: id.userId });
  return redirectWith(c, "/account", { kind: "ok", text: `Verknüpft mit dem Cortex-Konto „${id.username}“. Ihren Anmeldelink finden Sie unten.` });
}

/** Mein Konto: the own link, for staff, once the connection is set up (or a link still exists). */
export async function CortexLinkCard(props: { c: Context }) {
  const me = props.c.get("user");
  const [conn, link] = await Promise.all([
    cortexConnection(),
    rls(props.c, (tx) => first<CortexLink>(tx`select cortex_username, linked_at from cortex_links where user_id = ${me.id}`)),
  ]);
  if (!link && (!conn || me.role !== "staff")) return <></>;
  return (
    <Card title="Anmeldung mit Cortex" icon="key-round" description="Mit einem verknüpften Cortex-Konto melden Sie sich über Ihren Anmeldelink an, ohne Passwort. Den Code aus Ihrer Authenticator-App fragt Vantage trotzdem, außer Sie haben ihn in den letzten 12 Stunden in Cortex eingegeben.">
      {link ? (
        <div class="stack">
          <dl class="facts">
            <dt>Cortex-Konto</dt><dd><code>{link.cortex_username}</code></dd>
            <dt>Verknüpft</dt><dd>{formatDate(link.linked_at)}</dd>
          </dl>
          <div class="stack">
            <div class="secret-row"><div class="secret" id="cortex-login-url">{cortexLoginUrl()}</div><CopyButton target="cortex-login-url" /></div>
            <p class="muted small">Als Lesezeichen speichern: Die Anmeldeseite selbst bietet Cortex nicht an.</p>
          </div>
          <div><ConfirmAction action="/account/cortex/unlink" label="Verknüpfung lösen" question="Verknüpfung mit Cortex lösen? Danach melden Sie sich wieder mit E-Mail und Passwort an." /></div>
        </div>
      ) : (
        <div class="stack">
          <p class="muted small">Sie werden zu Cortex geleitet und melden sich dort an. Danach verknüpft Vantage dieses Konto mit Ihrem Cortex-Konto.</p>
          <div><a class="btn primary" href={`/account/cortex/link?t=${linkToken(me.sessionId)}`}><Icon name="link" size="sm" /> Mit Cortex verknüpfen</a></div>
        </div>
      )}
    </Card>
  );
}

/** Admin user page: whose Cortex account is linked, and a way to remove it. */
export async function CortexLinkAdmin(props: { c: Context; userId: number }) {
  const link = await rls(props.c, (tx) => first<CortexLink>(tx`select cortex_username, linked_at from cortex_links where user_id = ${props.userId}`));
  if (!link) return <></>;
  return (
    <div>
      <p class="muted small">Verknüpft mit dem Cortex-Konto <code>{link.cortex_username}</code> seit {formatDate(link.linked_at)}. Damit meldet sich die Person ohne Passwort an.</p>
      <ConfirmAction action={`/admin/users/${props.userId}/cortex/unlink`} label="Cortex-Verknüpfung lösen" question="Cortex-Verknüpfung lösen? Die Person meldet sich danach wieder mit E-Mail und Passwort an." />
    </div>
  );
}

/** Routes without a session (login, callback); mounted after auth.mount, before requireUser. */
export function mountCortexLogin(app: Hono, auth: Auth) {
  app.get("/login/cortex", async (c) => {
    if (c.get("user")) return c.redirect(auth.safeNext(c.req.query("next")), 303);
    return startFlow(c, "login", auth.safeNext(c.req.query("next")));
  });

  app.get(CORTEX_CALLBACK, async (c) => {
    const flow = await readFlow(getCookie(c, flowCookie()));
    deleteCookie(c, flowCookie(), { path: "/", secure: cookieOptions(0).secure });
    if (!flow) return redirectWith(c, "/login", { kind: "info", text: "Die Anmeldung über Cortex ist abgelaufen. Bitte noch einmal." });
    const back = flow.mode === "link" ? "/account" : "/login";
    if (!timingSafeEqualStr(c.req.query("state") ?? "", flow.state)) {
      return redirectWith(c, back, { kind: "bad", text: "Die Antwort von Cortex gehört nicht zu dieser Anmeldung. Bitte noch einmal." });
    }
    const error = c.req.query("error");
    if (error) {
      return redirectWith(c, back, error === "access_denied"
        ? { kind: "info", text: "Die Anmeldung bei Cortex wurde abgebrochen." }
        : { kind: "bad", text: `Cortex hat die Anmeldung abgelehnt (${error.slice(0, 80)}).` });
    }
    const conn = await cortexConnection();
    if (!conn) return redirectWith(c, back, { kind: "bad", text: "Die Anmeldung mit Cortex ist nicht eingerichtet." });
    let id: CortexIdentity;
    try {
      const d = await discover(conn.issuer);
      const idToken = await exchangeCode(d, conn, { code: c.req.query("code") ?? "", verifier: flow.verifier, redirectUri: cortexCallbackUrl() });
      id = await verifyIdToken(idToken, d, conn, flow.nonce);
    } catch (err) {
      if (!(err instanceof OidcError)) throw err;
      console.warn(`[hub] cortex login: ${err.message}`);
      return redirectWith(c, back, { kind: "bad", text: err.message });
    }
    return flow.mode === "link" ? finishLink(c, flow, conn.issuer, id) : finishLogin(c, auth, flow, conn.issuer, id);
  });
}

/** Routes with a session: linking on Mein Konto, unlinking there and on the admin user page. */
export function mountCortexAccount(app: Hono) {
  app.get("/account/cortex/link", async (c) => {
    const me = c.get("user");
    if (!timingSafeEqualStr(c.req.query("t") ?? "", linkToken(me.sessionId))) return c.redirect("/account", 303);
    if (me.role !== "staff") return redirectWith(c, "/account", { kind: "bad", text: "Nur Systaro-Konten können sich mit Cortex anmelden." });
    return startFlow(c, "link", "/account", me.id);
  });

  app.post("/account/cortex/unlink", async (c) => {
    const rows = await rls(c, (tx) => tx`delete from cortex_links where user_id = ${c.get("user").id} returning cortex_username`);
    if (rows.length) await audit(c, "account.cortex_unlinked", (rows[0] as CortexLink).cortex_username);
    return redirectWith(c, "/account", { kind: "ok", text: "Die Verknüpfung mit Cortex ist gelöst." });
  });

  app.post("/admin/users/:id/cortex/unlink", async (c) => {
    const userId = parseId(c.req.param("id"));
    if (!userId) return c.notFound();
    const rows = await rls(c, (tx) => tx`delete from cortex_links where user_id = ${userId} returning cortex_username`);
    if (rows.length) await audit(c, "user.cortex_unlinked", String(userId), { cortex_username: (rows[0] as CortexLink).cortex_username });
    return redirectWith(c, `/admin/users/${userId}`, { kind: "ok", text: "Cortex-Verknüpfung gelöst." });
  });
}
