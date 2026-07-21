// test/relay-metrics.test.ts
import { describe, test, expect } from "bun:test";
import { recordRefreshSuccess, recordRefreshFailure, renderMetrics, resetMetricsForTest } from "../src/metrics";

describe("metrics", () => {
  // Metrics are process-global singletons; other test files record successes,
  // so reset before asserting the absent-gauge case (the incident had zero
  // successes → Prometheus absent() must fire).
  test("gauge line is absent until a success is recorded (drives absent() alert)", () => {
    resetMetricsForTest();
    const out = renderMetrics();
    expect(out).toContain("relay_oauth_refresh_failures_total 0");
    // no VALUE line (name + number); the "# TYPE ... gauge" comment is expected
    expect(out).not.toMatch(/relay_oauth_last_success_timestamp_seconds \d/);
  });

  test("renders success gauge and failure counter once recorded", () => {
    recordRefreshFailure();
    recordRefreshSuccess(1_700_000_000);
    const out = renderMetrics();
    expect(out).toContain("relay_oauth_last_success_timestamp_seconds 1700000000");
    expect(out).toMatch(/relay_oauth_refresh_failures_total [1-9]/);
  });
});
