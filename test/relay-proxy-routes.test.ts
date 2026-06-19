// test/relay-proxy-routes.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { proxyRoutes } from "../src/relay/proxy-routes";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import { initDB } from "../src/db/init";
import { AuditLog } from "../src/audit/logger";
import type { AuditEntry } from "../src/audit/logger";
import type { RelayConfig } from "../src/relay/config";
import { mkdtempSync, rmSync } from "fs"; import { join } from "path"; import { tmpdir } from "os";

let upstream: ReturnType<typeof Bun.serve> | undefined; let tokenSrv: ReturnType<typeof Bun.serve> | undefined; let discordSrv: ReturnType<typeof Bun.serve> | undefined; let dir: string;
afterEach(() => { upstream?.stop(true); tokenSrv?.stop(true); discordSrv?.stop(true); upstream = tokenSrv = discordSrv = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); delete process.env.DISCORD_AUDIT_WEBHOOK_URL; });

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
    upstreamRespondsWithHeaders: (body: object, extraHeaders: Record<string, string> = {}) => { responseFactory = () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...extraHeaders } }); },
  };
}

// Helper that exposes the audit instance so tests can intercept log calls
function makeAppWithDenylistAndAudit() {
  let upstreamCalled = false;
  let responseFactory: () => Response = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { headers: { "content-type": "application/json" } });
  upstream = Bun.serve({ port: 0, async fetch(req) { upstreamCalled = true; return responseFactory(); } });
  tokenSrv = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "AT-LIVE", expires_in: 3600 }) });
  const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: "https://x/authorize", token_endpoint: `http://localhost:${tokenSrv.port}/token`, redirect_uri: "https://relay.example.com/auth/google/callback", scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" }, upstreams: { workspace: { url: `http://localhost:${upstream.port}`, toolDenylist: ["send_message", "delete_file"] } } } } };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const audit = new AuditLog(db);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", proxyRoutes({ config, managers, audit }));
  return {
    app, audit,
    getUpstreamCalled: () => upstreamCalled,
    upstreamResponds: (body: object, ct = "application/json") => { responseFactory = () => new Response(JSON.stringify(body), { headers: { "content-type": ct } }); },
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

  test("Mcp-Session-Id is forwarded back from upstream response", async () => {
    const { app, upstreamRespondsWithHeaders } = makeAppWithDenylist();
    upstreamRespondsWithHeaders({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "sess-123", "mcp-protocol-version": "2024-11-05" });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.headers.get("mcp-session-id")).toBe("sess-123");
    expect(res.headers.get("mcp-protocol-version")).toBe("2024-11-05");
  });
});

describe("relay proxy routes — audit enrichment + Discord sink (Task 5)", () => {
  test("tools/call audit record includes tool name and target, never the token", async () => {
    const logs: AuditEntry[] = [];
    const { app, audit, upstreamResponds } = makeAppWithDenylistAndAudit();
    const originalLog = audit.log.bind(audit);
    audit.log = (e: AuditEntry) => { logs.push(e); originalLog(e); };
    upstreamResponds({ jsonrpc: "2.0", id: 1, result: {} });
    await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_drive_files", arguments: { query: "budget" } } }),
    });
    const rec = logs.find((l) => l.action === "relay.proxy.call");
    expect(rec).toBeDefined();
    expect(rec!.metadata?.tool).toBe("search_drive_files");
    // Bearer token must never appear in the audit record
    expect(JSON.stringify(rec)).not.toMatch(/Bearer|AT-LIVE/);
  });

  test("non-tools/call request has empty tool field in audit record", async () => {
    const logs: AuditEntry[] = [];
    const { app, audit, upstreamResponds } = makeAppWithDenylistAndAudit();
    const originalLog = audit.log.bind(audit);
    audit.log = (e: AuditEntry) => { logs.push(e); originalLog(e); };
    upstreamResponds({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const rec = logs.find((l) => l.action === "relay.proxy.call");
    expect(rec).toBeDefined();
    expect(rec!.metadata?.tool).toBe("");
  });

  test("relay.tool.denied fires Discord webhook with tool name, not the token", async () => {
    const discordBodies: string[] = [];
    discordSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        discordBodies.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    process.env.DISCORD_AUDIT_WEBHOOK_URL = `http://localhost:${discordSrv.port}/webhook`;

    const { app } = makeAppWithDenylistAndAudit();
    await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: {} } }),
    });

    // Give the async webhook POST a moment to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(discordBodies.length).toBeGreaterThanOrEqual(1);
    const body = discordBodies[0];
    expect(body).toContain("send_message");
    // Token must never appear in Discord payload
    expect(body).not.toMatch(/Bearer|AT-LIVE/);
  });

  test("Discord webhook is NOT called for a normal (allowed) tools/call", async () => {
    const discordBodies: string[] = [];
    discordSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        discordBodies.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    process.env.DISCORD_AUDIT_WEBHOOK_URL = `http://localhost:${discordSrv.port}/webhook`;

    const { app, upstreamResponds } = makeAppWithDenylistAndAudit();
    upstreamResponds({ jsonrpc: "2.0", id: 4, result: { ok: true } });
    await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_drive_files", arguments: {} } }),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(discordBodies.length).toBe(0);
  });

  test("Discord webhook is no-op when DISCORD_AUDIT_WEBHOOK_URL is unset", async () => {
    delete process.env.DISCORD_AUDIT_WEBHOOK_URL;
    const { app } = makeAppWithDenylistAndAudit();
    // Should not throw even with no webhook configured
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_message", arguments: {} } }),
    });
    expect(res.status).toBe(403); // still denied
  });
});

