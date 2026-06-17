// src/relay/secrets/onepassword.ts
import { createClient, ItemFieldType, type Client } from "@1password/sdk";
import type { SecretsBackend } from "./types";

function parseRef(ref: string): { vault: string; item: string; field: string } {
  const m = /^op:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) throw new Error(`invalid 1Password ref (expected op://vault/item/field): ${ref}`);
  return { vault: m[1], item: m[2], field: m[3] };
}

export class OnePasswordBackend implements SecretsBackend {
  private client?: Client;
  constructor(private opts: { token: string; integrationName?: string; integrationVersion?: string }) {}

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.client = await createClient({
        auth: this.opts.token,
        integrationName: this.opts.integrationName ?? "gatehouse-relay",
        integrationVersion: this.opts.integrationVersion ?? "1.0.0",
      });
    }
    return this.client;
  }

  async resolve(ref: string): Promise<string> {
    // secrets.resolve accepts op://vault/item/field BY NAME (server-side resolution).
    return (await this.getClient()).secrets.resolve(ref);
  }

  async put(ref: string, value: string): Promise<void> {
    const { vault, item, field } = parseRef(ref);
    const client = await this.getClient();
    // The items API is ID-based; op:// refs carry NAMES → resolve names→IDs first.
    const vaults = await client.vaults.list();
    const v = vaults.find((x) => x.title === vault || x.id === vault);
    if (!v) throw new Error(`1Password: vault not found: ${vault}`);
    const items = await client.items.list(v.id);
    const it = items.find((x) => x.title === item || x.id === item);
    if (!it) throw new Error(`1Password: item not found: ${vault}/${item}`);
    const full = await client.items.get(v.id, it.id);
    const f = full.fields.find((x) => x.title === field || x.id === field);
    if (!f) throw new Error(`1Password: field not found: ${vault}/${item}/${field} (create it first; relay does not create fields)`);
    f.value = value;
    f.fieldType = ItemFieldType.Concealed;
    await client.items.put(full);
  }
}
