import type { SQL } from "bun";
import type { AuthStore, SessionUser } from "../shared/auth";
import { first } from "../shared/db";

/** Ops owns its tables outright (one role, no RLS), so the store is plain SQL. */
export function opsAuthStore(sql: SQL): AuthStore {
  return {
    async userForLogin(email) {
      const row = await first<any>(sql`select id, password_hash, totp_secret_enc, disabled_at is not null as disabled from users where email = lower(${email})`);
      return row ? { id: row.id, passwordHash: row.password_hash, totpSecretEnc: row.totp_secret_enc, disabled: row.disabled } : null;
    },
    async userForLoginById(id) {
      const row = await first<any>(sql`select email, totp_secret_enc, disabled_at is not null as disabled from users where id = ${id}`);
      return row ? { email: row.email, totpSecretEnc: row.totp_secret_enc, disabled: row.disabled } : null;
    },
    async recordAttempt(email, ip, ok) {
      await sql`insert into login_attempts (email, ip, ok) values (lower(${email}), ${ip}, ${ok})`;
    },
    async recentFailures(email, ip, windowSeconds) {
      const row = await first<any>(sql`select
        (select count(*)::int from login_attempts where email = lower(${email}) and not ok and at > now() - make_interval(secs => ${windowSeconds})) as by_email,
        (select count(*)::int from login_attempts where ip = ${ip} and not ok and at > now() - make_interval(secs => ${windowSeconds})) as by_ip`);
      return { byEmail: row?.by_email ?? 0, byIp: row?.by_ip ?? 0 };
    },
    async createSession(userId, tokenHash, expiresAt, ip, userAgent) {
      await sql.begin(async (tx) => {
        await tx`insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values (${userId}, ${tokenHash}, ${expiresAt}, ${ip}, ${userAgent.slice(0, 300)})`;
        await tx`update users set last_login_at = now() where id = ${userId}`;
      });
    },
    async sessionUser(tokenHash, idleSeconds): Promise<SessionUser | null> {
      const row = await first<any>(sql`
        update sessions s set last_seen_at = now()
        from users u
        where s.token_hash = ${tokenHash} and u.id = s.user_id and s.revoked_at is null and s.expires_at > now()
          and s.last_seen_at > now() - make_interval(secs => ${idleSeconds}) and u.disabled_at is null
          and u.password_hash is not null and u.totp_secret_enc is not null
        returning s.id as session_id, u.id, u.email, u.name, u.role`);
      if (!row) return null;
      return { sessionId: row.session_id, id: row.id, email: row.email, name: row.name, isAdmin: row.role === "admin", role: row.role };
    },
    async revokeSession(tokenHash) {
      await sql`update sessions set revoked_at = now() where token_hash = ${tokenHash} and revoked_at is null`;
    },
    async invite(tokenHash) {
      const row = await first<any>(sql`
        select u.id as user_id, u.email, u.name, i.pending_totp_enc from invites i join users u on u.id = i.user_id
        where i.token_hash = ${tokenHash} and i.used_at is null and i.expires_at > now() and u.disabled_at is null`);
      return row ? { userId: row.user_id, email: row.email, name: row.name, pendingTotpEnc: row.pending_totp_enc } : null;
    },
    async setInvitePendingTotp(tokenHash, totpEnc) {
      await sql`update invites set pending_totp_enc = ${totpEnc}
                where token_hash = ${tokenHash} and used_at is null and expires_at > now() and pending_totp_enc is null`;
    },
    async acceptInvite(tokenHash, passwordHash) {
      return (await sql.begin(async (tx) => {
        const inv = await first<any>(tx`
          select i.id, i.user_id, i.pending_totp_enc from invites i join users u on u.id = i.user_id
          where i.token_hash = ${tokenHash} and i.used_at is null and i.expires_at > now() and u.disabled_at is null
          for update of i`);
        if (!inv?.pending_totp_enc) return null;
        await tx`update invites set used_at = now() where user_id = ${inv.user_id} and used_at is null`;
        await tx`update users set password_hash = ${passwordHash}, totp_secret_enc = ${inv.pending_totp_enc} where id = ${inv.user_id}`;
        return inv.user_id as number;
      })) as number | null;
    },
    async audit(userId, action, detail, ip, label) {
      await sql`insert into audit_log (actor_id, actor_label, action, detail, ip)
        values (${userId}, coalesce(${label ?? null}, (select email from users where id = ${userId})), ${action}, ${detail}::jsonb, ${ip})`;
    },
  };
}
