// src/metrics.ts
// Hand-rolled Prometheus text exposition — two series, no dependency.
// The gauge line is emitted ONLY after a first success, so a relay that has
// never refreshed reports the gauge as ABSENT (drives the absent()-keyed alert).
let lastSuccessSec = 0;
let refreshFailures = 0;

export function recordRefreshSuccess(nowSec: number): void { lastSuccessSec = nowSec; }
export function recordRefreshFailure(): void { refreshFailures++; }

export function renderMetrics(): string {
  const lines = [
    "# TYPE relay_oauth_refresh_failures_total counter",
    `relay_oauth_refresh_failures_total ${refreshFailures}`,
    "# TYPE relay_oauth_last_success_timestamp_seconds gauge",
  ];
  if (lastSuccessSec > 0) lines.push(`relay_oauth_last_success_timestamp_seconds ${lastSuccessSec}`);
  return lines.join("\n") + "\n";
}
