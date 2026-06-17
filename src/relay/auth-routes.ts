// src/relay/auth-routes.ts
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { RelayConfig } from "./config";
import type { TokenManager } from "./token-manager";
import type { AuditLog } from "../audit/logger";
import { buildAuthorizeUrl, pkceChallenge } from "./oauth";

const STATE_TTL_SEC = 600;
const rand = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

export function authRoutes(deps: { config: RelayConfig; managers: Record<string, TokenManager>; db: Database; audit: AuditLog }): Hono {
  const { config, managers, db, audit } = deps;
  const router = new Hono();

  router.get("/auth/:provider/login", async (c) => {
    const name = c.req.param("provider"); const provider = config.providers[name];
    if (!provider) return c.text("unknown provider", 404);
    const state = rand(); const nonce = crypto.randomUUID(); const verifier = rand();
    db.query("INSERT INTO sso_login_state (state, nonce, code_verifier, created_at) VALUES (?, ?, ?, ?)").run(state, nonce, verifier, Math.floor(Date.now() / 1000));
    const url = buildAuthorizeUrl(provider.oauth, await managers[name].getClientId(), state, await pkceChallenge(verifier));
    return c.redirect(url.toString(), 302);
  });

  router.get("/auth/:provider/callback", async (c) => {
    const name = c.req.param("provider"); const provider = config.providers[name];
    if (!provider) return c.text("unknown provider", 404);
    const code = c.req.query("code"); const state = c.req.query("state");
    if (!code || !state) return c.text("missing code/state", 400);
    const row = db.query("SELECT code_verifier, created_at FROM sso_login_state WHERE state = ?").get(state) as { code_verifier: string; created_at: number } | null;
    db.query("DELETE FROM sso_login_state WHERE state = ?").run(state); // single-use
    if (!row) return c.text("invalid or expired state", 400);
    if (Math.floor(Date.now() / 1000) - row.created_at > STATE_TTL_SEC) return c.text("state expired", 400);
    const { email, commit } = await managers[name].exchangeForIdentity(code, row.code_verifier);
    if (!email || email.toLowerCase() !== provider.oauth.owner_email.toLowerCase()) {
      audit.log({ identity: email ?? "unknown", action: "relay.auth.reject", path: `/auth/${name}/callback`, success: false, metadata: { reason: "identity_mismatch" } });
      return c.text("authenticated identity does not match the configured owner", 403);
    }
    await commit();
    audit.log({ identity: email, action: "relay.auth.success", path: `/auth/${name}/callback`, success: true });
    return c.html(`<html><body><h2>Re-auth successful for ${name}</h2><p>You can close this tab.</p></body></html>`);
  });

  return router;
}