// ---------------------------------------------------------------------------
// Helper: upstream with alertTools configured (no denylist — this is the
// allowed-but-sensitive path, distinct from the block-and-deny path).
// ---------------------------------------------------------------------------
function makeAppWithAlertTools() {
  let upstreamCalled = false;
  let responseFactory: () => Response = () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
      headers: { "content-type": "application/json" },
    });
  upstream = Bun.serve({ port: 0, async fetch() { upstreamCalled = true; return responseFactory(); } });
  tokenSrv = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "AT-LIVE", expires_in: 3600 }) });
  const config: RelayConfig = {
    providers: {
      google: {
        oauth: {
          authorization_endpoint: "https://x/authorize",
          token_endpoint: `http://localhost:${tokenSrv!.port}/token`,
          redirect_uri: "https://relay.example.com/auth/google/callback",
          scopes: ["s1"], owner_email: "o@e.com",
          client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt",
        },
        upstreams: {
          workspace: {
            url: `http://localhost:${upstream!.port}`,
            // share_file is sensitive-write but NOT denied — it passes through, and Discord is notified.
            alertTools: ["share_file"],
          },
        },
      },
    },
  };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", proxyRoutes({ config, managers, audit: new AuditLog(db) }));
  return {
    app,
    getUpstreamCalled: () => upstreamCalled,
    upstreamResponds: (body: object, ct = "application/json") => {
      responseFactory = () => new Response(JSON.stringify(body), { headers: { "content-type": ct } });
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: upstream with mixed denylist (bare + scoped entries)
// ---------------------------------------------------------------------------
function makeAppWithScopedDenylist() {
  let upstreamCalled = false;
  let responseFactory: () => Response = () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
      headers: { "content-type": "application/json" },
    });
  upstream = Bun.serve({ port: 0, async fetch() { upstreamCalled = true; return responseFactory(); } });
  tokenSrv = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "AT-LIVE", expires_in: 3600 }) });
  const config: RelayConfig = {
    providers: {
      google: {
        oauth: {
          authorization_endpoint: "https://x/authorize",
          token_endpoint: `http://localhost:${tokenSrv!.port}/token`,
          redirect_uri: "https://relay.example.com/auth/google/callback",
          scopes: ["s1"], owner_email: "o@e.com",
          client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt",
        },
        upstreams: {
          workspace: {
            url: `http://localhost:${upstream!.port}`,
            // bare: send_gmail_message is fully blocked and stripped from tools/list
            // scoped: manage_event is only blocked for action=delete; still visible in tools/list
            toolDenylist: ["send_gmail_message", "manage_event:action=delete"],
          },
        },
      },
    },
  };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  const app = new Hono(); app.route("/", proxyRoutes({ config, managers, audit: new AuditLog(db) }));
  return {
    app,
    getUpstreamCalled: () => upstreamCalled,
    resetUpstreamCalled: () => { upstreamCalled = false; },
    upstreamResponds: (body: object, ct = "application/json") => {
      responseFactory = () => new Response(JSON.stringify(body), { headers: { "content-type": ct } });
    },
    upstreamRespondsSse: (body: object) => {
      responseFactory = () => new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  };
}

