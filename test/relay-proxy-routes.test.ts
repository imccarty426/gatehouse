// test/relay-proxy-routes.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { proxyRoutes } from "../src/relay/proxy-routes";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import { Database } from "bun:sqlite";
import { initDB } from "../src/db/init";
import { AuditLog } from "../src/audit/logger";
import type { RelayConfig } from "../src/relay/config";
import { mkdtempSync, rmSync } from "fs"; import { join } from "path"; import { tmpdir } from "os";

let upstream: ReturnType<typeof Bun.serve> | undefined; let tokenSrv: ReturnType<typeof Bun.serve> | undefined; let dir: string;
afterEach(() => { upstream?.stop(true); tokenSrv?.stop(true); upstream = tokenSrv = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

function makeApp(opts: { expiredRefresh?: boolean; publicHeader?: string } = {}) {
  let seenAuth = ""; let seenBody = "";
  upstream = Bun.serve({ port: 0, async fetch(req) { seenAuth = req.headers.get("authorization") ?? ""; seenBody = await req.text(); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { headers: { "content-type": "application/json; charset=UTF-8" } }); } });
  tokenSrv = Bun.serve({ port: 0, fetch: () => opts.expiredRefresh ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : Response.json({ access_token: "AT-LIVE", expires_in: 3600 }) });
  const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: "https://x/authorize", token_endpoint: `http://localhost:${tokenSrv.port}/token`, redirect_uri: "https://relay.example.com/auth/google/callback", scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" }, upstreams: { drive: { url: `http://localhost:${upstream.port}` } } } } };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", proxyRoutes({ config, managers, audit: new AuditLog(db), publicHeader: opts.publicHeader }));
  return { app, getSeenAuth: () => seenAuth, getSeenBody: () => seenBody };
}

describe("relay proxy routes", () => {
  test("injects bearer, forwards body, returns upstream JSON verbatim (no envelope)", async () => {
    const { app, getSeenAuth, getSeenBody } = makeApp();
    const res = await app.request("/relay/google/drive/mcp/v1", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(getSeenAuth()).toBe("Bearer AT-LIVE");
    expect(JSON.parse(getSeenBody())).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });
  test("unknown provider/upstream → 404", async () => {
    const { app } = makeApp();
    expect((await app.request("/relay/google/nope/x", { method: "POST" })).status).toBe(404);
    expect((await app.request("/relay/bogus/drive/x", { method: "POST" })).status).toBe(404);
  });
  test("dead refresh token → 503 with login URL", async () => {
    const { app } = makeApp({ expiredRefresh: true });
    const res = await app.request("/relay/google/drive/mcp/v1", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(503); expect(await res.text()).toContain("/auth/google/login");
  });
  test("public-ingress guard: request carrying the public marker header → 403", async () => {
    const { app } = makeApp({ publicHeader: "x-relay-public" });
    const res = await app.request("/relay/google/drive/mcp/v1", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-relay-public": "1" } });
    expect(res.status).toBe(403);
  });
});
