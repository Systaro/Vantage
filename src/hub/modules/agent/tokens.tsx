/**
 * Personal API tokens on "Mein Konto": create (shown once, with the MCP and curl setup), list,
 * revoke. Every user manages their own; the token acts with exactly that user's grants.
 */
import type { Context, Hono } from "hono";
import { newToken, sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { Ago, Card, ConfirmAction, DialogButton, Empty, Field, formatDate, FormDialog, SecretBox } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { all, rls } from "../../db";
import { audit } from "../../ui";

const VALIDITY: Record<string, { label: string; days: number | null }> = {
  "30": { label: "30 Tage", days: 30 },
  "90": { label: "90 Tage", days: 90 },
  "365": { label: "1 Jahr", days: 365 },
  never: { label: "unbegrenzt", days: null },
};

export async function ApiTokensCard(props: { c: Context }) {
  const me = props.c.get("user");
  const tokens = await rls(props.c, (tx) => all<any>(tx`
    select id, name, token_prefix, created_at, expires_at, last_used_at from api_tokens
    where user_id = ${me.id} and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at desc`));
  const add = (primary: boolean) => <DialogButton dialog="new-api-token" icon="plus" class={primary ? "primary" : "small"}>Token anlegen</DialogButton>;
  return (
    <Card
      title="API-Zugänge für Agenten"
      icon="terminal"
      description="Ein Token lässt ein Programm oder einen KI-Agenten (MCP) mit Ihren Rechten lesen: dieselben Umgebungen, dieselbe Stufe, nichts darüber hinaus."
      actions={tokens.length > 0 && add(false)}
      flush={tokens.length > 0}
    >
      {tokens.length === 0 ? (
        <Empty title="Keine Tokens" icon="key-round" action={add(true)}>Zum Beispiel für Claude Code oder ein Skript, das den Zustand Ihrer Umgebungen abfragt.</Empty>
      ) : (
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Zuletzt benutzt</th><th>Läuft ab</th><th></th></tr></thead>
          <tbody>{tokens.map((t) => (
            <tr>
              <td><span class="cell-title">{t.name}</span><span class="cell-sub mono">{t.token_prefix}… · angelegt {formatDate(t.created_at)}</span></td>
              <td>{t.last_used_at ? <Ago at={t.last_used_at} /> : <span class="muted">nie</span>}</td>
              <td>{t.expires_at ? formatDate(t.expires_at) : "nie"}</td>
              <td class="right"><ConfirmAction action={`/account/api-tokens/${t.id}/revoke`} label="Widerrufen" question={`„${t.name}“ widerrufen? Programme mit diesem Token verlieren sofort den Zugang.`} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <FormDialog id="new-api-token" title="API-Token anlegen" description="Der Token wird nur einmal angezeigt. Er liest mit Ihren Rechten, solange Ihr Konto aktiv ist." icon="key-round" action="/account/api-tokens" submitLabel="Token anlegen">
        <Field label="Name" for="token-name" hint="Wofür, z. B. „Claude Code Laptop“"><input id="token-name" name="name" type="text" required maxlength={100} /></Field>
        <Field label="Gültig" for="token-validity">
          <select id="token-validity" name="validity">{Object.entries(VALIDITY).map(([k, v]) => <option value={k} selected={k === "90"}>{v.label}</option>)}</select>
        </Field>
      </FormDialog>
    </Card>
  );
}

function TokenStep(props: { token: string }) {
  const base = hubConfig.publicUrl.replace(/\/+$/, "");
  return (
    <>
      <p>Der Token wird nur jetzt angezeigt. Er gehört in die Konfiguration des Agenten, nicht in ein Repository.</p>
      <SecretBox id="api-token" value={props.token} />
      <p class="small">Als MCP-Server in Claude Code:</p>
      <SecretBox id="api-token-mcp" value={`claude mcp add --transport http vantage ${base}/api/mcp --header "Authorization: Bearer ${props.token}"`} />
      <p class="muted small">Oder direkt: <code>curl -H "Authorization: Bearer …" {base}/api/v1/environments</code></p>
    </>
  );
}

export function mountApiTokens(app: Hono) {
  app.post("/account/api-tokens", async (c) => {
    const f = await formData(c);
    const name = f.get("name");
    if (!name || name.length > 100) return redirectWith(c, "/account", { kind: "bad", text: "Der Name fehlt oder ist zu lang." });
    const validity = VALIDITY[f.get("validity")] ?? VALIDITY["90"]!;
    const token = newToken("vpat");
    const expires = validity.days ? new Date(Date.now() + validity.days * 86_400_000) : null;
    const me = c.get("user");
    await rls(c, (tx) => tx`insert into api_tokens (user_id, name, token_hash, token_prefix, expires_at)
                             values (${me.id}, ${name}, ${sha256Hex(token)}, ${token.slice(0, 9)}, ${expires})`);
    await audit(c, "api_token.created", name, { expires_at: expires?.toISOString() ?? null });
    return showDialogStep(c, { title: `„${name}“ angelegt`, icon: "key-round", body: <TokenStep token={token} /> });
  });

  app.post("/account/api-tokens/:id/revoke", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = id ? await rls(c, (tx) => tx`update api_tokens set revoked_at = now() where id = ${id} and revoked_at is null returning name`) : [];
    if (!rows.length) return c.notFound();
    await audit(c, "api_token.revoked", (rows[0] as { name: string }).name);
    return redirectWith(c, "/account", { kind: "ok", text: "Token widerrufen." });
  });
}
