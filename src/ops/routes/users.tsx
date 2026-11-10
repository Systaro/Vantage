import type { Context, Hono } from "hono";
import { newToken, sha256Hex } from "../../shared/crypto";
import { formData, parseId, redirectWith } from "../../shared/http";
import { ActionButton, Ago, Badge, Card, ConfirmAction, Field, formatDate, PageHead, SecretBox } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { initials } from "../../shared/ui/layout";
import { all, first } from "../../shared/db";
import { isRole, ROLE_LABEL, ROLES, type Role } from "../roles";
import type { Ops } from "../service";
import { audit, emailProblem, FormActions, isUniqueViolation, nameProblem, OpsPage } from "../ui";

export const INVITE_HOURS = 72;

export async function issueInvite(ops: Ops, userId: number, createdBy: number | null): Promise<string> {
  const token = newToken("voi");
  await ops.sql`insert into invites (user_id, token_hash, expires_at, created_by)
    values (${userId}, ${sha256Hex(token)}, now() + make_interval(hours => ${INVITE_HOURS}), ${createdBy})`;
  return `${ops.config.publicUrl}/invite/${token}`;
}

function RoleSelect(props: { value?: string }) {
  return (
    <select id="role" name="role">
      {ROLES.map((r) => <option value={r} selected={props.value === r}>{ROLE_LABEL[r]}</option>)}
    </select>
  );
}

const ROLE_HELP: { role: Role; text: string }[] = [
  { role: "viewer", text: "sieht alles außer Benutzern und Protokoll." },
  { role: "operator", text: "startet Vorlagen und Pipelines, bricht Läufe ab, verwaltet Hosts." },
  { role: "admin", text: "zusätzlich Benutzer, Vorlagen und Pipeline-Zeitpläne mit ihren Tokens." },
];

function RoleHelp() {
  return (
    <ul class="ops-role-help">
      {ROLE_HELP.map((r) => <li><strong>{ROLE_LABEL[r.role]}:</strong> {r.text}</li>)}
    </ul>
  );
}

const ROLE_TONE: Record<Role, "accent" | "info" | "idle"> = { admin: "accent", operator: "info", viewer: "idle" };

function RoleBadge(props: { role: string }) {
  return <Badge tone={ROLE_TONE[props.role as Role] ?? "idle"}>{ROLE_LABEL[props.role as Role] ?? props.role}</Badge>;
}

function UserStatus(props: { u: any }) {
  const u = props.u;
  if (u.disabled_at) return <Badge tone="bad" icon="lock">gesperrt</Badge>;
  if (u.invite_open) return <Badge tone="info" icon="mail">eingeladen</Badge>;
  if (u.active) return <Badge tone="ok" dot>aktiv</Badge>;
  return <Badge tone="idle">ohne Zugang</Badge>;
}

