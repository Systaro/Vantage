import type { Child, PropsWithChildren } from "hono/jsx";
import { Icon, type IconName } from "./icons";

export type Tone = "ok" | "warn" | "bad" | "idle" | "info" | "accent";

export function Badge(props: PropsWithChildren<{ tone?: Tone; dot?: boolean; title?: string; icon?: IconName }>) {
  return (
    <span class={`badge ${props.tone ?? ""}`} title={props.title}>
      {props.dot && <span class="dot" />}
      {props.icon && <Icon name={props.icon} size="sm" />}
      {props.children}
    </span>
  );
}

export function Card(props: PropsWithChildren<{ title?: Child; description?: Child; icon?: IconName; actions?: Child; flush?: boolean; id?: string; class?: string }>) {
  return (
    <section class={`card${props.class ? ` ${props.class}` : ""}`} id={props.id}>
      {(props.title || props.actions) && (
        <div class="card-head">
          <div>
            {typeof props.title === "string" ? <h2>{props.icon && <Icon name={props.icon} />}{props.title}</h2> : props.title}
            {props.description && <div class="desc">{props.description}</div>}
          </div>
          {props.actions && <div class="row">{props.actions}</div>}
        </div>
      )}
      <div class={props.flush ? "card-body flush" : "card-body"}>{props.children}</div>
    </section>
  );
}

