// src/relay/proxy-routes.ts
import { Hono } from "hono";
import type { RelayConfig } from "./config";
import { TokenManager, RefreshTokenExpiredError } from "./token-manager";
import type { AuditLog } from "../audit/logger";

const HOP_BY_HOP = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host","content-length"]);

/** Parse SSE text, filter result.tools in any data: frames, re-emit valid SSE. */
export function filterToolsInSse(text: string, denylist: string[]): string {
  return text.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice("data:".length).trim();
    try {
      const obj: any = JSON.parse(payload);
      if (Array.isArray(obj?.result?.tools)) {
        obj.result.tools = obj.result.tools.filter((t: any) => !denylist.includes(t.name));
      }
      return `data: ${JSON.stringify(obj)}`;
    } catch { return line; }
  }).join("\n");
}

/**
 * Extract a non-sensitive target identifier from tools/call params.
 * Never includes auth tokens, full file contents, or query payloads.
 * Returns a short opaque identifier (fileId, calendarId, recipient address) or "".
 */
export function summarizeTarget(params: any): string {
  if (!params || typeof params !== "object") return "";
  const args = params.arguments ?? params.args ?? {};
  if (typeof args !== "object" || args === null) return "";
  // Ordered list of well-known non-sensitive identifier fields
  for (const key of ["fileId", "file_id", "calendarId", "calendar_id", "eventId", "event_id", "recipient", "to", "threadId", "thread_id", "driveId", "drive_id", "folderId", "folder_id", "documentId", "document_id", "spreadsheetId", "spreadsheet_id"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0 && v.length < 200) return v;
  }
  return "";
}

/**
 * Post a compact notification to Discord for sensitive/denied events.
 * No-op if DISCORD_AUDIT_WEBHOOK_URL is not set. Never includes token material.
 */
