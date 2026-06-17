// src/relay/secrets/types.ts
export interface SecretsBackend {
  resolve(ref: string): Promise<string>;
  put(ref: string, value: string): Promise<void>;
}
export class MemorySecretsBackend implements SecretsBackend {
  private store: Map<string, string>;
  constructor(seed: Record<string, string> = {}) { this.store = new Map(Object.entries(seed)); }
  async resolve(ref: string): Promise<string> {
    const v = this.store.get(ref);
    if (v === undefined) throw new Error(`secret not found: ${ref}`);
    return v;
  }
  async put(ref: string, value: string): Promise<void> { this.store.set(ref, value); }
}
