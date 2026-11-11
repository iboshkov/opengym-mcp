# Contributing

Thanks for helping with openGym MCP. This is an independent companion project for [openGym](https://github.com/DuarteSantos8/openGym). Contributions are licensed under AGPL-3.0-or-later, like the rest of the project.

## Setup

You need Node.js 22 and Docker (Docker only for the contract test and the image build).

```sh
npm ci
npm test
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for running the service locally and for the source layout.

## Before you open a pull request

These must pass:

```sh
npm test
npx playwright install chromium --only-shell
npm run test:browser
```

Run `npm run test:contract` (needs Docker) when you touch anything that writes to the openGym API, and build the image with `docker build -t opengym-mcp:local .` when you touch the Dockerfile or dependencies. The image build runs the tests too.

## Invariants every change must keep

Changes that touch these areas need tests that keep them covered:

- **OAuth:** resource binding to `/mcp`, S256 PKCE only, explicit user consent through an openGym pairing code, refresh token rotation with replay detection, and the SSRF-filtered client metadata fetch.
- **Isolation:** one profile per grant, the upstream session checked on every request, and no state shared between profiles.
- **Writes:** every mutation goes through the openGym API, reads the current revision, and preserves fields outside the requested change. Deletions require `confirm: true`, and a custom exercise in use cannot be deleted.
- **Idempotency:** `request_id` receipts, and the distinction between a write that definitely saved nothing and one with an unknown outcome.
- **Secrets:** tokens, pairing codes and workout data are never logged, and the encrypted store and key handling stay as documented.

Also:

- Tests for writes use the isolated in-memory API fixtures (or the disposable contract container), never a real workout profile.
- Keep fixtures, logs and examples free of tokens, pairing codes, real hostnames and personal workout data. Use `example.com` hosts.
- Update the docs in the same change: `docs/TOOLS.md` and the server instructions in `src/tools/` when tools change, `docs/CONFIGURATION.md` and `.env.example` when settings change, and the README connection examples when capabilities change.
- Files under `vendor/` come from upstream openGym. Do not edit them casually. If a local adaptation is unavoidable, record it in `vendor/UPSTREAM.md`. Never vendor exercise images or videos.

## Style

- 2-space indentation, no semicolons, ES modules.
- Small modules with one job, and plain names over clever ones.
- Comments explain why, not what.
- Docs are plain and direct, in the second person, with copy-pasteable commands. Do not use em dashes.

## Pull requests

Keep each pull request to one change, describe what it does and how you tested it, and note any behaviour a deployer would notice. For security issues, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
