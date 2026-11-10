import type { SQL } from "bun";
import type { AuthStore, SessionUser } from "../shared/auth";

/** Every call goes through a SECURITY DEFINER function; the hub role cannot read these tables. */
export function hubAuthStore(sql: SQL): AuthStore {
  return {
    async userForLogin(email) {
      const [row] = (await sql`select * from auth_user_for_login(${email})`) as any[];
      return row ? { id: row.id, passwordHash: row.password_hash, totpSecretEnc: row.totp_secret_enc, disabled: row.disabled } : null;
    },
    async userForLoginById(id) {
      const [row] = (await sql`select * from auth_user_for_totp(${id})`) as any[];
      return row ? { email: row.email, totpSecretEnc: row.totp_secret_enc, disabled: row.disabled } : null;
    },
    async recordAttempt(email, ip, ok) {
      await sql`select auth_record_attempt(${email}, ${ip}, ${ok})`;
    },
    async recentFailures(email, ip, windowSeconds) {
      const [row] = (await sql`select * from auth_recent_failures(${email}, ${ip}, ${windowSeconds})`) as any[];
      return { byEmail: row?.by_email ?? 0, byIp: row?.by_ip ?? 0 };
    },
    async createSession(userId, tokenHash, expiresAt, ip, userAgent) {
      await sql`select auth_create_session(${userId}, ${tokenHash}, ${expiresAt}, ${ip}, ${userAgent})`;
    },
    async sessionUser(tokenHash, idleSeconds): Promise<SessionUser | null> {
      const [row] = (await sql`select * from auth_session(${tokenHash}, ${idleSeconds})`) as any[];
      if (!row) return null;
      return { sessionId: row.session_id, id: row.user_id, email: row.email, name: row.name, isAdmin: row.is_admin, role: row.kind };
    },
    async revokeSession(tokenHash) {
      await sql`select auth_revoke_session(${tokenHash})`;
    },
    async invite(tokenHash) {
      const [row] = (await sql`select * from auth_invite(${tokenHash})`) as any[];
      return row ? { userId: row.user_id, email: row.email, name: row.name, pendingTotpEnc: row.pending_totp_enc } : null;
    },
    async setInvitePendingTotp(tokenHash, totpEnc) {
      await sql`select auth_invite_set_pending_totp(${tokenHash}, ${totpEnc})`;
    },
    async acceptInvite(tokenHash, passwordHash) {
      const [row] = (await sql`select auth_accept_invite(${tokenHash}, ${passwordHash}) as id`) as any[];
      return row?.id ?? null;
    },
    devices: {
      async trust(userId, tokenHash, expiresAt, ip, userAgent) {
        const [row] = (await sql`select auth_trust_device(${userId}, ${tokenHash}, ${expiresAt}, ${ip}, ${userAgent}) as id`) as any[];
        return row.id;
      },
      async use(userId, tokenHash, ip) {
        const [row] = (await sql`select * from auth_use_device(${userId}, ${tokenHash}, ${ip}) as id`) as any[];
        return row?.id ?? null;
      },
      async revoke(tokenHash) {
        await sql`select auth_revoke_device(${tokenHash})`;
      },
    },
    async audit(userId, action, detail, ip, label) {
      await sql.begin(async (tx) => {
        if (userId !== null) await tx`select set_config('vantage.user_id', ${String(userId)}, true)`;
        await tx`select audit(${action}, null, ${detail}::jsonb, ${ip}, ${label ?? null})`;
      });
    },
  };
}
