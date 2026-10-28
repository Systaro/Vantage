/**
 * Vantage's e-mails: notifications and invites. Mail clients are not browsers: layout is tables, every colour sits in the
 * <style> blocks (bgcolor attributes are only the fallback for clients that drop styles), so the
 * dark-mode block can override colours without !important. Gmail drops a whole <style> block it does
 * not understand, hence two blocks: the base styles survive even if the dark-mode one is discarded.
 */
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { formatDate } from "../../../shared/ui/components";
import { SEVERITY_LABEL, SOURCE_LABEL, STATE_LABEL, type Message } from "./channels";

type Tone = "bad" | "warn" | "info" | "ok";

const TONES: Record<Tone, { light: [string, string, string]; dark: [string, string, string] }> = {
  // stripe, badge background, badge text
  bad: { light: ["#dc2626", "#fef1f1", "#c81e1e"], dark: ["#ef4444", "#2c1213", "#f87171"] },
  warn: { light: ["#d97706", "#fff7e6", "#b45309"], dark: ["#f59e0b", "#2a1f08", "#fbbf24"] },
  info: { light: ["#2563eb", "#eef4ff", "#1d4ed8"], dark: ["#7cb0ff", "#111d36", "#7cb0ff"] },
  ok: { light: ["#16a34a", "#ecfdf3", "#15803d"], dark: ["#22c55e", "#0d2619", "#4ade80"] },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

function toneRules(mode: "light" | "dark") {
  return (Object.keys(TONES) as Tone[])
    .map((t) => {
      const [stripe, soft, text] = TONES[t][mode];
      return `.card-${t}{border-top-color:${stripe}}.badge-${t}{background-color:${soft};color:${text}}`;
    })
    .join("");
}

const BASE_CSS = `
body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse}
.shell{border-collapse:separate}
td,p,h1,a,span,div{font-family:${FONT}}
.page{background-color:#f7f7f9}
.outer{padding:32px 16px}
.brand{padding:0 4px 16px}
.brand-name{font-size:15px;font-weight:700;color:#17171c;letter-spacing:-0.01em}
.card{background-color:#ffffff;border:1px solid #e6e6ec;border-top:4px solid #7c3aed;border-radius:14px}
.card-body{padding:28px 32px 32px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
.meta{font-size:13px;color:#5f5f6c;padding-left:8px}
.title{margin:16px 0 6px;font-size:21px;line-height:1.3;font-weight:700;color:#17171c}
.context{margin:0;font-size:14px;color:#5f5f6c}
.detail{margin:20px 0 0;padding:14px 16px;background-color:#f4f4f7;border:1px solid #e6e6ec;border-radius:10px;font-size:14px;line-height:1.5;color:#17171c;white-space:pre-wrap;word-break:break-word}
.detail-mono{font-family:${MONO};font-size:12.5px}
.facts{margin-top:20px}
.fact-label{padding:6px 16px 6px 0;font-size:13px;color:#8e8e9a;white-space:nowrap;vertical-align:top}
.fact-value{padding:6px 0;font-size:13.5px;color:#17171c}
.button-row{padding-top:24px}
.button{background-color:#7c3aed;border-radius:8px}
.button a{display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none}
.foot{padding:20px 8px 0;font-size:12px;line-height:1.6;color:#8e8e9a}
.foot a{color:#7c3aed}
.text{margin:14px 0 0;font-size:14.5px;line-height:1.6;color:#17171c}
.fine{margin:18px 0 0;font-size:12.5px;line-height:1.5;color:#8e8e9a}
.fine a{color:#7c3aed;word-break:break-all}
${toneRules("light")}
@media (max-width:600px){.outer{padding:16px 8px}.card-body{padding:22px 20px 24px}.title{font-size:19px}}
`;

const DARK_CSS = `
@media (prefers-color-scheme:dark){
.page{background-color:#0b0b0f}
.brand-name{color:#ececf1}
.card{background-color:#131318;border-color:#25252e}
.meta,.context{color:#a0a0ad}
.title,.fact-value,.text{color:#ececf1}
.detail{background-color:#1a1a21;border-color:#25252e;color:#ececf1}
.fact-label,.foot,.fine{color:#6f6f7c}
.foot a,.fine a{color:#a78bfa}
${toneRules("dark")}
}
`;

function toneOf(m: Message): Tone {
  if (m.state === "resolved") return "ok";
  return m.severity === "critical" ? "bad" : m.severity === "warning" ? "warn" : "info";
}

export interface MailOptions {
  publicUrl: string;
  /** Personal subscriptions can be managed by the recipient; channel addresses only by an admin. */
  recipient: "subscriber" | "channel";
}

function reason(opts: MailOptions): string {
  return opts.recipient === "subscriber"
    ? "Sie bekommen diese E-Mail, weil Sie in Vantage Benachrichtigungen abonniert haben."
    : "Diese Adresse ist in Vantage als Benachrichtigungskanal eingetragen. Ändern kann das ein Vantage-Administrator.";
}

function headline(m: Message): string {
  const severity = m.state === "resolved" ? null : SEVERITY_LABEL[m.severity];
  return [severity, SOURCE_LABEL[m.source] ?? m.source].filter(Boolean).join(" · ");
}

/** Head, logo, card and footer of every Vantage e-mail; the card's content comes from the caller. */
function MailFrame(props: { subject: string; preheader?: string; publicUrl: string; tone?: Tone; children: Child; foot: Child }) {
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="x-apple-disable-message-reformatting" />
        <meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{props.subject}</title>
        <style>{raw(BASE_CSS)}</style>
        <style>{raw(DARK_CSS)}</style>
      </head>
      <body class="page" bgcolor="#f7f7f9">
        {props.preheader && <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">{props.preheader}</div>}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border={0} class="page" bgcolor="#f7f7f9">
          <tr>
            <td align="center" class="outer">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border={0} class="shell" style="max-width:560px">
                <tr>
                  <td class="brand">
                    <table role="presentation" cellpadding="0" cellspacing="0" border={0}>
                      <tr>
                        <td style="padding-right:10px;line-height:0"><img src={new URL("/static/mail-logo.png", props.publicUrl).toString()} width="28" height="28" alt="" style="display:block;border:0" /></td>
                        <td class="brand-name">Vantage</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class={props.tone ? `card card-${props.tone}` : "card"} bgcolor="#ffffff">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border={0}>
                      <tr>
                        <td class="card-body">{props.children}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="foot">
                    {props.foot}
                    <br />
                    Vantage · Systaro GmbH
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  );
}

function MailButton(props: { href: string; label: string }) {
  return (
    <table role="presentation" cellpadding="0" cellspacing="0" border={0}>
      <tr>
        <td class="button-row">
          <table role="presentation" cellpadding="0" cellspacing="0" border={0}>
            <tr><td class="button" bgcolor="#7c3aed"><a href={props.href} style="color:#ffffff">{props.label}</a></td></tr>
          </table>
        </td>
      </tr>
    </table>
  );
}

function MailDocument(props: { m: Message; opts: MailOptions; subject: string }) {
  const { m, opts } = props;
  const manageUrl = new URL("/account/notifications", opts.publicUrl).toString();
  const preheader = [m.context, m.body?.split("\n")[0]].filter(Boolean).join(": ").slice(0, 140);
  return (
    <MailFrame
      subject={props.subject}
      preheader={preheader}
      publicUrl={opts.publicUrl}
      tone={toneOf(m)}
      foot={<>{reason(opts)}{opts.recipient === "subscriber" && <> <a href={manageUrl}>Benachrichtigungen verwalten</a></>}</>}
    >
      <table role="presentation" cellpadding="0" cellspacing="0" border={0}>
        <tr>
          <td><span class={`badge badge-${toneOf(m)}`}>{STATE_LABEL[m.state]}</span></td>
          <td class="meta">{headline(m)}</td>
        </tr>
      </table>
      <h1 class="title">{m.title}</h1>
      {m.context && <p class="context">{m.context}</p>}
      {m.body && <div class={m.source === "errors" ? "detail detail-mono" : "detail"}>{m.body}</div>}
      <table role="presentation" cellpadding="0" cellspacing="0" border={0} class="facts">
        <tr><td class="fact-label">Zeitpunkt</td><td class="fact-value">{formatDate(m.at)} Uhr</td></tr>
        <tr><td class="fact-label">Ereignis</td><td class="fact-value">#{m.eventId}</td></tr>
      </table>
      {m.url && <MailButton href={m.url} label="In Vantage öffnen" />}
    </MailFrame>
  );
}

export async function renderMailHtml(m: Message, subject: string, opts: MailOptions): Promise<string> {
  return `<!doctype html>${await (<MailDocument m={m} opts={opts} subject={subject} />).toString()}`;
}

export function renderMailText(m: Message, opts: MailOptions): string {
  return [
    `${STATE_LABEL[m.state]} · ${headline(m)}`,
    m.title,
    m.context,
    "",
    m.body,
    m.body ? "" : null,
    `Zeitpunkt: ${formatDate(m.at)} Uhr`,
    `Ereignis: #${m.eventId}`,
    m.url ? `In Vantage öffnen: ${m.url}` : null,
    "",
    "-- ",
    reason(opts),
    opts.recipient === "subscriber" ? `Benachrichtigungen verwalten: ${new URL("/account/notifications", opts.publicUrl)}` : null,
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

export interface InviteMail {
  name: string;
  email: string;
  link: string;
  expiresAt: Date;
  /** Who set the account up, as the invited person knows them. */
  invitedBy: string;
  publicUrl: string;
}

const INVITE_SUBJECT = "Ihr Zugang zu Vantage";

function inviteFoot(i: InviteMail): string {
  return `Sie bekommen diese E-Mail, weil ${i.invitedBy} von Systaro Ihnen einen Zugang zu Vantage angelegt hat. Haben Sie keinen erwartet, ignorieren Sie sie einfach: ohne den Link lässt sich der Zugang nicht benutzen.`;
}

function InviteDocument(props: { i: InviteMail }) {
  const { i } = props;
  return (
    <MailFrame subject={INVITE_SUBJECT} preheader={`${i.invitedBy} hat Ihnen einen Zugang zu Vantage angelegt.`} publicUrl={i.publicUrl} foot={inviteFoot(i)}>
      <h1 class="title">Ihr Zugang zu Vantage</h1>
      <p class="text">Hallo {i.name},</p>
      <p class="text">{i.invitedBy} hat Ihnen einen Zugang zu Vantage angelegt. Dort sehen Sie Verfügbarkeit, Testläufe, Fehler und Logs Ihrer Anwendungen.</p>
      <p class="text">Über den Button legen Sie Ihr Passwort fest und verbinden eine Authenticator-App, zum Beispiel Microsoft Authenticator, Google Authenticator oder 1Password.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border={0} class="facts">
        <tr><td class="fact-label">Anmeldung mit</td><td class="fact-value">{i.email}</td></tr>
        <tr><td class="fact-label">Gültig bis</td><td class="fact-value">{formatDate(i.expiresAt)} Uhr</td></tr>
      </table>
      <MailButton href={i.link} label="Zugang einrichten" />
      <p class="fine">Der Link funktioniert nur einmal. Falls der Button nicht geht, öffnen Sie diese Adresse:<br /><a href={i.link}>{i.link}</a></p>
    </MailFrame>
  );
}

export async function renderInviteMail(i: InviteMail): Promise<{ subject: string; html: string; text: string }> {
  const text = [
    "Ihr Zugang zu Vantage",
    "",
    `Hallo ${i.name},`,
    "",
    `${i.invitedBy} hat Ihnen einen Zugang zu Vantage angelegt. Dort sehen Sie Verfügbarkeit, Testläufe, Fehler und Logs Ihrer Anwendungen.`,
    "",
    "Über diesen Link legen Sie Ihr Passwort fest und verbinden eine Authenticator-App, zum Beispiel Microsoft Authenticator, Google Authenticator oder 1Password:",
    i.link,
    "",
    `Anmeldung mit: ${i.email}`,
    `Gültig bis: ${formatDate(i.expiresAt)} Uhr. Der Link funktioniert nur einmal.`,
    "",
    "-- ",
    inviteFoot(i),
  ].join("\n");
  return { subject: INVITE_SUBJECT, html: `<!doctype html>${await (<InviteDocument i={i} />).toString()}`, text };
}
