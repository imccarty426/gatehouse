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

function bootstrap() {
  const env = loadRelayEnv();
  const config = loadRelayConfig(env.relayConfigPath);
  const db = initDB(env.dataDir);
  const audit = new AuditLog(db);
  const secrets = new OnePasswordBackend({ token: env.opToken });
  const managers: Record<string, TokenManager> = {};
  for (const [name, provider] of Object.entries(config.providers)) managers[name] = new TokenManager(provider, name, secrets);
  console.log(`[gatehouse-relay] listening on :${env.port}`);
  return { app: buildRelayApp({ config, managers, db, audit, publicHeader: env.publicHeader }), port: env.port };
}

const { app, port } = import.meta.main ? bootstrap() : { app: new Hono(), port: 0 };
export default { port, fetch: app.fetch };
