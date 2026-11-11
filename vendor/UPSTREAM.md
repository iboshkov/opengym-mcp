# Vendored openGym source

Source: https://github.com/DuarteSantos8/openGym

Revision: `50ab7f24e3c4ee70e7f26b3beb426f571e03414b`

License: AGPL-3.0-or-later. The license text is at the project root and the upstream notice is in [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md).

## What is included

The MCP tool implementations (`mcp/src`), the shared frontend training libraries they import (`frontend/src/lib`), and the API coach core helpers those libraries need (`api/coach/core`). Reusing them keeps this service's calculations (progression, volume, PR history, weigh-ins) identical to the app's.

No user data, credentials, exercise images or videos, or application configuration was copied. Upstream's own unit tests are kept in the tree for reference and are excluded from the container image by `.dockerignore`.

## Local adaptations

Keep this list complete: it is what has to be re-applied when the revision is bumped.

1. `mcp/src/state.js` accepts request-scoped state fetched from the API, using AsyncLocalStorage. This keeps the upstream calculations while avoiding filesystem access and state shared between profiles. The filesystem transport remains in the module but is not used by this service.
2. Successful `log_workout` messages that contain workout identifiers and dates are suppressed, so nothing personal reaches the logs.
3. `mcp/src/api-client.js`: `apiBase()` takes an `allowHttp` option, enabled through `OPENGYM_ALLOW_HTTP=1` in the environment object passed to the tool. This service validates the API address itself (`src/config.js`) and may reach the API over a private container network such as `http://api:3000`. Upstream's default (HTTPS, or HTTP to loopback only) is unchanged when the option is absent.

## Updating

1. Copy the same three directories from the new upstream revision over `vendor/opengym/`.
2. Re-apply the adaptations above.
3. Update the revision in this file.
4. Run `npm test` and `npm run test:contract`.
