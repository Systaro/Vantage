import type { Hono } from "hono";
import { parseId } from "../../shared/http";
import { Card, Empty, formatDate, PageHead } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { all } from "../../shared/db";
import type { Ops } from "../service";
import { OpsPage } from "../ui";

const PAGE = 100;

export function mountAudit(app: Hono, ops: Ops) {
  app.get("/audit", async (c) => {
    const before = parseId(c.req.query("before"));
    const action = (c.req.query("action") ?? "").slice(0, 60);
    const rows = await all<any>(ops.sql`
      select id, at, actor_label, action, target, detail, ip from audit_log
      where (${before}::bigint is null or id < ${before}::bigint)
        and (${action} = '' or starts_with(action, ${action}))
      order by id desc limit ${PAGE}`);
    const last = rows.at(-1);
    return c.html(
      <OpsPage c={c} title="Protokoll" section="audit">
        <PageHead icon="scroll-text" title="Protokoll" sub="Jede Änderung und jede Anmeldung in Vantage Ops, zwei Jahre lang." />
        <Card flush title={
          <form method="get" action="/audit" class="ops-filter" role="search">
            <span class="search-field">
              <Icon name="search" size="sm" />
              <input type="search" name="action" value={action} placeholder="Aktion, z. B. login. oder template." aria-label="Nach Aktion filtern" />
            </span>
            <button class="btn small" type="submit"><Icon name="filter" size="sm" />Filtern</button>
            {action && <a class="btn small ghost" href="/audit"><Icon name="x" size="sm" />Zurücksetzen</a>}
          </form>
        }>
          {rows.length === 0 ? (
            <Empty title={action ? `Keine Einträge für „${action}“` : "Keine Einträge"} icon="scroll-text" />
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Ziel</th><th>Details</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr>
                  <td class="nowrap">{formatDate(r.at)}</td>
                  <td>{r.actor_label ?? <span class="subtle">–</span>}{r.ip && <span class="cell-sub mono">{r.ip}</span>}</td>
                  <td class="nowrap"><code>{r.action}</code></td>
                  <td class="small">{r.target}</td>
                  <td class="small mono ops-detail">{Object.keys(r.detail ?? {}).length ? JSON.stringify(r.detail) : ""}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        {rows.length === PAGE && last && (
          <div class="ops-pager"><a class="btn" href={`/audit?before=${last.id}${action ? `&action=${encodeURIComponent(action)}` : ""}`}>Ältere Einträge<Icon name="arrow-right" size="sm" /></a></div>
        )}
      </OpsPage>,
    );
  });
}
