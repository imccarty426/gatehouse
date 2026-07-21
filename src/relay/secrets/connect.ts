// src/relay/secrets/connect.ts
// SecretsBackend backed by in-cluster 1Password Connect (REST). No cloud SDK,
// no extra dependency — Connect exposes a 3-endpoint REST API we hit with fetch.
import type { SecretsBackend } from "./types";

function parseRef(ref: string): { vault: string; item: string; field: string } {
  const m = /^op:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) throw new Error(`invalid 1Password ref (expected op://vault/item/field): ${ref}`);
  return { vault: m[1], item: m[2], field: m[3] };
}

export class ConnectBackend implements SecretsBackend {
  constructor(private opts: { host: string; token: string }) {}

  // Errors carry only method+path+status — NEVER headers/token (log-leak invariant).
  private async api(path: string, init?: RequestInit): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.host}/v1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new Error(`connect ${init?.method ?? "GET"} ${path} failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`connect ${init?.method ?? "GET"} ${path} → ${res.status}`);
    return res.json();
  }

  private async locate(vault: string, item: string): Promise<{ vaultId: string; itemId: string }> {
    const vaults = await this.api(`/vaults`);
    const v = vaults.find((x: any) => x.name === vault || x.id === vault);
    if (!v) throw new Error(`connect: vault not found: ${vault}`);
    const items = await this.api(`/vaults/${v.id}/items`);
    const it = items.find((x: any) => x.title === item || x.id === item);
    if (!it) throw new Error(`connect: item not found: ${vault}/${item}`);
    return { vaultId: v.id, itemId: it.id };
  }

  async resolve(ref: string): Promise<string> {
    const { vault, item, field } = parseRef(ref);
    const { vaultId, itemId } = await this.locate(vault, item);
    const full = await this.api(`/vaults/${vaultId}/items/${itemId}`);
    const f = (full.fields ?? []).find((x: any) => x.label === field || x.id === field);
    if (!f) throw new Error(`connect: field not found: ${vault}/${item}/${field}`);
    return f.value ?? "";
  }

  // Connect (connect-sdk-js parity) has no field-level JSON-Patch — update is
  // whole-item PUT. We fetch the FULL item, mutate ONLY the target field, and
  // PUT it back, so sibling fields (client-id/secret) are preserved by
  // construction. The refresh-token field keeps its CONCEALED type.
  async put(ref: string, value: string): Promise<void> {
    const { vault, item, field } = parseRef(ref);
    const { vaultId, itemId } = await this.locate(vault, item);
    const full = await this.api(`/vaults/${vaultId}/items/${itemId}`);
    const f = (full.fields ?? []).find((x: any) => x.label === field || x.id === field);
    if (!f) throw new Error(`connect: field not found: ${vault}/${item}/${field}`);
    f.value = value;
    f.type = "CONCEALED"; // never downgrade the secret's type on write
    await this.api(`/vaults/${vaultId}/items/${itemId}`, { method: "PUT", body: JSON.stringify(full) });
  }
}
