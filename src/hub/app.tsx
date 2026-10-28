import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuth } from "../shared/auth";
import { csrfProtection, mountStatic, securityHeaders } from "../shared/http";
import { Empty } from "../shared/ui/components";
import { PlainLayout } from "../shared/ui/layout";
import { hubAuthStore } from "./auth-store";
import { hubConfig } from "./config";
import { hubSql } from "./db";
import { mountAccount, SESSION_COOKIE } from "./modules/core/account";
import { mountAuditAndTokens } from "./modules/core/audit-tokens";
import { mountEnvironment } from "./modules/core/environment";
import { mountOverview } from "./modules/core/overview";
import { mountProject } from "./modules/core/project";
import { mountRegistry } from "./modules/core/registry";
import { mountUsers } from "./modules/core/users";
import { mountAlerts } from "./modules/alerts/routes";
import { mountAnsible } from "./modules/ansible/routes";
import { mountErrors } from "./modules/errors/routes";
import { mountErrorRules } from "./modules/errors/rules";
import { mountApm } from "./modules/apm/routes";
import { mountLogs } from "./modules/logs/routes";
import { mountSecurity } from "./modules/security/routes";
import { isReportsRequest, mountReportsOrigin } from "./modules/tests/reports";
import { mountTests, mountTestsApi } from "./modules/tests/routes";
import { mountUptime, mountUptimeApi } from "./modules/uptime/routes";
import { mountOpsEventsApi } from "./modules/alerts/ops-api";
import { initIntegrations } from "./modules/integrations/store";
import { mountAgentApi } from "./modules/agent/routes";
import { mountRunnerApi } from "./modules/runners/api";
import { mountRunners } from "./modules/runners/routes";
import { mountIntegrations } from "./modules/integrations/routes";
import { mountCortexLogin } from "./modules/cortex/routes";

export function createHubApp() {
  initIntegrations(hubSql, hubConfig.secret);
  const app = new Hono();
  const reports = new Hono();
  mountReportsOrigin(reports);

  // The reports origin serves uploaded Playwright HTML and nothing else: no session, no app routes.
  app.use(async (c, next) => {
    if (isReportsRequest(c.req.raw)) return reports.fetch(c.req.raw, c.env);
    await next();
  });

  app.use(securityHeaders());
  app.use(csrfProtection(hubConfig.publicUrl));
  mountStatic(app);
  app.get("/healthz", async (c) => {
    await hubSql`select 1`;
    return c.json({ ok: true });
  });

  // Machine APIs: Bearer tokens only, checked inside SECURITY DEFINER functions. Never cookies.
  mountUptimeApi(app);
  mountTestsApi(app);
  mountOpsEventsApi(app);
  // Runners inside customer networks: their own token, only their own monitors and servers.
  mountRunnerApi(app);
  // Agents: personal API tokens, REST and MCP; every read under the token user's RLS.
  mountAgentApi(app);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  const auth = createAuth({
    product: "Vantage",
    pitch: {
      headline: "Alles im Blick, was Ihre Anwendungen tun.",
      text: "Verfügbarkeit, Testläufe, Fehler und Logs Ihrer Umgebungen an einem Ort, mit Benachrichtigung, sobald etwas nicht stimmt.",
      features: [
        { icon: "heart-pulse", text: "Uptime-Monitoring rund um die Uhr, mit Verlauf und Zertifikatsprüfung" },
        { icon: "flask-conical", text: "Ergebnisse der automatischen Tests jeder Pipeline" },
        { icon: "bug", text: "Fehlergruppen, Logs und Antwortzeiten aus dem laufenden Betrieb" },
        { icon: "shield-check", text: "Sie sehen genau die Umgebungen, die Systaro für Sie freigegeben hat" },
      ],
    },
    cookieName: SESSION_COOKIE,
    publicUrl: hubConfig.publicUrl,
    secret: hubConfig.secret,
    store: hubAuthStore(hubSql),
  });
  app.use(auth.loadUser);
  auth.mount(app);
  mountCortexLogin(app, auth);

  // Everything below needs a session; /admin additionally the admin flag (and RLS checks it again).
  app.use(auth.requireUser);
  app.use("/admin", auth.requireAdmin);
  app.use("/admin/*", auth.requireAdmin);

  mountOverview(app);
  mountProject(app);
  mountAccount(app);
  mountRegistry(app);
  mountUsers(app);
  mountAuditAndTokens(app);
  mountIntegrations(app);
  mountEnvironment(app);
  mountUptime(app);
  mountTests(app);
  mountAlerts(app);
  mountErrors(app);
  mountErrorRules(app);
  mountLogs(app);
  mountApm(app);
  mountSecurity(app);
  mountAnsible(app);
  mountRunners(app);

  app.notFound((c) =>
    c.html(
      <PlainLayout product="Vantage" title="Nicht gefunden">
        <div class="card">
          <Empty title="Nicht gefunden" icon="search" action={<a class="btn primary" href="/">Zur Übersicht</a>}>
            Diese Seite gibt es nicht, oder Sie haben keinen Zugriff darauf.
          </Empty>
        </div>
      </PlainLayout>,
      404,
    ),
  );

  app.onError((err, c) => {
    // Deliberate HTTP errors (e.g. hono/csrf refusing a cross-origin post) keep their status.
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`[hub] ${c.req.method} ${c.req.path}:`, err);
    if (c.req.path.startsWith("/api/")) return c.json({ error: "internal error" }, 500);
    return c.html(
      <PlainLayout product="Vantage" title="Fehler">
        <div class="card">
          <Empty title="Da ist etwas schiefgegangen" icon="triangle-alert" action={<a class="btn primary" href="/">Zur Übersicht</a>}>
            Der Fehler wurde protokolliert. Bitte versuchen Sie es noch einmal.
          </Empty>
        </div>
      </PlainLayout>,
      500,
    );
  });

  return app;
}
