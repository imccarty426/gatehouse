// test/relay-auth-routes.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initDB } from "../src/db/init";
import { authRoutes } from "../src/relay/auth-routes";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import { AuditLog } from "../src/audit/logger";
import type { RelayConfig } from "../src/relay/config";
import { mkdtempSync, rmSync } from "fs"; import { join } from "path"; import { tmpdir } from "os";

let oauth: ReturnType<typeof Bun.serve> | undefined; let dir: string;
afterEach(() => { oauth?.stop(true); oauth = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

function setup(ownerEmail: string, returnedEmail: string) {
  oauth = Bun.serve({ port: 0, async fetch() { const idt = "h." + Buffer.from(JSON.stringify({ email: returnedEmail })).toString("base64url") + ".s"; return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: idt }); } });
  const base = `http://localhost:${oauth.port}`;
  const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, redirect_uri: "https://relay.example.com/auth/google/callback", scopes: ["s1"], owner_email: ownerEmail, client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt", auth_url_params: { access_type: "offline", prompt: "consent" } }, upstreams: { drive: { url: "https://drivemcp/mcp/v1" } } } } };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db: Database = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", authRoutes({ config, managers, db, audit: new AuditLog(db) }));
  return { app, db, secrets };
}
async function stateFromLogin(app: any) { const r = await app.request("/auth/google/login", { redirect: "manual" }); return { r, state: new URL(r.headers.get("location")!).searchParams.get("state")! }; }

describe("relay auth routes", () => {
  test("login redirects with PKCE + offline params + state", async () => {
    const { app } = setup("o@e.com", "o@e.com"); const { r } = await stateFromLogin(app);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });
  test("callback with matching identity persists + consumes state", async () => {
    const { app, db, secrets } = setup("o@e.com", "o@e.com"); const { state } = await stateFromLogin(app);
    const res = await app.request(`/auth/google/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    expect(await secrets.resolve("op://v/i/rt")).toBe("RT");
    expect(db.query("SELECT state FROM sso_login_state WHERE state = ?").get(state)).toBeNull();
  });
  test("mismatched identity → 403, no persist", async () => {
    const { app, secrets } = setup("o@e.com", "attacker@evil.com"); const { state } = await stateFromLogin(app);
    expect((await app.request(`/auth/google/callback?code=c&state=${state}`)).status).toBe(403);
    expect(await secrets.resolve("op://v/i/rt")).toBe("RT0");
  });
  test("unknown state → 400", async () => {
    const { app } = setup("o@e.com", "o@e.com");
    expect((await app.request(`/auth/google/callback?code=c&state=bogus`)).status).toBe(400);
  });
  test("expired state (>600s) → 400, no persist", async () => {
    const { app, db, secrets } = setup("o@e.com", "o@e.com"); const { state } = await stateFromLogin(app);
    db.query("UPDATE sso_login_state SET created_at = ? WHERE state = ?").run(Math.floor(Date.now()/1000) - 601, state);
    expect((await app.request(`/auth/google/callback?code=c&state=${state}`)).status).toBe(400);
    expect(await secrets.resolve("op://v/i/rt")).toBe("RT0");
  });
});
