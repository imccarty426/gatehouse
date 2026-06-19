// test/relay-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadRelayConfig } from "../src/relay/config";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path"; import { tmpdir } from "os";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "relaycfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function write(yaml: string) { const p = join(dir, "relays.yaml"); writeFileSync(p, yaml); return p; }

const VALID = `
providers:
  google:
    oauth:
      authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth
      token_endpoint: https://oauth2.googleapis.com/token
      redirect_uri: https://relay.example.com/auth/google/callback
      scopes: [https://www.googleapis.com/auth/drive.readonly]
      auth_url_params: { access_type: offline, prompt: consent }
      owner_email: owner@example.com
      client_id_ref: op://gatehouse/google-oauth/client_id
      client_secret_ref: op://gatehouse/google-oauth/client_secret
      refresh_token_ref: op://gatehouse/google-oauth/refresh_token
    upstreams:
      drive: { url: https://drivemcp.googleapis.com/mcp/v1 }
`;

describe("loadRelayConfig", () => {
  test("parses a valid config", () => {
    const cfg = loadRelayConfig(write(VALID));
    expect(cfg.providers.google.oauth.token_endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(cfg.providers.google.oauth.scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(cfg.providers.google.oauth.auth_url_params).toEqual({ access_type: "offline", prompt: "consent" });
    expect(cfg.providers.google.upstreams.drive.url).toBe("https://drivemcp.googleapis.com/mcp/v1");
    expect(cfg.providers.google.oauth.header_name).toBeUndefined();
  });
  test("throws on missing token_endpoint", () => {
    expect(() => loadRelayConfig(write(VALID.replace(/ *token_endpoint:.*\n/, "")))).toThrow(/google.*token_endpoint/);
  });
  test("throws on empty upstreams", () => {
    expect(() => loadRelayConfig(write(VALID.replace(/upstreams:[\s\S]*$/, "upstreams: {}\n")))).toThrow(/google.*upstream/);
  });
  test("throws on non-URL endpoint", () => {
    expect(() => loadRelayConfig(write(VALID.replace("https://oauth2.googleapis.com/token", "not-a-url")))).toThrow(/google.*token_endpoint.*URL/);
  });
  test("throws on missing file", () => {
    expect(() => loadRelayConfig(join(dir, "nope.yaml"))).toThrow();
  });
  test("loadRelayConfig parses per-upstream toolDenylist", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams:
      workspace: { url: "https://svc:8000/mcp/", toolDenylist: ["send_message", "delete_file"] }
`;
    const cfg = loadRelayConfig(write(yaml));
    expect(cfg.providers.google.upstreams.workspace.toolDenylist).toEqual(["send_message", "delete_file"]);
  });
  test("loadRelayConfig rejects non-array toolDenylist", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams: { workspace: { url: "https://svc:8000/mcp/", toolDenylist: "nope" } }
`;
    expect(() => loadRelayConfig(write(yaml))).toThrow(/toolDenylist must be an array/);
  });
  test("loadRelayConfig parses per-upstream alertTools", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams:
      workspace: { url: "https://svc:8000/mcp/", alertTools: ["share_file", "move_file"] }
`;
    const cfg = loadRelayConfig(write(yaml));
    expect(cfg.providers.google.upstreams.workspace.alertTools).toEqual(["share_file", "move_file"]);
  });
  test("loadRelayConfig rejects non-array alertTools", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams: { workspace: { url: "https://svc:8000/mcp/", alertTools: "nope" } }
`;
    expect(() => loadRelayConfig(write(yaml))).toThrow(/alertTools must be an array/);
  });
  test("loadRelayConfig parses scoped denylist entries (toolName:argKey=argValue)", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams:
      workspace: { url: "https://svc:8000/mcp/", toolDenylist: ["send_gmail_message", "manage_event:action=delete"] }
`;
    const cfg = loadRelayConfig(write(yaml));
    expect(cfg.providers.google.upstreams.workspace.toolDenylist).toEqual(["send_gmail_message", "manage_event:action=delete"]);
  });
  test("loadRelayConfig rejects alertTools with non-string entries", () => {
    const yaml = `
providers:
  google:
    oauth: { authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth, token_endpoint: https://oauth2.googleapis.com/token, redirect_uri: https://relay.example.com/auth/google/callback, scopes: [openid], client_id_ref: op://gatehouse/google-oauth/client_id, client_secret_ref: op://gatehouse/google-oauth/client_secret, refresh_token_ref: op://gatehouse/google-oauth/refresh_token, owner_email: x@y.z }
    upstreams: { workspace: { url: "https://svc:8000/mcp/", alertTools: [42] } }
`;
    expect(() => loadRelayConfig(write(yaml))).toThrow(/alertTools must be an array/);
  });
});
