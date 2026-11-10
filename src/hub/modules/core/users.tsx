import type { Context, Hono } from "hono";
import { newToken, sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { ActionButton, Ago, Badge, Card, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, SecretBox } from "../../../shared/ui/components";
import { initials } from "../../../shared/ui/layout";
import { hubConfig } from "../../config";
import { all, first, rls } from "../../db";
import { audit } from "../../ui";
import { sendMail } from "../alerts/channels";
import { renderInviteMail } from "../alerts/mail";
import { CortexLinkAdmin } from "../cortex/routes";
import { mailConnection } from "../integrations/store";
import { AdminShell, dbProblem, emailProblem, nameProblem } from "./admin-shell";

const INVITE_HOURS = 72;

interface Invite {
  link: string;
  expiresAt: Date;
  /** null: not asked to send it; true: sent; a string: why sending failed. */
  mailed: true | string | null;
}

/** A new invite link; it replaces every open one of the account, so only the newest works. */
async function issueInvite(c: Context, userId: number): Promise<Omit<Invite, "mailed">> {
  const token = newToken("vi");
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000);
  await rls(c, (tx) => tx`select admin_issue_invite(${userId}, ${sha256Hex(token)}, ${expiresAt})`);
  return { link: `${hubConfig.publicUrl}/invite/${token}`, expiresAt };
}

/** Sends the invite through the mail relay; true, or the reason it did not go out. */
async function mailInvite(c: Context, to: { name: string; email: string }, invite: Omit<Invite, "mailed">): Promise<true | string> {
  const mail = await mailConnection();
  if (!mail) return "Der E-Mail-Versand ist nicht eingerichtet (Verwaltung › Integrationen).";
  try {
    const msg = await renderInviteMail({ name: to.name, email: to.email, link: invite.link, expiresAt: invite.expiresAt, invitedBy: c.get("user").name, publicUrl: hubConfig.publicUrl });
    await sendMail(mail, { to: [to.email], ...msg });
  } catch (err) {
    return `Die E-Mail ließ sich nicht senden: ${(err as Error).message}`.slice(0, 300);
  }
  await audit(c, "user.invite_mailed", to.email);
  return true;
}

function InviteLink(props: { email: string; invite: Invite }) {
  const { mailed } = props.invite;
  return (
    <>
      {mailed === true ? (
        <p>Die Einladung ist per E-Mail an <strong>{props.email}</strong> unterwegs. Der Link darin ist {INVITE_HOURS} Stunden gültig und nur einmal benutzbar. Kommt die E-Mail nicht an, geben Sie ihn selbst weiter:</p>
      ) : (
        <>
          {typeof mailed === "string" && <p class="status-warn">{mailed}</p>}
          <p>Diesen Link geben Sie <strong>{props.email}</strong> auf einem vertraulichen Weg weiter. Er ist {INVITE_HOURS} Stunden gültig, nur einmal benutzbar und wird nicht noch einmal angezeigt.</p>
        </>
      )}
      <SecretBox id="invite-link" value={props.invite.link} />
    </>
  );
}

/** Grant levels, cumulative: each includes everything of the ones before it (vantage_level 1–3). */
export const GRANT_LEVELS = {
  overview: { label: "Überblick", tone: "info", text: "Überblick (Uptime, Tests, Vorfälle)" },
  diagnostics: { label: "Diagnose", tone: "warn", text: "Diagnose (zusätzlich Fehler, Logs, APM)" },
  security: { label: "Sicherheit", tone: "bad", text: "Sicherheit (zusätzlich Schwachstellen und Sicherheitslage)" },
} as const;
export type GrantLevel = keyof typeof GRANT_LEVELS;

export function parseGrantLevel(value: string): GrantLevel {
  return value in GRANT_LEVELS ? (value as GrantLevel) : "overview";
}

export function GrantLevelBadge(props: { level: string }) {
  const l = GRANT_LEVELS[parseGrantLevel(props.level)];
  return <Badge tone={l.tone}>{l.label}</Badge>;
}

function LevelSelect(props: { value?: string; name?: string; id: string }) {
  return (
    <select name={props.name ?? "level"} id={props.id}>
      {Object.entries(GRANT_LEVELS).map(([value, l]) => <option value={value} selected={(props.value ?? "overview") === value}>{l.text}</option>)}
    </select>
  );
}

