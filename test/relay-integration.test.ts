// test/relay-integration.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { initDB } from "../src/db/init";
import { buildRelayApp } from "../src/relay";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import { AuditLog } from "../src/audit/logger";
import type { RelayConfig } from "../src/relay/config";
import { mkdtempSync, rmSync } from "fs"; import { join } from "path"; import { tmpdir } from "os";

let oauth: ReturnType<typeof Bun.serve> | undefined; let upstream: ReturnType<typeof Bun.serve> | undefined; let dir: string;
afterEach(() => { oauth?.stop(true); upstream?.stop(true); oauth = upstream = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

function build() {
  let lastUpstreamAuth = "";
  upstream = Bun.serve({ port: 0, async fetch(req) { lastUpstreamAuth = req.headers.get("authorization") ?? ""; return Response.json({ ok: true }); } });
  oauth = Bun.serve({ port: 0, async fetch(req) {
    const f = new URLSearchParams(await req.text());
    if (f.get("grant_type") === "authorization_code") { const idt = "h." + Buffer.from(JSON.stringify({ email: "owner@e.com" })).toString("base64url") + ".s"; return Response.json({ access_token: "AT-CODE", refresh_token: "RT-1", expires_in: 3600, id_token: idt }); }
    return Response.json({ access_token: "AT-FROM-RT1", expires_in: 3600 });
  } });
  const base = `http://localhost:${oauth.port}`;
  const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, redirect_uri: "https://relay.example.com/auth/google/callback", scopes: ["s1"], owner_email: "owner@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt", auth_url_params: { access_type: "offline", prompt: "consent" } }, upstreams: { drive: { url: `http://localhost:${upstream.port}` } } } } };
  const secrets = new MemorySecretsBackend({ "op://v/i/cid": "c", "op://v/i/sec": "s", "op://v/i/rt": "RT0" });
  dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
  const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
  return { app: buildRelayApp({ config, managers, db, audit: new AuditLog(db) }), secrets, getAuth: () => lastUpstreamAuth };
}

describe("relay integration", () => {
  test("token from callback is the one the proxy injects; no secret in response", async () => {
    const { app, secrets, getAuth } = build();
    const login = await app.request("/auth/google/login", { redirect: "manual" });
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    expect((await app.request(`/auth/google/callback?code=ac&state=${state}`)).status).toBe(200);
    expect(await secrets.resolve("op://v/i/rt")).toBe("RT-1");
    const res = await app.request("/relay/google/drive/mcp/v1", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(getAuth()).toBe("Bearer AT-FROM-RT1");
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("RT-1"); expect(text).not.toContain("AT-FROM-RT1");
  });

  test("no token leaks into console logs (spec §7 invariant)", async () => {
    const { app } = build();
    const lines: string[] = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a: any[]) => lines.push(a.map(String).join(" "));
    console.error = (...a: any[]) => lines.push(a.map(String).join(" "));
    try {
      const login = await app.request("/auth/google/login", { redirect: "manual" });
      const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
      await app.request(`/auth/google/callback?code=ac&state=${state}`);
      await app.request("/relay/google/drive/mcp/v1", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    } finally { console.log = origLog; console.error = origErr; }
    const blob = lines.join("\n");
    expect(blob).not.toContain("RT-1");
    expect(blob).not.toContain("AT-FROM-RT1");
    expect(blob).not.toContain("Bearer AT-FROM-RT1");
  });
});
