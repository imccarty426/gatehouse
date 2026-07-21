// test/relay-token-manager.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { TokenManager, RefreshTokenExpiredError } from "../src/relay/token-manager";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
import type { RelayProvider } from "../src/relay/config";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });
function tokenServer(handler: (f: URLSearchParams) => Response | object) {
  server = Bun.serve({ port: 0, async fetch(req) { const f = new URLSearchParams(await req.text()); const r = handler(f); return r instanceof Response ? r : Response.json(r); } });
  return `http://localhost:${server.port}/token`;
}
function P(ep: string): RelayProvider {
  return { oauth: { authorization_endpoint: "https://x/authorize", token_endpoint: ep, redirect_uri: "https://r/auth/google/callback",
    scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" },
    upstreams: { drive: { url: "https://drivemcp/mcp/v1" } } };
}
const sec = () => new MemorySecretsBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });

describe("TokenManager", () => {
  test("getClientId resolves the client_id ref", async () => {
    expect(await new TokenManager(P("http://x/token"), "google", sec()).getClientId()).toBe("cid");
  });
  test("mints + caches; second call does not re-hit the endpoint", async () => {
    let calls = 0; const ep = tokenServer(() => { calls++; return { access_token: "AT", expires_in: 3600 }; });
    const tm = new TokenManager(P(ep), "google", sec());
    expect(await tm.getAccessToken()).toBe("AT"); expect(await tm.getAccessToken()).toBe("AT"); expect(calls).toBe(1);
  });
  test("single-flight: concurrent calls trigger ONE refresh", async () => {
    let calls = 0; const ep = tokenServer(() => { calls++; return { access_token: "AT", expires_in: 3600 }; });
    const tm = new TokenManager(P(ep), "google", sec());
    await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]); expect(calls).toBe(1);
  });
  test("fail-closed: 400 invalid_grant → RefreshTokenExpiredError", async () => {
    const ep = tokenServer(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(new TokenManager(P(ep), "google", sec()).getAccessToken()).rejects.toBeInstanceOf(RefreshTokenExpiredError);
  });
  test("any 400 refresh failure maps to RefreshTokenExpiredError (503)", async () => {
    const ep = tokenServer(() => new Response(JSON.stringify({ error: "bad_request" }), { status: 400 }));
    await expect(new TokenManager(P(ep), "google", sec()).getAccessToken()).rejects.toBeInstanceOf(RefreshTokenExpiredError);
  });
  test("empty access_token in 200 response maps to RefreshTokenExpiredError", async () => {
    const ep = tokenServer(() => ({ access_token: "", expires_in: 3600 }));
    await expect(new TokenManager(P(ep), "google", sec()).getAccessToken()).rejects.toBeInstanceOf(RefreshTokenExpiredError);
  });
  test("5xx token-endpoint error is transient (re-thrown, NOT reauth)", async () => {
    const ep = tokenServer(() => new Response("upstream down", { status: 503 }));
    await expect(new TokenManager(P(ep), "google", sec()).getAccessToken()).rejects.not.toBeInstanceOf(RefreshTokenExpiredError);
  });
  test("exchangeForIdentity returns email but does NOT persist until commit()", async () => {
    const idt = "h." + Buffer.from(JSON.stringify({ email: "owner@e.com" })).toString("base64url") + ".s";
    const ep = tokenServer((f) => f.get("grant_type") === "authorization_code" ? { access_token: "AT", refresh_token: "RT-NEW", expires_in: 3600, id_token: idt } : { access_token: "AT", expires_in: 3600 });
    const s = sec(); const tm = new TokenManager(P(ep), "google", s);
    const r = await tm.exchangeForIdentity("code", "ver");
    expect(r.email).toBe("owner@e.com");
    expect(await s.resolve("op://v/i/rt")).toBe("RT0"); // not persisted yet
    await r.commit();
    expect(await s.resolve("op://v/i/rt")).toBe("RT-NEW"); // persisted (atomic, read-back-verified)
  });

  test("atomicWriteBack tolerates delayed read-your-writes (verify retries)", async () => {
    // Connect is a sync-cache: the first read after a write may lag one call behind.
    class LaggyBackend extends MemorySecretsBackend {
      private lag = new Set<string>();
      async put(ref: string, v: string) { this.lag.add(ref); await super.put(ref, v); }
      async resolve(ref: string) { if (this.lag.has(ref)) { this.lag.delete(ref); return "STALE"; } return super.resolve(ref); }
    }
    const s = new LaggyBackend({ "op://v/i/cid": "cid", "op://v/i/sec": "sec", "op://v/i/rt": "RT0" });
    const idt = "h." + Buffer.from(JSON.stringify({ email: "owner@e.com" })).toString("base64url") + ".s";
    const ep = tokenServer((f) => f.get("grant_type") === "authorization_code"
      ? { access_token: "AT", refresh_token: "RT-NEW", expires_in: 3600, id_token: idt } : { access_token: "AT", expires_in: 3600 });
    const r = await new TokenManager(P(ep), "google", s).exchangeForIdentity("code", "ver");
    await r.commit(); // must NOT throw despite the one stale read
    expect(await s.resolve("op://v/i/rt")).toBe("RT-NEW");
  });
});