export function mountUsers(app: Hono) {
  app.get("/admin/users", async (c) => {
    const users = await rls(c, (tx) => all<any>(tx`
      select u.id, u.email, u.name, u.kind, u.is_admin, u.disabled_at, u.last_login_at, u.created_at,
        (select count(*)::int from grants g where g.user_id = u.id) as grants,
        exists (select 1 from invites i where i.user_id = u.id and i.used_at is null and i.expires_at > now()) as invite_open,
        a.set_up
      from users u left join admin_user_access() a on a.user_id = u.id
      order by u.disabled_at nulls first, u.kind desc, u.name`));
    const mailReady = (await mailConnection()) !== null;
    return c.html(
      <AdminShell c={c} tab="users" title="Benutzer & Freigaben" actions={<DialogButton dialog="new-user" icon="user-plus" class="primary">Benutzer anlegen</DialogButton>}>
        <Card flush>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Benutzer</th><th>Art</th><th class="num">Freigaben</th><th>Zuletzt angemeldet</th><th>Status</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr>
                    <td>
                      <a class="user-cell" href={`/admin/users/${u.id}`}>
                        <span class="avatar sm">{initials(u.name)}</span>
                        <span>
                          <span class="cell-title">{u.name}</span> {u.is_admin && <Badge tone="accent">Admin</Badge>}
                          <span class="cell-sub">{u.email}</span>
                        </span>
                      </a>
                    </td>
                    <td>{u.kind === "staff" ? "Systaro" : "Kunde"}</td>
                    <td class="num">{u.is_admin ? "alle" : u.grants}</td>
                    <td><Ago at={u.last_login_at} /></td>
                    <td><AccessBadge user={u} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <FormDialog id="new-user" title="Benutzer anlegen" description={`Die Person bekommt einen Einladungslink (${INVITE_HOURS} h gültig) und setzt darüber Passwort und Authenticator-App selbst.`} icon="user-plus" action="/admin/users" submitLabel="Anlegen und einladen">
          <div class="fields">
            <Field label="Name" for="new-user-name"><input id="new-user-name" name="name" type="text" required /></Field>
            <Field label="E-Mail" for="new-user-email"><input id="new-user-email" name="email" type="email" required autocomplete="off" /></Field>
            <Field label="Art" for="new-user-kind">
              <select id="new-user-kind" name="kind"><option value="customer">Kunde</option><option value="staff">Systaro</option></select>
            </Field>
          </div>
          <label class="check"><input type="checkbox" name="is_admin" value="1" /> Administrator (sieht alles, vergibt Freigaben)</label>
          <div>
            <label class="check"><input type="checkbox" name="send_mail" value="1" checked={mailReady} disabled={!mailReady} /> Einladung per E-Mail schicken</label>
            <p class="muted small">{mailReady ? "Den Link sehen Sie danach trotzdem, falls die E-Mail nicht ankommt." : "Der E-Mail-Versand ist nicht eingerichtet (Integrationen). Sie bekommen den Link zum Weitergeben."}</p>
          </div>
        </FormDialog>
      </AdminShell>,
    );
  });

  app.post("/admin/users", async (c) => {
    const f = await formData(c);
    const email = f.get("email").toLowerCase();
    const problem = nameProblem(f.get("name")) ?? emailProblem(email);
    if (problem) return redirectWith(c, "/admin/users", { kind: "bad", text: problem });
    const kind = f.get("kind") === "staff" ? "staff" : "customer";
    const isAdmin = f.get("is_admin") === "1";
    let id: number;
    try {
      const row = await rls(c, (tx) => first<{ id: number }>(tx`
        insert into users (email, name, kind, is_admin, created_by) values (${email}, ${f.get("name")}, ${kind}, ${isAdmin}, ${c.get("user").id})
        returning id`));
      id = row!.id;
    } catch (err) {
      return redirectWith(c, "/admin/users", { kind: "bad", text: dbProblem(err, "Diese E-Mail-Adresse hat schon einen Zugang.") });
    }
    const issued = await issueInvite(c, id);
    await audit(c, "user.created", email, { kind, is_admin: isAdmin });
    const mailed = f.get("send_mail") === "1" ? await mailInvite(c, { name: f.get("name"), email }, issued) : null;
    return showDialogStep(c, {
      title: `„${f.get("name")}“ angelegt`,
      icon: "user-plus",
      next: { href: `/admin/users/${id}`, label: isAdmin ? "Zum Benutzer" : "Weiter zu den Freigaben" },
      body: <InviteLink email={email} invite={{ ...issued, mailed }} />,
    });
  });

  app.get("/admin/users/:id", async (c) => userPage(c, parseId(c.req.param("id")) ?? 0, null));

  app.get("/admin/users/:id/grant-envs", async (c) => {
    const projectId = parseId(c.req.query("project_id"));
    const envs = projectId ? await rls(c, (tx) => all<any>(tx`select id, name from environments where project_id = ${projectId} order by sort_order, name`)) : [];
    return c.html(<EnvChoice envs={envs} selected={[]} all={true} />);
  });

  app.post("/admin/users/:id/grants", async (c) => {
    const userId = parseId(c.req.param("id"));
    const f = await formData(c);
    const projectId = parseId(f.get("project_id"));
    if (!userId || !projectId) return redirectWith(c, `/admin/users/${userId}`, { kind: "bad", text: "Projekt fehlt." });
    const level = parseGrantLevel(f.get("level"));
    const allEnvs = f.get("scope") !== "some";
    const envIds = f.all("environment_id").map((v) => parseId(v)).filter((v): v is number => v !== null);
    const expires = f.get("expires_at") ? new Date(f.get("expires_at")) : null;
    if (!allEnvs && envIds.length === 0) return redirectWith(c, `/admin/users/${userId}`, { kind: "bad", text: "Bitte mindestens eine Umgebung wählen oder „alle Umgebungen“." });
    await rls(c, async (tx) => {
      const grant = await first<{ id: number }>(tx`
        insert into grants (user_id, project_id, level, all_environments, expires_at, note, created_by)
        values (${userId}, ${projectId}, ${level}, ${allEnvs}, ${expires}, ${f.get("note") || null}, ${c.get("user").id})
        on conflict (user_id, project_id) do update
          set level = excluded.level, all_environments = excluded.all_environments, expires_at = excluded.expires_at, note = excluded.note
        returning id`);
      await tx`delete from grant_environments where grant_id = ${grant!.id}`;
      if (!allEnvs) for (const envId of envIds) await tx`insert into grant_environments (grant_id, environment_id) values (${grant!.id}, ${envId})`;
    });
    await audit(c, "grant.set", String(userId), { project_id: projectId, level, all_environments: allEnvs, environments: envIds });
    return redirectWith(c, `/admin/users/${userId}`, { kind: "ok", text: "Freigabe gespeichert." });
  });

  app.post("/admin/users/:id/grants/organisation", async (c) => {
    const userId = parseId(c.req.param("id"));
    const f = await formData(c);
    const orgId = parseId(f.get("organisation_id"));
    const level = parseGrantLevel(f.get("level"));
    if (!userId || !orgId) return redirectWith(c, `/admin/users/${userId}`, { kind: "bad", text: "Organisation fehlt." });
    const count = await rls(c, async (tx) => {
      const rows = await tx`
        insert into grants (user_id, project_id, level, all_environments, created_by)
        select ${userId}, p.id, ${level}, true, ${c.get("user").id} from projects p where p.organisation_id = ${orgId}
        on conflict (user_id, project_id) do update set level = excluded.level, all_environments = true
        returning id`;
      await tx`delete from grant_environments where grant_id in (select id from grants where user_id = ${userId}
               and project_id in (select id from projects where organisation_id = ${orgId}))`;
      return rows.length;
    });
    await audit(c, "grant.organisation", String(userId), { organisation_id: orgId, level, projects: count });
    return redirectWith(c, `/admin/users/${userId}`, { kind: "ok", text: `${count} Projekt-Freigabe${count === 1 ? "" : "n"} gesetzt. Neue Projekte der Organisation kommen nicht automatisch dazu.` });
  });

  app.post("/admin/users/:id/grants/:grantId/delete", async (c) => {
    const userId = parseId(c.req.param("id"));
    const grantId = parseId(c.req.param("grantId"));
    const rows = await rls(c, (tx) => tx`delete from grants where id = ${grantId} and user_id = ${userId} returning project_id`);
    if (!rows.length) return c.notFound();
    await audit(c, "grant.removed", String(userId), { project_id: (rows[0] as any).project_id });
    return redirectWith(c, `/admin/users/${userId}`, { kind: "ok", text: "Freigabe entfernt." });
  });

  app.post("/admin/users/:id/update", async (c) => {
    const userId = parseId(c.req.param("id"));
    if (!userId) return c.notFound();
    const back = `/admin/users/${userId}`;
    const f = await formData(c);
    const current = await rls(c, (tx) => first<{ email: string }>(tx`select email from users where id = ${userId}`));
    if (!current) return c.notFound();
    // The field is only rendered while the address can still be corrected; admin_correct_email checks again.
    const email = f.has("email") ? f.get("email").toLowerCase() : current.email;
    const problem = nameProblem(f.get("name")) ?? emailProblem(email);
    if (problem) return redirectWith(c, back, { kind: "bad", text: problem });
    const isAdmin = f.get("is_admin") === "1";
    if (userId === c.get("user").id && !isAdmin) {
      return redirectWith(c, back, { kind: "bad", text: "Sie können sich die Administratorrechte nicht selbst entziehen." });
    }
    const kind = f.get("kind") === "staff" ? "staff" : "customer";
    const emailChanged = email !== current.email;
    try {
      await rls(c, async (tx) => {
        if (emailChanged) await tx`select admin_correct_email(${userId}, ${email})`;
        await tx`update users set name = ${f.get("name")}, kind = ${kind}, is_admin = ${isAdmin} where id = ${userId}`;
      });
    } catch (err) {
      if ((err as Error).message?.includes("already in use")) {
        return redirectWith(c, back, { kind: "bad", text: "Die E-Mail-Adresse lässt sich nicht mehr ändern: Die Person hat sich schon angemeldet." });
      }
      return redirectWith(c, back, { kind: "bad", text: dbProblem(err, "Diese E-Mail-Adresse hat schon einen Zugang.") });
    }
    if (emailChanged) await audit(c, "user.email_corrected", String(userId), { from: current.email, to: email });
    await audit(c, "user.updated", String(userId), { kind, is_admin: isAdmin });
    return redirectWith(c, back, emailChanged
      ? { kind: "ok", text: `Gespeichert. Die Einladung an ${current.email} gilt nicht mehr; schicken Sie eine neue an ${email}.` }
      : { kind: "ok", text: "Gespeichert." });
  });

  app.post("/admin/users/:id/reset", async (c) => {
    const userId = parseId(c.req.param("id"));
    if (!userId) return c.notFound();
    const f = await formData(c);
    const target = await rls(c, (tx) => first<{ name: string; email: string }>(tx`select name, email from users where id = ${userId}`));
    if (!target) return c.notFound();
    await rls(c, (tx) => tx`select admin_reset_user(${userId})`);
    const issued = await issueInvite(c, userId);
    await audit(c, "user.reset", String(userId));
    const mailed = f.get("mail") === "1" ? await mailInvite(c, target, issued) : null;
    return userPage(c, userId, { ...issued, mailed });
  });

  // A new invite for an account that is not set up yet (the old link expired, or the mail got lost).
  app.post("/admin/users/:id/invite", async (c) => {
    const userId = parseId(c.req.param("id"));
    if (!userId) return c.notFound();
    const f = await formData(c);
    const target = await rls(c, (tx) => first<{ name: string; email: string; disabled_at: Date | null; set_up: boolean }>(tx`
      select u.name, u.email, u.disabled_at, a.set_up from users u join admin_user_access() a on a.user_id = u.id where u.id = ${userId}`));
    if (!target) return c.notFound();
    const back = `/admin/users/${userId}`;
    if (target.disabled_at) return redirectWith(c, back, { kind: "bad", text: "Der Zugang ist gesperrt. Erst entsperren, dann einladen." });
    if (target.set_up) return redirectWith(c, back, { kind: "bad", text: "Dieser Zugang ist schon eingerichtet. Für ein neues Passwort: Zugang zurücksetzen." });
    const issued = await issueInvite(c, userId);
    await audit(c, "user.invite_issued", String(userId));
    const mailed = f.get("mail") === "1" ? await mailInvite(c, target, issued) : null;
    if (mailed === true) return redirectWith(c, back, { kind: "ok", text: `Einladung an ${target.email} geschickt. Ältere Links gelten nicht mehr.` });
    return userPage(c, userId, { ...issued, mailed });
  });

  app.post("/admin/users/:id/disable", async (c) => {
    const userId = parseId(c.req.param("id"));
    const f = await formData(c);
    const disable = f.get("disabled") === "1";
    try {
      await rls(c, (tx) => tx`select admin_set_disabled(${userId}, ${disable})`);
    } catch (err) {
      return redirectWith(c, `/admin/users/${userId}`, { kind: "bad", text: (err as Error).message.includes("themselves") ? "Sie können sich nicht selbst sperren." : "Das hat nicht geklappt." });
    }
    await audit(c, disable ? "user.disabled" : "user.enabled", String(userId));
    return redirectWith(c, `/admin/users/${userId}`, { kind: "ok", text: disable ? "Gesperrt, alle Sitzungen beendet." : "Entsperrt." });
  });
}

