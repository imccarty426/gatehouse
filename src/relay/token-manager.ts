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
    // Single-flight: concurrent callers share one in-flight refresh. .finally() clears it so a FAILED refresh does not poison the cache (next call retries); accessToken/expiresAtMs are set only on success.
    this.inflight = this.doRefresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const { id, secret } = await this.creds();
    const refreshToken = await this.secrets.resolve(this.provider.oauth.refresh_token_ref);
    let t;
    try { t = await refreshAccessToken(this.provider.oauth, id, secret, refreshToken); }
    catch (e) {
      if (e instanceof TokenEndpointError && e.status >= 400 && e.status < 500) throw new RefreshTokenExpiredError(this.oauthName); // any 4xx → reauth
      throw e; // 5xx/network → transient, becomes 500
    }
    if (!t.accessToken) throw new RefreshTokenExpiredError(this.oauthName); // empty token → reauth
    // Write back a rotated refresh token (atomic, read-back-verified) BEFORE caching the new access token, so a write-back failure never leaves us serving a token whose refresh credential wasn't persisted.
    if (t.refreshToken && t.refreshToken !== refreshToken) await this.atomicWriteBack(t.refreshToken);
    this.accessToken = t.accessToken; this.expiresAtMs = this.now() + t.expiresInSec * 1000;
    return t.accessToken;
  }

  /** Persist then read-back-verify; never discard the working token until confirmed. */
  private async atomicWriteBack(newToken: string): Promise<void> {
    const ref = this.provider.oauth.refresh_token_ref;
    await this.secrets.put(ref, newToken);
    // Connect is a sync-cache with no read-your-writes guarantee: the verify read
    // may lag the write briefly. Retry with backoff before failing; the accept
    // condition stays strict equality, so a retry can never accept a bad write.
    let delay = 200;
    for (let i = 0; i < 5; i++) {
      if ((await this.secrets.resolve(ref)) === newToken) return;
      if (i < 4) { await new Promise<void>((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 3000); }
    }
    throw new Error(`refresh-token write-back verification failed for '${this.oauthName}'`);
  }

  async exchangeForIdentity(code: string, codeVerifier: string): Promise<{ email?: string; commit: () => Promise<void> }> {
    const { id, secret } = await this.creds();
    const t = await exchangeCodeForTokens(this.provider.oauth, id, secret, code, codeVerifier);
    if (!t.refreshToken) throw new Error(`provider '${this.oauthName}' returned no refresh token (need access_type=offline&prompt=consent)`);
    // commit persists ONLY the refresh token; getAccessToken() is the single source of access tokens
    // (it refreshes the just-persisted refresh token on first proxy use). Do not cache the code-exchange access token.
    const commit = async () => { await this.atomicWriteBack(t.refreshToken!); };
    return { email: t.email, commit };
  }
}