export function PageHead(props: { title: Child; sub?: Child; crumbs?: { href?: string; label: string }[]; actions?: Child; icon?: IconName }) {
  return (
    <div class="page-head">
      <div>
        {props.crumbs && props.crumbs.length > 0 && (
          <nav class="crumbs" aria-label="Pfad">
            {props.crumbs.map((c, i) => (
              <>
                {i > 0 && <span class="sep"><Icon name="chevron-right" size="sm" /></span>}
                {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
              </>
            ))}
          </nav>
        )}
        <div class="title-row">
          {props.icon && <span class="head-icon"><Icon name={props.icon} size="lg" /></span>}
          <h1>{props.title}</h1>
        </div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      {props.actions && <div class="actions">{props.actions}</div>}
    </div>
  );
}

export function Tabs(props: { items: { href: string; label: string; active?: boolean; icon?: IconName; count?: number }[] }) {
  return (
    <nav class="tabs">
      {props.items.map((t) => (
        <a href={t.href} class={t.active ? "active" : ""} aria-current={t.active ? "page" : undefined}>
          {t.icon && <Icon name={t.icon} />}
          {t.label}
          {t.count !== undefined && t.count > 0 && <span class="sb-count">{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}

export function Empty(props: PropsWithChildren<{ title: string; icon?: IconName; action?: Child }>) {
  return (
    <div class="empty">
      <span class="empty-icon"><Icon name={props.icon ?? "inbox"} size="lg" /></span>
      <h3>{props.title}</h3>
      {props.children && <div>{props.children}</div>}
      {props.action}
    </div>
  );
}

/** A big number in a tile; with `href` the whole tile is a link, children (a trend) go below the hint. */
export function Stat(props: PropsWithChildren<{ label: string; value: Child; hint?: Child; tone?: Tone; icon?: IconName; href?: string }>) {
  const body = (
    <>
      <div class="stat-label">{props.icon && <Icon name={props.icon} size="sm" />}{props.label}</div>
      <div class={`stat-value ${props.tone ? `status-${props.tone}` : ""}`}>{props.value}</div>
      {props.hint && <div class="stat-hint">{props.hint}</div>}
      {props.children}
    </>
  );
  return props.href ? <a class="card stat stat-link" href={props.href}>{body}</a> : <div class="card stat">{body}</div>;
}

/** A coloured summary line at the top of a page ("Alle Systeme betriebsbereit"). */
export function StatusBanner(props: { tone: "ok" | "bad" | "warn" | "info"; title: Child; text?: Child; actions?: Child }) {
  const icon: IconName = props.tone === "ok" ? "check" : props.tone === "info" ? "info" : "triangle-alert";
  return (
    <div class={`banner ${props.tone}`} role="status">
      <span class="banner-icon"><Icon name={icon} /></span>
      <div class="spacer">
        <strong>{props.title}</strong>
        {props.text && <span class="muted">{props.text}</span>}
      </div>
      {props.actions}
    </div>
  );
}

/** Hidden username in password forms, so password managers file the new password under the right account. */
export function UsernameHint(props: { email: string }) {
  return <input hidden type="email" name="username" value={props.email} autocomplete="username" readonly />;
}

export function Field(props: PropsWithChildren<{ label: string; hint?: Child; for?: string }>) {
  return (
    <div class="field">
      <label for={props.for}>{props.label}</label>
      {props.children}
      {props.hint && <div class="hint">{props.hint}</div>}
    </div>
  );
}

/** A POST button in its own tiny form, for actions on list rows. */
export function ActionButton(props: {
  action: string;
  label: string;
  tone?: "danger" | "primary";
  small?: boolean;
  icon?: IconName;
  fields?: Record<string, string | number>;
}) {
  return (
    <form method="post" action={props.action} class="inline-form">
      {Object.entries(props.fields ?? {}).map(([k, v]) => (
        <input type="hidden" name={k} value={String(v)} />
      ))}
      <button type="submit" class={`btn ${props.small ? "small" : ""} ${props.tone ?? ""}`}>{props.icon && <Icon name={props.icon} size="sm" />}{props.label}</button>
    </form>
  );
}

/**
 * Destructive actions need a second, deliberate click. A disclosure does that without a native
 * confirm() dialog and without JavaScript.
 */
export function ConfirmAction(props: { action: string; label: string; question: string; confirmLabel?: string; fields?: Record<string, string | number> }) {
  return (
    <details class="disclosure">
      <summary class="btn small danger">{props.label}</summary>
      <div class="confirm-row">
        <span class="small">{props.question}</span>
        <ActionButton action={props.action} label={props.confirmLabel ?? "Ja, ausführen"} tone="danger" small fields={props.fields} />
      </div>
    </details>
  );
}

/** Opens the dialog with this id (a FormDialog or ChoiceDialog on the same page; vantage.js). */
export function DialogButton(props: PropsWithChildren<{ dialog: string; icon?: IconName; class?: string; title?: string }>) {
  return (
    <button type="button" class={`btn${props.class ? ` ${props.class}` : ""}`} data-dialog-open={props.dialog} aria-haspopup="dialog" title={props.title}>
      {props.icon && <Icon name={props.icon} size="sm" />}
      {props.children}
    </button>
  );
}

function ModalHead(props: { id?: string; title: Child; description?: Child; icon?: IconName; tone?: "ok" | "danger" }) {
  return (
    <div class="modal-head">
      {props.icon && <span class={`modal-icon${props.tone ? ` ${props.tone}` : ""}`}><Icon name={props.icon} /></span>}
      <div class="modal-heading">
        <h2 class="modal-title" id={props.id}>{props.title}</h2>
        {props.description && <p class="modal-desc">{props.description}</p>}
      </div>
      <button type="button" class="btn ghost small icon-only" data-dialog-close aria-label="Schließen"><Icon name="x" /></button>
    </div>
  );
}

/**
 * A create or edit form in a modal. It posts with htmx: problems come back into `.modal-error`
 * (see redirectWith) and the typed values stay; success reloads the page with a toast.
 * `novalidate`: the server checks every field and its message appears here, styled, instead of the
 * browser's own validation bubble. `hx-disinherit`: htmx elements inside the form (live previews)
 * keep their own targets. `back` adds a "Zurück" button to a previous dialog (type picker).
 */
export function FormDialog(
  props: PropsWithChildren<{
    id: string;
    title: string;
    description?: Child;
    icon?: IconName;
    action: string;
    submitLabel: string;
    danger?: boolean;
    back?: string;
    wide?: boolean;
  }>,
) {
  return (
    <dialog id={props.id} class={`modal${props.wide ? " wide" : ""}`} aria-labelledby={`${props.id}-title`}>
      <div class="modal-panel">
        <ModalHead id={`${props.id}-title`} title={props.title} description={props.description} icon={props.icon} tone={props.danger ? "danger" : undefined} />
        <form
          method="post"
          action={props.action}
          class="modal-form"
          novalidate
          hx-post={props.action}
          hx-target="find .modal-error"
          hx-swap="innerHTML"
          hx-disabled-elt="find button[type=submit]"
          hx-disinherit="*"
        >
          <div class="modal-body">
            <div class="modal-error" role="alert"></div>
            {props.children}
          </div>
          <div class="modal-foot">
            {props.back && <button type="button" class="btn ghost" data-dialog-open={props.back}><Icon name="arrow-left" size="sm" />Zurück</button>}
            <span class="spacer" />
            <button type="button" class="btn ghost" data-dialog-close>Abbrechen</button>
            <button type="submit" class={`btn ${props.danger ? "danger" : "primary"}`}>{props.submitLabel}</button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

export interface Choice {
  dialog: string;
  label: string;
  text: string;
  icon: IconName;
}

/** First step of a creation flow with several kinds: each choice opens that kind's FormDialog. */
/**
 * A read-only detail in a modal, filled when it opens: a table row with `data-detail-dialog="<id>"`
 * and `data-detail-url` loads that URL into the body (vantage.js), on a click or Enter.
 */
export function DetailDialog(props: { id: string; title: string; icon?: IconName }) {
  return (
    <dialog id={props.id} class="modal wide" aria-labelledby={`${props.id}-title`}>
      <div class="modal-panel">
        <ModalHead id={`${props.id}-title`} title={props.title} icon={props.icon} />
        <div class="modal-body" data-detail-body></div>
      </div>
    </dialog>
  );
}

export function ChoiceDialog(props: { id: string; title: string; description?: Child; icon?: IconName; choices: Choice[] }) {
  return (
    <dialog id={props.id} class="modal" aria-labelledby={`${props.id}-title`}>
      <div class="modal-panel">
        <ModalHead id={`${props.id}-title`} title={props.title} description={props.description} icon={props.icon} />
        <div class="modal-body">
          <div class="choices">
            {props.choices.map((ch) => (
              <button type="button" class="choice" data-dialog-open={ch.dialog}>
                <span class="choice-icon"><Icon name={ch.icon} /></span>
                <span class="choice-text"><strong>{ch.label}</strong><span>{ch.text}</span></span>
                <span class="choice-chev"><Icon name="chevron-right" size="sm" /></span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * What a dialog shows after a successful create when there is something to take away (a token shown
 * once, the next step). Closing it reloads the page, so the new entry appears in the list.
 */
export function DialogStep(props: PropsWithChildren<{ title: string; icon?: IconName; next?: { href: string; label: string } }>) {
  return (
    <>
      <ModalHead title={props.title} icon={props.icon ?? "circle-check"} tone="ok" />
      <div class="modal-body" data-reload-on-close>{props.children}</div>
      <div class="modal-foot">
        <span class="spacer" />
        {props.next ? (
          <>
            <button type="button" class="btn ghost" data-dialog-close>Schließen</button>
            <a class="btn primary" href={props.next.href}>{props.next.label}<Icon name="arrow-right" size="sm" /></a>
          </>
        ) : (
          <button type="button" class="btn primary" data-dialog-close>Fertig</button>
        )}
      </div>
    </>
  );
}

/** A value shown once (token, invite link) with a copy button (needs JS; the text stays selectable without). */
/** Copies the text of the element with id `target` (vantage.js, data-copy). */
export function CopyButton(props: { target: string; label?: string }) {
  return <button type="button" class="btn small" data-copy={props.target}><Icon name="copy" size="sm" /><span class="copy-label">{props.label ?? "Kopieren"}</span></button>;
}

export function SecretBox(props: { id: string; value: string }) {
  return (
    <div class="secret-row">
      <div class="secret" id={props.id}>{props.value}</div>
      <CopyButton target={props.id} />
    </div>
  );
}

const dateFmt = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});
const timeFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "medium", timeZone: "Europe/Berlin" });
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "–";
  return dateFmt.format(new Date(d));
}

export function formatTime(d: Date | string): string {
  return timeFmt.format(new Date(d));
}

export function formatDay(d: Date | string): string {
  return dayFmt.format(new Date(d));
}

export function relative(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "nie";
  const diff = Math.round((now - new Date(d).getTime()) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  let text: string;
  if (s < 45) text = "gerade eben";
  else if (s < 90) text = "1 Minute";
  else if (s < 3600) text = `${Math.round(s / 60)} Minuten`;
  else if (s < 5400) text = "1 Stunde";
  else if (s < 86400) text = `${Math.round(s / 3600)} Stunden`;
  else if (s < 172800) text = "1 Tag";
  else text = `${Math.round(s / 86400)} Tagen`;
  if (text === "gerade eben") return text;
  return future ? `in ${text}` : `vor ${text}`;
}

export function Ago(props: { at: Date | string | null | undefined }) {
  if (!props.at) return <span class="muted">nie</span>;
  return <time datetime={new Date(props.at).toISOString()} title={formatDate(props.at)}>{relative(props.at)}</time>;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", ",")} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m} min ${rest} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return `${value.toFixed(digits).replace(".", ",")} %`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("de-DE").format(n);
}

/** "Mozilla/5.0 (Macintosh; …) Chrome/141 …" → "Chrome auf macOS". Display only; show the raw string as a tooltip. */
export function formatUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unbekanntes Gerät";
  // Order matters: Edge and Opera also send "Chrome/", Chrome also sends "Safari/", iOS also says "Mac OS X".
  const browser = /Edg(A|iOS)?\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} auf ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}
