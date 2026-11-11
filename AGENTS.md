# openGym MCP

This is an independent HTTP MCP service for the openGym API, packaged as a container that runs alongside openGym. Do not modify openGym accounts, passkeys, a running deployment, or unrelated reverse-proxy routes.

Run `npm test` after changes. All mutations must use the openGym API, read the current revision, and preserve fields outside the requested change. Test writes against isolated in-memory API fixtures, never a personal workout profile. Keep tokens, pairing codes, and personal workout data out of source, logs, test fixtures, and Git. Keep real hostnames out of the repository: examples use `gym.example.com` and `gym-mcp.example.com`.

Keep OAuth resource binding, S256 PKCE, user consent, refresh rotation, profile isolation, and deletion guards covered by tests. Support standard Streamable HTTP clients and document authorization and restart limitations accurately. Update the README, `docs/`, the landing page (`src/web/pages.js`) and the server instructions (`src/tools/instructions.js`) when capabilities change.

Vendored openGym source is AGPL-3.0-or-later. Record its pinned upstream revision and local adaptations in vendor/UPSTREAM.md. No exercise images or videos are vendored.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/server.js`, `src/config.js` | Entry point; environment parsing and validation |
| `src/app.js` | Assembles the Express app from the routers below |
| `src/http/` | Host allowlist and security headers |
| `src/oauth/` | Authorization server: clients, consent, grants, tokens |
| `src/mcp/` | Streamable HTTP endpoint, tool dispatch, write limit, idempotency receipts |
| `src/tools/` | Tool definitions by domain, plus wrappers around vendored upstream tools |
| `src/opengym/` | openGym API client with revision-checked writes |
| `src/storage/` | Encrypted authorization store |
| `src/web/` | Landing, consent and notice pages; static assets in `public/` |

## Conventions

ES modules, 2-space indent, no semicolons, single quotes. Small modules with one responsibility, named constants instead of magic numbers, comments that explain why. The product is spelled "openGym" in anything a person or assistant reads. Pages must work under the strict Content-Security-Policy in `src/http/security.js`: no inline styles or scripts.
