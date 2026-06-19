// test/relay-proxy-routes.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { proxyRoutes } from "../src/relay/proxy-routes";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
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

// Helper for denylist tests: workspace upstream with configurable response factory
function makeAppWithDenylist() {
  let upstreamCalled = false;
  let responseFactory: () => Response = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { headers: { "content-type": "application/json" } });
  upstream = Bun.serve({ port: 0, async fetch(req) { upstreamCalled = true; return responseFactory(); } });
  tokenSrv = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "AT-LIVE", expires_in: 3600 }) });
  const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: "https://x/authorize", token_endpoint: `http://localhost:${tokenSrv.port}/token`, redirect_uri: "https://relay.example.com/auth/google/callback", scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" }, upstreams: { workspace: { url: `http://localhost:${upstream.port}`, toolDenylist: ["send_message", "delete_file"] } } } } };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", proxyRoutes({ config, managers, audit: new AuditLog(db) }));
  return {
    app,
    getUpstreamCalled: () => upstreamCalled,
    resetUpstreamCalled: () => { upstreamCalled = false; },
    upstreamResponds: (body: object, ct = "application/json") => { responseFactory = () => new Response(JSON.stringify(body), { headers: { "content-type": ct } }); },
    upstreamRespondsSse: (body: object) => { responseFactory = () => new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } }); },
  };
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

describe("relay proxy routes — tool denylist (Mechanism A)", () => {
  test("denied tools/call is rejected with JSON-RPC error, not forwarded", async () => {
    const { app, getUpstreamCalled } = makeAppWithDenylist();
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: {} } }),
    });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error.message).toMatch(/denied/i);
    expect(getUpstreamCalled()).toBe(false);
  });

  test("tools/list response (JSON) has denied tools filtered out", async () => {
    const { app, upstreamResponds } = makeAppWithDenylist();
    upstreamResponds({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_drive_files" }, { name: "send_message" }, { name: "delete_file" }] } });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const j = await res.json();
    expect(j.result.tools.map((t: any) => t.name)).toEqual(["search_drive_files"]);
  });

  test("allowed tools/call is forwarded and response returned", async () => {
    const { app, upstreamResponds, getUpstreamCalled } = makeAppWithDenylist();
    upstreamResponds({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_drive_files", arguments: {} } }),
    });
    expect(getUpstreamCalled()).toBe(true);
    expect((await res.json()).result.ok).toBe(true);
  });

  test("tools/list response (SSE) has denied tools filtered out", async () => {
    const { app, upstreamRespondsSse } = makeAppWithDenylist();
    upstreamRespondsSse({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "search_drive_files" }, { name: "send_message" }, { name: "delete_file" }] } });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // SSE frame: "data: <json>\n\n"
    const dataLine = text.split("\n").find((l: string) => l.startsWith("data:"))!;
    const j = JSON.parse(dataLine.slice("data:".length).trim());
    expect(j.result.tools.map((t: any) => t.name)).toEqual(["search_drive_files"]);
  });
});
