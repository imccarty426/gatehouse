// test/relay-connect.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { ConnectBackend } from "../src/relay/secrets/connect";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

// Minimal Connect REST stub: /v1/vaults, /v1/vaults/{id}/items, /v1/vaults/{id}/items/{id}
function connectStub(item: any, vaultTitle = "gatehouse") {
  const vaultId = "v1", itemId = "i1";
  server = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/v1/vaults") return Response.json([{ id: vaultId, name: vaultTitle }]);
    if (u.pathname === `/v1/vaults/${vaultId}/items`) return Response.json([{ id: itemId, title: item.title }]);
    if (u.pathname === `/v1/vaults/${vaultId}/items/${itemId}`) return Response.json(item);
    return new Response("not found", { status: 404 });
  }});
  return `http://localhost:${server.port}`;
}

describe("ConnectBackend.resolve", () => {
  test("resolves a field by vault title, item title, and field label", async () => {
    const host = connectStub({ id: "i1", title: "imm-google-oauth-openwebui",
      fields: [{ id: "f1", label: "refresh_token", type: "CONCEALED", value: "RT0" },
               { id: "f2", label: "client-id", type: "STRING", value: "CID" }] });
    const b = new ConnectBackend({ host, token: "connect-tok" });
    expect(await b.resolve("op://gatehouse/imm-google-oauth-openwebui/refresh_token")).toBe("RT0");
    expect(await b.resolve("op://gatehouse/imm-google-oauth-openwebui/client-id")).toBe("CID");
  });
  test("throws on unknown field label", async () => {
    const host = connectStub({ id: "i1", title: "imm-google-oauth-openwebui", fields: [] });
    const b = new ConnectBackend({ host, token: "t" });
    await expect(b.resolve("op://gatehouse/imm-google-oauth-openwebui/missing")).rejects.toThrow();
  });
});
