/**
 * DEV ONLY: realistic logs and APM data in the local Elasticsearch, plus the matching
 * environment_sources rows. Run by scripts/seed.ts (which writes data/seed-world.json first).
 * Idempotent: the dev indices are deleted and recreated, the seeded environments' error groups are
 * rebuilt by one backfill poll.
 *   Webshop Produktion → logstash-shop-prod-*   + APM shop-backend / production
 *   Webshop Stage      → logstash-shop-stage-*  + APM shop-backend / staging
 *   Minenportal Prod.  → logstash-mine-prod-*   + APM mine-portal / production
 *   Webshop Produktion → logstash-shop-payments-prod-*, a second logs source (a service with its own
 *                        index family and no APM, as R2's services have)
 * logstash-crm-prod-* is a decoy family with no source, to see that patterns stay apart.
 */
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";
import { pollErrors } from "../src/hub/modules/errors/poller";
import { APM_ERROR_MAPPINGS, APM_TRANSACTION_MAPPINGS, assertLocalEs, bulkIndex, DEV_ES, es, LOGS_MAPPINGS, recreateIndex } from "./es-dev";

if (process.env.NODE_ENV === "production") throw new Error("seed is a development tool");
assertLocalEs(DEV_ES);
if (process.env.APM_ES_URL) assertLocalEs(process.env.APM_ES_URL);

