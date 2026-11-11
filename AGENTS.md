# openGym MCP

This is an independent HTTP MCP service for the openGym API, packaged as a container that runs alongside openGym. Do not modify openGym accounts, passkeys, a running deployment, or unrelated reverse-proxy routes.

Run `npm run typecheck` and `npm test` after changes. All mutations must use the openGym API, read the current revision, and preserve fields outside the requested change. Test writes against isolated in-memory API fixtures, never a personal workout profile. Keep tokens, pairing codes, and personal workout data out of source, logs, test fixtures, and Git. Keep real hostnames out of the repository: examples use `gym.example.com` and `gym-mcp.example.com`.

Keep OAuth resource binding, S256 PKCE, user consent, refresh rotation, profile isolation, and deletion guards covered by tests. Support standard Streamable HTTP clients and document authorization and restart limitations accurately. Update the README, `docs/`, the landing page (`src/web/pages.ts`) and the server instructions (`src/tools/instructions.ts`) when capabilities change.

Vendored openGym source is AGPL-3.0-or-later. Record its pinned upstream revision and local adaptations in vendor/UPSTREAM.md. No exercise images or videos are vendored.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/server.ts`, `src/config.ts` | Entry point; environment parsing and validation |
| `src/app.ts` | Assembles the Express app from the routers below |
| `src/http/` | Host allowlist and security headers |
| `src/oauth/` | Authorization server: clients, consent, grants, tokens |
| `src/mcp/` | Streamable HTTP endpoint, tool dispatch, write limit, idempotency receipts |
| `src/tools/` | Tool definitions by domain, plus wrappers around vendored upstream tools |
| `src/opengym/` | openGym API client with revision-checked writes |
| `src/storage/` | Encrypted authorization store |
| `src/web/` | Landing, consent and notice pages; static assets in `public/` |

## Conventions

TypeScript run directly by Node (type stripping, no build step), so only erasable syntax: no enums or parameter properties, `import type` for types, and `.ts` extensions in relative imports. Vendored code and the browser script in `src/web/public/` stay JavaScript. ES modules, 2-space indent, no semicolons, single quotes. Small modules with one responsibility, named constants instead of magic numbers, comments that explain why. The product is spelled "openGym" in anything a person or assistant reads. Pages must work under the strict Content-Security-Policy in `src/http/security.ts`: no inline styles or scripts.