function EnvChoice(props: { envs: { id: number; name: string }[]; selected: number[]; all: boolean }) {
  return (
    <div class="stack">
      <label class="check"><input type="radio" name="scope" value="all" checked={props.all} /> Alle Umgebungen, auch künftige</label>
      <label class="check"><input type="radio" name="scope" value="some" checked={!props.all} /> Nur diese:</label>
      <div class="row">
        {props.envs.length === 0 && <span class="muted small">Projekt wählen, um Umgebungen zu sehen.</span>}
        {props.envs.map((e) => (
          <label class="check"><input type="checkbox" name="environment_id" value={String(e.id)} checked={props.selected.includes(e.id)} /> {e.name}</label>
        ))}
      </div>
    </div>
  );
}

function AccessBadge(props: { user: { disabled_at: Date | null; set_up: boolean | null; invite_open: boolean } }) {
  const u = props.user;
  if (u.disabled_at) return <Badge tone="bad">gesperrt</Badge>;
  if (u.set_up) return <Badge tone="ok">aktiv</Badge>;
  return u.invite_open ? <Badge tone="info">eingeladen</Badge> : <Badge tone="warn">nicht eingerichtet</Badge>;
}

async function userPage(c: Context, userId: number, invite: Invite | null) {
  const data = await rls(c, async (tx) => ({
    user: await first<any>(tx`select id, email, name, kind, is_admin, disabled_at, last_login_at, created_at from users where id = ${userId}`),
    grants: await all<any>(tx`
      select g.id, g.level, g.all_environments, g.expires_at, g.note, g.created_at, p.id as project_id, p.name as project_name, o.name as org_name,
        (select string_agg(e.name, ', ' order by e.sort_order, e.name) from grant_environments ge join environments e on e.id = ge.environment_id where ge.grant_id = g.id) as env_names
      from grants g join projects p on p.id = g.project_id join organisations o on o.id = p.organisation_id
      where g.user_id = ${userId} order by o.name, p.name`),
    projects: await all<any>(tx`select p.id, p.name, o.name as org_name from projects p join organisations o on o.id = p.organisation_id order by o.name, p.name`),
    orgs: await all<any>(tx`select id, name from organisations order by name`),
    sessions: await all<any>(tx`select count(*)::int as n from sessions where user_id = ${userId} and revoked_at is null and expires_at > now()`),
    devices: await first<{ n: number }>(tx`select count(*)::int as n from trusted_devices where user_id = ${userId} and revoked_at is null and expires_at > now()`),
    invite: await first<any>(tx`select expires_at from invites where user_id = ${userId} and used_at is null and expires_at > now() order by created_at desc limit 1`),
    access: await first<{ set_up: boolean }>(tx`select set_up from admin_user_access() where user_id = ${userId}`),
  }));
  const u = data.user;
  if (!u) return c.notFound();
  const isSelf = u.id === c.get("user").id;
  const mailReady = (await mailConnection()) !== null;
  const pending = !data.access?.set_up && !u.disabled_at;
  // The login name stays fixed once used; before that it is a typo to correct (admin_correct_email).
  const emailCorrectable = !data.access?.set_up && !u.last_login_at;
  return c.html(
    <AdminShell c={c} tab="users" title={u.name} heading={<span class="row">{u.name} {u.is_admin && <Badge tone="accent">Admin</Badge>} {u.disabled_at && <Badge tone="bad">gesperrt</Badge>}</span>} crumbs={[{ href: "/admin/users", label: "Benutzer" }]}>
      <div class="stack">
        {invite && (
          <Card title="Einladungslink">
            <div class="stack"><InviteLink email={u.email} invite={invite} /></div>
          </Card>
        )}
        {pending && !invite && (
          <Card title="Noch nicht eingerichtet" icon="mail">
            <div class="stack">
              <p>{data.invite
                ? <>Die Einladung ist offen bis {formatDate(data.invite.expires_at)}. Kam sie nicht an, schicken Sie eine neue; der bisherige Link gilt dann nicht mehr.</>
                : <>Es gibt keine gültige Einladung. {u.name} braucht eine, um Passwort und Authenticator-App einzurichten.</>}
                {mailReady && <> Die E-Mail geht an <strong>{u.email}</strong>.</>}</p>
              <div class="row">
                {mailReady && <ActionButton action={`/admin/users/${u.id}/invite`} label="Einladung per E-Mail schicken" icon="mail" tone="primary" fields={{ mail: "1" }} />}
                <ActionButton action={`/admin/users/${u.id}/invite`} label="Nur neuen Link erzeugen" icon="link" small={mailReady} />
              </div>
            </div>
          </Card>
        )}
        <div class="grid grid-2">
          <Card title="Zugang">
            <form method="post" action={`/admin/users/${u.id}/update`} class="stack" novalidate>
              <div class="fields">
                <Field label="Name" for="name"><input id="name" name="name" type="text" value={u.name} required /></Field>
                {emailCorrectable && (
                  <Field label="E-Mail" for="email" hint="Änderbar, bis sich die Person zum ersten Mal anmeldet. Die offene Einladung gilt danach nicht mehr.">
                    <input id="email" name="email" type="email" value={u.email} required autocomplete="off" />
                  </Field>
                )}
                <Field label="Art" for="kind">
                  <select id="kind" name="kind"><option value="customer" selected={u.kind === "customer"}>Kunde</option><option value="staff" selected={u.kind === "staff"}>Systaro</option></select>
                </Field>
              </div>
              <label class="check"><input type="checkbox" name="is_admin" value="1" checked={u.is_admin} /> Administrator</label>
              <p class="muted small">{!emailCorrectable && <>{u.email} · </>}angelegt {formatDate(u.created_at)} · zuletzt angemeldet <Ago at={u.last_login_at} /> · {data.sessions[0]?.n ?? 0} aktive Sitzung(en) · {data.devices?.n ?? 0} gemerkte(s) Gerät(e){data.invite ? ` · Einladung offen bis ${formatDate(data.invite.expires_at)}` : ""}</p>
              <button class="btn primary" type="submit">Speichern</button>
            </form>
          </Card>
          <Card title="Sicherheit">
            <div class="stack">
              <div>
                <p class="muted small">Neue Einladung: löscht Passwort, Authenticator und die Cortex-Verknüpfung, beendet alle Sitzungen, vergisst gemerkte Geräte und erzeugt einen neuen Link{mailReady ? ", der per E-Mail an die Person geht" : ""}. So setzt man ein vergessenes Passwort zurück.</p>
                <ConfirmAction action={`/admin/users/${u.id}/reset`} label="Zugang zurücksetzen"
                  question={mailReady ? `Passwort und 2FA löschen und eine neue Einladung an ${u.email} schicken?` : "Passwort und 2FA löschen, neuen Link erzeugen?"}
                  fields={mailReady ? { mail: "1" } : undefined} />
              </div>
              <CortexLinkAdmin c={c} userId={u.id} />
              {!isSelf && (
                <div>
                  <p class="muted small">{u.disabled_at ? "Gesperrt seit " + formatDate(u.disabled_at) + "." : "Sperren beendet alle Sitzungen sofort und vergisst gemerkte Geräte; Freigaben bleiben erhalten, wirken aber nicht."}</p>
                  {u.disabled_at
                    ? <ActionButton action={`/admin/users/${u.id}/disable`} label="Entsperren" fields={{ disabled: "0" }} />
                    : <ConfirmAction action={`/admin/users/${u.id}/disable`} label="Sperren" question="Zugang sperren?" fields={{ disabled: "1" }} />}
                </div>
              )}
            </div>
          </Card>
        </div>

        <Card title="Freigaben" flush actions={
          <>
            <DialogButton dialog="grant-project" icon="plus" class="small">Projekt freigeben</DialogButton>
            <DialogButton dialog="grant-org" icon="building-2" class="small">Organisation freigeben</DialogButton>
          </>
        }>
          {u.is_admin && <div class="card-body"><p class="muted">Administratoren sehen alles; Freigaben wirken erst, wenn die Administratorrolle entzogen wird.</p></div>}
          {data.grants.length === 0 ? (
            <Empty title="Keine Freigaben">Ohne Freigabe sieht diese Person nichts.</Empty>
          ) : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Projekt</th><th>Stufe</th><th>Umgebungen</th><th>Läuft ab</th><th>Notiz</th><th></th></tr></thead>
                <tbody>
                  {data.grants.map((g) => (
                    <tr>
                      <td>{g.org_name} / {g.project_name}</td>
                      <td><GrantLevelBadge level={g.level} /></td>
                      <td>{g.all_environments ? "alle, auch künftige" : (g.env_names ?? <span class="muted">keine</span>)}</td>
                      <td>{g.expires_at ? (new Date(g.expires_at) < new Date() ? <Badge tone="bad">abgelaufen</Badge> : formatDate(g.expires_at)) : "nie"}</td>
                      <td class="small">{g.note}</td>
                      <td class="right"><ConfirmAction action={`/admin/users/${u.id}/grants/${g.id}/delete`} label="Entfernen" question="Freigabe entfernen?" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <FormDialog id="grant-project" title="Projekt freigeben" description={<>Was {u.name} in einem Projekt sehen darf. Gibt es schon eine Freigabe für das Projekt, wird sie ersetzt.</>} icon="shield-check" action={`/admin/users/${u.id}/grants`} submitLabel="Freigeben">
          <Field label="Projekt" for="project_id">
            <select id="project_id" name="project_id" required hx-get={`/admin/users/${u.id}/grant-envs`} hx-target="#env-choice" hx-trigger="change">
              <option value="">Bitte wählen</option>
              {data.projects.map((p) => <option value={String(p.id)}>{p.org_name} / {p.name}</option>)}
            </select>
          </Field>
          <Field label="Stufe" for="level"><LevelSelect id="level" /></Field>
          <div id="env-choice"><EnvChoice envs={[]} selected={[]} all={true} /></div>
          <div class="fields">
            <Field label="Läuft ab (optional)" for="expires_at"><input id="expires_at" name="expires_at" type="datetime-local" /></Field>
            <Field label="Notiz (optional)" for="note"><input id="note" name="note" type="text" placeholder="z. B. Angebot 2026-10" /></Field>
          </div>
        </FormDialog>
        <FormDialog id="grant-org" title="Ganze Organisation freigeben" description="Legt für jedes heutige Projekt der Organisation eine Freigabe mit allen Umgebungen an. Später angelegte Projekte kommen nicht automatisch dazu." icon="building-2" action={`/admin/users/${u.id}/grants/organisation`} submitLabel="Alle Projekte freigeben">
          <div class="fields">
            <Field label="Organisation" for="organisation_id">
              <select id="organisation_id" name="organisation_id" required>
                {data.orgs.map((o) => <option value={String(o.id)}>{o.name}</option>)}
              </select>
            </Field>
            <Field label="Stufe" for="level-org"><LevelSelect id="level-org" /></Field>
          </div>
        </FormDialog>
      </div>
    </AdminShell>,
  );
}