export function mountUsers(app: Hono, ops: Ops) {
  app.get("/users", async (c) => {
    const users = await all<any>(ops.sql`
      select u.id, u.email, u.name, u.role, u.disabled_at, u.last_login_at, u.password_hash is not null as active,
        exists (select 1 from invites i where i.user_id = u.id and i.used_at is null and i.expires_at > now()) as invite_open
      from users u order by u.disabled_at nulls first, u.name`);
    return c.html(
      <OpsPage c={c} title="Benutzer" section="users">
        <PageHead
          icon="users"
          title="Benutzer"
          sub="Wer Vantage Ops benutzen darf und mit welcher Rolle. Neue Personen kommen über einen Einladungslink dazu."
          actions={<a class="btn primary" href="/users/new"><Icon name="user-plus" size="sm" />Benutzer anlegen</a>}
        />
        <Card flush>
          <div class="table-wrap"><table>
            <thead><tr><th>Benutzer</th><th>Rolle</th><th>Zuletzt angemeldet</th><th>Status</th></tr></thead>
            <tbody>{users.map((u) => (
              <tr>
                <td>
                  <a class="user-cell" href={`/users/${u.id}`}>
                    <span class="avatar sm">{initials(u.name)}</span>
                    <span>
                      <span class="cell-title">{u.name}</span>
                      <span class="cell-sub">{u.email}</span>
                    </span>
                  </a>
                </td>
                <td><RoleBadge role={u.role} /></td>
                <td class="nowrap ops-time"><Ago at={u.last_login_at} />{u.last_login_at && <span class="cell-sub">{formatDate(u.last_login_at)}</span>}</td>
                <td><UserStatus u={u} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      </OpsPage>,
    );
  });

  app.get("/users/new", (c) =>
    c.html(
      <OpsPage c={c} title="Benutzer anlegen" section="users">
        <PageHead
          icon="user-plus"
          title="Benutzer anlegen"
          crumbs={[{ href: "/users", label: "Benutzer" }]}
          sub="Die Person bekommt einen Einladungslink und setzt darüber Passwort und Authenticator-App selbst."
        />
        <form method="post" action="/users" class="stack">
          <Card title="Person" icon="user" description="Name und Adresse, mit der sich die Person anmeldet.">
            <div class="fields">
              <Field label="Name" for="name"><input id="name" name="name" type="text" autocomplete="off" required maxlength={200} /></Field>
              <Field label="E-Mail" for="email"><input id="email" name="email" type="email" autocomplete="off" required /></Field>
            </div>
          </Card>
          <Card title="Rolle" icon="shield-check" description="Was die Person in Vantage Ops darf. Lässt sich später ändern.">
            <div class="stack">
              <div class="fields ops-fields-narrow">
                <Field label="Rolle" for="role"><RoleSelect value="viewer" /></Field>
              </div>
              <RoleHelp />
            </div>
          </Card>
          <p class="muted small">Nach dem Anlegen erscheint ein Einladungslink ({INVITE_HOURS} h gültig, nur einmal benutzbar). Darüber setzt die Person ihr Passwort und richtet die Authenticator-App ein.</p>
          <FormActions label="Anlegen und Einladung erzeugen" icon="mail" cancelHref="/users" />
        </form>
      </OpsPage>,
    ),
  );

  app.post("/users", async (c) => {
    const f = await formData(c);
    const email = f.get("email").toLowerCase();
    const role = f.get("role");
    const problem = nameProblem(f.get("name")) ?? emailProblem(email) ?? (isRole(role) ? null : "Unbekannte Rolle.");
    if (problem) return redirectWith(c, "/users/new", { kind: "bad", text: problem });
    let id: number;
    try {
      const row = await first<{ id: number }>(ops.sql`insert into users (email, name, role, created_by) values (${email}, ${f.get("name")}, ${role}, ${c.get("user").id}) returning id`);
      id = row!.id;
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, "/users/new", { kind: "bad", text: "Diese E-Mail-Adresse hat schon einen Zugang." });
      throw err;
    }
    const link = await issueInvite(ops, id, c.get("user").id);
    await audit(ops.sql, c, "user.created", email, { role });
    return userPage(c, ops, id, link);
  });

  app.get("/users/:id", (c) => userPage(c, ops, parseId(c.req.param("id")) ?? 0, null));

  app.post("/users/:id/update", async (c) => {
    const id = parseId(c.req.param("id"));
    const f = await formData(c);
    const role = f.get("role");
    const problem = nameProblem(f.get("name")) ?? (isRole(role) ? null : "Unbekannte Rolle.");
    if (!id) return c.notFound();
    if (problem) return redirectWith(c, `/users/${id}`, { kind: "bad", text: problem });
    if (id === c.get("user").id && role !== "admin") {
      return redirectWith(c, `/users/${id}`, { kind: "bad", text: "Sie können sich die Administratorrolle nicht selbst entziehen." });
    }
    const rows = await ops.sql`update users set name = ${f.get("name")}, role = ${role} where id = ${id} returning email`;
    if (!rows.length) return c.notFound();
    await audit(ops.sql, c, "user.updated", (rows[0] as any).email, { role });
    return redirectWith(c, `/users/${id}`, { kind: "ok", text: "Gespeichert. Die Rolle gilt ab der nächsten Seite." });
  });

  app.post("/users/:id/reset", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const row = await ops.sql.begin(async (tx) => {
      const u = await first<{ email: string }>(tx`update users set password_hash = null, totp_secret_enc = null where id = ${id} returning email`);
      if (!u) return null;
      await tx`update sessions set revoked_at = now() where user_id = ${id} and revoked_at is null`;
      await tx`update invites set used_at = now() where user_id = ${id} and used_at is null`;
      return u;
    });
    if (!row) return c.notFound();
    const link = await issueInvite(ops, id, c.get("user").id);
    await audit(ops.sql, c, "user.reset", row.email);
    return userPage(c, ops, id, link);
  });

  app.post("/users/:id/disable", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const disable = (await formData(c)).get("disabled") === "1";
    if (id === c.get("user").id) return redirectWith(c, `/users/${id}`, { kind: "bad", text: "Sie können sich nicht selbst sperren." });
    const row = await ops.sql.begin(async (tx) => {
      const u = await first<{ email: string }>(tx`update users set disabled_at = ${disable ? new Date() : null} where id = ${id} returning email`);
      if (u && disable) await tx`update sessions set revoked_at = now() where user_id = ${id} and revoked_at is null`;
      return u;
    });
    if (!row) return c.notFound();
    await audit(ops.sql, c, disable ? "user.disabled" : "user.enabled", row.email);
    return redirectWith(c, `/users/${id}`, { kind: "ok", text: disable ? "Gesperrt, alle Sitzungen beendet." : "Entsperrt." });
  });
}

