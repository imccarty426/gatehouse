# OAuth MCP Relay

The relay is a provider-agnostic **OAuth token lifecycle manager and transparent pass-through proxy** for hosted MCP servers that require OAuth 2.0 bearer authentication. It owns token minting, caching, refresh, and re-auth flows so that consumers (e.g. Open WebUI) connect with **No Auth** while the relay silently injects a valid bearer on every upstream request.

Shipped with a Google Workspace provider covering six hosted MCP servers (Drive, Gmail, Calendar, Docs, Sheets, Slides). Adding a second OAuth 2.0 authorization-code + refresh-token provider is **config-only** within the boundaries documented in [Config schema](#config-schema).

The relay runs as a **separate entrypoint** (`relay.ts`) — it does not require `GATEHOUSE_MASTER_KEY` or the broker stack. It is designed to be deployed independently with a dedicated Kubernetes Deployment/HelmRelease, split ingress exposure, and a CiliumNetworkPolicy.

---

## How it works

**Tool call (in-cluster, no internet):**

```
Open WebUI → GET /relay/google/drive/mcp/v1
           → token-manager (cached or refreshed access token)
           → inject Authorization: Bearer <token>
           → transparent pass-through → drivemcp.googleapis.com
           → raw JSON-RPC body returned verbatim to Open WebUI
```

There is no response envelope. The relay does not buffer or re-wrap the upstream body — it streams the response verbatim (content-type preserved). See [Security model — Body-size cap](#body-size-cap) for the tradeoff.

**Re-auth (browser, public, CF Access-gated):**

```
Browser (CF-Access-authed) → GET /auth/google/login
  → build Google consent URL (PKCE + state stored in sso_login_state)
  → redirect to Google
  → user consents
  → GET /auth/google/callback?code=...
  → validate + consume state (single-use, ≤10 min TTL)
  → exchange code for tokens
  → verify granted token's email == owner_email (identity-bind)
  → SecretsBackend.put(refresh_token_ref, newRefreshToken)
  → success page
```

---

## Config schema

Set `RELAY_CONFIG_PATH` to point at a YAML file with the following shape. See `examples/relays.yaml` for the full annotated Google example.

```yaml
providers:
  <provider-name>:
    oauth:
      authorization_endpoint: <URL>         # OAuth 2.0 authorization endpoint
      token_endpoint:         <URL>         # Token endpoint (exchange + refresh)
      redirect_uri:           <URL>         # Must be registered on the OAuth client
      scopes:                 [<scope>, …]  # Union of all upstream scopes
      auth_url_params:        <map>         # Extra params appended to the auth URL
      token_url_params:       <map>         # Extra params sent in the token POST body
      header_name:            <string>      # Injection header name (default: Authorization)
      owner_email:            <string>      # Identity-bind target email
      client_id_ref:          <secret-ref>  # Resolved by SecretsBackend at runtime
      client_secret_ref:      <secret-ref>  # Resolved by SecretsBackend at runtime
      refresh_token_ref:      <secret-ref>  # Read AND written back by SecretsBackend
    upstreams:
      <upstream-name>:
        url: <URL>                          # Base URL for this upstream MCP server
      # … more upstreams
  # … more providers
```

### Field notes

**`auth_url_params`** — key/value pairs appended to the authorization URL query string. For Google, **`{access_type: offline, prompt: consent}` is required** to receive a refresh token. Without `access_type: offline`, Google returns only an access token (no refresh). Without `prompt: consent`, Google may skip the consent screen on repeat auth, returning no refresh token.

**`token_url_params`** — key/value pairs added to the token endpoint POST body. Escape hatch for providers that require non-standard parameters: Auth0 `audience`, Azure AD `resource`, etc. Leave `{}` for standard Google OAuth.

**`header_name`** — the HTTP header used to carry the bearer token to the upstream. Default is `Authorization` (value: `Bearer <token>`). Override only if an upstream expects a different header name.

**`owner_email`** — the identity the relay verifies before persisting any refresh token. The relay calls the token introspection endpoint to confirm the email in the granted token matches this value. Mismatch = reject + no persist, regardless of CF Access state.

**Secret refs** — values of `*_ref` fields are opaque references passed to the `SecretsBackend.resolve()` method. The default implementation uses `@1password/sdk` and accepts `op://<vault>/<item>/<field>` format. The relay never logs, returns, or exposes resolved secret values.

**Honest extensibility boundary:** the config-only guarantee applies to providers that use **OAuth 2.0 authorization-code flow with a refresh token and a bearer injection header**. The `auth_url_params`, `token_url_params`, and `header_name` escape hatches absorb the common deviations. A provider with fundamentally different token semantics (e.g. device-flow only, mTLS, custom signing) may require a code change.

---

## Routes

### Auth routes — `/auth/:provider/login` and `/auth/:provider/callback`

These routes drive the browser OAuth consent flow. They **must** be behind CF Access (or equivalent) in production — the relay does not authenticate callers on these routes itself; it relies on the deployment-layer guard.

| Route | Method | Description |
|---|---|---|
| `GET /auth/:provider/login` | GET | Builds the OAuth authorization URL (PKCE + single-use state stored in `sso_login_state`), redirects the browser to the provider's consent page. |
| `GET /auth/:provider/callback` | GET | Validates and consumes state, exchanges the code for tokens, performs identity-bind check, persists the refresh token via `SecretsBackend.put()`, returns a success page. |

The authorization URL is built **only** from `relays.yaml` config. No request-supplied redirect or next parameters are accepted (open-redirect defense). The success page does not perform any caller-controlled redirect.

### Relay routes — `/relay/:provider/:upstream/*`

Handles all MCP methods. Accepts any HTTP method (`ALL`).

| Route | Method | Description |
|---|---|---|
| `ALL /relay/:provider/:upstream/*` | ANY | Resolves the upstream URL from config, retrieves (or refreshes) a valid access token via the token manager, injects the bearer header, and transparently proxies the request and response. |

Path matching: `:provider` must match a key in `providers`; `:upstream` must match a key in `providers.<name>.upstreams`. Unknown provider or upstream → `404`.

**Relay routes are in-cluster only.** The ingress must route `/auth/*` to the public hostname (behind CF Access) and expose `/relay/*` only as a ClusterIP service accessible to the MCP consumer. The relay also refuses `/relay/*` with `403` when the `RELAY_PUBLIC_HEADER` marker is present — defense-in-depth guard (see [Security model — Public-ingress guard](#public-ingress-guard)).

**Token expired / refresh token revoked:** the relay returns `503` with an actionable error message containing the `/auth/:provider/login` URL. It never serves a stale token.

**Audit:** every `/relay` call emits an `AuditLog` row (provider, upstream, method, outcome).

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RELAY_CONFIG_PATH` | Yes | — | Absolute path to the `relays.yaml` config file. |
| `RELAY_PORT` | No | `3100` | TCP port the relay server listens on. |
| `GATEHOUSE_DATA_DIR` | Yes | — | Directory for the SQLite database (`relay.db`). Must be writable and persistent. |
| `OP_SERVICE_ACCOUNT_TOKEN` | Yes (1Password backend) | — | 1Password service account token. Prefer a mounted file if `@1password/sdk` supports it in your version — env vars can appear in crash dumps and `kubectl describe` output. |
| `RELAY_PUBLIC_HEADER` | No | — | If set, the relay returns `403` on any `/relay/*` request that carries this header. Set this header name on the public ingress server block to arm the in-app guard. |

---

## Extensibility — `SecretsBackend`

The relay resolves and writes back secret references through the `SecretsBackend` interface:

```typescript
interface SecretsBackend {
  /** Read a secret value by reference (e.g. "op://vault/item/field"). */
  resolve(ref: string): Promise<string>;

  /** Write a new value back to the same reference location.
   *  Used to persist a rotated refresh token after re-auth.
   *  Implementations MUST be atomic: persist the new value before the
   *  caller discards the old in-memory value, and verify the write by
   *  reading back. On failure, surface a loud error — do not silently
   *  lose the only valid refresh token. */
  put(ref: string): (value: string) => Promise<void>;
}
```

The shipped implementation is `OnePasswordBackend` (`src/relay/secrets/onepassword.ts`), which uses `@1password/sdk` for both reads and writes.

To implement a different backend (HashiCorp Vault, a file, an env var, etc.):

1. Create a class that implements `SecretsBackend`.
2. Export it from `src/relay/secrets/`.
3. Wire it in `relay.ts` (the `buildRelayApp` call).

The `SecretsBackend` is the sole integration point for secret storage — no other relay code reads or writes credentials directly.

**Why not gatehouse's built-in `SecretsEngine`?** The relay runs in a separate deployment without `GATEHOUSE_MASTER_KEY` or the encrypted SQLite DB. The relay must also write back a rotating refresh token, which the one-way ESO flow cannot do. `SecretsBackend` is the minimal new seam that supports 1Password now and any external store later.

---

## Security model

The relay's security guarantees are split between in-code invariants and deployment responsibilities. Deployers must implement the deployment-side controls before exposing the relay to production traffic.

### In-code invariants (enforced by the relay itself)

**Identity-bind:** before persisting any refresh token, the relay verifies the granted token's email matches `owner_email` in config. Mismatch = immediate reject, no persist. This holds even if CF Access is misconfigured or bypassed.

**Single-use PKCE state:** the OAuth state + PKCE `code_verifier` are stored in `sso_login_state` with a ≤10-minute TTL and consumed exactly once at callback. Replayed or expired states are rejected.

**Open-redirect defense:** the authorization URL and `redirect_uri` come only from `relays.yaml`. No request-supplied redirect or next parameter is ever honored.

**Authorization header redaction:** the injected outbound `Authorization` header is never written to logs. Resolved secret values (`client_secret`, access/refresh tokens) never appear in HTTP error bodies, the re-auth success page, or log output.

**Atomic write-back:** when a refresh token is rotated, the new value is persisted via `put()` before the old in-memory value is discarded. If `put()` fails, the relay keeps serving with the still-valid in-memory access token and surfaces a loud error — it does not silently lose the only valid refresh token.

**Public-ingress guard:** when `RELAY_PUBLIC_HEADER` is configured, any `/relay/*` request carrying that header is rejected with `403`, providing defense-in-depth behind the NetworkPolicy.

### Deployment responsibilities

**CF Access (or equivalent) on `/auth/*`:** only authenticated users should be able to initiate or complete the OAuth flow. Without this guard, an attacker can trigger consent flows or intercept callbacks. The relay does **not** authenticate callers on `/auth/*` itself.

**In-cluster NetworkPolicy on `/relay/*`:** `/relay/*` routes must be ClusterIP-only (not exposed through the public ingress). A CiliumNetworkPolicy or equivalent must restrict ingress to `/relay/*` to the specific pod identity (e.g. the Open WebUI pod) — not the whole cluster. *Accepted residual risk (single-user):* a compromised Open WebUI pod can make Workspace API calls on behalf of the configured owner; mitigated by the per-call audit log.

**Ingress split exposure:** the ingress must route `/auth/*` to the public hostname (CF Access-gated) and must not expose `/relay/*` through the same public route. Verify the split with path-normalization checks (`/auth/../relay`, URL-encoded variants) in your end-to-end gate.

**Egress allow-list:** configure a deny-by-default egress policy (CiliumNetworkPolicy or equivalent) allowing only the specific FQDNs the relay must reach: `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` (identity check), the six `*mcp.googleapis.com` hosts, and the 1Password API FQDN. Include the DNS visibility policy if using `toFQDNs` — without DNS visibility, `toFQDNs` fails closed and blocks all egress.

**1Password SA token scope:** the `OP_SERVICE_ACCOUNT_TOKEN` must be scoped to only the vault and items the relay needs — not the whole-org Homelab vault. Item-scoped is preferred; a dedicated vault is the minimum acceptable fallback.

### Body-size cap

Unlike gatehouse's existing buffered proxy (`readCappedText`), the relay **streams the response body without a size cap**. This preserves SSE extensibility and avoids unnecessary buffering for the Google JSON-only responses, but means the relay cannot enforce a hard response-size limit for a misbehaving or compromised upstream.

For trusted, well-behaved upstreams (Google's hosted MCP servers), the DoS surface is low. Deployers who need a hard response-size cap should enforce it at the ingress (e.g. an nginx `proxy_max_temp_file_size` or Envoy `max_response_bytes` policy) rather than in the relay itself.

Request bodies are buffered (MCP requests are small and well-bounded).
