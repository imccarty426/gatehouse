import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { initDB } from "./db/init";
import { AuditLog } from "./audit/logger";
import { loadRelayConfig, type RelayConfig } from "./relay/config";
import { loadRelayEnv } from "./relay/relay-config-env";
import { readFileSync } from "fs";
import { ConnectBackend } from "./relay/secrets/connect";
import { renderMetrics } from "./metrics";
import { TokenManager } from "./relay/token-manager";
import { authRoutes } from "./relay/auth-routes";
import { proxyRoutes } from "./relay/proxy-routes";

export function buildRelayApp(deps: { config: RelayConfig; managers: Record<string, TokenManager>; db: Database; audit: AuditLog; publicHeader?: string }): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", authRoutes({ config: deps.config, managers: deps.managers, db: deps.db, audit: deps.audit }));
  app.route("/", proxyRoutes({ config: deps.config, managers: deps.managers, audit: deps.audit, publicHeader: deps.publicHeader }));
  return app;
}

/**
 * Prime each provider's OAuth token before the relay starts serving.
 * Guards against the Cilium toFQDNs first-call race: the first outbound request
 * after a pod restart can 500 before the DNS policy has been resolved and cached.
 * Retries up to 5 times with 500 ms backoff; swallows all errors so a stale or
 * unconfigured provider never prevents startup.
 */
export async function warmup(
  managers: Record<string, { getAccessToken: () => Promise<string> }>,
  baseDelayMs = 500,
): Promise<void> {
  for (const [name, m] of Object.entries(managers)) {
    let delay = baseDelayMs;
    for (let i = 0; i < 5; i++) {
      try {
        await m.getAccessToken();
        break;
      } catch (e) {
        // Non-fatal BY DESIGN: TokenManager re-resolves per request, so a failed
        // warmup can never wedge the pod — it just delays the first success.
        // Scrub the error to its message (never log the token/headers).
        if (i === 4) {
          console.warn(`[gatehouse-relay] warmup ${name} gave up after 5 attempts (non-fatal; per-request retry continues): ${(e as Error).message}`);
        } else {
          await new Promise<void>((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 8000); // exponential backoff, 8s ceiling — survives a minutes-long throttle window
        }
      }
    }
  }
}

async function bootstrap() {
  const env = loadRelayEnv();
  const config = loadRelayConfig(env.relayConfigPath);
  const db = initDB(env.dataDir);
  const audit = new AuditLog(db);
  // Secrets resolve via in-cluster 1Password Connect (not the rate-limited cloud SDK).
  // The Connect token is mounted from a K8s secret file, never an env var.
  const connectToken = readFileSync(env.opConnectTokenFile, "utf8").trim();
  const secrets = new ConnectBackend({ host: env.opConnectHost, token: connectToken });
  const managers: Record<string, TokenManager> = {};
  for (const [name, provider] of Object.entries(config.providers)) managers[name] = new TokenManager(provider, name, secrets);
  await warmup(managers);
  // Metrics on a dedicated port (scraped by kube-prometheus-stack; netpol-restricted to the monitoring ns).
  Bun.serve({ port: env.metricsPort, fetch(req) {
    return new URL(req.url).pathname === "/metrics"
      ? new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } })
      : new Response("not found", { status: 404 });
  }});
  console.log(`[gatehouse-relay] listening on :${env.port} (metrics :${env.metricsPort})`);
  return { app: buildRelayApp({ config, managers, db, audit, publicHeader: env.publicHeader }), port: env.port };
}

const { app, port } = import.meta.main ? await bootstrap() : { app: new Hono(), port: 0 };
export default { port, fetch: app.fetch };
