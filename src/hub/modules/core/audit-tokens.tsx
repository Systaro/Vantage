import type { Hono } from "hono";
import { newToken, sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { Ago, Badge, Card, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, SecretBox } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { all, first, rls } from "../../db";
import { audit } from "../../ui";
import { AdminShell, nameProblem } from "./admin-shell";

const PAGE = 100;

export function mountAuditAndTokens(app: Hono) {
  app.get("/admin/audit", async (c) => {
    const before = parseId(c.req.query("before"));
    const action = (c.req.query("action") ?? "").slice(0, 60);
    const rows = await rls(c, (tx) => all<any>(tx`
      select id, at, actor_label, action, target, detail, ip from audit_log
      where (${before}::bigint is null or id < ${before}::bigint)
        and (${action} = '' or action like ${action + "%"})
      order by id desc limit ${PAGE}`));
    const last = rows.at(-1);
    return c.html(
      <AdminShell c={c} tab="audit" title="Protokoll">
        <Card flush title={
          <form method="get" action="/admin/audit" class="search-row" role="search">
            <input type="search" name="action" value={action} placeholder="Aktion, z. B. login. oder grant." aria-label="Nach Aktion filtern" />
            <button class="btn" type="submit"><Icon name="filter" size="sm" />Filtern</button>
          </form>
        }>
          {rows.length === 0 ? <Empty title="Keine Einträge" /> : (
            <div class="table-wrap"><table>
              <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Ziel</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr>
                  <td class="nowrap small">{formatDate(r.at)}</td>
                  <td class="small">{r.actor_label ?? "–"}</td>
                  <td><code>{r.action}</code></td>
                  <td class="small">{r.target}</td>
                  <td class="small mono audit-detail">{Object.keys(r.detail ?? {}).length ? JSON.stringify(r.detail) : ""}</td>
                  <td class="small">{r.ip}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        {rows.length === PAGE && last && (
          <p><a class="btn" href={`/admin/audit?before=${last.id}${action ? `&action=${encodeURIComponent(action)}` : ""}`}>Ältere Einträge</a></p>
        )}
      </AdminShell>,
    );
  });

  app.get("/admin/tokens", async (c) => {
    const tokens = await rls(c, (tx) => all<any>(tx`select id, name, purpose, token_prefix, created_at, last_used_at, revoked_at from machine_tokens order by revoked_at nulls first, created_at desc`));
    return c.html(<TokensPage c={c} tokens={tokens} />);
  });

  app.post("/admin/tokens", async (c) => {
    const f = await formData(c);
    const problem = nameProblem(f.get("name"));
    if (problem) return redirectWith(c, "/admin/tokens", { kind: "bad", text: problem });
    const token = newToken("vop");
    await rls(c, (tx) => first(tx`
      insert into machine_tokens (name, purpose, token_hash, token_prefix, created_by)
      values (${f.get("name")}, 'ops-events', ${sha256Hex(token)}, ${token.slice(0, 10)}, ${c.get("user").id}) returning id`));
    await audit(c, "machine_token.created", f.get("name"));
    return showDialogStep(c, {
      title: `Token „${f.get("name")}“ erzeugt`,
      icon: "key-round",
      body: (
        <>
          <p>In die Ops-Konfiguration als <code>OPS_HUB_EVENT_TOKEN</code> eintragen. Es wird nur jetzt angezeigt.</p>
          <SecretBox id="machine-token" value={token} />
        </>
      ),
    });
  });

  app.post("/admin/tokens/:id/revoke", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await rls(c, (tx) => tx`update machine_tokens set revoked_at = now() where id = ${id} and revoked_at is null returning name`);
    if (!rows.length) return c.notFound();
    await audit(c, "machine_token.revoked", (rows[0] as any).name);
    return redirectWith(c, "/admin/tokens", { kind: "ok", text: "Token widerrufen." });
  });
}

function TokensPage(props: { c: any; tokens: any[] }) {
  const newButton = <DialogButton dialog="new-token" icon="plus" class="primary">Token anlegen</DialogButton>;
  return (
    <AdminShell c={props.c} tab="tokens" title="Maschinen-Tokens" actions={newButton}>
      <div class="stack">
        <Card flush title="Tokens" description="Ops meldet Host-Prüfungen und fehlgeschlagene Ansible-Läufe mit einem solchen Token an den Hub. Es darf nur Ereignisse schreiben, nichts lesen.">
          {props.tokens.length === 0 ? <Empty title="Keine Tokens" icon="key-round" action={newButton} /> : (
            <div class="table-wrap"><table>
              <thead><tr><th>Name</th><th>Präfix</th><th>Angelegt</th><th>Zuletzt benutzt</th><th>Status</th><th></th></tr></thead>
              <tbody>{props.tokens.map((t) => (
                <tr>
                  <td>{t.name}</td>
                  <td class="mono small">{t.token_prefix}…</td>
                  <td class="small">{formatDate(t.created_at)}</td>
                  <td><Ago at={t.last_used_at} /></td>
                  <td>{t.revoked_at ? <Badge tone="bad">widerrufen</Badge> : <Badge tone="ok">aktiv</Badge>}</td>
                  <td class="right">{!t.revoked_at && <ConfirmAction action={`/admin/tokens/${t.id}/revoke`} label="Widerrufen" question="Token widerrufen?" />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
      <FormDialog id="new-token" title="Token für Ops-Ereignisse anlegen" description="Das Token wird nach dem Anlegen einmal angezeigt und danach nur noch als Hash gespeichert." icon="key-round" action="/admin/tokens" submitLabel="Token erzeugen">
        <Field label="Name" for="token-name" hint="Wofür das Token ist, z. B. der Ops-Server."><input id="token-name" name="name" type="text" required placeholder="ops.example.com" /></Field>
      </FormDialog>
    </AdminShell>
  );
}
