/**
 * /admin/integrations: where each external system is, how Vantage logs in, and whether that works.
 * Credentials are write-only here: the page shows that one is set (and for logins the user name),
 * never the value; leaving a credential field empty keeps the stored one.
 */
import type { Context, Hono } from "hono";
import { formData, redirectWith } from "../../../shared/http";
import { ActionButton, Ago, Badge, Card, ConfirmAction, DialogButton, Field, FormDialog } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { all, rls } from "../../db";
import { audit } from "../../ui";
import { AdminShell } from "../core/admin-shell";
import { cortexCallbackUrl } from "../cortex/routes";
import { checkIntegration } from "./checks";
import {
  buildSmtpUrl,
  caProblem,
  describeEsAuth,
  esAuthHeader,
  INTEGRATION_KINDS,
  INTEGRATIONS,
  isConfigured,
  isIntegrationKind,
  issuerProblem,
  parseSmtpUrl,
  senderProblem,
  SMTP_AUTH_METHODS,
  urlProblem,
  type IntegrationInfo,
  type IntegrationKind,
  type SmtpParts,
  type StoredIntegration,
} from "./kinds";
import { forgetIntegration, resolveIntegration, saveIntegration, sealSecret, type ResolvedIntegration } from "./store";

const BASE = "/admin/integrations";

