# openGym MCP

A remote MCP server for [openGym](https://github.com/DuarteSantos8/openGym), the self-hosted workout tracker. It runs as a container next to openGym and lets AI assistants such as Claude, ChatGPT, Codex, Cursor and VS Code read and edit one paired openGym profile: look up routines and history, log a workout, adjust a routine, record bodyweight.

It speaks Streamable HTTP with OAuth 2.1, so assistants connect by URL with no API keys to copy around. Each person pairs their own profile with a one-time code from openGym's settings and chooses read-only or read and write access.

```
 Assistant (Claude, ChatGPT, ...)
        |  HTTPS, OAuth bearer token
        v
 Reverse proxy or tunnel  ->  openGym MCP (this project, port 8082)
                                    |  openGym HTTP API, per-profile session
                                    v
                              openGym API (api:3000)  ->  your workout data
```

The service stores no workout data. It keeps only OAuth clients, grants and token hashes in an encrypted file on its own volume.

> This is an independent companion project. It is not part of openGym and is not endorsed by the openGym author unless stated otherwise.

## Quick start (next to openGym)

You need a running openGym Compose project and a public HTTPS hostname for this service, for example `gym-mcp.example.com`. It must be its own hostname at the root, not a subpath of openGym's.

1. Build the image once (no registry image is published yet):

   ```sh
   git clone <this repository> opengym-mcp
   docker build -t opengym-mcp:local opengym-mcp
   ```

2. Copy the sidecar file next to openGym's `docker-compose.yml`:

   ```sh
   cp opengym-mcp/deploy/compose.opengym.yaml /path/to/opengym/
   ```

3. From openGym's directory, add the public address to its `.env` (its existing `ORIGIN` is reused for links):

   ```sh
   echo 'MCP_PUBLIC_ORIGIN=https://gym-mcp.example.com' >> .env
   ```

4. Start openGym and the MCP service together:

   ```sh
   docker compose -f docker-compose.yml -f compose.opengym.yaml up -d
   ```

5. Route the hostname to `127.0.0.1:8082`. With Caddy:

   ```
   gym-mcp.example.com {
     reverse_proxy 127.0.0.1:8082
   }
   ```

   nginx, Traefik and Cloudflare Tunnel examples are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Do not put SSO or forward-auth in front of it.

6. Check it, then open `https://gym-mcp.example.com` in a browser:

   ```sh
   curl https://gym-mcp.example.com/healthz
   ```

The page shows the server URL with a copy button and steps for each assistant.

### Standalone variant

If openGym runs elsewhere, or you prefer a separate Compose project, point this service at any openGym reachable over HTTPS:

```sh
cp .env.example .env    # set PUBLIC_ORIGIN and OPENGYM_URL
docker compose up -d --build --wait
```

Then add the reverse proxy route as above. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Connect an assistant

Add `https://gym-mcp.example.com/mcp` as a remote MCP server in your assistant. It opens a sign-in page on your server. In openGym, go to **Settings → Account → Pair the mobile app**, confirm with your passkey or password, and type the one-time code (valid 5 minutes) into the sign-in page. Choose read-only or read and write, and you are connected.

```sh
claude mcp add --transport http --scope user opengym https://gym-mcp.example.com/mcp
```

Steps for Claude apps, Claude Code, Codex, ChatGPT, Cursor, VS Code and stdio-only clients are in [docs/CLIENTS.md](docs/CLIENTS.md).

## What assistants can do

29 tools, each declaring the OAuth scope it needs. Reads need `opengym:read`; anything that changes data also needs `opengym:write`.

| Area | Tools |
| --- | --- |
| Profile and exercises | `get_profile`, `search_exercises`, `get_exercise` |
| Plans and progress | `list_routines`, `get_routine`, `preview_session`, `get_week_plan`, `get_programme`, `estimate_1rm`, `muscle_balance` |
| History and bodyweight | `list_workouts`, `get_workout`, `get_bodyweight` |
| Custom exercises | `create_exercise`, `update_exercise`, `delete_exercise` |
| Routines | `create_routine`, `update_routine`, `add_routine_exercise`, `update_routine_exercise`, `remove_routine_exercise`, `delete_routine`, `set_weekday_routines` |
| Workouts | `log_workout`, `update_workout`, `delete_workout` |
| Bodyweight | `add_bodyweight`, `update_bodyweight`, `delete_bodyweight` |

Writes read the current profile revision, change only what was asked, and keep edits made on other devices. Most accept `dry_run` and a `request_id` for safe retries; deletions require `confirm=true`. Details in [docs/TOOLS.md](docs/TOOLS.md).

## Security at a glance

- OAuth 2.1 authorization code flow with S256 PKCE, resource binding to `/mcp`, and rotating refresh tokens with replay detection.
- The person consents by redeeming an openGym pairing code. Your passkey or password never reaches this service.
- Each connection is tied to one profile. The upstream openGym session is checked on every request, so "Sign out everywhere" in openGym cuts access immediately.
- Access tokens last 1 hour and grants 30 days. Tokens are stored only as hashes.
- Authorization state is AES-256-GCM encrypted on disk. The key lives beside it by default, which protects a leaked copy of the file, not a stolen volume. A Docker secret key is supported.
- Requests for other hostnames are rejected, rate limits apply, and tokens, pairing codes and workout data are never logged.
- The container runs as a non-root user with a read-only filesystem and all capabilities dropped.

Full model and limits: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md). Report problems as described in [SECURITY.md](SECURITY.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | Index of the documentation |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Sidecar and standalone setup, reverse proxy and tunnel examples, storage, backup, upgrades, troubleshooting |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable and Compose setting |
| [docs/CLIENTS.md](docs/CLIENTS.md) | Connecting Claude, ChatGPT, Codex, Cursor, VS Code and others |
| [docs/TOOLS.md](docs/TOOLS.md) | Tool reference and write semantics |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Authorization design, data handling, limits, known limitations |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Source layout, running tests, updating vendored code |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Limitations

- One openGym instance per service, and the service must be served from the root of its own hostname.
- Unfinished sign-in pages do not survive a restart. Established connections do.
- Exercise photos and videos are not exposed.

## Development

```sh
npm ci && npm test
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for browser and contract tests.

## License and credits

AGPL-3.0-or-later, see [LICENSE](LICENSE). The training calculations and tool implementations are vendored from [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos (AGPL-3.0). The pinned upstream revision and local adaptations are recorded in [vendor/UPSTREAM.md](vendor/UPSTREAM.md). No exercise images or videos are vendored.
