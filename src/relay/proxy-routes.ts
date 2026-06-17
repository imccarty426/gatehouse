// src/relay/proxy-routes.ts
import { Hono } from "hono";
import type { RelayConfig } from "./config";
import { TokenManager, RefreshTokenExpiredError } from "./token-manager";
import type { AuditLog } from "../audit/logger";

const HOP_BY_HOP = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host","content-length"]);

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
    const body = (method === "GET" || method === "HEAD") ? undefined : await c.req.arrayBuffer(); // buffer small MCP requests
    const upstreamRes = await fetch(target.toString(), { method, headers, body, redirect: "manual" });
    audit.log({ identity: provider.oauth.owner_email, action: "relay.proxy.call", path: `/relay/${pname}/${uname}`, success: upstreamRes.ok, metadata: { status: String(upstreamRes.status), method } });

    const out = new Headers();
    for (const h of ["content-type", "cache-control"]) { const v = upstreamRes.headers.get(h); if (v) out.set(h, v); }
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out }); // stream response (no envelope, never echo Authorization)
  });

  return router;
}
