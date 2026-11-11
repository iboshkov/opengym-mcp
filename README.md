# openGym MCP

[![Build](https://github.com/iboshkov/opengym-mcp/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/iboshkov/opengym-mcp/actions/workflows/docker-publish.yml)

Connect Claude, ChatGPT and other AI assistants to [openGym](https://github.com/DuarteSantos8/openGym), the self-hosted workout tracker. The assistant can look up your routines and history, log a workout, adjust a routine or record your bodyweight.

It is a small container that runs next to openGym. Assistants connect by URL and sign in with OAuth, so there are no API keys to copy around. Each person pairs their own profile with a one-time code from openGym and chooses read-only or read and write access.

```
Assistant  --HTTPS-->  reverse proxy  -->  openGym MCP  -->  openGym API
```

No workout data is stored here. The service keeps only its own authorizations, encrypted, on one volume.

> An independent companion project, not part of openGym.

## Quick start

You need a running openGym Compose project and a public HTTPS hostname for this service, such as `gym-mcp.example.com`. It needs its own hostname; a subpath of openGym's will not work.

1. In openGym's directory, download the sidecar file and set the public address:

   ```sh
   curl -O https://raw.githubusercontent.com/iboshkov/opengym-mcp/main/deploy/compose.opengym.yaml
   echo 'MCP_PUBLIC_ORIGIN=https://gym-mcp.example.com' >> .env
   ```

2. Start it together with openGym:

   ```sh
   docker compose -f docker-compose.yml -f compose.opengym.yaml up -d
   ```

3. Route the hostname to `127.0.0.1:8082` in your reverse proxy. With Caddy:

   ```
   gym-mcp.example.com {
     reverse_proxy 127.0.0.1:8082
   }
   ```

4. Open `https://gym-mcp.example.com`. The page shows the server address and the steps for each assistant.

nginx, Traefik and Cloudflare Tunnel examples, the standalone mode for an openGym that runs elsewhere, backups and upgrades are covered in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Do not put SSO or forward-auth in front of the service.

## Connect an assistant

Add `https://gym-mcp.example.com/mcp` as a remote MCP server. For example, in Claude Code:

```sh
claude mcp add --transport http --scope user opengym https://gym-mcp.example.com/mcp
```

The assistant opens a sign-in page on your server. In openGym, go to **Settings → Account → Pair the mobile app**, type the one-time code into the sign-in page, and choose what the assistant may do.

Steps for every client are in [docs/CLIENTS.md](docs/CLIENTS.md).

## What assistants can do

| Area | Read | Change (if you allow it) |
| --- | --- | --- |
| Exercises | Search the library, view details | Create, edit and delete custom exercises |
| Routines | List, preview a session, week plan, programme | Create, edit, reorder, delete, assign to weekdays |
| Workouts | History, single workouts, 1RM estimates, muscle balance | Log, edit and delete |
| Bodyweight | Readings over time | Add, edit and delete |

Changes are applied on top of the latest version of your data and never overwrite edits made on another device. Deletions need explicit confirmation. All 29 tools are listed in [docs/TOOLS.md](docs/TOOLS.md).

## Security

- OAuth 2.1 with PKCE. Your openGym password or passkey never reaches this service.
- Each connection is limited to the one profile that was paired, with the access level chosen at sign-in.
- "Sign out everywhere" in openGym ends every connection immediately.
- Tokens are stored as hashes in an encrypted file. Tokens, pairing codes and workout data are never logged.
- The container runs as a non-root user on a read-only filesystem.

The full model and its limits are in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation

- [Deployment](docs/DEPLOYMENT.md): sidecar and standalone setup, reverse proxies, storage, backup, upgrades, troubleshooting
- [Configuration](docs/CONFIGURATION.md): every environment variable
- [Clients](docs/CLIENTS.md): connecting each assistant
- [Tools](docs/TOOLS.md): tool reference and how writes behave
- [Security model](docs/SECURITY_MODEL.md): authorization design and known limitations
- [Development](docs/DEVELOPMENT.md): source layout, tests, vendored code

## Development

TypeScript on Node 22, run directly without a build step.

```sh
npm ci
npm run typecheck
npm test
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE). The training calculations and several tools are vendored from [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos; the pinned revision and local changes are recorded in [vendor/UPSTREAM.md](vendor/UPSTREAM.md).