const world = JSON.parse(await Bun.file("data/seed-world.json").text()) as { envs: Record<string, number> };
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Deterministic randomness, so two seeds look alike (timestamps still follow "now").
let state = 0x5eed;
function rand(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const normal = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
function weighted<T extends { w: number }>(xs: T[]): T {
  let r = rand() * xs.reduce((a, x) => a + x.w, 0);
  for (const x of xs) if ((r -= x.w) <= 0) return x;
  return xs.at(-1)!;
}
const berlinHour = (t: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(t));
/** Office-hours traffic: quiet at night, busy 8–20 h. */
const diurnal = (t: number) => {
  const h = berlinHour(t);
  return h >= 8 && h < 20 ? 1 : h >= 6 && h < 23 ? 0.5 : 0.15;
};

// ── Error catalogue ──────────────────────────────────────────────────────────────────────────────

interface Frame { classname: string; function: string; filename: string; line: { number: number }; library_frame: boolean; module?: string; exclude_from_grouping: boolean }
interface ErrorKind {
  type: string;
  message: string;
  culprit: string;
  handled: boolean;
  app: [string, string, number][];
  cause?: { type: string; message: string };
  /** only in the last N ms (a new group), or only older than N ms (gone from the 24 h backfill) */
  onlyWithin?: number;
  onlyBefore?: number;
}

const LIB_WEB: [string, string, string, number][] = [
  ["org.springframework.web.servlet.FrameworkServlet", "service", "FrameworkServlet.java", 897],
  ["org.springframework.web.servlet.DispatcherServlet", "doDispatch", "DispatcherServlet.java", 1072],
  ["org.apache.catalina.core.ApplicationFilterChain", "doFilter", "ApplicationFilterChain.java", 166],
  ["org.apache.coyote.http11.Http11Processor", "service", "Http11Processor.java", 399],
  ["org.apache.tomcat.util.threads.ThreadPoolExecutor$Worker", "run", "ThreadPoolExecutor.java", 659],
  ["java.lang.Thread", "run", "Thread.java", 840],
];

function frames(kind: ErrorKind): Frame[] {
  const app = kind.app.map(([classname, fn, line]) => ({
    classname, function: fn, filename: `${classname.split(".").at(-1)!.split("$")[0]}.java`, line: { number: line }, library_frame: false, exclude_from_grouping: false,
  }));
  const lib = LIB_WEB.map(([classname, fn, filename, line]) => ({ classname, function: fn, filename, line: { number: line }, library_frame: true, exclude_from_grouping: false }));
  // An app frame first, a few in the middle (controller), then the container: like real Spring traces.
  return [...app.slice(0, -1), lib[1]!, ...app.slice(-1), lib[0]!, ...lib.slice(2)];
}

function stackText(kind: ErrorKind): string {
  const lines = [`${kind.type}: ${kind.message}`, ...frames(kind).map((f) => `\tat ${f.classname}.${f.function}(${f.filename}:${f.line.number})`)];
  if (kind.cause) lines.push(`Caused by: ${kind.cause.type}: ${kind.cause.message}`, "\t... 42 common frames omitted");
  return lines.join("\n");
}

const SHOP_ERRORS: Record<string, ErrorKind> = {
  jdbc: {
    type: "org.springframework.dao.DataAccessResourceFailureException", message: "Unable to acquire JDBC Connection", culprit: "de.nordwind.shop.order.OrderRepository in findOpenOrders", handled: false,
    app: [["de.nordwind.shop.order.OrderRepository", "findOpenOrders", 54], ["de.nordwind.shop.checkout.CheckoutService", "placeOrder", 131], ["de.nordwind.shop.checkout.CheckoutController", "checkout", 48]],
    cause: { type: "java.sql.SQLTransientConnectionException", message: "HikariPool-1 - Connection is not available, request timed out after 30000ms." },
  },
  npe: {
    type: "java.lang.NullPointerException", message: 'Cannot invoke "de.nordwind.shop.cart.CartItem.getPrice()" because "item" is null', culprit: "de.nordwind.shop.cart.CartService in total", handled: false,
    app: [["de.nordwind.shop.cart.CartService", "total", 88], ["de.nordwind.shop.cart.CartController", "get", 37]],
  },
  declined: {
    type: "de.nordwind.shop.payment.PaymentDeclinedException", message: "Payment provider declined: insufficient_funds", culprit: "de.nordwind.shop.payment.PaymentClient in authorize", handled: true,
    app: [["de.nordwind.shop.payment.PaymentClient", "authorize", 112], ["de.nordwind.shop.checkout.CheckoutService", "placeOrder", 140], ["de.nordwind.shop.checkout.CheckoutController", "checkout", 48]],
  },
  timeout: {
    type: "java.net.SocketTimeoutException", message: "Read timed out", culprit: "de.nordwind.shop.payment.PaymentClient in authorize", handled: false,
    app: [["de.nordwind.shop.payment.PaymentClient", "authorize", 109], ["de.nordwind.shop.checkout.CheckoutService", "placeOrder", 140], ["de.nordwind.shop.checkout.CheckoutController", "checkout", 48]],
  },
  credentials: {
    type: "org.springframework.security.authentication.BadCredentialsException", message: "Bad credentials", culprit: "de.nordwind.shop.auth.LoginController in login", handled: true,
    app: [["de.nordwind.shop.auth.LoginService", "authenticate", 61], ["de.nordwind.shop.auth.LoginController", "login", 29]],
  },
  format: {
    type: "com.fasterxml.jackson.databind.exc.InvalidFormatException", message: 'Cannot deserialize value of type `java.math.BigDecimal` from String "12,50": not a valid representation', culprit: "de.nordwind.shop.cart.CartController in addItem", handled: true,
    app: [["de.nordwind.shop.cart.CartController", "addItem", 52]],
  },
  inventory: {
    type: "java.lang.IllegalStateException", message: "Inventory reservation expired before payment completed", culprit: "de.nordwind.shop.inventory.InventoryService in confirm", handled: false,
    app: [["de.nordwind.shop.inventory.InventoryService", "confirm", 77], ["de.nordwind.shop.checkout.CheckoutService", "placeOrder", 152], ["de.nordwind.shop.checkout.CheckoutController", "checkout", 48]],
    onlyWithin: 40 * MIN,
  },
  oom: {
    type: "java.lang.OutOfMemoryError", message: "Java heap space", culprit: "de.nordwind.shop.export.CsvExporter in writeAll", handled: false,
    app: [["de.nordwind.shop.export.CsvExporter", "writeAll", 203], ["de.nordwind.shop.export.ExportController", "orders", 31]],
    onlyBefore: 3 * DAY,
  },
  classcast: {
    type: "java.lang.ClassCastException", message: "class java.lang.Integer cannot be cast to class java.lang.Long", culprit: "de.nordwind.shop.order.OrderMapper in toDto", handled: false,
    app: [["de.nordwind.shop.order.OrderMapper", "toDto", 44], ["de.nordwind.shop.order.OrderController", "list", 26]],
  },
};

const MINE_ERRORS: Record<string, ErrorKind> = {
  sensor: {
    type: "java.util.concurrent.TimeoutException", message: "Sensor gateway did not respond within 5000 ms", culprit: "de.bergbau.portal.sensors.SensorClient in readings", handled: false,
    app: [["de.bergbau.portal.sensors.SensorClient", "readings", 71], ["de.bergbau.portal.sensors.SensorController", "readings", 33]],
  },
  lazy: {
    type: "org.hibernate.LazyInitializationException", message: "could not initialize proxy [de.bergbau.portal.shifts.Crew#118] - no Session", culprit: "de.bergbau.portal.shifts.ShiftService in planFor", handled: false,
    app: [["de.bergbau.portal.shifts.ShiftService", "planFor", 96], ["de.bergbau.portal.shifts.ShiftController", "list", 41]],
  },
  shift: {
    type: "java.lang.IllegalArgumentException", message: "Unknown shift type: NACHT2", culprit: "de.bergbau.portal.shifts.ShiftType in parse", handled: true,
    app: [["de.bergbau.portal.shifts.ShiftType", "parse", 22], ["de.bergbau.portal.reports.ReportController", "create", 58]],
  },
};

// ── Services ─────────────────────────────────────────────────────────────────────────────────────

interface TxKind { name: string; w: number; ms: number; fail: number; errors: string[]; logger: string; log: string }
interface Service {
  envId: number;
  name: string;
  environment: string;
  appname: string;
  logEnv: string;
  logIndexPrefix: string;
  hosts: string[];
  version: string;
  perMinute: number;
  logChance: number;
  tx: TxKind[];
  errors: Record<string, ErrorKind>;
  background: { logger: string; level: string; message: string; w: number }[];
  /** A degraded window: the named transaction gets slow and fails often. */
  incident?: { from: number; to: number; tx: string; slow: number; fail: number; error: string };
}

const SHOP_TX: TxKind[] = [
  { name: "GET /api/products", w: 40, ms: 45, fail: 0.002, errors: [], logger: "de.nordwind.shop.catalog.ProductController", log: "Listed products (category=%c, page=%p)" },
  { name: "GET /api/products/{id}", w: 25, ms: 30, fail: 0.002, errors: [], logger: "de.nordwind.shop.catalog.ProductController", log: "Product %n loaded from cache" },
  { name: "GET /api/cart", w: 12, ms: 25, fail: 0.01, errors: ["npe"], logger: "de.nordwind.shop.cart.CartController", log: "Cart %n has %p items" },
  { name: "POST /api/cart/items", w: 8, ms: 60, fail: 0.01, errors: ["format"], logger: "de.nordwind.shop.cart.CartController", log: "Added item %n to cart" },
  { name: "POST /api/checkout", w: 4, ms: 420, fail: 0.04, errors: ["declined", "timeout", "inventory"], logger: "de.nordwind.shop.checkout.CheckoutService", log: "Order %n placed, total %p EUR" },
  { name: "GET /api/orders", w: 6, ms: 80, fail: 0.004, errors: ["classcast", "oom"], logger: "de.nordwind.shop.order.OrderController", log: "Listed %p orders for customer %n" },
  { name: "POST /api/login", w: 5, ms: 150, fail: 0.03, errors: ["credentials"], logger: "de.nordwind.shop.auth.LoginController", log: "Login for customer %n" },
];

const SHOP_BACKGROUND = [
  { logger: "de.nordwind.shop.jobs.PriceSyncJob", level: "INFO", message: "Price sync finished: %p prices updated in %n ms", w: 3 },
  { logger: "de.nordwind.shop.jobs.AbandonedCartJob", level: "INFO", message: "Abandoned cart reminder sent to %p customers", w: 1 },
  { logger: "com.zaxxer.hikari.pool.HikariPool", level: "DEBUG", message: "HikariPool-1 - Pool stats (total=10, active=%p, idle=%n, waiting=0)", w: 4 },
  { logger: "org.springframework.web.servlet.PageNotFound", level: "WARN", message: "No mapping for GET /wp-login.php", w: 1 },
  { logger: "de.nordwind.shop.catalog.SearchIndexer", level: "WARN", message: "Search index lag is %p s, threshold 30 s", w: 1 },
  { logger: "de.nordwind.shop.mail.MailService", level: "INFO", message: "Order confirmation mail queued for order %n", w: 2 },
];

const MINE_TX: TxKind[] = [
  { name: "GET /portal/dashboard", w: 30, ms: 120, fail: 0.003, errors: [], logger: "de.bergbau.portal.web.DashboardController", log: "Dashboard rendered for site %c" },
  { name: "GET /portal/shifts", w: 25, ms: 90, fail: 0.01, errors: ["lazy"], logger: "de.bergbau.portal.shifts.ShiftController", log: "Shift plan for crew %n loaded (%p entries)" },
  { name: "POST /portal/reports", w: 10, ms: 260, fail: 0.02, errors: ["shift"], logger: "de.bergbau.portal.reports.ReportController", log: "Shift report %n submitted" },
  { name: "GET /api/sensors/{id}/readings", w: 30, ms: 900, fail: 0.03, errors: ["sensor"], logger: "de.bergbau.portal.sensors.SensorController", log: "Fetched %p readings from sensor %n" },
  { name: "POST /api/login", w: 5, ms: 140, fail: 0.01, errors: [], logger: "de.bergbau.portal.auth.LoginController", log: "Login for user %n" },
];

const MINE_BACKGROUND = [
  { logger: "de.bergbau.portal.sensors.SensorPoller", level: "INFO", message: "Polled %p sensors on site %c", w: 4 },
  { logger: "de.bergbau.portal.sensors.SensorPoller", level: "WARN", message: "Sensor %n reported no value for %p minutes", w: 1 },
  { logger: "de.bergbau.portal.jobs.ShiftExport", level: "INFO", message: "Exported shift plan to SAP (%p rows)", w: 1 },
  { logger: "org.hibernate.engine.jdbc.spi.SqlExceptionHelper", level: "DEBUG", message: "SQL statement took %p ms", w: 2 },
];

const services: Service[] = [
  {
    envId: world.envs.shopProd!, name: "shop-backend", environment: "production", appname: "shop-backend", logEnv: "prod", logIndexPrefix: "logstash-shop-prod",
    hosts: ["shop-app-1", "shop-app-2"], version: "2.14.3", perMinute: 3, logChance: 0.15, tx: SHOP_TX, errors: SHOP_ERRORS, background: SHOP_BACKGROUND,
    incident: { from: NOW - 3 * HOUR - 25 * MIN, to: NOW - 3 * HOUR, tx: "POST /api/checkout", slow: 6, fail: 0.35, error: "jdbc" },
  },
  {
    envId: world.envs.shopStage!, name: "shop-backend", environment: "staging", appname: "shop-backend", logEnv: "stage", logIndexPrefix: "logstash-shop-stage",
    hosts: ["shop-stage-1"], version: "2.15.0-rc.2", perMinute: 0.4, logChance: 0.3, tx: SHOP_TX, errors: { npe: SHOP_ERRORS.npe!, classcast: SHOP_ERRORS.classcast!, credentials: SHOP_ERRORS.credentials! }, background: SHOP_BACKGROUND,
  },
  {
    envId: world.envs.mineProd!, name: "mine-portal", environment: "production", appname: "mine-portal", logEnv: "production", logIndexPrefix: "logstash-mine-prod",
    hosts: ["portal-1"], version: "5.2.1", perMinute: 1.2, logChance: 0.15, tx: MINE_TX, errors: MINE_ERRORS, background: MINE_BACKGROUND,
  },
];

const LEVEL_VALUE: Record<string, number> = { ERROR: 40000, WARN: 30000, INFO: 20000, DEBUG: 10000 };
const fill = (tpl: string) =>
  tpl.replace("%c", pick(["schuhe", "jacken", "zubehoer", "nord", "sued", "stollen-3"])).replace("%p", String(Math.floor(rand() * 40) + 1)).replace("%n", String(Math.floor(rand() * 90000) + 1000));
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
// APM 7.x grouping keys are hex hashes of the exception type and culprit frames.
const md5 = (s: string) => new Bun.CryptoHasher("md5").update(s).digest("hex");

const transactions: Record<string, unknown>[] = [];
const errors: Record<string, unknown>[] = [];
const logs = new Map<string, Record<string, unknown>[]>();
const addLog = (index: string, doc: Record<string, unknown>) => {
  if (!logs.has(index)) logs.set(index, []);
  logs.get(index)!.push(doc);
};

for (const s of services) {
  const groupKeys = new Map<string, string>();
  for (const [id, kind] of Object.entries(s.errors)) groupKeys.set(id, md5(`${s.name}|${kind.type}|${kind.culprit}`));
  const thread = () => `http-nio-8080-exec-${Math.floor(rand() * 40) + 1}`;
  const logDoc = (t: number, level: string, logger: string, message: string, extra: Record<string, unknown> = {}) => ({
    "@timestamp": new Date(t).toISOString(), "@version": "1", appname: s.appname, environment: s.logEnv, level, level_value: LEVEL_VALUE[level],
    logger_name: logger, message, thread_name: extra.thread ?? "main", localhostname: pick(s.hosts), host: `10.0.3.${Math.floor(rand() * 200) + 10}`,
    ...(extra.trace ? { "trace.id": extra.trace, "transaction.id": extra.txId } : {}),
    ...(extra.stack ? { stack_trace: extra.stack } : {}),
  });

  const emitError = (id: string, e: ErrorKind, at: number, trace: string, txId: string, txName: string, host: string, th: string) => {
    errors.push({
      "@timestamp": new Date(at).toISOString(), processor: { event: "error", name: "error" },
      service: { name: s.name, environment: s.environment, version: s.version, language: { name: "Java" } },
      error: {
        id: hex(32), grouping_key: groupKeys.get(id), culprit: e.culprit,
        exception: [
          { type: e.type, message: e.message, handled: e.handled, module: e.type.split(".").slice(0, -1).join("."), stacktrace: frames(e) },
          ...(e.cause ? [{ type: e.cause.type, message: e.cause.message, handled: e.handled }] : []),
        ],
      },
      trace: { id: trace }, transaction: { id: txId, name: txName, type: "request", sampled: true }, parent: { id: txId }, host: { hostname: host, name: host },
    });
    addLog(`${s.logIndexPrefix}-${monthOf(at)}`, logDoc(at, e.handled ? "WARN" : "ERROR", e.culprit.split(" in ")[0]!, e.handled ? `${e.message}` : `Request failed: ${e.message}`, { trace, txId, thread: th, stack: stackText(e) }));
  };
  const recent: { doc: any; t: number; ms: number }[] = [];
  const seenRecently = new Set<string>();

  for (let m = NOW - 7 * DAY; m < NOW; m += MIN) {
    const expected = s.perMinute * diurnal(m);
    const count = Math.floor(expected + rand());
    for (let i = 0; i < count; i++) {
      const t = m + Math.floor(rand() * MIN);
      if (t > NOW) continue;
      const kind = weighted(s.tx);
      const inIncident = s.incident && t >= s.incident.from && t < s.incident.to && kind.name === s.incident.tx;
      const ms = kind.ms * Math.exp(normal() * 0.45) * (inIncident ? s.incident!.slow : 1);
      const failed = rand() < (inIncident ? s.incident!.fail : kind.fail);
      const trace = hex(32);
      const txId = hex(16);
      const host = pick(s.hosts);
      const doc = {
        "@timestamp": new Date(t).toISOString(), processor: { event: "transaction", name: "transaction" },
        service: { name: s.name, environment: s.environment, version: s.version, language: { name: "Java" } },
        transaction: { id: txId, name: kind.name, type: "request", duration: { us: Math.round(ms * 1000) }, result: failed ? "HTTP 5xx" : "HTTP 2xx", sampled: true },
        event: { outcome: failed ? "failure" : "success" }, trace: { id: trace }, host: { hostname: host, name: host }, agent: { name: "java", version: "1.26.0" },
      };
      transactions.push(doc);
      if (t > NOW - DAY && !failed) recent.push({ doc, t, ms });
      const th = thread();
      if (rand() < s.logChance) addLog(`${s.logIndexPrefix}-${monthOf(t)}`, logDoc(t + 2, "INFO", kind.logger, fill(kind.log), { trace, txId, thread: th }));
      if (!failed) continue;
      const candidates = (inIncident ? [s.incident!.error] : kind.errors)
        .map((id) => [id, s.errors[id]] as const)
        .filter((e): e is readonly [string, ErrorKind] => !!e[1])
        .filter(([, e]) => (!e.onlyWithin || t > NOW - e.onlyWithin) && (!e.onlyBefore || t < NOW - e.onlyBefore));
      if (candidates.length === 0) continue;
      const [id, e] = pick([...candidates]);
      if (t > NOW - 20 * HOUR) seenRecently.add(id);
      emitError(id, e, t + Math.round(ms * 0.8), trace, txId, kind.name, host, th);
    }
  }

  // At night the last 24 h may hold no failure of some kinds; give every current kind a few recent
  // occurrences on real transactions (flipped to failed), so the error list is representative.
  for (const [id, e] of Object.entries(s.errors)) {
    if (e.onlyBefore || seenRecently.has(id)) continue;
    const names = s.tx.filter((k) => k.errors.includes(id)).map((k) => k.name);
    if (s.incident?.error === id) names.push(s.incident.tx);
    const window = e.onlyWithin ?? 20 * HOUR;
    const pool = recent.filter((r) => names.includes(r.doc.transaction.name) && r.t > NOW - window && r.doc.event.outcome === "success");
    for (let i = 0; i < 1 + Math.floor(rand() * 3) && pool.length; i++) {
      const r = pool.splice(Math.floor(rand() * pool.length), 1)[0]!;
      r.doc.event.outcome = "failure";
      r.doc.transaction.result = "HTTP 5xx";
      emitError(id, e, Math.min(NOW, r.t + Math.round(r.ms * 0.8)), r.doc.trace.id, r.doc.transaction.id, r.doc.transaction.name, r.doc.host.hostname, thread());
    }
  }

  // Scheduler and infrastructure lines without a trace; for shop prod also further back, so the
  // September index exists and the preview shows one family with two indices.
  const backTo = s.envId === world.envs.shopProd ? NOW - 20 * DAY : NOW - 7 * DAY;
  for (let t = backTo; t < NOW; t += Math.floor(MIN * (2 + rand() * 6))) {
    const b = weighted(s.background);
    addLog(`${s.logIndexPrefix}-${monthOf(t)}`, logDoc(t, b.level, b.logger, fill(b.message), { thread: pick(["scheduling-1", "scheduling-2", "task-3"]) }));
  }
}

// Decoy: a neighbour application's logs that no seeded source may ever show.
for (let t = NOW - 7 * DAY; t < NOW; t += 10 * MIN) {
  addLog(`logstash-crm-prod-${monthOf(t)}`, {
    "@timestamp": new Date(t).toISOString(), "@version": "1", appname: "crm", environment: "prod", level: "INFO", level_value: 20000,
    logger_name: "de.nordwind.crm.sync.ContactSync", message: `Synced ${Math.floor(rand() * 50)} contacts`, thread_name: "scheduling-1", localhostname: "crm-1", host: "10.0.4.11",
  });
}

// The Webshop's payment service: own index family, log lines only, a few failed captures.
const PAYMENT_LINES = [
  { logger: "de.nordwind.payments.PspClient", level: "INFO", message: "Payment %n authorised (%p EUR)", w: 6 },
  { logger: "de.nordwind.payments.WebhookHandler", level: "INFO", message: "PSP webhook for payment %n processed", w: 3 },
  { logger: "de.nordwind.payments.PspClient", level: "WARN", message: "PSP answered after %p s, retrying payment %n", w: 1 },
  { logger: "de.nordwind.payments.CaptureJob", level: "ERROR", message: "Capture failed for payment %n", w: 0.3 },
];
const PAYMENT_STACK = [
  "de.nordwind.payments.PspException: capture declined by acquirer",
  "\tat de.nordwind.payments.PspClient.capture(PspClient.java:88)",
  "\tat de.nordwind.payments.CaptureJob.run(CaptureJob.java:41)",
  "\tat org.springframework.scheduling.support.DelegatingErrorHandlingRunnable.run(DelegatingErrorHandlingRunnable.java:54)",
].join("\n");
for (let t = NOW - 7 * DAY; t < NOW; t += Math.floor(MIN * (3 + rand() * 6))) {
  const b = weighted(PAYMENT_LINES);
  addLog(`logstash-shop-payments-prod-${monthOf(t)}`, {
    "@timestamp": new Date(t).toISOString(), "@version": "1", appname: "shop-payments", environment: "prod", level: b.level, level_value: LEVEL_VALUE[b.level],
    logger_name: b.logger, message: fill(b.message), thread_name: "scheduling-1", localhostname: "pay-1", host: "10.0.3.40",
    ...(b.level === "ERROR" ? { stack_trace: PAYMENT_STACK } : {}),
  });
}

// ── Write ────────────────────────────────────────────────────────────────────────────────────────

const existing = (await es("GET", "/_cat/indices/logstash-shop-*,logstash-mine-*,logstash-crm-*,apm-7.15.0-*?format=json&h=index&expand_wildcards=all")) as { index: string }[];
for (const { index } of existing) await es("DELETE", `/${index}`);

await recreateIndex("apm-7.15.0-transaction-000001", APM_TRANSACTION_MAPPINGS);
await recreateIndex("apm-7.15.0-error-000001", APM_ERROR_MAPPINGS);
await bulkIndex("apm-7.15.0-transaction-000001", transactions);
await bulkIndex("apm-7.15.0-error-000001", errors);
for (const [index, docs] of logs) {
  await recreateIndex(index, LOGS_MAPPINGS);
  await bulkIndex(index, docs);
}
await es("POST", "/_refresh");

const sql = connect(env("HUB_MIGRATE_URL"), 2);
const envIds = services.map((s) => s.envId);
const logSources = [
  ...services.map((s) => ({ envId: s.envId, prefix: s.logIndexPrefix })),
  { envId: world.envs.shopProd!, prefix: "logstash-shop-payments-prod" },
];
for (const l of logSources) {
  await sql`insert into environment_sources (environment_id, kind, name, config) values (${l.envId}, 'logs', ${l.prefix.replace(/^logstash-/, "")}, ${{ index: `${l.prefix}-*` }}::jsonb)
            on conflict (environment_id, lower(name)) where kind = 'logs' do update set config = excluded.config`;
}
for (const s of services) {
  await sql`insert into environment_sources (environment_id, kind, config) values (${s.envId}, 'apm', ${{ service: s.name, environment: s.environment }}::jsonb)
            on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`;
}
// Rebuild the error groups from scratch with one backfill poll (silent, as in production).
await sql`delete from events where source = 'errors' and environment_id = any(${sql.array(envIds, "int4")})`;
await sql`delete from error_groups where environment_id = any(${sql.array(envIds, "int4")})`;
await sql`delete from error_poll_state where environment_id = any(${sql.array(envIds, "int4")})`;
// The logs are read again by the worker's next poll, its silent backfill of the last day.
await sql`delete from log_error_poll_state where source_id in (select id from environment_sources where environment_id = any(${sql.array(envIds, "int4")}))`;
await pollErrors(sql, (m) => console.log(m));
const [{ n }] = (await sql`select count(*)::int as n from error_groups where environment_id = any(${sql.array(envIds, "int4")})`) as [{ n: number }];
await sql.end();

console.log(
  `seeded es: ${transactions.length} transactions, ${errors.length} errors, ${[...logs.values()].reduce((a, d) => a + d.length, 0)} log lines in ${logs.size} indices; ${n} error groups`,
);
