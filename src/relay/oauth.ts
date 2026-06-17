// src/relay/oauth.ts
import type { RelayProviderOAuth } from "./config";

export interface TokenSet { accessToken: string; refreshToken?: string; expiresInSec: number; email?: string; }
export class TokenEndpointError extends Error {
  constructor(public status: number, public body: string) { super(`token endpoint ${status}`); this.name = "TokenEndpointError"; }
}

function b64url(b: Uint8Array) { return Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function buildAuthorizeUrl(p: RelayProviderOAuth, clientId: string, state: string, codeChallenge: string): URL {
  const u = new URL(p.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", p.redirect_uri);
  u.searchParams.set("scope", p.scopes.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(p.auth_url_params ?? {})) u.searchParams.set(k, v);
  return u;
}

function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  try { const j = JSON.parse(Buffer.from(parts[1].replace(/-/g,"+").replace(/_/g,"/"), "base64").toString("utf8")); return typeof j.email === "string" ? j.email : undefined; }
  catch { return undefined; }
}

async function tokenRequest(p: RelayProviderOAuth, form: URLSearchParams): Promise<TokenSet> {
  for (const [k, v] of Object.entries(p.token_url_params ?? {})) form.set(k, v);
  const res = await fetch(p.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
  const text = await res.text();
  if (!res.ok) throw new TokenEndpointError(res.status, text);
  const j = JSON.parse(text);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresInSec: j.expires_in ?? 3600, email: emailFromIdToken(j.id_token) };
}

export function exchangeCodeForTokens(p: RelayProviderOAuth, clientId: string, clientSecret: string, code: string, codeVerifier: string): Promise<TokenSet> {
  return tokenRequest(p, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: p.redirect_uri, client_id: clientId, client_secret: clientSecret, code_verifier: codeVerifier }));
}
export function refreshAccessToken(p: RelayProviderOAuth, clientId: string, clientSecret: string, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(p, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }));
}
