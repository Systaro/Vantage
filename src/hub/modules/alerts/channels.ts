/**
 * Channel configs (encrypted at rest) and delivery. Delivery runs only in the worker; the hub merely
 * stores the encrypted channel config. The mail relay is the "mail" integration.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { decryptString, encryptString, hmacHex } from "../../../shared/crypto";
import type { MailConnection } from "../integrations/kinds";
import { renderMailHtml, renderMailText, type MailOptions } from "./mail";

export type ChannelKind = "email" | "slack" | "teams" | "webhook";

export type ChannelConfig =
  | { kind: "email"; recipients: string[] }
  | { kind: "slack"; url: string }
  | { kind: "teams"; url: string }
  | { kind: "webhook"; url: string; secret: string };

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  email: "E-Mail",
  slack: "Slack",
  teams: "Microsoft Teams",
  webhook: "Webhook",
};

export async function sealConfig(secret: string, cfg: ChannelConfig): Promise<string> {
  return encryptString(secret, JSON.stringify(cfg));
}

export async function openConfig(secret: string, enc: string): Promise<ChannelConfig> {
  return JSON.parse(await decryptString(secret, enc)) as ChannelConfig;
}

/** What admins see in lists: never the webhook path or secret, only enough to recognise it. */
export function summarize(cfg: ChannelConfig): string {
  switch (cfg.kind) {
    case "email":
      return cfg.recipients.join(", ");
    default: {
      const u = new URL(cfg.url);
      return `${u.host}${u.pathname.length > 1 ? "/…" : ""}`;
    }
  }
}

export interface Message {
  state: "firing" | "resolved" | "notice";
  severity: "critical" | "warning" | "info";
  title: string;
  body: string | null;
  url: string | null;
  context: string | null;
  at: Date;
  source: string;
  eventId: number;
}

export const STATE_LABEL: Record<Message["state"], string> = { firing: "PROBLEM", resolved: "BEHOBEN", notice: "HINWEIS" };
export const SEVERITY_LABEL: Record<string, string> = { critical: "kritisch", warning: "Warnung", info: "Info" };
export const SOURCE_LABEL: Record<string, string> = { uptime: "Uptime", tests: "Tests", errors: "Fehler", security: "Sicherheit", ops: "Ops", system: "System" };

/** Shows at a glance in an inbox or channel what went down (red), what is getting tight (yellow) and what came back. */
function stateMark(m: Pick<Message, "state" | "severity">): string {
  if (m.state === "resolved") return "🟢";
  if (m.state === "notice") return "ℹ️";
  return m.severity === "critical" ? "🔴" : "🟡";
}

/** The state as subject lines and chat messages lead with it, e.g. "🔴 PROBLEM". */
export function stateTag(m: Pick<Message, "state" | "severity">): string {
  return `${stateMark(m)} ${STATE_LABEL[m.state]}`;
}

export function subjectLine(m: Message): string {
  return `[Vantage] ${stateTag(m)}: ${m.title}`.slice(0, 250);
}

/** Slack mrkdwn: & < > are control characters (links are <url|text>); event text is never markup. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Teams TextBlocks render Markdown; breaking "](" keeps exception text from becoming a link. */
export function teamsEscape(text: string): string {
  return text.replace(/\]\(/g, "] (");
}

let transport: { url: string; mailer: Transporter } | null = null;
/** One pooled transport per relay address; a new address on /admin/integrations replaces it. */
function mailer(smtpUrl: string): Transporter {
  if (transport?.url !== smtpUrl) {
    transport?.mailer.close();
    transport = { url: smtpUrl, mailer: nodemailer.createTransport(smtpUrl) };
  }
  return transport.mailer;
}

/** Sends through the mail relay (integration "mail"), from its configured sender. */
export async function sendMail(mail: MailConnection, msg: { to: string[]; subject: string; text: string; html: string }): Promise<void> {
  await mailer(mail.smtpUrl).sendMail({ from: mail.from, ...msg });
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Vantage-Alerts/1.0", ...headers },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export interface DeliveryEnv {
  publicUrl: string;
  /** The mail relay (integration "mail"); null while none is set up. */
  mail: () => Promise<MailConnection | null>;
}

export async function deliver(env: DeliveryEnv, cfg: ChannelConfig | { kind: "user"; email: string }, m: Message): Promise<void> {
  switch (cfg.kind) {
    case "email":
    case "user": {
      const to = cfg.kind === "user" ? [cfg.email] : cfg.recipients;
      const opts: MailOptions = { publicUrl: env.publicUrl, recipient: cfg.kind === "user" ? "subscriber" : "channel" };
      const subject = subjectLine(m);
      const mail = await env.mail();
      if (!mail) throw new Error("E-Mail-Versand ist nicht eingerichtet (Verwaltung → Integrationen)");
      await sendMail(mail, { to, subject, text: renderMailText(m, opts), html: await renderMailHtml(m, subject, opts) });
      return;
    }
    case "slack":
      await postJson(cfg.url, { text: `*${stateTag(m)}*: ${slackEscape(m.title)}${m.context ? ` (${slackEscape(m.context)})` : ""}\n${slackEscape(m.body ?? "")}${m.url ? `\n<${m.url}|In Vantage öffnen>` : ""}` });
      return;
    case "teams":
      // Teams "Workflows" webhooks take an Adaptive Card wrapped in a message.
      await postJson(cfg.url, {
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: stateTag(m), weight: "Bolder", color: m.state === "resolved" ? "Good" : m.severity === "critical" ? "Attention" : "Warning" },
              { type: "TextBlock", text: teamsEscape(m.title), size: "Medium", weight: "Bolder", wrap: true },
              ...(m.context ? [{ type: "TextBlock", text: teamsEscape(m.context), isSubtle: true, wrap: true }] : []),
              ...(m.body ? [{ type: "TextBlock", text: teamsEscape(m.body), wrap: true }] : []),
            ],
            actions: m.url ? [{ type: "Action.OpenUrl", title: "In Vantage öffnen", url: m.url }] : [],
          },
        }],
      });
      return;
    case "webhook": {
      const body = {
        id: m.eventId,
        source: m.source,
        state: m.state,
        severity: m.severity,
        title: m.title,
        body: m.body,
        environment: m.context,
        url: m.url,
        at: m.at.toISOString(),
      };
      const payload = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      // Receivers verify HMAC-SHA256(secret, "<timestamp>.<body>") and reject old timestamps.
      await postJson(cfg.url, body, {
        "x-vantage-timestamp": timestamp,
        "x-vantage-signature": `sha256=${hmacHex(cfg.secret, `${timestamp}.${payload}`)}`,
      });
      return;
    }
  }
}
