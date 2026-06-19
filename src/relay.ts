import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { initDB } from "./db/init";
import { AuditLog } from "./audit/logger";
import { loadRelayConfig, type RelayConfig } from "./relay/config";
import { loadRelayEnv } from "./relay/relay-config-env";
import { OnePasswordBackend } from "./relay/secrets/onepassword";
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
export async function warmup(managers: Record<string, { getAccessToken: () => Promise<string> }>): Promise<void> {
  for (const [name, m] of Object.entries(managers)) {
    for (let i = 0; i < 5; i++) {
      try {
        await m.getAccessToken();
        break;
      } catch (e) {
        if (i === 4) {
          console.warn(`[gatehouse-relay] warmup ${name} gave up after 5 attempts: ${e}`);
        } else {
          await new Promise<void>((r) => setTimeout(r, 500));
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
  const secrets = new OnePasswordBackend({ token: env.opToken });
  const managers: Record<string, TokenManager> = {};
  for (const [name, provider] of Object.entries(config.providers)) managers[name] = new TokenManager(provider, name, secrets);
  await warmup(managers);
  console.log(`[gatehouse-relay] listening on :${env.port}`);
  return { app: buildRelayApp({ config, managers, db, audit, publicHeader: env.publicHeader }), port: env.port };
}

const { app, port } = import.meta.main ? await bootstrap() : { app: new Hono(), port: 0 };
export default { port, fetch: app.fetch };
