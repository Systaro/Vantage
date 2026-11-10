import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuth } from "../shared/auth";
import { csrfProtection, mountStatic, securityHeaders } from "../shared/http";
import { opsAuthStore } from "./auth-store";
import { enforceRoles } from "./roles";
import { mountAccount } from "./routes/account";
import { mountAudit } from "./routes/audit";
import { mountDashboard } from "./routes/dashboard";
import { mountEvents } from "./routes/events";
import { mountHosts, mountHostsApi } from "./routes/hosts";
import { mountRuns } from "./routes/runs";
import { mountSchedules } from "./routes/schedules";
import { mountTemplates } from "./routes/templates";
import { mountUsers } from "./routes/users";
import type { Ops } from "./service";
import { MessagePage, PRODUCT, SESSION_COOKIE } from "./ui";

export function createOpsApp(ops: Ops) {
  const app = new Hono();
  app.use(securityHeaders());
  app.use(csrfProtection(ops.config.publicUrl));
  mountStatic(app);
  app.get("/healthz", async (c) => {
    await ops.sql`select 1`;
    return c.json({ ok: true });
  });

  // Machine API and the agent download: Bearer host tokens only, never the session cookie.
  mountHostsApi(app, ops);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  const auth = createAuth({
    product: PRODUCT,
    pitch: {
      headline: "Der Leitstand für die Systaro-Flotte.",
      text: "Ansible-Läufe, geplante Test-Pipelines und Host-Prüfungen. Nur für das Systaro-Team.",
      features: [
        { icon: "terminal", text: "Playbooks starten, live mitlesen, abbrechen" },
        { icon: "calendar-clock", text: "Zeitpläne für Ansible und GitLab-Pipelines" },
        { icon: "server", text: "Festplatten, Speicher, Dienste und Container aller Hosts" },
      ],
    },
    cookieName: SESSION_COOKIE,
    publicUrl: ops.config.publicUrl,
    secret: ops.config.secret,
    store: opsAuthStore(ops.sql),
  });
  app.use(auth.loadUser);
  auth.mount(app);

  // Everything below needs a session; what the session's role may do is decided in roles.ts.
  app.use(auth.requireUser);
  app.use(enforceRoles((c) => c.html(<MessagePage c={c} title="Keine Berechtigung" text="Dafür reicht Ihre Rolle nicht. Wenden Sie sich an einen Ops-Administrator." />, 403)));

  mountDashboard(app, ops);
  mountHosts(app, ops);
  mountTemplates(app, ops);
  mountRuns(app, ops);
  mountSchedules(app, ops);
  mountEvents(app, ops);
  mountUsers(app, ops);
  mountAccount(app, ops);
  mountAudit(app, ops);

  app.notFound((c) => c.html(<MessagePage c={c} title="Nicht gefunden" text="Diese Seite gibt es nicht." />, 404));

  app.onError((err, c) => {
    // Middleware refusals (CSRF origin check, body limit) carry their own status.
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`[ops] ${c.req.method} ${c.req.path}:`, err);
    if (c.req.path.startsWith("/api/")) return c.json({ error: "internal error" }, 500);
    return c.html(<MessagePage c={c} title="Da ist etwas schiefgegangen" text="Der Fehler wurde protokolliert. Bitte versuchen Sie es noch einmal." />, 500);
  });

  return app;
}
