export interface RelayEnv {
  port: number;
  dataDir: string;
  relayConfigPath: string;
  opConnectHost: string;
  opConnectTokenFile: string;
  metricsPort: number;
  publicHeader?: string;
}
export function loadRelayEnv(): RelayEnv {
  const relayConfigPath = process.env.RELAY_CONFIG_PATH; if (!relayConfigPath) throw new Error("RELAY_CONFIG_PATH must be set");
  const opConnectHost = process.env.OP_CONNECT_HOST; if (!opConnectHost) throw new Error("OP_CONNECT_HOST must be set");
  const opConnectTokenFile = process.env.OP_CONNECT_TOKEN_FILE; if (!opConnectTokenFile) throw new Error("OP_CONNECT_TOKEN_FILE must be set");
  const port = Number(process.env.RELAY_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("RELAY_PORT must be an integer 1-65535");
  const metricsPort = Number(process.env.METRICS_PORT ?? 9090);
  if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) throw new Error("METRICS_PORT must be an integer 1-65535");
  return { port, dataDir: process.env.GATEHOUSE_DATA_DIR || "/data", relayConfigPath, opConnectHost, opConnectTokenFile, metricsPort, publicHeader: process.env.RELAY_PUBLIC_HEADER };
}
