/**
 * Lucide icons (ISC licence, package lucide-static), read once from the package and inlined as SVG.
 * Only the names listed here can be rendered, so no request ever picks a file.
 */
import { readFileSync } from "node:fs";
import { raw } from "hono/html";

const NAMES = [
  "activity", "arrow-left", "arrow-right", "bell", "bug", "building-2", "calendar-clock", "check", "chevron-right",
  "circle-alert", "circle-check", "circle-dashed", "circle-stop", "circle-x", "clock", "copy", "download", "external-link",
  "file-text", "filter", "flask-conical", "folder-plus", "gauge", "git-branch", "globe", "hash", "heart-pulse", "history",
  "inbox", "info", "key-round", "layers", "layout-dashboard", "link", "list-checks", "lock", "lock-open", "log-out", "mail",
  "menu", "message-square", "monitor", "monitor-smartphone", "moon", "network", "pause", "pencil", "play", "plug", "plus", "refresh-cw", "rocket",
  "scroll-text", "search", "send", "server", "settings", "shield-check", "signpost", "siren", "sliders-horizontal", "square", "stethoscope",
  "sun", "terminal", "trash-2", "triangle-alert", "user", "user-plus", "users", "webhook", "x", "zap",
] as const;

export type IconName = (typeof NAMES)[number];

const ICON_DIR = Bun.resolveSync("lucide-static/icons/activity.svg", import.meta.dir).replace(/activity\.svg$/, "");
const cache = new Map<IconName, string>();

function inner(name: IconName): string {
  let body = cache.get(name);
  if (!body) {
    const svg = readFileSync(`${ICON_DIR}${name}.svg`, "utf8");
    body = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>")).trim();
    cache.set(name, body);
  }
  return body;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function Icon(props: { name: IconName; size?: "sm" | "lg"; label?: string }) {
  const cls = `icon${props.size ? ` ${props.size}` : ""}`;
  const a11y = props.label ? `role="img" aria-label="${escapeAttr(props.label)}"` : `aria-hidden="true"`;
  return raw(
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${inner(props.name)}</svg>`,
  );
}

export function isIconName(value: string): value is IconName {
  return (NAMES as readonly string[]).includes(value);
}
