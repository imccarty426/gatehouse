// test/relay-oauth.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { exchangeCodeForTokens, refreshAccessToken, pkceChallenge, TokenEndpointError } from "../src/relay/oauth";
import type { RelayProviderOAuth } from "../src/relay/config";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });
function fakeToken(handler: (f: URLSearchParams) => Response | object) {
  server = Bun.serve({ port: 0, async fetch(req) { const f = new URLSearchParams(await req.text()); const r = handler(f); return r instanceof Response ? r : Response.json(r); } });
  return `http://localhost:${server.port}/token`;
}
function P(tokenEndpoint: string): RelayProviderOAuth {
  return { authorization_endpoint: "https://x/authorize", token_endpoint: tokenEndpoint, redirect_uri: "https://r/auth/google/callback",
    scopes: ["s1"], owner_email: "o@e.com", client_id_ref: "op://v/i/cid", client_secret_ref: "op://v/i/sec", refresh_token_ref: "op://v/i/rt" };
}

describe("oauth helpers", () => {
  test("pkceChallenge is base64url S256 (43 chars)", async () => {
    expect(await pkceChallenge("verifier-1234567890")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  test("exchangeCodeForTokens returns access+refresh+expiry", async () => {
    const ep = fakeToken((f) => { expect(f.get("grant_type")).toBe("authorization_code"); expect(f.get("code_verifier")).toBe("ver"); return { access_token: "AT", refresh_token: "RT", expires_in: 3600 }; });
    const t = await exchangeCodeForTokens(P(ep), "cid", "sec", "code", "ver");
    expect(t).toMatchObject({ accessToken: "AT", refreshToken: "RT", expiresInSec: 3600 });
  });
  test("refreshAccessToken uses refresh_token grant", async () => {
    const ep = fakeToken((f) => { expect(f.get("grant_type")).toBe("refresh_token"); return { access_token: "AT2", expires_in: 3600 }; });
    expect((await refreshAccessToken(P(ep), "cid", "sec", "RT")).accessToken).toBe("AT2");
  });
  test("non-2xx throws TokenEndpointError with status+body", async () => {
    const ep = fakeToken(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    try { await refreshAccessToken(P(ep), "cid", "sec", "RT"); throw new Error("should have thrown"); }
    catch (e) { expect(e).toBeInstanceOf(TokenEndpointError); expect((e as TokenEndpointError).status).toBe(400); expect((e as TokenEndpointError).body).toContain("invalid_grant"); }
  });
});
