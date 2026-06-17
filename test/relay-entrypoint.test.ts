// test/relay-entrypoint.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { initDB } from "../src/db/init";
import { buildRelayApp } from "../src/relay";
import { TokenManager } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import { AuditLog } from "../src/audit/logger";
import type { RelayConfig } from "../src/relay/config";
import { mkdtempSync, rmSync } from "fs"; import { join } from "path"; import { tmpdir } from "os";

let dir: string; afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("relay entrypoint", () => {
  test("mounts health + auth + relay routes; no GATEHOUSE_MASTER_KEY needed", async () => {
    delete process.env.GATEHOUSE_MASTER_KEY;
    const config: RelayConfig = { providers: { google: { oauth: { authorization_endpoint: "https://x/authorize", token_endpoint: "https://x/token", redirect_uri: "https://r/auth/google/callback", scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" }, upstreams: { drive: { url: "https://drivemcp/mcp/v1" } } } } };
    const secrets = new MemorySecretsBackend({ "op://v/i/cid": "c", "op://v/i/sec": "s", "op://v/i/rt": "RT0" });
    dir = mkdtempSync(join(tmpdir(), "relaydb-")); const db = initDB(dir);
    const managers = { google: new TokenManager(config.providers.google, "google", secrets) };
    const app = buildRelayApp({ config, managers, db, audit: new AuditLog(db) });
    const health = await app.request("/health");
    expect(health.status).toBe(200); expect(await health.json()).toEqual({ status: "ok" });
    // login route is mounted (builds URL even with a bogus authorize endpoint) → 302
    expect((await app.request("/auth/google/login", { redirect: "manual" })).status).toBe(302);
    // relay route is mounted (token fetch to bogus endpoint will error → not a 404 route-miss)
    expect((await app.request("/relay/google/drive/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).not.toBe(404);
  });
});
