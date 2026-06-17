// test/relay-secrets.test.ts
import { describe, test, expect } from "bun:test";
import { MemorySecretsBackend } from "../src/relay/secrets/types";
describe("MemorySecretsBackend", () => {
  test("resolve seeded; put then resolve round-trips", async () => {
    const b = new MemorySecretsBackend({ "op://v/i/f": "seed" });
    expect(await b.resolve("op://v/i/f")).toBe("seed");
    await b.put("op://v/i/f", "rotated");
    expect(await b.resolve("op://v/i/f")).toBe("rotated");
  });
  test("resolve throws on unknown ref", async () => {
    await expect(new MemorySecretsBackend({}).resolve("op://v/i/x")).rejects.toThrow(/not found/i);
  });
});
