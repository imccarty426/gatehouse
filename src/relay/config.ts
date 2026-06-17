// src/relay/config.ts
import { readFileSync } from "fs";
import { parse } from "yaml";

export interface RelayProviderOAuth {
  authorization_endpoint: string; token_endpoint: string; redirect_uri: string;
  scopes: string[]; client_id_ref: string; client_secret_ref: string; refresh_token_ref: string;
  owner_email: string; auth_url_params?: Record<string, string>; token_url_params?: Record<string, string>; header_name?: string;
}
export interface RelayUpstream { url: string; }
export interface RelayProvider { oauth: RelayProviderOAuth; upstreams: Record<string, RelayUpstream>; }
export interface RelayConfig { providers: Record<string, RelayProvider>; }

const REQUIRED: (keyof RelayProviderOAuth)[] = [
  "authorization_endpoint","token_endpoint","redirect_uri","scopes",
  "client_id_ref","client_secret_ref","refresh_token_ref","owner_email",
];
const URL_FIELDS: (keyof RelayProviderOAuth)[] = ["authorization_endpoint","token_endpoint","redirect_uri"];

function assertUrl(name: string, field: string, value: string) {
  try { new URL(value); } catch { throw new Error(`relay config: provider ${name}: oauth.${field} must be a valid URL (got ${value})`); }
}

export function loadRelayConfig(path: string): RelayConfig {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { throw new Error(`relay config: cannot read ${path}: ${(e as Error).message}`); }
  const doc = parse(raw) as any;
  if (!doc?.providers || typeof doc.providers !== "object") throw new Error("relay config: top-level `providers` map is required");
  for (const [name, p] of Object.entries<any>(doc.providers)) {
    if (!p?.oauth || typeof p.oauth !== "object") throw new Error(`relay config: provider ${name}: missing oauth block`);
    for (const k of REQUIRED) if (p.oauth[k] == null) throw new Error(`relay config: provider ${name}: oauth.${k} is required`);
    if (!Array.isArray(p.oauth.scopes) || p.oauth.scopes.length === 0) throw new Error(`relay config: provider ${name}: oauth.scopes must be a non-empty list`);
    for (const f of URL_FIELDS) assertUrl(name, f, p.oauth[f]);
    if (!p.upstreams || typeof p.upstreams !== "object" || Object.keys(p.upstreams).length === 0) throw new Error(`relay config: provider ${name}: at least one upstream is required`);
    for (const [un, u] of Object.entries<any>(p.upstreams)) {
      if (!u?.url || typeof u.url !== "string") throw new Error(`relay config: provider ${name}: upstream ${un}.url is required`);
      try { new URL(u.url); } catch { throw new Error(`relay config: provider ${name}: upstream ${un}.url must be a valid URL`); }
    }
  }
  return doc as RelayConfig;
}
