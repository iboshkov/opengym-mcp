# Development

Contents: [Setup](#setup) · [Running locally](#running-locally) · [Tests](#tests) · [Source layout](#source-layout) · [Vendored openGym code](#vendored-opengym-code) · [Continuous integration](#continuous-integration) · [Releases](#releases)

## Setup

Requirements: Node.js 22 (`package.json` requires 22.23.4 or later, the version the Docker image uses), npm, and Docker for the contract test and for building the image.

```sh
npm ci
```

## Running locally

Without Docker, using a `.env` file. Local runs use `PORT`, not `MCP_PORT`, which only Compose reads:

```sh
cat > .env <<'EOF'
PUBLIC_ORIGIN=http://localhost:8082
OPENGYM_URL=http://localhost:3000
PORT=8082
EOF
node --env-file=.env src/server.js
```

This creates `./data/state.enc` and `./data/storage.key` on first start (`./data` is git-ignored). `PUBLIC_ORIGIN` may use plain HTTP only for `localhost` and `127.0.0.1`. Pairing needs an openGym API reachable at `OPENGYM_URL`, for example a local openGym from its Compose file with the API port published. Use a throwaway profile and never real data in tests.

With Docker:

```sh
docker build -t opengym-mcp:local .
docker compose up -d --wait
```

All settings are described in [CONFIGURATION.md](CONFIGURATION.md).

## Tests

| Command | What it runs |
| --- | --- |
| `npm test` | Unit and integration tests with `node --test`, against in-memory openGym API fixtures. No network, Docker or browser needed. Runs during every image build. |
| `npm run test:browser` | Playwright test of the real consent form in Chromium. Install the browser first with `npx playwright install chromium --only-shell`. |
| `npm run test:contract` | Needs Docker. Starts a disposable upstream openGym API container (`ghcr.io/duartesantos8/opengym-api`) with synthetic data in a temporary directory, runs exercise, routine, schedule, workout and bodyweight changes through the service, and removes only its own container and files. |

What the suites cover:

- **OAuth** (`test/auth.test.js`): unauthenticated challenge, cookie-bound same-origin consent, S256 PKCE, resource, client and redirect binding, one-use codes, read-only scope enforcement, DCR with public and confidential clients, refresh rotation and replay revocation, revocation by openGym sign-out, encrypted store reload and wrong-key rejection, client ID metadata documents for ChatGPT, Claude web and Claude Code (including dynamic loopback ports and no-redirect fetching), and issuer and state on error redirects.
- **Tools** (`test/tools.test.js`): the MCP handshake, instructions and annotations, profile isolation, custom exercise and routine CRUD with deletion guards, preservation of unrelated data, `dry_run`, `request_id` receipts (including across a restart and uncertain outcomes), revision conflicts that keep concurrent edits, bodyweight units, and `log_workout` duplicate handling.
- **Web and HTTP** (`test/ui.test.js`): the connection guide and its assets, recovery pages versus JSON errors, retained consent choices, the SSRF-filtered metadata client, and the Host check with a trusted proxy.
- **Configuration** (`test/config.test.js`): required variables, HTTPS rules for `PUBLIC_ORIGIN` and `OPENGYM_URL`, private service names, derived public URL, defaults and overrides.
- **Storage** (`test/storage.test.js`): first-start key creation, refusal to replace a missing key for an existing store, and an encrypted round trip.
- **Browser** (`test/browser/`): approval and cancellation using the browser's native form submission, without hand-set headers.
- **Contract** (`test/contract.js`): the same operations against the real openGym API.

Shared fixtures live in `test/fixture.js`. They use synthetic profiles only.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/config.js` | Reads and validates environment variables. |
| `src/server.js` | Process entry point: loads config, creates the key and store, starts listening, handles shutdown. |
| `src/app.js` | Builds the Express app: Host guard, security headers, `/healthz`, then the web, OAuth and MCP routers. |
| `src/http/` | Host and Origin checks and security headers. |
| `src/oauth/` | The OAuth authorization server: provider, routes, and client metadata fetching. |
| `src/mcp/` | The Streamable HTTP endpoint, the tool runner, write receipts and the write limiter. |
| `src/tools/` | Tool definitions, shared schemas, and the server instructions sent to assistants. |
| `src/opengym/` | Client for the openGym HTTP API, including revision-checked saves with conflict retry. |
| `src/storage/` | The AES-256-GCM encrypted store and key creation. |
| `src/web/` | Server-rendered connection and sign-in pages. `web/public/` holds the static assets (stylesheet, script, icon). |
| `vendor/` | Vendored openGym source and its notices. Not edited casually, see below. |
| `test/` | Tests and fixtures. |
| `deploy/` | The sidecar Compose file. |
| `docs/` | This documentation. |

## Vendored openGym code

The training calculations and several tool implementations come from upstream openGym (AGPL-3.0-or-later) and are copied into `vendor/`. `vendor/UPSTREAM.md` records the source, the pinned upstream revision, what was included, and every local adaptation. No user data, credentials, media or application configuration is vendored. The upstream notice is `vendor/UPSTREAM-NOTICE.md`.

To update it:

1. Copy the changed files from the new upstream revision over the matching files in `vendor/`.
2. Reapply the local adaptations listed in `vendor/UPSTREAM.md`, and add any new ones to that list.
3. Update the pinned revision in `vendor/UPSTREAM.md`.
4. Run `npm test`, `npm run test:browser` and `npm run test:contract`. Check `docs/TOOLS.md` if tools or their parameters changed.

## Continuous integration

- `.github/workflows/test.yml` runs `npm test` and the browser test on pull requests. A second job builds the image (which runs the test stage), starts it read-only and waits for it to become healthy.
- `.github/workflows/docker-publish.yml` runs on pushes to `main` and on published releases. It calls the test workflow first and only then publishes `ghcr.io/<owner>/opengym-mcp` for `linux/amd64` and `linux/arm64`.
- `.github/dependabot.yml` opens weekly pull requests for npm packages, GitHub Actions and the base image.

## Releases

A push to `main` publishes the `edge` image. Publishing a GitHub release tagged `vX.Y.Z` publishes `X.Y.Z`, `X.Y` and `latest`. The workflow passes the version as a build argument, which becomes an image label. The version reported at `/healthz` comes from `package.json`.

## Documentation upkeep

When tools, environment variables, endpoints or limits change, update the matching page in `docs/`, the README connection examples, and the server instructions in `src/tools/` in the same change.
