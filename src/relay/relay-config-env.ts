export interface RelayEnv { port: number; dataDir: string; relayConfigPath: string; opToken: string; publicHeader?: string; }
export function loadRelayEnv(): RelayEnv {
  const relayConfigPath = process.env.RELAY_CONFIG_PATH; if (!relayConfigPath) throw new Error("RELAY_CONFIG_PATH must be set");
  const opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN; if (!opToken) throw new Error("OP_SERVICE_ACCOUNT_TOKEN must be set");
  const port = Number(process.env.RELAY_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("RELAY_PORT must be an integer 1-65535");
  return { port, dataDir: process.env.GATEHOUSE_DATA_DIR || "/data", relayConfigPath, opToken, publicHeader: process.env.RELAY_PUBLIC_HEADER };
}
