// test/relay-warmup.test.ts
import { describe, test, expect } from "bun:test";
import { warmup } from "../src/relay";

describe("warmup", () => {
  test("warms each provider token before listening", async () => {
    const calls: string[] = [];
    const mgrs = { google: { getAccessToken: async () => { calls.push("google"); return "tok"; } } };
    await warmup(mgrs as any);
    expect(calls).toContain("google");
  });

  test("warms multiple providers", async () => {
    const calls: string[] = [];
    const mgrs = {
      google: { getAccessToken: async () => { calls.push("google"); return "tok-g"; } },
      github: { getAccessToken: async () => { calls.push("github"); return "tok-h"; } },
    };
    await warmup(mgrs as any);
    expect(calls).toContain("google");
    expect(calls).toContain("github");
  });

  test("transient getAccessToken failure does NOT throw out of warmup", async () => {
    const mgrs = {
      failing: { getAccessToken: async () => { throw new Error("DNS not ready yet"); } },
    };
    // warmup must resolve, not reject (baseDelayMs=1 keeps the 5-attempt backoff fast in-test)
    await expect(warmup(mgrs as any, 1)).resolves.toBeUndefined();
  });

  test("succeeds on retry after transient failure", async () => {
    let attempt = 0;
    const calls: string[] = [];
    const mgrs = {
      flaky: {
        getAccessToken: async () => {
          attempt++;
          if (attempt < 3) throw new Error("transient");
          calls.push("flaky");
          return "tok";
        },
      },
    };
    await warmup(mgrs as any, 1);
    expect(calls).toContain("flaky");
  });
});
