import { readFileSync } from "node:fs";
import { join } from "node:path";
import { raw } from "hono/html";
import type { Child, PropsWithChildren } from "hono/jsx";
import { Icon, type IconName } from "./icons";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "..", "public");
const versions = new Map<string, string>();

/** Content hash per static asset, so a deploy never serves stale cached CSS or JS. Recomputed per page outside production. */
function asset(file: string): string {
  let v = versions.get(file);
  if (!v || process.env.NODE_ENV !== "production") {
    v = new Bun.CryptoHasher("sha256").update(readFileSync(join(PUBLIC_DIR, file))).digest("hex").slice(0, 10);
    versions.set(file, v);
  }
  return `/static/${file}?v=${v}`;
}

export interface LayoutUser {
  name: string;
  email: string;
}

export interface Flash {
  kind: "ok" | "bad" | "info";
  text: string;
}

export interface NavItem {
  href: string;
  label: string;
  icon?: IconName;
  active?: boolean;
  count?: number;
  countTone?: "bad";
  /** Status dot instead of an icon (environments). */
  dot?: "ok" | "bad" | "warn" | "idle";
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/** The Vantage signet: a V cut like a gem from three facets. Colours follow the theme via CSS tokens. */
export function LogoMark() {
  return (
    <span class="logo" aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <path class="facet-a" d="M5 4 50 26 37 72Z" />
        <path class="facet-b" d="M95 4 50 26 63 72Z" />
        <path class="facet-c" d="M50 26 63 72 50 100 37 72Z" />
      </svg>
    </span>
  );
}

/** The document root of every page. Without the doctype browsers render in quirks mode. */
function Document(props: PropsWithChildren) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="de">{props.children}</html>
    </>
  );
}

function Head(props: { title: string; extra?: Child }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false,"allowScriptTags":false}' />
      <title>{props.title}</title>
      <script src={asset("theme.js")}></script>
      <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
      <link rel="preload" href="/static/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
      <link rel="stylesheet" href={asset("vantage.css")} />
      <script src="/static/htmx.min.js" defer></script>
      <script src={asset("vantage.js")} defer></script>
      {props.extra}
    </head>
  );
}

function fullTitle(title: string, product: string) {
  return title ? `${title} – ${product}` : product;
}

