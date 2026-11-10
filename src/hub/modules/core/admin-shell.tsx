import type { Context } from "hono";
import type { Child, PropsWithChildren } from "hono/jsx";
import { PageHead } from "../../../shared/ui/components";
import type { IconName } from "../../../shared/ui/icons";
import { isUniqueViolation } from "../../../shared/validate";
import { HubPage } from "../../ui";

const ADMIN_PAGES: Record<string, { icon: IconName; sub: string }> = {
  registry: { icon: "building-2", sub: "Organisationen, Projekte und ihre Umgebungen." },
  users: { icon: "users", sub: "Zugänge für Systaro und Kunden. Freigaben gelten pro Projekt, wahlweise nur für einzelne Umgebungen." },
  alerts: { icon: "zap", sub: "Systaro-interne Kanäle (Postfach, Slack, Teams, Webhook) und wofür sie benachrichtigt werden." },
  tokens: { icon: "key-round", sub: "Tokens, mit denen Maschinen Ereignisse an den Hub melden." },
  ansible: { icon: "terminal", sub: "Alle Läufe aus Semaphore, mit dem Ergebnis je Server, und die Server, die noch keiner Umgebung zugeordnet sind." },
  runners: { icon: "network", sub: "Runner laufen im Netz eines Kunden und prüfen von dort, was Vantage aus dem Internet nicht erreicht. Der Systaro-Runner liest die Server, die Systaro betreibt. Runner bauen nur ausgehende Verbindungen auf." },
  integrations: { icon: "plug", sub: "Die Systeme, aus denen Vantage liest und über die es Nachrichten verschickt: Adresse, Zugang und ob die Verbindung steht." },
  audit: { icon: "scroll-text", sub: "Wer hat wann was getan: Anmeldungen, Freigaben, Änderungen." },
};

/** Admin pages: the sidebar holds the admin navigation; this adds the page header. */
export function AdminShell(props: PropsWithChildren<{ c: Context; tab: string; title: string; heading?: Child; actions?: Child; crumbs?: { href?: string; label: string }[]; sub?: Child }>) {
  const page = ADMIN_PAGES[props.tab];
  const isTop = !props.crumbs || props.crumbs.length === 0;
  return (
    <HubPage c={props.c} title={`${props.title} – Verwaltung`} section={`admin:${props.tab}`}>
      <PageHead
        title={props.heading ?? props.title}
        actions={props.actions}
        crumbs={[{ label: "Verwaltung" }, ...(props.crumbs ?? [])]}
        icon={isTop ? page?.icon : undefined}
        sub={props.sub ?? (isTop ? page?.sub : undefined)}
      />
      {props.children}
    </HubPage>
  );
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugProblem(slug: string): string | null {
  return SLUG_PATTERN.test(slug) ? null : "Kürzel: nur Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit Buchstabe oder Ziffer.";
}

export { emailProblem, nameProblem } from "../../../shared/validate";

/** Postgres unique violations turn into a readable message; everything else is rethrown. */
export function dbProblem(err: unknown, uniqueMessage: string): string {
  if (isUniqueViolation(err)) return uniqueMessage;
  if (/violates foreign key|still referenced/.test((err as Error)?.message ?? "")) return "Das geht nicht, solange noch etwas daran hängt.";
  throw err;
}
