/**
 * Delivers outbox rows to the hub (`POST /api/internal/v1/events`), strictly in id order so a
 * `resolved` never overtakes its `firing`. A retryable failure (network, 5xx, 429) stops the batch
 * and backs off for the whole outbox (10 s doubling, capped at 1 h); any other 4xx marks that one
 * row failed and delivery continues with the next.
 */
import type { SQL } from "bun";
import { all } from "../shared/db";

export type Delivery = { kind: "sent"; hubId: number | null } | { kind: "retry"; error: string } | { kind: "permanent"; error: string };

export function classifyStatus(status: number): "sent" | "retry" | "permanent" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 429 || status >= 500) return "retry";
  return "permanent";
}

export function backoffMs(failures: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, failures - 1), 3_600_000);
}

export interface OutboxOptions {
  hubUrl: string;
  token: string | undefined;
  fetch?: typeof fetch;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export class OutboxSender {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private failures = 0;
  private notBefore = 0;
  lastError: string | null = null;
  lastSentAt: Date | null = null;

  constructor(private sql: SQL, private opts: OutboxOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.token);
  }

  /** When the next attempt is allowed after a retryable failure, or null when not backing off. */
  get backoffUntil(): Date | null {
    return this.notBefore > Date.now() ? new Date(this.notBefore) : null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.intervalMs ?? 5_000);
    void this.flush();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }

  /** Called after something was enqueued; respects the current backoff. */
  wake() {
    void this.flush();
  }

  flush(): Promise<void> {
    if (!this.configured || Date.now() < this.notBefore) return Promise.resolve();
    if (!this.busy) {
      this.busy = this.drain()
        .catch((err) => this.opts.log?.(`[ops] outbox: ${(err as Error).message}`))
        .finally(() => {
          this.busy = null;
        });
    }
    return this.busy;
  }

  private async drain() {
    for (;;) {
      const rows = await all<any>(this.sql`select id, subject, state, severity, title, body, link, environment
        from outbox where status = 'pending' order by id limit 50`);
      if (rows.length === 0) return;
      for (const row of rows) {
        const result = await this.deliver(row);
        if (result.kind === "sent") {
          await this.sql`update outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, last_attempt_at = now(),
                         last_error = null, hub_event_id = ${result.hubId} where id = ${row.id}`;
          this.failures = 0;
          this.lastError = null;
          this.lastSentAt = new Date();
        } else if (result.kind === "permanent") {
          await this.sql`update outbox set status = 'failed', attempts = attempts + 1, last_attempt_at = now(),
                         last_error = ${result.error} where id = ${row.id}`;
          this.lastError = result.error;
        } else {
          await this.sql`update outbox set attempts = attempts + 1, last_attempt_at = now(), last_error = ${result.error} where id = ${row.id}`;
          this.failures++;
          this.lastError = result.error;
          this.notBefore = Date.now() + backoffMs(this.failures);
          return;
        }
      }
    }
  }

  private async deliver(row: any): Promise<Delivery> {
    const payload: Record<string, string> = { subject: row.subject, state: row.state, severity: row.severity, title: row.title };
    if (row.environment) payload.environment = row.environment;
    if (row.body) payload.body = row.body;
    if (row.link) payload.link = row.link;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.hubUrl}/api/internal/v1/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { kind: "retry", error: `network: ${(err as Error).message}`.slice(0, 500) };
    }
    const text = (await res.text().catch(() => "")).slice(0, 500);
    const kind = classifyStatus(res.status);
    if (kind === "sent") {
      let hubId: number | null = null;
      try {
        const id = JSON.parse(text)?.id;
        hubId = Number.isSafeInteger(id) ? id : null;
      } catch {}
      return { kind, hubId };
    }
    return { kind, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  }
}