interface StatusRow {
  kind: IntegrationKind;
  updated_at: Date;
  updated_by: string | null;
  checked_at: Date | null;
  check_ok: boolean | null;
  check_message: string | null;
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────────

function StatusBadge(props: { resolved: ResolvedIntegration; kind: IntegrationKind; status?: StatusRow }) {
  if (!isConfigured(props.kind, props.resolved.row)) return <Badge tone="idle">nicht eingerichtet</Badge>;
  if (props.resolved.source === "env") return <Badge tone="warn">aus app.env</Badge>;
  const s = props.status;
  if (!s?.checked_at) return <Badge tone="idle">noch nicht geprüft</Badge>;
  return s.check_ok ? <Badge tone="ok" dot>verbunden</Badge> : <Badge tone="bad" dot>Fehler</Badge>;
}

function Facts(props: { kind: IntegrationKind; row: StoredIntegration | null; status?: StatusRow; usage?: number }) {
  const { kind, row, status } = props;
  const type = INTEGRATIONS[kind].type;
  const smtp = type === "mail" ? parseSmtpUrl(row?.secret) : null;
  return (
    <dl class="facts">
      {type === "elasticsearch" && <>
        <dt>Adresse</dt><dd><code>{String(row?.config.url)}</code></dd>
        <dt>Anmeldung</dt><dd>{describeEsAuth(row?.secret)}</dd>
        <dt>Zertifikat</dt><dd>{row?.config.ca ? "eigene CA hinterlegt" : "öffentlich vertrauenswürdig"}</dd>
      </>}
      {type === "dependency_track" && <>
        <dt>API-Adresse</dt><dd><code>{String(row?.config.url)}</code></dd>
        <dt>Anmeldung</dt><dd>API-Key hinterlegt</dd>
      </>}
      {type === "semaphore" && <>
        <dt>Adresse</dt><dd><code>{String(row?.config.url)}</code></dd>
        <dt>Projekt</dt><dd>ID {String(row?.config.project_id)}</dd>
        <dt>Anmeldung</dt><dd>API-Token hinterlegt</dd>
      </>}
      {type === "oidc" && <>
        <dt>Cortex</dt><dd><code>{String(row?.config.issuer)}</code></dd>
        <dt>Client-ID</dt><dd><code>{String(row?.config.client_id)}</code></dd>
        <dt>Rückleitung</dt><dd><code>{cortexCallbackUrl()}</code></dd>
      </>}
      {smtp && <>
        <dt>Server</dt><dd><code>{smtp.host}:{smtp.port}</code></dd>
        <dt>Anmeldung</dt><dd>{smtp.user ? <>Benutzer <code>{smtp.user}</code>{smtp.authMethod && ` · ${smtp.authMethod}`}</> : "keine"}</dd>
        <dt>Verschlüsselung</dt><dd>{smtp.security === "tls" ? "TLS" : smtp.security === "starttls" ? "STARTTLS erzwungen" : <span class="status-warn">keine</span>}</dd>
        <dt>Absender</dt><dd>{String(row?.config.from ?? "")}</dd>
      </>}
      {props.usage !== undefined && <><dt>Genutzt von</dt><dd>{props.usage === 1 ? "1 Umgebung" : `${props.usage} Umgebungen`}</dd></>}
      {status?.checked_at && <>
        <dt>Geprüft</dt>
        <dd><Ago at={status.checked_at} />: <span class={status.check_ok ? "" : "status-bad"}>{status.check_message}</span></dd>
      </>}
      {status && <><dt>Geändert</dt><dd><Ago at={status.updated_at} />{status.updated_by && ` von ${status.updated_by}`}</dd></>}
    </dl>
  );
}

function EsFields(props: { kind: IntegrationKind; row: StoredIntegration | null }) {
  const id = (n: string) => `${props.kind}-${n}`;
  const hasSecret = !!props.row?.secret;
  return (
    <>
      <Field label="Adresse" for={id("url")} hint={props.kind === "wazuh" ? "z. B. https://wazuh.example.com/vantage-indexer" : "z. B. https://logs.example.de/es oder https://elasticsearch:9200"}>
        <input id={id("url")} name="url" type="url" required autocomplete="off" spellcheck={false} value={String(props.row?.config.url ?? "")} />
      </Field>
      <div class="auth-switch">
        <Field label="Anmeldung" for={id("auth")}>
          <select id={id("auth")} name="auth_mode">
            {hasSecret && <option value="keep" selected>Unverändert lassen ({describeEsAuth(props.row?.secret)})</option>}
            <option value="none">Keine</option>
            <option value="basic">Benutzer und Passwort</option>
            <option value="apikey">API-Key</option>
          </select>
        </Field>
        <div class="fields auth-basic">
          <Field label="Benutzer" for={id("user")}><input id={id("user")} name="user" type="text" autocomplete="off" spellcheck={false} /></Field>
          <Field label="Passwort" for={id("password")}><input id={id("password")} name="password" type="password" autocomplete="new-password" /></Field>
        </div>
        <div class="auth-apikey">
          <Field label="API-Key" for={id("apikey")} hint="Den „encoded“-Wert oder id:api_key, wie Elasticsearch ihn beim Anlegen zeigt.">
            <input id={id("apikey")} name="api_key" type="password" autocomplete="new-password" spellcheck={false} />
          </Field>
        </div>
      </div>
      <Field label="CA-Zertifikat (optional)" for={id("ca")} hint="Nur bei einem selbst signierten Zertifikat: die CA im PEM-Format. Leer lassen für öffentlich vertrauenswürdige Zertifikate.">
        <textarea id={id("ca")} name="ca" rows={4} spellcheck={false} placeholder="-----BEGIN CERTIFICATE-----">{String(props.row?.config.ca ?? "")}</textarea>
      </Field>
    </>
  );
}

function DependencyTrackFields(props: { row: StoredIntegration | null }) {
  return (
    <>
      <Field label="API-Adresse" for="dt-url" hint="Die Adresse des API-Servers, nicht die der Oberfläche, z. B. https://dependencytrack-api.example.com">
        <input id="dt-url" name="url" type="url" required autocomplete="off" spellcheck={false} value={String(props.row?.config.url ?? "")} />
      </Field>
      <Field label="API-Key" for="dt-key" hint={props.row?.secret ? "Leer lassen, um den hinterlegten Key zu behalten." : "Ein Team in Dependency-Track mit VIEW_PORTFOLIO und VIEW_VULNERABILITY, dessen API-Key."}>
        <input id="dt-key" name="api_key" type="password" autocomplete="new-password" spellcheck={false} {...(props.row?.secret ? {} : { required: true })} />
      </Field>
    </>
  );
}

function SemaphoreFields(props: { row: StoredIntegration | null }) {
  return (
    <>
      <div class="fields">
        <Field label="Adresse" for="sem-url" hint="Wie im Browser, ohne /api, z. B. https://semaphore.example.com">
          <input id="sem-url" name="url" type="url" required autocomplete="off" spellcheck={false} value={String(props.row?.config.url ?? "")} />
        </Field>
        <Field label="Projekt-ID" for="sem-project" hint="Die Zahl in /project/…/ der Semaphore-Adresse">
          <input id="sem-project" name="project_id" type="text" inputmode="numeric" required value={String(props.row?.config.project_id ?? "1")} />
        </Field>
      </div>
      <Field label="API-Token" for="sem-token" hint={props.row?.secret ? "Leer lassen, um das hinterlegte Token zu behalten." : "Token eines Semaphore-Benutzers, der im Projekt nur die Rolle Guest hat (docs/self-hosting.md)."}>
        <input id="sem-token" name="api_token" type="password" autocomplete="new-password" spellcheck={false} {...(props.row?.secret ? {} : { required: true })} />
      </Field>
    </>
  );
}

function MailFields(props: { row: StoredIntegration | null }) {
  const p = parseSmtpUrl(props.row?.secret);
  return (
    <>
      <div class="fields">
        <Field label="Server" for="mail-host"><input id="mail-host" name="host" type="text" required autocomplete="off" spellcheck={false} value={p?.host ?? ""} placeholder="mailrelay.example.de" /></Field>
        <Field label="Port" for="mail-port"><input id="mail-port" name="port" type="text" inputmode="numeric" required value={p?.port ?? "587"} /></Field>
      </div>
      <div class="fields">
        <Field label="Benutzer" for="mail-user"><input id="mail-user" name="user" type="text" autocomplete="off" spellcheck={false} value={p?.user ?? ""} /></Field>
        <Field label="Passwort" for="mail-password" hint={p?.password ? "Leer lassen, um das hinterlegte Passwort zu behalten." : undefined}>
          <input id="mail-password" name="password" type="password" autocomplete="new-password" />
        </Field>
      </div>
      <div class="fields">
        <Field label="Verschlüsselung" for="mail-security">
          <select id="mail-security" name="security">
            {([["starttls", "STARTTLS erzwingen"], ["tls", "TLS (smtps, meist Port 465)"], ["none", "Keine"]] as const).map(([v, l]) => (
              <option value={v} selected={(p?.security ?? "starttls") === v}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Anmeldeverfahren" for="mail-auth">
          <select id="mail-auth" name="auth_method">
            {SMTP_AUTH_METHODS.map((m) => <option value={m} selected={(p?.authMethod ?? "") === m}>{m || "Automatisch"}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Absender" for="mail-from" hint="z. B. Vantage <vantage@systaro.de>">
        <input id="mail-from" name="from" type="text" required autocomplete="off" value={String(props.row?.config.from ?? "")} />
      </Field>
    </>
  );
}

function CortexFields(props: { row: StoredIntegration | null }) {
  return (
    <>
      <Field label="Cortex-Adresse" for="cortex-issuer" hint="Der Aussteller, wie Cortex ihn meldet, ohne „/“ am Ende: https://cortex.example.com">
        <input id="cortex-issuer" name="issuer" type="url" required autocomplete="off" spellcheck={false} value={String(props.row?.config.issuer ?? "")} />
      </Field>
      <Field label="Client-ID" for="cortex-client" hint="Beginnt mit „sso_“. Ein Cortex-Admin legt den Client per API an (docs/self-hosting.md), mit dieser Rückleitungsadresse:">
        <input id="cortex-client" name="client_id" type="text" required autocomplete="off" spellcheck={false} value={String(props.row?.config.client_id ?? "")} />
      </Field>
      <p class="small"><code>{cortexCallbackUrl()}</code></p>
      <Field label="Client-Secret" for="cortex-secret" hint={props.row?.secret ? "Leer lassen, um das hinterlegte Secret zu behalten." : "Cortex zeigt es nur einmal, beim Anlegen des Clients."}>
        <input id="cortex-secret" name="client_secret" type="password" autocomplete="new-password" spellcheck={false} {...(props.row?.secret ? {} : { required: true })} />
      </Field>
    </>
  );
}

async function IntegrationsPage(c: Context) {
  const data = await rls(c, async (tx) => ({
    status: await all<StatusRow>(tx`
      select i.kind, i.updated_at, u.email as updated_by, i.checked_at, i.check_ok, i.check_message
      from integrations i left join users u on u.id = i.updated_by`),
    usage: await all<{ kind: string; n: number }>(tx`select kind, count(distinct environment_id)::int as n from environment_sources group by kind`),
  }));
  const resolved = Object.fromEntries(await Promise.all(INTEGRATION_KINDS.map(async (k) => [k, await resolveIntegration(k)] as const))) as Record<IntegrationKind, ResolvedIntegration>;
  const sourceKind: Partial<Record<IntegrationKind, string>> = { logs: "logs", apm: "apm", semaphore: "ansible" };
  const usage = (kind: IntegrationKind) => (sourceKind[kind] ? data.usage.find((u) => u.kind === sourceKind[kind])?.n ?? 0 : undefined);

  return c.html(
    <AdminShell c={c} tab="integrations" title="Integrationen">
      <div class="grid grid-2">
        {INTEGRATION_KINDS.map((kind) => {
          const info = INTEGRATIONS[kind];
          const r = resolved[kind];
          const status = data.status.find((s) => s.kind === kind);
          const configured = isConfigured(kind, r.row);
          return (
            <Card
              icon={info.icon}
              title={<h2 class="row">{info.label} <StatusBadge resolved={r} kind={kind} status={status} /></h2>}
              description={info.provides}
              actions={
                <>
                  <DialogButton dialog={`integration-${kind}`} icon={configured ? "pencil" : "plus"} class={configured ? "small" : "small primary"}>{configured ? "Ändern" : "Einrichten"}</DialogButton>
                  {configured && <ActionButton action={`${BASE}/${kind}/check`} label="Testen" small icon="refresh-cw" />}
                </>
              }
            >
              <div class="stack">
                {configured ? <Facts kind={kind} row={r.row} status={status} usage={usage(kind)} /> : <p class="muted small">Noch keine Verbindung hinterlegt.</p>}
                {r.source === "env" && <p class="status-warn small">Kommt noch aus den Umgebungsvariablen des Servers. Der Worker übernimmt sie beim nächsten Start; danach gilt nur noch, was hier steht.</p>}
                {configured && r.source === "vantage" && (
                  <div><ConfirmAction action={`${BASE}/${kind}/delete`} label="Entfernen" question={`Verbindung zu „${info.label}“ entfernen? Was daraus kommt, zeigt Vantage danach nicht mehr.`} /></div>
                )}
              </div>
              <FormDialog
                id={`integration-${kind}`}
                title={`${info.label} ${configured ? "ändern" : "einrichten"}`}
                description={info.provides}
                icon={info.icon}
                action={`${BASE}/${kind}`}
                submitLabel="Speichern und testen"
                wide
              >
                {info.type === "elasticsearch" && <EsFields kind={kind} row={r.row} />}
                {info.type === "dependency_track" && <DependencyTrackFields row={r.row} />}
                {info.type === "semaphore" && <SemaphoreFields row={r.row} />}
                {info.type === "mail" && <MailFields row={r.row} />}
                {info.type === "oidc" && <CortexFields row={r.row} />}
              </FormDialog>
            </Card>
          );
        })}
      </div>
    </AdminShell>,
  );
}

// ── Saving ────────────────────────────────────────────────────────────────────────────────────────

type Form = Awaited<ReturnType<typeof formData>>;
type Parsed = { config: Record<string, unknown>; secret: string | null } | { problem: string };

function parseEs(f: Form, current: StoredIntegration | null): Parsed {
  const url = f.get("url");
  const ca = f.get("ca");
  const problem = urlProblem(url, "Adresse") ?? caProblem(ca);
  if (problem) return { problem };
  const mode = f.get("auth_mode");
  if (mode === "keep" && current?.secret) return { config: ca ? { url, ca } : { url }, secret: current.secret };
  const auth = esAuthHeader({ mode, user: f.get("user"), password: f.get("password"), apiKey: f.get("api_key") });
  if (auth.problem) return { problem: auth.problem };
  return { config: ca ? { url, ca } : { url }, secret: auth.header };
}

function parseDependencyTrack(f: Form, current: StoredIntegration | null): Parsed {
  const url = f.get("url").replace(/\/+$/, "");
  const problem = urlProblem(url, "API-Adresse");
  if (problem) return { problem };
  if (/\/api(\/|$)/.test(new URL(url).pathname)) return { problem: "Die API-Adresse ohne „/api“ angeben; Vantage hängt den Pfad selbst an." };
  const key = f.get("api_key") || current?.secret || "";
  if (!key) return { problem: "API-Key fehlt." };
  if (!/^[A-Za-z0-9_-]{16,}$/.test(key)) return { problem: "Der API-Key hat ein unerwartetes Format." };
  return { config: { url }, secret: key };
}

function parseSemaphore(f: Form, current: StoredIntegration | null): Parsed {
  const url = f.get("url").replace(/\/+$/, "");
  const problem = urlProblem(url, "Adresse");
  if (problem) return { problem };
  if (/\/api(\/|$)/.test(new URL(url).pathname)) return { problem: "Die Adresse ohne „/api“ angeben; Vantage hängt den Pfad selbst an." };
  const projectId = Number(f.get("project_id"));
  if (!/^\d{1,7}$/.test(f.get("project_id")) || projectId < 1) return { problem: "Die Projekt-ID ist eine Zahl, z. B. 1." };
  const token = f.get("api_token") || current?.secret || "";
  if (!token) return { problem: "API-Token fehlt." };
  if (!/^[A-Za-z0-9_=+/-]{16,200}$/.test(token)) return { problem: "Das API-Token hat ein unerwartetes Format." };
  return { config: { url, project_id: projectId }, secret: token };
}

function parseMail(f: Form, current: StoredIntegration | null): Parsed {
  const host = f.get("host");
  const port = f.get("port");
  const user = f.get("user");
  const security = f.get("security");
  const authMethod = f.get("auth_method");
  const from = f.get("from");
  if (!/^[a-z0-9.-]+$/i.test(host)) return { problem: "Server: nur der Hostname, z. B. mailrelay.example.de." };
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { problem: "Port muss eine Zahl zwischen 1 und 65535 sein." };
  if (!["none", "starttls", "tls"].includes(security)) return { problem: "Unbekannte Verschlüsselung." };
  if (!SMTP_AUTH_METHODS.includes(authMethod)) return { problem: "Unbekanntes Anmeldeverfahren." };
  const senderIssue = senderProblem(from);
  if (senderIssue) return { problem: senderIssue };
  const previous = parseSmtpUrl(current?.secret);
  const password = f.get("password") || (previous && previous.user === user ? previous.password : "");
  if (user && !password) return { problem: "Passwort fehlt." };
  return { config: { from }, secret: buildSmtpUrl({ host, port, user, password, security: security as SmtpParts["security"], authMethod }) };
}

function parseCortex(f: Form, current: StoredIntegration | null): Parsed {
  const issuer = f.get("issuer");
  const clientId = f.get("client_id");
  const problem = issuerProblem(issuer);
  if (problem) return { problem };
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(clientId)) return { problem: "Die Client-ID hat ein unerwartetes Format." };
  const secret = f.get("client_secret") || current?.secret || "";
  if (!secret) return { problem: "Client-Secret fehlt." };
  if (secret.length > 500 || /\s/.test(secret)) return { problem: "Das Client-Secret hat ein unerwartetes Format." };
  return { config: { issuer, client_id: clientId }, secret };
}

const PARSERS: Record<IntegrationInfo["type"], (f: Form, current: StoredIntegration | null) => Parsed> = {
  elasticsearch: parseEs,
  dependency_track: parseDependencyTrack,
  semaphore: parseSemaphore,
  mail: parseMail,
  oidc: parseCortex,
};

export function mountIntegrations(app: Hono) {
  app.get(BASE, (c) => IntegrationsPage(c));

  app.post(`${BASE}/:kind`, async (c) => {
    const kind = c.req.param("kind");
    if (!isIntegrationKind(kind)) return c.notFound();
    const current = (await resolveIntegration(kind)).row;
    const f = await formData(c);
    const parsed = PARSERS[INTEGRATIONS[kind].type](f, current);
    if ("problem" in parsed) return redirectWith(c, BASE, { kind: "bad", text: parsed.problem });

    const secretEnc = await sealSecret(hubConfig.secret, parsed.secret);
    await rls(c, (tx) => saveIntegration(tx, kind, parsed.config, secretEnc, c.get("user").id));
    await audit(c, "integration.saved", kind, { url: parsed.config.url ?? parsed.config.issuer ?? null, credential: parsed.secret !== null });

    const result = await checkIntegration(kind);
    await rls(c, (tx) => tx`update integrations set checked_at = now(), check_ok = ${result.ok}, check_message = ${result.message} where kind = ${kind}`);
    return redirectWith(c, BASE, result.ok
      ? { kind: "ok", text: `Gespeichert. ${result.message}` }
      : { kind: "info", text: `Gespeichert, aber die Verbindung klappt noch nicht: ${result.message}` });
  });

  app.post(`${BASE}/:kind/check`, async (c) => {
    const kind = c.req.param("kind");
    if (!isIntegrationKind(kind)) return c.notFound();
    const result = await checkIntegration(kind);
    await rls(c, (tx) => tx`update integrations set checked_at = now(), check_ok = ${result.ok}, check_message = ${result.message} where kind = ${kind}`);
    return redirectWith(c, BASE, { kind: result.ok ? "ok" : "bad", text: result.message });
  });

  app.post(`${BASE}/:kind/delete`, async (c) => {
    const kind = c.req.param("kind");
    if (!isIntegrationKind(kind)) return c.notFound();
    // An emptied row, not a deleted one: environment variables must not take over again.
    await rls(c, (tx) => tx`
      update integrations set config = '{}'::jsonb, secret_enc = null, updated_at = now(), updated_by = ${c.get("user").id},
        checked_at = null, check_ok = null, check_message = null
      where kind = ${kind}`);
    forgetIntegration(kind);
    await audit(c, "integration.removed", kind);
    return redirectWith(c, BASE, { kind: "ok", text: `Verbindung zu „${INTEGRATIONS[kind].label}“ entfernt.` });
  });
}
