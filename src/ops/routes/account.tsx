import type { Hono } from "hono";
import { passwordProblem } from "../../shared/auth";
import { decryptString, hashPassword, verifyPassword } from "../../shared/crypto";
import { formData, parseId, redirectWith } from "../../shared/http";
import { verifyTotp } from "../../shared/totp";
import { ActionButton, Ago, Badge, Card, Field, formatDate, formatUserAgent, PageHead, UsernameHint } from "../../shared/ui/components";
import { initials } from "../../shared/ui/layout";
import { all, first } from "../../shared/db";
import { ROLE_LABEL, type Role } from "../roles";
import type { Ops } from "../service";
import { audit, FormActions, OpsPage } from "../ui";

export function mountAccount(app: Hono, ops: Ops) {
  app.get("/account", async (c) => {
    const me = c.get("user");
    const sessions = await all<any>(ops.sql`select id, created_at, last_seen_at, ip, user_agent from sessions
      where user_id = ${me.id} and revoked_at is null and expires_at > now() order by last_seen_at desc`);
    return c.html(
      <OpsPage c={c} title="Mein Konto">
        <PageHead icon="user" title="Mein Konto" sub="Ihr Zugang zu Vantage Ops: Passwort ändern und sehen, wo Sie angemeldet sind." />
        <div class="grid grid-2 ops-align-start">
          <div class="stack">
            <Card title="Profil" icon="user" description="Name und Rolle ändert ein Administrator.">
              <div class="user-cell ops-profile">
                <span class="avatar">{initials(me.name)}</span>
                <span>
                  <span class="cell-title">{me.name}</span>
                  <span class="cell-sub">{me.email}</span>
                </span>
                <Badge tone="accent">{ROLE_LABEL[me.role as Role] ?? me.role}</Badge>
              </div>
            </Card>
            <Card title="Passwort ändern" icon="key-round" description="Zur Bestätigung brauchen Sie das aktuelle Passwort und einen Code aus der Authenticator-App. Alle anderen Sitzungen enden danach.">
              <form method="post" action="/account/password" class="stack">
                <UsernameHint email={me.email} />
                <Field label="Aktuelles Passwort" for="current"><input id="current" name="current" type="password" autocomplete="current-password" required /></Field>
                <div class="fields">
                  <Field label="Neues Passwort" for="password"><input id="password" name="password" type="password" autocomplete="new-password" required /></Field>
                  <Field label="Neues Passwort wiederholen" for="password_repeat"><input id="password_repeat" name="password_repeat" type="password" autocomplete="new-password" required /></Field>
                </div>
                <Field label="Code aus der Authenticator-App" for="code"><input id="code" class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required /></Field>
                <FormActions label="Passwort ändern" icon="key-round" />
              </form>
            </Card>
          </div>
          <Card title="Aktive Sitzungen" icon="monitor" description="Geräte, auf denen Sie gerade angemeldet sind." flush>
            <div class="table-wrap"><table>
              <thead><tr><th>Gerät</th><th>Zuletzt aktiv</th><th></th></tr></thead>
              <tbody>{sessions.map((s) => (
                <tr>
                  <td>
                    <span class="cell-title" title={s.user_agent || undefined}>{formatUserAgent(s.user_agent)}</span>
                    <span class="cell-sub">{s.ip} · seit {formatDate(s.created_at)}</span>
                  </td>
                  <td class="nowrap ops-time"><Ago at={s.last_seen_at} /></td>
                  <td class="right">{s.id === me.sessionId ? <Badge tone="ok" dot>diese Sitzung</Badge> : <ActionButton action={`/account/sessions/${s.id}/revoke`} label="Beenden" icon="log-out" small />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        </div>
      </OpsPage>,
    );
  });

  app.post("/account/password", async (c) => {
    const me = c.get("user");
    const f = await formData(c);
    const problem = passwordProblem(f.get("password"), f.get("password_repeat"));
    if (problem) return redirectWith(c, "/account", { kind: "bad", text: problem });
    const login = await first<any>(ops.sql`select password_hash, totp_secret_enc from users where id = ${me.id}`);
    const secret = login?.totp_secret_enc ? await decryptString(ops.config.secret, login.totp_secret_enc) : null;
    const ok = login?.password_hash && (await verifyPassword(f.get("current"), login.password_hash)) && secret && (await verifyTotp(secret, f.get("code")));
    if (!ok) {
      await audit(ops.sql, c, "account.password_failed", null);
      return redirectWith(c, "/account", { kind: "bad", text: "Aktuelles Passwort oder Code stimmt nicht." });
    }
    const hash = await hashPassword(f.get("password"));
    await ops.sql.begin(async (tx) => {
      await tx`update users set password_hash = ${hash} where id = ${me.id}`;
      await tx`update sessions set revoked_at = now() where user_id = ${me.id} and revoked_at is null and id <> ${me.sessionId}`;
    });
    await audit(ops.sql, c, "account.password_changed", null);
    return redirectWith(c, "/account", { kind: "ok", text: "Passwort geändert. Alle anderen Sitzungen wurden beendet." });
  });

  app.post("/account/sessions/:id/revoke", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await ops.sql`update sessions set revoked_at = now() where id = ${id} and user_id = ${c.get("user").id} and revoked_at is null returning id`;
    if (!rows.length) return c.notFound();
    await audit(ops.sql, c, "account.session_revoked", String(id));
    return redirectWith(c, "/account", { kind: "ok", text: "Sitzung beendet." });
  });
}