describe("relay proxy routes — action-aware denylist (scoped rules)", () => {
  test("scoped: tools/call manage_event {action:delete} → 403 denied, not forwarded", async () => {
    const { app, getUpstreamCalled } = makeAppWithScopedDenylist();
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "manage_event", arguments: { action: "delete", eventId: "ev-1" } } }),
    });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error.message).toMatch(/denied/i);
    expect(getUpstreamCalled()).toBe(false);
  });

  test("scoped: tools/call manage_event {action:create} → forwarded, NOT denied", async () => {
    const { app, getUpstreamCalled, upstreamResponds } = makeAppWithScopedDenylist();
    upstreamResponds({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "manage_event", arguments: { action: "create" } } }),
    });
    expect(res.status).toBe(200);
    expect(getUpstreamCalled()).toBe(true);
    expect((await res.json()).result.ok).toBe(true);
  });

  test("scoped: tools/call manage_event {action:update} → forwarded, NOT denied", async () => {
    const { app, getUpstreamCalled, upstreamResponds } = makeAppWithScopedDenylist();
    upstreamResponds({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "manage_event", arguments: { action: "update" } } }),
    });
    expect(res.status).toBe(200);
    expect(getUpstreamCalled()).toBe(true);
  });

  test("scoped: tools/list still INCLUDES manage_event (only bare names are stripped)", async () => {
    const { app, upstreamResponds } = makeAppWithScopedDenylist();
    upstreamResponds({
      jsonrpc: "2.0", id: 4,
      result: { tools: [{ name: "manage_event" }, { name: "send_gmail_message" }, { name: "search_calendar" }] },
    });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    const j = await res.json();
    const names = j.result.tools.map((t: any) => t.name);
    expect(names).toContain("manage_event");       // scoped: must survive
    expect(names).not.toContain("send_gmail_message"); // bare: must be stripped
    expect(names).toContain("search_calendar");    // untouched
  });

  test("scoped: tools/list (SSE) still INCLUDES manage_event, strips send_gmail_message", async () => {
    const { app, upstreamRespondsSse } = makeAppWithScopedDenylist();
    upstreamRespondsSse({
      jsonrpc: "2.0", id: 5,
      result: { tools: [{ name: "manage_event" }, { name: "send_gmail_message" }, { name: "search_calendar" }] },
    });
    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const dataLine = text.split("\n").find((l: string) => l.startsWith("data:"))!;
    const j = JSON.parse(dataLine.slice("data:".length).trim());
    const names = j.result.tools.map((t: any) => t.name);
    expect(names).toContain("manage_event");
    expect(names).not.toContain("send_gmail_message");
    expect(names).toContain("search_calendar");
  });

  test("bare entry send_gmail_message: tools/call → 403, tools/list removes it", async () => {
    const { app, getUpstreamCalled, upstreamResponds } = makeAppWithScopedDenylist();
    // Call denied
    const callRes = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "send_gmail_message", arguments: {} } }),
    });
    expect(callRes.status).toBe(403);
    expect(getUpstreamCalled()).toBe(false);
    // List filtered
    upstreamResponds({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "send_gmail_message" }, { name: "manage_event" }] } });
    const listRes = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    const j = await listRes.json();
    expect(j.result.tools.map((t: any) => t.name)).not.toContain("send_gmail_message");
  });
});

describe("relay proxy routes — alertTools Discord trigger (configurable sensitive-write)", () => {
  test("allowed tools/call to alertTools tool fires Discord webhook with tool name, NOT the token", async () => {
    const discordBodies: string[] = [];
    discordSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        discordBodies.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    process.env.DISCORD_AUDIT_WEBHOOK_URL = `http://localhost:${discordSrv.port}/webhook`;

    const { app, upstreamResponds } = makeAppWithAlertTools();
    upstreamResponds({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "share_file", arguments: { fileId: "file-abc" } } }),
    });
    // The call must succeed — alertTools does NOT block
    expect(res.status).toBe(200);

    // Give the async webhook POST a moment to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(discordBodies.length).toBeGreaterThanOrEqual(1);
    const body = discordBodies[0];
    expect(body).toContain("share_file");
    // Token must NEVER appear in the Discord payload
    expect(body).not.toMatch(/Bearer|AT-LIVE/);
  });

  test("allowed tools/call to NON-alert tool does NOT fire Discord", async () => {
    const discordBodies: string[] = [];
    discordSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        discordBodies.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    process.env.DISCORD_AUDIT_WEBHOOK_URL = `http://localhost:${discordSrv.port}/webhook`;

    const { app, upstreamResponds } = makeAppWithAlertTools();
    upstreamResponds({ jsonrpc: "2.0", id: 2, result: { ok: true } });

    const res = await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_drive_files", arguments: {} } }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(discordBodies.length).toBe(0);
  });

  test("alertTools call is still forwarded upstream (not blocked)", async () => {
    const { app, upstreamResponds, getUpstreamCalled } = makeAppWithAlertTools();
    upstreamResponds({ jsonrpc: "2.0", id: 3, result: { ok: true } });

    await app.request("/relay/google/workspace/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "share_file", arguments: {} } }),
    });
    expect(getUpstreamCalled()).toBe(true);
  });
});