export function ThemeSwitch() {
  const options: { key: string; label: string; icon: IconName }[] = [
    { key: "system", label: "System", icon: "monitor" },
    { key: "light", label: "Hell", icon: "sun" },
    { key: "dark", label: "Dunkel", icon: "moon" },
  ];
  return (
    <div class="theme-switch" role="group" aria-label="Darstellung">
      {options.map((o) => (
        <button type="button" data-theme-choice={o.key} aria-pressed={o.key === "system" ? "true" : "false"} title={`Darstellung: ${o.label}`}>
          <Icon name={o.icon} size="sm" />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Toasts(props: { flash?: Flash | null }) {
  if (!props.flash) return <div class="toasts" aria-live="polite"></div>;
  const icon: IconName = props.flash.kind === "ok" ? "circle-check" : props.flash.kind === "bad" ? "circle-alert" : "info";
  return (
    <div class="toasts" aria-live="polite">
      <div class={`toast ${props.flash.kind}`} role={props.flash.kind === "bad" ? "alert" : "status"}>
        <Icon name={icon} />
        <div class="toast-text">{props.flash.text}</div>
        <button type="button" class="toast-close" data-dismiss aria-label="Schließen"><Icon name="x" size="sm" /></button>
      </div>
    </div>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase() || "?";
}

function NavLink(props: { item: NavItem }) {
  const i = props.item;
  return (
    <a href={i.href} class={`sb-link${i.active ? " active" : ""}`} aria-current={i.active ? "page" : undefined}>
      {i.dot ? <span class={`dot ${i.dot}${i.dot === "bad" ? " pulse" : ""}`} aria-hidden="true" /> : i.icon && <Icon name={i.icon} />}
      <span class="label">{i.label}</span>
      {i.count !== undefined && i.count > 0 && <span class={`sb-count${i.countTone ? ` ${i.countTone}` : ""}`}>{i.count}</span>}
    </a>
  );
}

/**
 * The application shell: sidebar with navigation, environment list and user menu; a drawer on
 * phones (checkbox toggle, no JS needed); toasts for flash messages.
 */
export function AppLayout(
  props: PropsWithChildren<{
    product: string;
    title: string;
    sections: NavSection[];
    user: LayoutUser;
    flash?: Flash | null;
    head?: Child;
    accountHref?: string;
    /** Context picker shown under the brand (the hub's customer/project switcher). */
    switcher?: Child;
    /** Dialogs rendered at the end of <body>, so they sit above everything. */
    dialogs?: Child;
  }>,
) {
  const tag = props.product.replace(/^Vantage\s*/, "");
  const brand = (
    <a class="sb-brand" href="/">
      <LogoMark />
      <span class="sb-brand-name">Vantage</span>
      {tag && <span class="sb-brand-tag">{tag}</span>}
    </a>
  );
  return (
    <Document>
      <Head title={fullTitle(props.title, props.product)} extra={props.head} />
      <body>
        <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true" tabindex={-1} />
        <div class="app">
          <label class="scrim" for="nav-toggle" aria-hidden="true"></label>
          <aside class="sidebar" aria-label="Navigation">
            {brand}
            {props.switcher}
            {props.sections.map((s) => (
              <nav class="sb-section" aria-label={s.label ?? "Hauptnavigation"}>
                {s.label && <div class="sb-label">{s.label}</div>}
                {s.items.map((i) => <NavLink item={i} />)}
              </nav>
            ))}
            <div class="sb-spacer" />
            <div class="sb-footer">
              <ThemeSwitch />
              <div class="user-card">
                <a href={props.accountHref ?? "/account"} title="Mein Konto" aria-hidden="true" tabindex={-1}>
                  <span class="avatar">{initials(props.user.name)}</span>
                </a>
                <a href={props.accountHref ?? "/account"} class="who">
                  <strong>{props.user.name}</strong>
                  <span>{props.user.email}</span>
                </a>
                <form method="post" action="/logout">
                  <button class="btn ghost small icon-only" type="submit" title="Abmelden" aria-label="Abmelden"><Icon name="log-out" /></button>
                </form>
              </div>
            </div>
          </aside>
          <div class="main">
            <header class="mobilebar">
              <label for="nav-toggle" class="btn ghost icon-only" aria-label="Menü öffnen"><Icon name="menu" /></label>
              {brand}
            </header>
            <main class="page" id="main">{props.children}</main>
          </div>
        </div>
        <Toasts flash={props.flash} />
        {props.dialogs}
      </body>
    </Document>
  );
}

export interface AuthPitch {
  headline: string;
  text: string;
  features: { icon: IconName; text: string }[];
}

/** Login, 2FA and invite pages: brand panel on the left, the form on the right. */
export function AuthLayout(props: PropsWithChildren<{ product: string; title: string; pitch: AuthPitch; flash?: Flash | null }>) {
  const tag = props.product.replace(/^Vantage\s*/, "");
  return (
    <Document>
      <Head title={fullTitle(props.title, props.product)} />
      <body>
        <div class="auth">
          <aside class="auth-aside">
            <div class="auth-brand"><LogoMark /> Vantage{tag && <span class="auth-tag">{tag}</span>}</div>
            <div class="auth-pitch">
              <h2>{props.pitch.headline}</h2>
              <p>{props.pitch.text}</p>
              <ul class="auth-features">
                {props.pitch.features.map((f) => (
                  <li><Icon name={f.icon} /><span>{f.text}</span></li>
                ))}
              </ul>
            </div>
            <div class="auth-foot">Ein Dienst der Systaro GmbH</div>
          </aside>
          <main class="auth-main">
            <div class="auth-tools"><ThemeSwitch /></div>
            <div class="auth-card">
              <div class="mobile-brand sb-brand"><LogoMark /><span class="sb-brand-name">Vantage</span>{tag && <span class="sb-brand-tag">{tag}</span>}</div>
              {props.children}
            </div>
          </main>
        </div>
        <Toasts flash={props.flash} />
      </body>
    </Document>
  );
}

/** A single centred card without navigation, for error pages. */
export function PlainLayout(props: PropsWithChildren<{ product: string; title: string; flash?: Flash | null }>) {
  return (
    <Document>
      <Head title={fullTitle(props.title, props.product)} />
      <body>
        <main class="page-narrow">
          <a class="sb-brand plain-brand" href="/"><LogoMark /><span class="sb-brand-name">Vantage</span></a>
          {props.children}
        </main>
        <Toasts flash={props.flash} />
      </body>
    </Document>
  );
}
