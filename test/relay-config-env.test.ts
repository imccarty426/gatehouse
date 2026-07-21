// test/relay-config-env.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { loadRelayEnv } from "../src/relay/relay-config-env";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("loadRelayEnv", () => {
  test("throws when OP_CONNECT_HOST is missing", () => {
    process.env.RELAY_CONFIG_PATH = "/x";
    delete process.env.OP_CONNECT_HOST;
    expect(() => loadRelayEnv()).toThrow(/OP_CONNECT_HOST/);
  });
  test("throws when OP_CONNECT_TOKEN_FILE is missing", () => {
    process.env.RELAY_CONFIG_PATH = "/x";
    process.env.OP_CONNECT_HOST = "http://connect:8080";
    delete process.env.OP_CONNECT_TOKEN_FILE;
    expect(() => loadRelayEnv()).toThrow(/OP_CONNECT_TOKEN_FILE/);
  });
  test("returns connect host, token file, and metrics port (default 9090)", () => {
    process.env.RELAY_CONFIG_PATH = "/x";
    process.env.OP_CONNECT_HOST = "http://connect:8080";
    process.env.OP_CONNECT_TOKEN_FILE = "/secrets/connect/token";
    delete process.env.METRICS_PORT;
    const e = loadRelayEnv();
    expect(e.opConnectHost).toBe("http://connect:8080");
    expect(e.opConnectTokenFile).toBe("/secrets/connect/token");
    expect(e.metricsPort).toBe(9090);
  });
});
