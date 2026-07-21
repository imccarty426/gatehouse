// test/relay-metrics.test.ts
import { describe, test, expect } from "bun:test";
import { recordRefreshSuccess, recordRefreshFailure, renderMetrics } from "../src/metrics";

describe("metrics", () => {
  // Runs first, on pristine module state (lastSuccess=0): the gauge LINE must be
  // absent so Prometheus absent() fires — the incident had zero successes.
  test("gauge line is absent until a success is recorded (drives absent() alert)", () => {
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
