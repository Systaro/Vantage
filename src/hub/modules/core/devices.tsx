/**
 * Trusted devices and the login history on "Mein Konto". A trusted device skips the code step at
 * login (shared/auth.tsx); here its owner sees where that is the case, names a device and removes it.
 * The history lists the logins and failed attempts on the owner's e-mail address from the audit log.
 */
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { deviceCookieName, TRUST_DAYS } from "../../../shared/auth";
import { sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Ago, Badge, Card, ConfirmAction, DialogButton, Empty, Field, formatDate, formatUserAgent, FormDialog } from "../../../shared/ui/components";
import { all, first, rls } from "../../db";
import { audit } from "../../ui";
import { SESSION_COOKIE } from "./account";

const HISTORY_ROWS = 15;
const MAX_NAME = 60;

interface DeviceRow {
  id: number;
  name: string | null;
  created_at: Date;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  last_used_at: Date | null;
  last_ip: string | null;
}

/** The token hash of this browser's trusted device, if it has one. */
function deviceHash(c: Context): string | null {
  const token = getCookie(c, deviceCookieName(SESSION_COOKIE));
  return token ? sha256Hex(token) : null;
}

const deviceLabel = (d: DeviceRow) => d.name ?? formatUserAgent(d.user_agent);

export async function TrustedDevicesCard(props: { c: Context }) {
  const me = props.c.get("user");
  const hash = deviceHash(props.c);
  const data = await rls(props.c, async (tx) => ({
    devices: await all<DeviceRow>(tx`select id, name, created_at, expires_at, ip, user_agent, last_used_at, last_ip from trusted_devices
      where user_id = ${me.id} and revoked_at is null and expires_at > now() order by coalesce(last_used_at, created_at) desc`),
    current: hash ? (await first<{ id: number | null }>(tx`select account_current_device(${hash}) as id`))?.id ?? null : null,
  }));
  return (
    <Card
      title="Gemerkte Geräte"
      icon="monitor-smartphone"
      description={`Auf diesen Geräten fragt Vantage bei der Anmeldung nur nach dem Passwort, nicht nach dem Code, jeweils ${TRUST_DAYS} Tage lang. Ein Gerät merken Sie sich beim Code mit „Diesem Gerät vertrauen“.`}
      flush={data.devices.length > 0}
    >
      {data.devices.length === 0 ? (
        <Empty title="Keine gemerkten Geräte" icon="monitor-smartphone">Bei jeder Anmeldung fragt Vantage nach dem Code aus der Authenticator-App.</Empty>
      ) : (
        <div class="table-wrap"><table>
          <thead><tr><th>Gerät</th><th>Zuletzt benutzt</th><th>Gilt bis</th><th></th></tr></thead>
          <tbody>{data.devices.map((d) => (
            <tr>
              <td>
                <span class="cell-title" title={d.user_agent ?? undefined}>{deviceLabel(d)}</span>
                <span class="cell-sub">{d.name && `${formatUserAgent(d.user_agent)} · `}gemerkt am {formatDate(d.created_at)}{d.ip && ` von ${d.ip}`}</span>
              </td>
              <td>{d.last_used_at ? <><Ago at={d.last_used_at} /><span class="cell-sub">{d.last_ip}</span></> : <span class="muted">noch nicht</span>}</td>
              <td class="nowrap">{formatDate(d.expires_at)}</td>
              <td class="right">
                <div class="btn-group">
                  {d.id === data.current && <Badge tone="ok">dieses Gerät</Badge>}
                  <DialogButton dialog={`device-${d.id}`} icon="pencil" class="small">Umbenennen</DialogButton>
                  <ConfirmAction
                    action={`/account/devices/${d.id}/revoke`}
                    label="Entfernen"
                    question={`„${deviceLabel(d)}“ entfernen? Dort fragt Vantage beim nächsten Mal wieder nach dem Code.`}
                  />
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data.devices.map((d) => (
        <FormDialog id={`device-${d.id}`} title="Gerät umbenennen" icon="pencil" action={`/account/devices/${d.id}`} submitLabel="Speichern">
          <Field label="Name" for={`device-${d.id}-name`} hint={`Leer lassen für „${formatUserAgent(d.user_agent)}“.`}>
            <input id={`device-${d.id}-name`} name="name" type="text" maxlength={MAX_NAME} value={d.name ?? ""} placeholder="z. B. Laptop Büro" />
          </Field>
        </FormDialog>
      ))}
    </Card>
  );
}

interface LoginRow {
  at: Date;
  action: "login.ok" | "login.failed" | "invite.accepted";
  detail: Record<string, unknown> | null;
  ip: string | null;
}

/** "Passwort + Code", "Cortex + gemerktes Gerät", "Code falsch": what the row's audit detail says. */
export function loginWay(action: LoginRow["action"], detail: Record<string, unknown> | null): string {
  const d = detail ?? {};
  if (action === "invite.accepted") return "Zugang eingerichtet";
  if (action === "login.failed") return d.step === "totp" ? "Code falsch" : "Passwort falsch";
  const first = d.method === "cortex" ? "Cortex" : "Passwort";
  const second = d.second_factor === "device" ? "gemerktes Gerät" : d.second_factor === "cortex" ? "Code in Cortex" : "Code";
  return `${first} + ${second}${d.trusted_device ? ", Gerät gemerkt" : ""}`;
}

export async function LoginHistoryCard(props: { c: Context }) {
  const rows = await rls(props.c, (tx) => all<LoginRow>(tx`select * from account_login_history(${HISTORY_ROWS})`));
  return (
    <Card
      title="Letzte Anmeldungen"
      icon="history"
      description="Anmeldungen und Fehlversuche mit Ihrer E-Mail-Adresse. Kennen Sie einen Eintrag nicht, ändern Sie Ihr Passwort und sagen Sie Systaro Bescheid."
      flush={rows.length > 0}
    >
      {rows.length === 0 ? (
        <Empty title="Noch keine Anmeldungen aufgezeichnet" icon="history">Ab der nächsten Anmeldung erscheint sie hier.</Empty>
      ) : (
        <div class="table-wrap"><table>
          <thead><tr><th>Zeitpunkt</th><th>Ergebnis</th><th>Gerät</th></tr></thead>
          <tbody>{rows.map((r) => {
            const ua = typeof r.detail?.user_agent === "string" ? r.detail.user_agent : null;
            return (
              <tr>
                <td class="nowrap"><span class="cell-title">{formatDate(r.at)}</span><span class="cell-sub"><Ago at={r.at} /></span></td>
                <td>
                  {r.action === "login.failed" ? <Badge tone="bad" icon="circle-x">Fehlgeschlagen</Badge> : <Badge tone="ok" icon="circle-check">Angemeldet</Badge>}
                  <span class="cell-sub">{loginWay(r.action, r.detail)}</span>
                </td>
                <td>
                  <span class="cell-title" title={ua ?? undefined}>{ua ? formatUserAgent(ua) : <span class="muted">nicht aufgezeichnet</span>}</span>
                  {r.ip && <span class="cell-sub">{r.ip}</span>}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
}

export function mountDevices(app: Hono) {
  app.post("/account/devices/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const name = (await formData(c)).get("name").trim();
    if (name.length > MAX_NAME) return redirectWith(c, "/account", { kind: "bad", text: `Der Name darf höchstens ${MAX_NAME} Zeichen haben.` });
    const rows = id ? await rls(c, (tx) => tx`update trusted_devices set name = ${name || null}
      where id = ${id} and user_id = ${c.get("user").id} and expires_at > now() returning id`) : [];
    if (!rows.length) return redirectWith(c, "/account", { kind: "bad", text: "Dieses Gerät ist nicht mehr gemerkt." });
    await audit(c, "account.device_renamed", String(id), { name: name || null });
    return redirectWith(c, "/account", { kind: "ok", text: "Gerät umbenannt." });
  });

  app.post("/account/devices/:id/revoke", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = id ? await rls(c, (tx) => tx`update trusted_devices set revoked_at = now() where id = ${id} and user_id = ${c.get("user").id} returning id`) : [];
    if (!rows.length) return c.notFound();
    await audit(c, "account.device_removed", String(id));
    return redirectWith(c, "/account", { kind: "ok", text: "Gerät entfernt. Dort fragt Vantage wieder nach dem Code." });
  });
}
