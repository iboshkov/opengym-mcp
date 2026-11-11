# Security model

This document describes what openGym MCP protects, how, and where the limits are. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

Contents: [Trust boundaries](#trust-boundaries) · [Authorization](#authorization) · [Consent and pairing](#consent-and-pairing) · [Tokens and grants](#tokens-and-grants) · [Profile isolation and revocation](#profile-isolation-and-revocation) · [Data at rest](#data-at-rest) · [HTTP hardening](#http-hardening) · [Write safety](#write-safety) · [Rate limits](#rate-limits) · [Logging](#logging) · [Container](#container-hardening) · [Limitations](#known-limitations)

## Trust boundaries

```
Assistant  --(OAuth access token)-->  openGym MCP  --(profile session token)-->  openGym API
```

- The assistant never sees your openGym session. It holds an MCP access token that only this service accepts.
- This service holds the openGym profile session obtained from a pairing code. It uses that session for every API call, so openGym enforces its own per-profile access rules.
- openGym stays the system of record. This service has no access to openGym's data directory and keeps no copy of workout data.
- openGym's passkeys and passwords are never sent to or stored by this service.

An openGym pairing session is a full profile session upstream. What restricts an assistant to the documented tools and to the scopes you chose is this service, not openGym. Treat the service and its volume as holding credentials for every connected profile.

## Authorization

The service is an OAuth 2.1 authorization server and protected resource for the single resource `<PUBLIC_ORIGIN>/mcp`. Routing, PKCE verification, client authentication and loopback callback matching use the official MCP TypeScript SDK.

- Authorization code flow only, with **S256 PKCE required**. Plain PKCE is not accepted.
- **Resource binding (RFC 8707):** a request that names a resource must name this server's `/mcp`. Tokens are bound to it, so a token from one deployment is useless at another, and changing `PUBLIC_ORIGIN` invalidates existing tokens.
- **Scopes:** `opengym:read` is always required; `opengym:write` is optional. A refresh cannot widen the granted scopes.
- **Client registration:** dynamic client registration (RFC 7591) for clients that register themselves, and client ID metadata documents for clients identified by an HTTPS URL. Registered clients may use `none` or `client_secret_post`. Registration is open, as OAuth dynamic registration is, and capped at 1000 clients. It grants nothing by itself: access still needs a pairing code from the person.
- **Redirect URIs** must be HTTPS, loopback HTTP (any port, but the host and path must match), or the `cursor:`, `vscode:` and `vscode-insiders:` schemes. Credentials and fragments are refused. An unregistered redirect URI is rejected.
- **Metadata documents** are fetched through an SSRF-filtering HTTPS agent that checks the address actually connected to, so private and loopback addresses are refused. Redirects are not followed. Responses are limited to 32 KiB with a 10 second timeout, must be HTTPS with a path, must repeat their own URL as `client_id`, need a client name and at most 20 redirect URIs, and must allow a public client. They are cached briefly, honouring `Cache-Control` up to one hour.
- Authorization responses carry the issuer (`iss`, RFC 9207) and the client's `state`.
- Discovery metadata is published at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. Unauthenticated `/mcp` requests get HTTP 401 with a challenge and expose no tools or data.

## Consent and pairing

Consent means redeeming an openGym pairing code, so only someone who is signed in to the profile in openGym can approve a connection.

1. `/authorize` validates the request and opens a sign-in flow valid for 10 minutes. It sets a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) holding a nonce, and the form carries a separate random ticket. Both must match, so a flow cannot be completed from another browser.
2. The consent post must come from the service's own origin. A missing, foreign or `null` Origin is rejected before any pairing code is redeemed.
3. The page shows which application is asking (the client's hostname) and where it returns to, and warns when the callback is a local agent, so a lookalike request can be recognised.
4. At most 5 code attempts are allowed per sign-in page. After that the flow is closed and must be restarted from the assistant.
5. A correct code is redeemed with openGym once. The authorization code returned to the client is single use and valid for 2 minutes. It is bound to the client, the redirect URI and the PKCE challenge.
6. The person chooses read-only or read and write on this page.

The page's Content Security Policy blocks inline script and framing, and allows the form to post only to the service itself and the callback origin of that one flow.

## Tokens and grants

| Item | Lifetime and handling |
| --- | --- |
| Access token (`ogmcp_...`) | 1 hour. Stored as a SHA-256 hash. |
| Refresh token (`ogmcpr_...`) | Rotated on every use. Stored as a hash. Valid until the grant ends. |
| Grant | 30 days from authorization. Refreshing does not extend it. Then the person reconnects with a fresh code. |
| Authorization code | 2 minutes, single use. |
| Sign-in flow | 10 minutes, in memory. |

A used refresh token moves to a spent list. Presenting it again is treated as replay, likely token theft, and **revokes the whole grant** with all its tokens. Only the client that owns a grant can revoke it through `/revoke` (RFC 7009).

The grant stores the upstream openGym session token. It is held only in the encrypted store.

## Profile isolation and revocation

- A grant is bound to one profile. On every MCP request the service checks the upstream session with openGym (`/api/me`) and confirms it still belongs to the same profile. Tool calls then read that profile only, using that profile's session. Different profiles connected to one service cannot see each other's data, which the tests check with concurrent profiles.
- **Revocation:** removing the connector in the assistant revokes the grant. **Sign out everywhere** in openGym invalidates the underlying sessions, and because the upstream session is checked on every request, access ends immediately for this service as well as for paired phones.
- There is no shared global token and no anonymous access to private tools.

## Data at rest

The store (`state.enc`) holds OAuth clients, grants, token hashes, upstream session tokens and write receipts. It is encrypted with AES-256-GCM, with a random nonce per write, an authentication tag and fixed associated data. Writes are atomic (temp file, fsync, rename), so a crash leaves the old file or the new one, never a partial one.

The 32-byte key is created automatically on first start with mode 0600 in the same volume, unless you supply one with `AUTH_KEY_FILE`. A supplied key is never auto-created. If the store exists without its key, the service refuses to start rather than silently making a new key.

Be clear about what this buys you:

- With the key in the same volume, encryption protects against a leaked copy of `state.enc` alone, such as a stray file in a backup or a log bundle.
- It does not protect against someone who has the whole volume, or the Docker host. They have the key, and so the upstream session tokens.
- Supplying the key as a Docker secret, stored apart from volume backups, restores real separation. See [DEPLOYMENT.md](DEPLOYMENT.md#what-the-encryption-does-and-does-not-do).
- Losing the volume or the key means every assistant must reconnect. No workout data is lost, because none is stored here.

## HTTP hardening

- **Host check:** requests are accepted only for the `PUBLIC_ORIGIN` hostname or loopback, otherwise HTTP 421. The raw Host header is checked, so forwarded-host headers cannot widen it. This blocks DNS rebinding and misrouted traffic. The proxy must therefore pass the original Host.
- **Origin check on `/mcp`:** a request carrying an Origin other than the service's own is rejected with HTTP 403, so a web page on another site cannot drive the endpoint from a browser.
- **Headers:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, and a Content Security Policy with `default-src 'none'`, `frame-ancestors 'none'` and `base-uri 'none'`. `same-origin` keeps the consent Origin check working while withholding referrers from other sites.
- **Stateless endpoint:** every MCP request is authenticated on its own. No session identifiers exist to steal. Request bodies are limited to 1 MB.
- Server timeouts: 15 seconds for headers and 90 seconds per request, and 15 seconds for each openGym API call (responses over 8 MB are refused).

## Write safety

- Mutations go through the openGym API, read the current revision, and preserve fields outside the requested change, including edits from other devices.
- Deletions need `confirm: true`, and a custom exercise in use cannot be deleted.
- `dry_run` previews changes, and `request_id` receipts prevent duplicate writes on retry. Details in [TOOLS.md](TOOLS.md#write-semantics).
- Tool results and openGym data are returned to the assistant as data. The server instructions tell the assistant to treat them as data, never instructions, but an assistant that is itself manipulated by content it reads can still misuse write access. Choose read-only if you do not need changes.

## Rate limits

| Limit | Value | Scope |
| --- | --- | --- |
| MCP requests | 180 per minute | per visitor address |
| Consent submissions | 30 per 15 minutes | per visitor address |
| Pairing code attempts | 5 | per sign-in page |
| Saved write requests | 120 per hour | per profile, kept in memory |
| `log_workout` saves | 20 per hour | whole service process, from the upstream implementation |

The visitor address comes from `X-Forwarded-For` according to `TRUST_PROXY_HOPS`. A wrong value makes limits apply to the proxy instead of individual visitors. The authorization, registration, token and revocation endpoints also carry the MCP SDK's own default rate limits.

## Logging

The service logs startup information (version, port, MCP URL, API address) and errors that stop it from starting. It does not log tokens, pairing codes, request bodies or workout data. Successful `log_workout` messages that contain workout identifiers and dates are suppressed.

## Container hardening

The container runs as the unprivileged `node` user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. Only `/data` is writable. The port is published on loopback only, so the public path goes through your reverse proxy. The standalone file also sets memory and process limits. Tests run during the image build.

## Known limitations

- **Restarts:** unfinished sign-in pages, issued but unexchanged authorization codes, cached client metadata, the per-profile write counters and the `log_workout` hourly count live in memory and reset on restart. Grants, tokens, clients and write receipts persist.
- **Paired-session bearer tokens:** a client may present a raw openGym paired-session token instead of OAuth. It is checked against openGym on each request and always has read and write scope. It cannot be limited to read-only and is not tracked or revocable here, only through openGym. See [CLIENTS.md](CLIENTS.md#clients-without-oauth).
- **Custody:** anyone with the volume and its key, or with root on the host, can use the stored upstream sessions until they are revoked in openGym. Revoke with **Sign out everywhere** if the host or a backup may be compromised.
- **One openGym per service** and root-host deployment only.
- **Upstream limit scope:** the `log_workout` limit is shared by all profiles on one service.
- **Not covered:** the confidentiality of openGym itself, the assistant vendor's handling of data you share with it, and the security of your reverse proxy or tunnel.