export function notifyDiscord(entry: { action: string; metadata?: Record<string, string> }): void {
  const url = process.env.DISCORD_AUDIT_WEBHOOK_URL;
  if (!url) return;
  const tool = entry.metadata?.tool ?? "";
  const target = entry.metadata?.target ?? "";
  const content = `**gatehouse alert** | action: \`${entry.action}\` | tool: \`${tool || "(none)"}\`${target ? ` | target: \`${target}\`` : ""}`;
  // Fire-and-forget; errors are non-fatal (audit DB is the source of truth)
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch(() => { /* swallow — Discord is best-effort */ });
}

/** Parse request body as JSON-RPC. Returns metadata for interception; never throws. */
export function interceptRequest(bodyBytes: ArrayBuffer, denylist: string[]): { deniedToolCall: boolean; rpc?: any; toolName?: string; rpcMethod?: string; rpcParamsName?: string; rpcParams?: any } {
  try {
    const rpc = JSON.parse(new TextDecoder().decode(bodyBytes));
    const rpcMethod: string | undefined = rpc?.method;
    const rpcParams = rpc?.params;
    const rpcParamsName: string | undefined = rpcParams?.name;
    if (rpcMethod === "tools/call" && denylist.includes(rpcParamsName!)) {
      return { deniedToolCall: true, rpc, toolName: String(rpcParamsName), rpcMethod, rpcParamsName, rpcParams };
    }
    return { deniedToolCall: false, rpc, rpcMethod, rpcParamsName, rpcParams };
  } catch { return { deniedToolCall: false }; }
}

export function proxyRoutes(deps: { config: RelayConfig; managers: Record<string, TokenManager>; audit: AuditLog; publicHeader?: string }): Hono {
  const { config, managers, audit, publicHeader } = deps;
  const router = new Hono();

  router.all("/relay/:provider/:upstream/*", async (c) => {
    // Defense-in-depth (spec §8): reject data-path requests that arrived via the public ingress.
    if (publicHeader && c.req.header(publicHeader)) return c.text("relay data path is not publicly accessible", 403);

    const pname = c.req.param("provider"); const uname = c.req.param("upstream");
    const provider = config.providers[pname]; const upstream = provider?.upstreams[uname];
    if (!provider || !upstream) return c.text("unknown provider/upstream", 404);

    let accessToken: string;
    try { accessToken = await managers[pname].getAccessToken(); }
    catch (e) {
      if (e instanceof RefreshTokenExpiredError) {
        audit.log({ identity: provider.oauth.owner_email, action: "relay.proxy.token_expired", path: c.req.path, success: false });
        return c.text(`refresh token expired — re-authenticate at /auth/${pname}/login`, 503);
      }
      throw e;
    }

    const tail = c.req.path.split(`/relay/${pname}/${uname}`)[1] ?? "";
    // Targets are config-derived (relays.yaml), never caller-derived, so SSRF is out of scope by construction; egress is constrained at the deployment layer (Cilium). The bare route yields an empty tail → target = the configured upstream url.
    const target = new URL(upstream.url.replace(/\/$/, "") + tail);
    new URL(c.req.url).searchParams.forEach((v, k) => target.searchParams.set(k, v));

    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => { const lk = k.toLowerCase(); if (!HOP_BY_HOP.has(lk) && lk !== "authorization") headers.set(k, v); });
    headers.set(provider.oauth.header_name ?? "Authorization", `Bearer ${accessToken}`);

    const method = c.req.method;

    // --- request interception ---
    let body: ArrayBuffer | undefined;
    let rpcMethod: string | undefined;
    let rpcParamsName: string | undefined;
    let rpcParams: any;
    if (method !== "GET" && method !== "HEAD") {
      const raw = await c.req.arrayBuffer();
      body = raw;
      if ((c.req.header("content-type") ?? "").includes("json")) {
        const intercepted = interceptRequest(raw, upstream.toolDenylist ?? []);
        rpcMethod = intercepted.rpcMethod;
        rpcParamsName = intercepted.rpcParamsName;
        rpcParams = intercepted.rpcParams;
        if (upstream.toolDenylist?.length && intercepted.deniedToolCall) {
          const deniedMeta = { tool: intercepted.toolName! };
          audit.log({ identity: provider.oauth.owner_email, action: "relay.tool.denied", path: `/relay/${pname}/${uname}`, success: false, metadata: deniedMeta });
          notifyDiscord({ action: "relay.tool.denied", metadata: deniedMeta });
          return c.json({ jsonrpc: "2.0", id: intercepted.rpc?.id ?? null, error: { code: -32601, message: `tool denied: ${intercepted.toolName}` } }, 403);
        }
      }
    }

    const upstreamRes = await fetch(target.toString(), { method, headers, body, redirect: "manual" });
    audit.log({
      identity: provider.oauth.owner_email, action: "relay.proxy.call",
      path: `/relay/${pname}/${uname}`, success: upstreamRes.ok,
      metadata: {
        status: String(upstreamRes.status), method,
        tool: rpcMethod === "tools/call" ? String(rpcParamsName ?? "") : "",
        target: rpcMethod === "tools/call" ? summarizeTarget(rpcParams) : "",
      },
    });

    const out = new Headers();
    for (const h of ["content-type", "cache-control", "mcp-session-id", "mcp-protocol-version"]) { const v = upstreamRes.headers.get(h); if (v) out.set(h, v); }

    // --- response interception: only buffer+filter tools/list ---
    if (rpcMethod === "tools/list" && upstream.toolDenylist?.length) {
      const ct = upstreamRes.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const text = await upstreamRes.text(); // small payload; safe to buffer
        const filtered = filterToolsInSse(text, upstream.toolDenylist);
        return new Response(filtered, { status: upstreamRes.status, headers: out });
      }
      const j: any = await upstreamRes.json();
      if (Array.isArray(j?.result?.tools)) j.result.tools = j.result.tools.filter((t: any) => !upstream.toolDenylist!.includes(t.name));
      return new Response(JSON.stringify(j), { status: upstreamRes.status, headers: out });
    }

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out }); // stream response (no envelope, never echo Authorization)
  });

  return router;
}
