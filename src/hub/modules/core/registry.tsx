import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Card, ConfirmAction, DialogButton, Empty, Field, FormDialog } from "../../../shared/ui/components";
import { all, first, rls } from "../../db";
import { audit, ENV_KIND_LABEL, EnvKindBadge, EnvShell, loadEnv, type EnvContext } from "../../ui";
import { AdminShell, dbProblem, nameProblem, slugProblem } from "./admin-shell";

type SettingsSection = (c: Context, env: EnvContext) => Promise<Child>;
const settingsSections: { order: number; render: SettingsSection }[] = [];

/** Modules add their configuration blocks to an environment's settings page. */
export function registerSettingsSection(order: number, render: SettingsSection) {
  settingsSections.push({ order, render });
  settingsSections.sort((a, b) => a.order - b.order);
}

function KindSelect(props: { value?: string; id?: string }) {
  return (
    <select name="kind" id={props.id ?? "kind"}>
      {Object.entries(ENV_KIND_LABEL).map(([k, label]) => (
        <option value={k} selected={props.value === k}>{label}</option>
      ))}
    </select>
  );
}

export function mountRegistry(app: Hono) {
  app.get("/admin", async (c) => {
    const data = await rls(c, async (tx) => ({
      orgs: await all<any>(tx`select id, slug, name from organisations order by name`),
      projects: await all<any>(tx`select id, organisation_id, slug, name from projects order by name`),
      envs: await all<any>(tx`
        select e.id, e.project_id, e.slug, e.name, e.kind,
          (select count(*)::int from monitors m where m.environment_id = e.id) as monitors,
          (select count(*)::int from test_suites s where s.environment_id = e.id) as suites,
          (select string_agg(distinct kind, ', ' order by kind) from environment_sources es where es.environment_id = e.id) as sources
        from environments e order by e.sort_order, e.name`),
    }));
    const newOrg = <DialogButton dialog="new-org" icon="plus" class="primary">Organisation anlegen</DialogButton>;
    return c.html(
      <AdminShell c={c} tab="registry" title="Organisationen & Umgebungen" actions={newOrg}>
        <div class="stack">
          {data.orgs.length === 0 && <Card><Empty title="Noch keine Organisationen" icon="building-2" action={newOrg}>Legen Sie die erste Organisation an, danach ihre Projekte und Umgebungen.</Empty></Card>}
          {data.orgs.map((o) => {
            const projects = data.projects.filter((p) => p.organisation_id === o.id);
            return (
              <Card title={<h2>{o.name} <span class="muted small mono">{o.slug}</span></h2>} actions={
                <>
                  <DialogButton dialog={`new-project-${o.id}`} icon="folder-plus" class="small">Projekt anlegen</DialogButton>
                  {projects.length === 0 && <ConfirmAction action={`/admin/organisations/${o.id}/delete`} label="Löschen" question="Organisation löschen?" />}
                </>
              }>
                <div class="stack">
                  {projects.length === 0 && <p class="muted">Noch kein Projekt. Ein Projekt fasst die Umgebungen einer Anwendung zusammen, z. B. „Webshop“ mit Produktion und Stage.</p>}
                  {projects.map((p) => {
                    const envs = data.envs.filter((e) => e.project_id === p.id);
                    return (
                      <div>
                        <div class="row-between">
                          <div class="project-title"><h3>{p.name}</h3><code>{o.slug}/{p.slug}</code></div>
                          <div class="btn-group">
                            <DialogButton dialog={`new-env-${p.id}`} icon="plus" class="small">Umgebung anlegen</DialogButton>
                            {envs.length === 0 && <ConfirmAction action={`/admin/projects/${p.id}/delete`} label="Löschen" question="Projekt löschen?" />}
                          </div>
                        </div>
                        <div class="table-wrap">
                          <table>
                            <thead><tr><th>Umgebung</th><th>Pfad</th><th>Art</th><th class="num">Monitore</th><th class="num">Testsuiten</th><th>Quellen</th><th></th></tr></thead>
                            <tbody>
                              {envs.map((e) => (
                                <tr>
                                  <td><a href={`/env/${e.id}`}>{e.name}</a></td>
                                  <td class="mono small">{o.slug}/{p.slug}/{e.slug}</td>
                                  <td><EnvKindBadge kind={e.kind} /></td>
                                  <td class="num">{e.monitors}</td>
                                  <td class="num">{e.suites}</td>
                                  <td class="small">{e.sources ?? <span class="muted">keine</span>}</td>
                                  <td class="right"><a class="btn small" href={`/env/${e.id}/settings`}>Einstellungen</a></td>
                                </tr>
                              ))}
                              {envs.length === 0 && <tr><td colspan={7} class="muted">Noch keine Umgebung.</td></tr>}
                            </tbody>
                          </table>
                        </div>
                        <FormDialog id={`new-env-${p.id}`} title="Umgebung anlegen" description={<>Im Projekt „{p.name}“. Danach richten Sie Monitore, Quellen und Testsuiten ein.</>} icon="layers" action="/admin/environments" submitLabel="Umgebung anlegen">
                          <input type="hidden" name="project_id" value={p.id} />
                          <div class="fields">
                            <Field label="Name" for={`env-name-${p.id}`}><input id={`env-name-${p.id}`} name="name" type="text" required placeholder="Produktion" /></Field>
                            <Field label="Kürzel" for={`env-slug-${p.id}`} hint="Teil des Pfads, z. B. prod"><input id={`env-slug-${p.id}`} name="slug" type="text" required placeholder="prod" /></Field>
                            <Field label="Art" for={`env-kind-${p.id}`}><KindSelect id={`env-kind-${p.id}`} /></Field>
                            <Field label="URL (optional)" for={`env-url-${p.id}`}><input id={`env-url-${p.id}`} name="url" type="url" placeholder="https://" /></Field>
                          </div>
                        </FormDialog>
                      </div>
                    );
                  })}
                </div>
                <FormDialog id={`new-project-${o.id}`} title="Projekt anlegen" description={<>In der Organisation „{o.name}“. Umgebungen legen Sie danach im Projekt an.</>} icon="folder-plus" action="/admin/projects" submitLabel="Projekt anlegen">
                  <input type="hidden" name="organisation_id" value={o.id} />
                  <div class="fields">
                    <Field label="Name" for={`p-name-${o.id}`}><input id={`p-name-${o.id}`} name="name" type="text" required placeholder="Webshop" /></Field>
                    <Field label="Kürzel" for={`p-slug-${o.id}`} hint="Teil des Pfads, z. B. shop"><input id={`p-slug-${o.id}`} name="slug" type="text" required placeholder="shop" /></Field>
                  </div>
                </FormDialog>
              </Card>
            );
          })}
        </div>
        <FormDialog id="new-org" title="Organisation anlegen" description="Ein Kunde oder Systaro selbst. Projekte und Umgebungen legen Sie danach in der Organisation an." icon="building-2" action="/admin/organisations" submitLabel="Organisation anlegen">
          <div class="fields">
            <Field label="Name" for="org-name"><input id="org-name" name="name" type="text" required placeholder="Nordwind GmbH" /></Field>
            <Field label="Kürzel" for="org-slug" hint="Teil des Umgebungspfads, z. B. nordwind"><input id="org-slug" name="slug" type="text" required pattern="[a-z0-9][a-z0-9-]*" /></Field>
          </div>
        </FormDialog>
      </AdminShell>,
    );
  });

  app.post("/admin/organisations", async (c) => {
    const f = await formData(c);
    const problem = nameProblem(f.get("name")) ?? slugProblem(f.get("slug"));
    if (problem) return redirectWith(c, "/admin", { kind: "bad", text: problem });
    try {
      await rls(c, (tx) => tx`insert into organisations (slug, name) values (${f.get("slug")}, ${f.get("name")})`);
    } catch (err) {
      return redirectWith(c, "/admin", { kind: "bad", text: dbProblem(err, "Dieses Kürzel gibt es schon.") });
    }
    await audit(c, "organisation.created", f.get("slug"));
    return redirectWith(c, "/admin", { kind: "ok", text: `Organisation „${f.get("name")}“ angelegt.` });
  });

  app.post("/admin/organisations/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    try {
      const rows = await rls(c, (tx) => tx`delete from organisations where id = ${id} returning slug`);
      if (!rows.length) return c.notFound();
      await audit(c, "organisation.deleted", (rows[0] as any).slug);
    } catch (err) {
      return redirectWith(c, "/admin", { kind: "bad", text: dbProblem(err, "") });
    }
    return redirectWith(c, "/admin", { kind: "ok", text: "Organisation gelöscht." });
  });

  app.post("/admin/projects", async (c) => {
    const f = await formData(c);
    const orgId = parseId(f.get("organisation_id"));
    const problem = nameProblem(f.get("name")) ?? slugProblem(f.get("slug"));
    if (problem || !orgId) return redirectWith(c, "/admin", { kind: "bad", text: problem ?? "Organisation fehlt." });
    try {
      await rls(c, (tx) => tx`insert into projects (organisation_id, slug, name) values (${orgId}, ${f.get("slug")}, ${f.get("name")})`);
    } catch (err) {
      return redirectWith(c, "/admin", { kind: "bad", text: dbProblem(err, "Dieses Kürzel gibt es in der Organisation schon.") });
    }
    await audit(c, "project.created", f.get("slug"), { organisation_id: orgId });
    return redirectWith(c, "/admin", { kind: "ok", text: `Projekt „${f.get("name")}“ angelegt.` });
  });

  app.post("/admin/projects/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    try {
      const rows = await rls(c, (tx) => tx`delete from projects where id = ${id} returning slug`);
      if (!rows.length) return c.notFound();
      await audit(c, "project.deleted", (rows[0] as any).slug);
    } catch (err) {
      return redirectWith(c, "/admin", { kind: "bad", text: dbProblem(err, "") });
    }
    return redirectWith(c, "/admin", { kind: "ok", text: "Projekt gelöscht." });
  });

  app.post("/admin/environments", async (c) => {
    const f = await formData(c);
    const projectId = parseId(f.get("project_id"));
    const url = f.get("url") || null;
    const problem = nameProblem(f.get("name")) ?? slugProblem(f.get("slug")) ?? (url && !/^https?:\/\//.test(url) ? "Die URL muss mit http:// oder https:// beginnen." : null);
    if (problem || !projectId) return redirectWith(c, "/admin", { kind: "bad", text: problem ?? "Projekt fehlt." });
    const kind = ENV_KIND_LABEL[f.get("kind")] ? f.get("kind") : "other";
    let id: number;
    try {
      const row = await rls(c, (tx) => first<{ id: number }>(tx`
        insert into environments (project_id, slug, name, kind, url) values (${projectId}, ${f.get("slug")}, ${f.get("name")}, ${kind}, ${url})
        returning id`));
      id = row!.id;
    } catch (err) {
      return redirectWith(c, "/admin", { kind: "bad", text: dbProblem(err, "Dieses Kürzel gibt es im Projekt schon.") });
    }
    await audit(c, "environment.created", String(id), { project_id: projectId, slug: f.get("slug") });
    return redirectWith(c, `/env/${id}/settings`, { kind: "ok", text: "Umgebung angelegt. Jetzt Monitore, Quellen und Testsuiten einrichten." });
  });

  app.get("/env/:id/settings", async (c) => {
    if (!c.get("user").isAdmin) return c.notFound();
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const sections: Child[] = [];
    for (const s of settingsSections) sections.push(await s.render(c, env));
    const [row] = (await rls(c, (tx) => tx`select sort_order from environments where id = ${env.id}`)) as any[];
    return c.html(
      <EnvShell c={c} env={env} tab="settings" title="Einstellungen">
        <div class="stack">
          <Card title="Allgemein">
            <form method="post" action={`/env/${env.id}/settings`} class="fields">
              <Field label="Name" for="name"><input id="name" name="name" type="text" required value={env.name} /></Field>
              <Field label="Art" for="kind"><KindSelect value={env.kind} /></Field>
              <Field label="URL" for="url"><input id="url" name="url" type="url" value={env.url ?? ""} /></Field>
              <Field label="Reihenfolge" for="sort" hint="kleiner = weiter vorn"><input id="sort" name="sort_order" type="number" value={String(row?.sort_order ?? 0)} /></Field>
              <div class="field"><span class="label">&nbsp;</span><button class="btn primary" type="submit">Speichern</button></div>
            </form>
            <p class="muted small">Pfad für Ops-Ereignisse: <code>{env.orgSlug}/{env.projectSlug}/{env.slug}</code></p>
          </Card>
          {sections}
          <Card title="Umgebung löschen">
            <p class="muted">Löscht auch Monitore, Testläufe, Fehlergruppen und Vorfälle dieser Umgebung.</p>
            <ConfirmAction action={`/env/${env.id}/settings/delete`} label="Umgebung löschen" question={`„${env.name}“ mit allen Daten löschen?`} />
          </Card>
        </div>
      </EnvShell>,
    );
  });

  app.post("/env/:id/settings", async (c) => {
    const id = parseId(c.req.param("id"));
    const f = await formData(c);
    const url = f.get("url") || null;
    const problem = nameProblem(f.get("name")) ?? (url && !/^https?:\/\//.test(url) ? "Die URL muss mit http:// oder https:// beginnen." : null);
    if (problem) return redirectWith(c, `/env/${id}/settings`, { kind: "bad", text: problem });
    const kind = ENV_KIND_LABEL[f.get("kind")] ? f.get("kind") : "other";
    const sort = Number.parseInt(f.get("sort_order") || "0", 10) || 0;
    const rows = await rls(c, (tx) => tx`update environments set name = ${f.get("name")}, kind = ${kind}, url = ${url}, sort_order = ${sort} where id = ${id} returning id`);
    if (!rows.length) return c.notFound();
    await audit(c, "environment.updated", String(id));
    return redirectWith(c, `/env/${id}/settings`, { kind: "ok", text: "Gespeichert." });
  });

  app.post("/env/:id/settings/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    try {
      const rows = await rls(c, async (tx) => {
        await tx`delete from grant_environments where environment_id = ${id}`;
        return tx`delete from environments where id = ${id} returning slug`;
      });
      if (!rows.length) return c.notFound();
      await audit(c, "environment.deleted", String(id));
    } catch (err) {
      return redirectWith(c, `/env/${id}/settings`, { kind: "bad", text: dbProblem(err, "") });
    }
    return redirectWith(c, "/admin", { kind: "ok", text: "Umgebung gelöscht." });
  });
}
