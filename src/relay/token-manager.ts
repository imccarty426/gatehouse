// src/relay/token-manager.ts
import type { RelayProvider } from "./config";
import type { SecretsBackend } from "./secrets/types";
import { exchangeCodeForTokens, refreshAccessToken, TokenEndpointError } from "./oauth";

export class RefreshTokenExpiredError extends Error {
  constructor(public oauthName: string) { super(`refresh token expired/invalid for '${oauthName}'`); this.name = "RefreshTokenExpiredError"; }
}

export class TokenManager {
  private accessToken?: string;
  private expiresAtMs = 0;
  private inflight?: Promise<string>;
  constructor(private provider: RelayProvider, public readonly oauthName: string, private secrets: SecretsBackend, private now: () => number = () => Date.now()) {}

  getClientId(): Promise<string> { return this.secrets.resolve(this.provider.oauth.client_id_ref); }

  private async creds(): Promise<{ id: string; secret: string }> {
    const [id, secret] = await Promise.all([this.secrets.resolve(this.provider.oauth.client_id_ref), this.secrets.resolve(this.provider.oauth.client_secret_ref)]);
    return { id, secret };
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAtMs - 60_000) return this.accessToken;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const { id, secret } = await this.creds();
    const refreshToken = await this.secrets.resolve(this.provider.oauth.refresh_token_ref);
    let t;
    try { t = await refreshAccessToken(this.provider.oauth, id, secret, refreshToken); }
    catch (e) {
      if (e instanceof TokenEndpointError && e.status === 400 && /invalid_grant/.test(e.body)) throw new RefreshTokenExpiredError(this.oauthName);
      throw e;
    }
    if (t.refreshToken && t.refreshToken !== refreshToken) await this.atomicWriteBack(t.refreshToken);
    this.accessToken = t.accessToken; this.expiresAtMs = this.now() + t.expiresInSec * 1000;
    return t.accessToken;
  }

  /** Persist then read-back-verify; never discard the working token until confirmed. */
  private async atomicWriteBack(newToken: string): Promise<void> {
    const ref = this.provider.oauth.refresh_token_ref;
    await this.secrets.put(ref, newToken);
    if ((await this.secrets.resolve(ref)) !== newToken) throw new Error(`refresh-token write-back verification failed for '${this.oauthName}'`);
  }

  async exchangeForIdentity(code: string, codeVerifier: string): Promise<{ email?: string; commit: () => Promise<void> }> {
    const { id, secret } = await this.creds();
    const t = await exchangeCodeForTokens(this.provider.oauth, id, secret, code, codeVerifier);
    if (!t.refreshToken) throw new Error(`provider '${this.oauthName}' returned no refresh token (need access_type=offline&prompt=consent)`);
    const commit = async () => { await this.atomicWriteBack(t.refreshToken!); this.accessToken = t.accessToken; this.expiresAtMs = this.now() + t.expiresInSec * 1000; };
    return { email: t.email, commit };
  }
}
