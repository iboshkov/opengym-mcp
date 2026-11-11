# Configuration

The service is configured only through environment variables. They are read once at startup and validated. A bad value stops the service with a `Configuration error:` message that names the variable.

Contents: [Service variables](#service-variables) · [Compose-only variables](#compose-only-variables) · [Examples](#examples) · [Fixed behaviour](#fixed-behaviour)

## Service variables

These are read by the Node process (`src/config.ts`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | none, required | The public address of this service, as a bare origin: `https://gym-mcp.example.com`. No path, credentials, query or fragment. Must be HTTPS, except `http://localhost` and `http://127.0.0.1` for local testing. It is the OAuth issuer, the base of the MCP URL (`<origin>/mcp`) and the audience every token is bound to, so changing it invalidates existing connections. Requests for any other hostname get HTTP 421. |
| `OPENGYM_URL` | none, required | Base URL of the openGym API, as this service reaches it: `https://gym.example.com` or `http://api:3000`. Must be an http(s) URL without credentials, query or fragment. Plain `http://` is accepted only for `localhost`, `127.0.0.1`, or a single-label private service name (no dots, such as `api`). Anything else needs HTTPS or `OPENGYM_ALLOW_HTTP`. |
| `OPENGYM_ALLOW_HTTP` | off | Set to `true` (also `1`, `yes`, `on`) to allow plain HTTP to another trusted private address, such as `http://192.168.1.20:8080`. Only use it on a network you trust, because profile session tokens cross it. |
| `OPENGYM_PUBLIC_URL` | `OPENGYM_URL` when that is HTTPS, otherwise unset | The address people open openGym at in a browser. Used only for the "Open openGym" links on the connection and sign-in pages. Set it when `OPENGYM_URL` is an internal address. If it is unset the pages show the text without a link, and the startup log says so. |
| `PORT` | `8082` | Port the service listens on, 1 to 65535. The image sets 8082 and the Compose files publish container port 8082, so leave it alone in containers and use `MCP_PORT` to change the host port. |
| `TRUST_PROXY_HOPS` | `0` in code, `1` in both Compose files | Number of reverse proxies between the internet and the service, 0 to 5. Used to find the visitor's address in `X-Forwarded-For` for per-visitor rate limits. Too low and every visitor looks like the proxy; too high and a visitor can spoof their address. The Host check never trusts forwarded headers. |
| `DATA_DIR` | `./data`, `/data` in the image | Directory for the encrypted store and the default key location. Created if missing. |
| `AUTH_STORE_PATH` | `<DATA_DIR>/state.enc` | Location of the encrypted authorization store. Override only to keep an older layout, see [DEPLOYMENT.md](DEPLOYMENT.md#deployments-created-before-the-data-layout). |
| `AUTH_KEY_FILE` | `<DATA_DIR>/storage.key` | Location of the 32-byte AES-256-GCM key. If you set it, the file must already exist and contain exactly 32 bytes, and the service never creates it. If you leave it unset, the key is created on first start (mode 0600), unless `state.enc` already exists without it, in which case the service refuses to start. |
| `TZ` | `UTC` in the Compose files | Time zone of the process. Tools that default to "today" (for example the date of a logged workout) use it, so set it to the time zone of the person whose profile is connected. |

## Compose-only variables

These are read by Docker Compose, not by the service.

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `OPENGYM_MCP_IMAGE` | both files | `ghcr.io/iboshkov/opengym-mcp:edge` (sidecar), `opengym-mcp:local` (standalone, built from the checkout) | Image to run. See [the image tags](DEPLOYMENT.md#the-image). |
| `MCP_PORT` | both files | `8082` | Host port published on `127.0.0.1`. Maps to container port 8082. |
| `MCP_PUBLIC_ORIGIN` | sidecar | none, required | Becomes `PUBLIC_ORIGIN`. Set it in openGym's `.env`. |
| `MCP_TRUST_PROXY_HOPS` | sidecar | `1` | Becomes `TRUST_PROXY_HOPS`. |
| `ORIGIN` | sidecar | none | openGym's own variable. Reused as `OPENGYM_PUBLIC_URL`. |
| `BACKEND`, `PORT` | sidecar | `api`, `3000` | openGym's own variables. Used to build `OPENGYM_URL` as `http://<BACKEND>:<PORT>`. They are not passed to the MCP container. |
| `TZ` | both files | `UTC` | Passed through as `TZ`. |

The standalone file (`compose.yaml`) passes `PUBLIC_ORIGIN`, `OPENGYM_URL`, `OPENGYM_PUBLIC_URL`, `TRUST_PROXY_HOPS` and `TZ` from `.env` straight through to the container. `.env.example` lists them.

The Compose files do not pass `OPENGYM_ALLOW_HTTP`, `AUTH_STORE_PATH` or `AUTH_KEY_FILE`. To set them, use a `compose.override.yaml`:

```yaml
services:
  mcp:
    environment:
      OPENGYM_ALLOW_HTTP: "true"
```

## Examples

Sidecar, in openGym's `.env`:

```sh
ORIGIN=https://gym.example.com
MCP_PUBLIC_ORIGIN=https://gym-mcp.example.com
```

Standalone, in `.env`:

```sh
PUBLIC_ORIGIN=https://gym-mcp.example.com
OPENGYM_URL=https://gym.example.com
MCP_PORT=8082
TRUST_PROXY_HOPS=1
TZ=Europe/Lisbon
```

Running without Docker for local testing:

```sh
PUBLIC_ORIGIN=http://localhost:8082 OPENGYM_URL=http://localhost:3000 node src/server.ts
```

## Fixed behaviour

Not configurable:

| Behaviour | Value |
| --- | --- |
| Access token lifetime | 1 hour |
| Grant (refresh token) lifetime | 30 days from authorization, not extended by refreshing |
| Sign-in page lifetime | 10 minutes |
| Authorization code lifetime | 2 minutes |
| Pairing code attempts per sign-in page | 5 |
| Consent submissions per visitor | 30 per 15 minutes |
| MCP requests per visitor | 180 per minute |
| Saved writes per profile | 120 per hour |
| Write receipts | 24 hours, at most 2000 |
| Request body limit on `/mcp` | 1 MB |
| openGym API request timeout | 15 seconds |
| Registered OAuth clients | at most 1000 |

See [SECURITY_MODEL.md](SECURITY_MODEL.md) for what each of these protects.
