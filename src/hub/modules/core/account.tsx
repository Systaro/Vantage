import type { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { deviceCookieName, passwordProblem } from "../../../shared/auth";
import { decryptString, hashPassword, verifyPassword } from "../../../shared/crypto";
import { cookieOptions, formData, parseId, redirectWith } from "../../../shared/http";
import { verifyTotp } from "../../../shared/totp";
import { ActionButton, Ago, Badge, Card, Field, formatDate, formatUserAgent, PageHead, UsernameHint } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { all, hubSql, rls } from "../../db";
import { audit, HubPage } from "../../ui";
import { ApiTokensCard, mountApiTokens } from "../agent/tokens";
import { CortexLinkCard, mountCortexAccount } from "../cortex/routes";
import { LoginHistoryCard, mountDevices, TrustedDevicesCard } from "./devices";
import { GRANT_LEVELS, parseGrantLevel } from "./users";

export const SESSION_COOKIE = "vantage_session";

export function mountAccount(app: Hono) {
  mountApiTokens(app);
  mountCortexAccount(app);
  mountDevices(app);
  app.get("/account", async (c) => {
    const me = c.get("user");
    const data = await rls(c, async (tx) => ({
      sessions: await all<any>(tx`select id, created_at, last_seen_at, ip, user_agent from sessions
        where user_id = ${me.id} and revoked_at is null and expires_at > now() order by last_seen_at desc`),
      grants: await all<any>(tx`
        select g.level, g.all_environments, g.expires_at, p.name as project_name, o.name as org_name,
          (select string_agg(e.name, ', ') from grant_environments ge join environments e on e.id = ge.environment_id where ge.grant_id = g.id) as env_names
        from grants g join projects p on p.id = g.project_id join organisations o on o.id = p.organisation_id
        where g.user_id = ${me.id} order by o.name, p.name`),
    }));
    return c.html(
      <HubPage c={c} title="Mein Konto">
        <PageHead icon="user" title="Mein Konto" sub={`${me.name} · ${me.email}`} actions={<a class="btn" href="/account/notifications">Benachrichtigungen</a>} />
        <div class="stack">
          <Card title="Meine Freigaben" flush>
            {me.isAdmin ? (
              <div class="card-body"><p>Sie sind Administrator und sehen alle Umgebungen.</p></div>
            ) : data.grants.length === 0 ? (
              <div class="card-body"><p class="muted">Noch keine Freigaben.</p></div>
            ) : (
              <div class="table-wrap"><table>
                <thead><tr><th>Projekt</th><th>Stufe</th><th>Umgebungen</th><th>Läuft ab</th></tr></thead>
                <tbody>{data.grants.map((g) => (
                  <tr>
                    <td>{g.org_name} / {g.project_name}</td>
                    <td>{GRANT_LEVELS[parseGrantLevel(g.level)].label}</td>
                    <td>{g.all_environments ? "alle" : g.env_names}</td>
                    <td>{g.expires_at ? formatDate(g.expires_at) : "nie"}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
          <div class="grid grid-2">
            <Card title="Passwort ändern">
              <form method="post" action="/account/password" class="stack">
                <UsernameHint email={me.email} />
                <Field label="Aktuelles Passwort" for="current"><input id="current" name="current" type="password" autocomplete="current-password" required /></Field>
                <Field label="Neues Passwort" for="password"><input id="password" name="password" type="password" autocomplete="new-password" required /></Field>
                <Field label="Neues Passwort wiederholen" for="password_repeat"><input id="password_repeat" name="password_repeat" type="password" autocomplete="new-password" required /></Field>
                <Field label="Code aus der Authenticator-App" for="code"><input id="code" class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required /></Field>
                <p class="muted small">Danach enden alle anderen Sitzungen, und gemerkte Geräte fragen wieder nach dem Code.</p>
                <button class="btn primary" type="submit">Passwort ändern</button>
              </form>
            </Card>
            <Card title="Aktive Sitzungen" flush>
              <div class="table-wrap"><table>
                <thead><tr><th>Gerät</th><th>Zuletzt aktiv</th><th></th></tr></thead>
                <tbody>{data.sessions.map((s) => (
                  <tr>
                    <td>
                      <span class="cell-title" title={s.user_agent ?? undefined}>{formatUserAgent(s.user_agent)}</span>
                      <span class="cell-sub">{s.ip} · seit {formatDate(s.created_at)}</span>
                    </td>
                    <td><Ago at={s.last_seen_at} /></td>
                    <td class="right">{s.id === me.sessionId ? <Badge tone="ok">diese</Badge> : <ActionButton action={`/account/sessions/${s.id}/revoke`} label="Beenden" small />}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
          </div>
          <TrustedDevicesCard c={c} />
          <LoginHistoryCard c={c} />
          <CortexLinkCard c={c} />
          <ApiTokensCard c={c} />
        </div>
      </HubPage>,
    );
  });

  app.post("/account/password", async (c) => {
    const me = c.get("user");
    const f = await formData(c);
    const problem = passwordProblem(f.get("password"), f.get("password_repeat"));
    if (problem) return redirectWith(c, "/account", { kind: "bad", text: problem });
    const [login] = (await hubSql`select * from auth_user_for_login(${me.email})`) as any[];
    const secret = login?.totp_secret_enc ? await decryptString(hubConfig.secret, login.totp_secret_enc) : null;
    const ok = login?.password_hash && (await verifyPassword(f.get("current"), login.password_hash)) && secret && (await verifyTotp(secret, f.get("code")));
    if (!ok) {
      await audit(c, "account.password_failed", null);
      return redirectWith(c, "/account", { kind: "bad", text: "Aktuelles Passwort oder Code stimmt nicht." });
    }
    const hash = await hashPassword(f.get("password"));
    await rls(c, async (tx) => {
      await tx`select account_set_password(${hash})`;
      await tx`update sessions set revoked_at = now() where user_id = ${me.id} and revoked_at is null and id <> ${me.sessionId}`;
      await tx`update trusted_devices set revoked_at = now() where user_id = ${me.id} and revoked_at is null`;
    });
    deleteCookie(c, deviceCookieName(SESSION_COOKIE), { path: "/", secure: cookieOptions(0).secure });
    await audit(c, "account.password_changed", null);
    return redirectWith(c, "/account", { kind: "ok", text: "Passwort geändert. Alle anderen Sitzungen wurden beendet, gemerkte Geräte fragen wieder nach dem Code." });
  });

  app.post("/account/sessions/:id/revoke", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await rls(c, (tx) => tx`update sessions set revoked_at = now() where id = ${id} and user_id = ${c.get("user").id} returning id`);
    if (!rows.length) return c.notFound();
    await audit(c, "account.session_revoked", String(id));
    return redirectWith(c, "/account", { kind: "ok", text: "Sitzung beendet." });
  });

}