async function userPage(c: Context, ops: Ops, id: number, inviteLink: string | null) {
  const u = await first<any>(ops.sql`select id, email, name, role, disabled_at, last_login_at, created_at, password_hash is not null as active from users where id = ${id}`);
  if (!u) return c.notFound();
  const sessions = await first<{ n: number }>(ops.sql`select count(*)::int as n from sessions where user_id = ${id} and revoked_at is null and expires_at > now()`);
  const invite = await first<any>(ops.sql`select expires_at from invites where user_id = ${id} and used_at is null and expires_at > now() order by created_at desc limit 1`);
  const isSelf = u.id === c.get("user").id;
  return c.html(
    <OpsPage c={c} title={`${u.name} – Benutzer`} section="users">
      <PageHead
        icon="user"
        title={<span class="row">{u.name} <RoleBadge role={u.role} /> {u.disabled_at && <Badge tone="bad" icon="lock">gesperrt</Badge>}</span>}
        sub={u.email}
        crumbs={[{ href: "/users", label: "Benutzer" }]}
      />
      <div class="stack">
        {inviteLink && (
          <Card title="Einladungslink" icon="mail" class="ops-highlight">
            <div class="stack-sm">
              <p>Diesen Link geben Sie <strong>{u.email}</strong> auf einem vertraulichen Weg weiter. Er ist {INVITE_HOURS} Stunden gültig, nur einmal benutzbar und wird hier nicht noch einmal angezeigt.</p>
              <SecretBox id="invite-link" value={inviteLink} />
            </div>
          </Card>
        )}
        <div class="grid grid-2 ops-align-start">
          <Card title="Zugang" icon="user" description="Name und Rolle; die Rolle gilt ab der nächsten Seite.">
            <form method="post" action={`/users/${u.id}/update`} class="stack">
              <div class="fields">
                <Field label="Name" for="name"><input id="name" name="name" type="text" autocomplete="off" value={u.name} required maxlength={200} /></Field>
                <Field label="Rolle" for="role"><RoleSelect value={u.role} /></Field>
              </div>
              <RoleHelp />
              <FormActions label="Speichern" />
            </form>
          </Card>
          <div class="stack">
            <Card title="Konto" icon="clock">
              <dl class="facts">
                <dt>Angelegt</dt><dd>{formatDate(u.created_at)}</dd>
                <dt>Zuletzt angemeldet</dt><dd><Ago at={u.last_login_at} /></dd>
                <dt>Aktive Sitzungen</dt><dd>{sessions?.n ?? 0}</dd>
                {invite && <><dt>Einladung offen bis</dt><dd>{formatDate(invite.expires_at)}</dd></>}
              </dl>
            </Card>
            <Card title="Sicherheit" icon="shield-check">
              <div class="stack">
                <div class="stack-sm">
                  <p class="muted small">Neue Einladung: löscht Passwort und Authenticator, beendet alle Sitzungen und erzeugt einen neuen Link. So setzt man ein vergessenes Passwort zurück.</p>
                  <ConfirmAction action={`/users/${u.id}/reset`} label="Zugang zurücksetzen" question="Passwort und 2FA löschen, neuen Link erzeugen?" />
                </div>
                {!isSelf && (
                  <div class="stack-sm ops-divided">
                    <p class="muted small">{u.disabled_at ? `Gesperrt seit ${formatDate(u.disabled_at)}.` : "Sperren beendet alle Sitzungen sofort."}</p>
                    {u.disabled_at
                      ? <ActionButton action={`/users/${u.id}/disable`} label="Entsperren" icon="lock-open" small fields={{ disabled: "0" }} />
                      : <ConfirmAction action={`/users/${u.id}/disable`} label="Sperren" question="Zugang sperren?" fields={{ disabled: "1" }} />}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </OpsPage>,
  );
}
