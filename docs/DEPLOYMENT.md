# Deployment

openGym MCP is one container with one volume. It needs two things from you: a way to reach your openGym API, and its own public HTTPS hostname.

Contents: [Requirements](#requirements) · [The image](#the-image) · [Sidecar](#mode-1-sidecar-recommended) · [Standalone](#mode-2-standalone) · [Reverse proxy](#publish-it-over-https) · [Storage and backup](#storage-and-backup) · [Upgrading](#upgrading) · [Troubleshooting](#troubleshooting)

## Requirements

- Docker with Compose v2.
- A running openGym. Upstream's Compose project is named `opengym` with an `api` service (Node, port 3000, not published) and a `web` service (nginx, published as `${WEB_PORT:-8080}`, which proxies `/api/*`).
- A public hostname for this service, such as `gym-mcp.example.com`, with TLS terminated by a reverse proxy or tunnel. Assistants' servers (Claude, ChatGPT) call it from the internet, so it must be reachable there.
- The service lives at the root of that hostname. Subpaths such as `https://example.com/mcp-service/` are not supported.

## The image

No image is published to a registry yet. Build it locally:

```sh
docker build -t opengym-mcp:local .
```

Both Compose files use `${OPENGYM_MCP_IMAGE:-opengym-mcp:local}`, so this tag works without further setup. Set `OPENGYM_MCP_IMAGE` to use a different image.

The repository includes a GitHub Actions workflow that publishes `ghcr.io/<owner>/opengym-mcp` once the repository is on GitHub: `edge` from every push to `main`, and `X.Y.Z`, `X.Y` and `latest` when a release is published. After that, set `OPENGYM_MCP_IMAGE=ghcr.io/<owner>/opengym-mcp:latest` (with your owner name) and use `docker compose pull`.

What the image is:

- `node:22` on Alpine, running as the unprivileged `node` user.
- The test suite runs during the build. A failing test fails the build, and the tests are not shipped in the image.
- Healthcheck: `GET /healthz`, which returns `{"ok":true,"service":"opengym-mcp","version":"..."}`.
- Data lives in the `/data` volume. The Compose files also run it with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.

## Mode 1: sidecar (recommended)

The service joins openGym's own Compose project as a third container beside `api` and `web`. It reaches the API at `http://api:3000` over the project's private network, so workout data never leaves the host, and it takes the address people open openGym at from openGym's `ORIGIN`.

1. Copy `deploy/compose.opengym.yaml` into the directory that holds openGym's `docker-compose.yml`.

2. Add the service's public address to openGym's `.env`. `ORIGIN` should already be there (the full URL openGym is served from, such as `https://gym.example.com`):

   ```sh
   MCP_PUBLIC_ORIGIN=https://gym-mcp.example.com
   ```

3. Start both files together:

   ```sh
   docker compose -f docker-compose.yml -f compose.opengym.yaml up -d
   ```

To avoid repeating `-f`, set this in openGym's `.env` (use `;` instead of `:` as the separator on Windows):

```sh
COMPOSE_FILE=docker-compose.yml:compose.opengym.yaml
```

After that, plain `docker compose up -d` includes the sidecar.

Notes:

- The sidecar file builds the target API address from openGym's own `BACKEND` (default `api`) and `PORT` (default `3000`) variables. If you changed them in openGym, the sidecar follows. Do not set `PORT` for the MCP container itself.
- The service waits for `api` to start (`depends_on`), but not for it to be healthy.
- The Compose project is named `opengym`, so the volume is `opengym_mcp-data`.
- The service publishes `127.0.0.1:${MCP_PORT:-8082}`. Set `MCP_PORT` in `.env` if 8082 is taken. This is loopback only; your proxy does the public part.
- `MCP_TRUST_PROXY_HOPS` (default 1) is the number of proxies in front, see [CONFIGURATION.md](CONFIGURATION.md).

## Mode 2: standalone

Use this when openGym runs on another host or in a Compose project you do not want to touch. The service reaches openGym over HTTPS.

```sh
cp .env.example .env
```

Edit `.env`:

```sh
PUBLIC_ORIGIN=https://gym-mcp.example.com
OPENGYM_URL=https://gym.example.com
```

Then build and start:

```sh
docker compose up -d --build --wait
```

`--wait` returns once the healthcheck passes. This Compose project is named `opengym-mcp` and its volume is `opengym-mcp_mcp-data`.

`OPENGYM_URL` is the address this service uses to call the openGym API, so it must be reachable from the container. Plain HTTP is accepted only for localhost or a single-label private name such as `http://api:3000`. To allow plain HTTP to another trusted private address, set `OPENGYM_ALLOW_HTTP=true`. If `OPENGYM_URL` is not an `https://` address, also set `OPENGYM_PUBLIC_URL` to the address people open openGym at, or the sign-in pages cannot link to it.

If you keep a `compose.override.yaml` in this directory, Compose loads it automatically.

## Publish it over HTTPS

Either mode publishes the service on `127.0.0.1:${MCP_PORT:-8082}`. Route your public hostname to that port.

Rules that apply to every proxy:

1. **Pass the original Host header.** The service answers HTTP 421 to any request whose Host is not the `PUBLIC_ORIGIN` hostname or loopback. Caddy and Cloudflare Tunnel do this by default. nginx needs `proxy_set_header Host $host;`.
2. **Do not put SSO, basic auth or forward-auth in front of it.** Assistants' servers must reach `/mcp`, `/authorize`, `/token`, `/register`, `/revoke` and `/.well-known/*` directly. The service does its own authentication.
3. **Set `TRUST_PROXY_HOPS`** to the number of proxies between the internet and the service that append to `X-Forwarded-For` (1 for one proxy, 2 for a CDN plus a proxy, 0 for none). It is used for per-visitor rate limiting. Both Compose files default it to 1.
4. If the proxy runs in a container and cannot use `127.0.0.1` on the host, put it on the same Docker network as the service and target `mcp:8082`, or use the host's gateway address.

### Caddy

```
gym-mcp.example.com {
  reverse_proxy 127.0.0.1:8082
}
```

### nginx

```nginx
server {
  listen 443 ssl;
  server_name gym-mcp.example.com;

  ssl_certificate     /etc/ssl/gym-mcp/fullchain.pem;
  ssl_certificate_key /etc/ssl/gym-mcp/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8082;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Traefik (Docker labels)

Traefik forwards the original Host header by default. Put the service on Traefik's network and add labels, for example in a `compose.override.yaml`. The names `websecure`, `letsencrypt` and `traefik` are placeholders for your own entrypoint, certificate resolver and network:

```yaml
services:
  mcp:
    networks: [default, traefik]
    labels:
      traefik.enable: "true"
      traefik.docker.network: traefik
      traefik.http.routers.opengym-mcp.rule: Host(`gym-mcp.example.com`)
      traefik.http.routers.opengym-mcp.entrypoints: websecure
      traefik.http.routers.opengym-mcp.tls.certresolver: letsencrypt
      traefik.http.services.opengym-mcp.loadbalancer.server.port: "8082"

networks:
  traefik:
    external: true
```

Do not attach forward-auth or SSO middleware to this router.

### Cloudflare Tunnel

With a locally managed tunnel, add an ingress rule in `config.yml`:

```yaml
ingress:
  - hostname: gym-mcp.example.com
    service: http://127.0.0.1:8082
  - service: http_status:404
```

```sh
cloudflared tunnel route dns <tunnel-name> gym-mcp.example.com
```

With a dashboard-managed tunnel, add a public hostname `gym-mcp.example.com` with service `http://127.0.0.1:8082`. If `cloudflared` runs in a container, use a host address the container can reach instead of `127.0.0.1`. Do not enable Cloudflare Access on this hostname. Keep `TRUST_PROXY_HOPS=1` for a single tunnel hop.

### Verify

```sh
curl https://gym-mcp.example.com/healthz
curl -i https://gym-mcp.example.com/mcp
```

The first returns `{"ok":true,...}`. The second returns HTTP 401 with a `WWW-Authenticate` header, which is correct: the endpoint exposes nothing without a token. Then open `https://gym-mcp.example.com/` in a browser.

## Storage and backup

One volume, mounted at `/data`, holds two files:

| File | Contents |
| --- | --- |
| `state.enc` | OAuth clients, grants, hashed access and refresh tokens, upstream session tokens, write receipts. AES-256-GCM encrypted. |
| `storage.key` | 32 random bytes, the encryption key. Created automatically on first start with mode 0600. |

No workout data is stored here. It stays in openGym.

If `state.enc` exists but the key is missing, the service refuses to start instead of creating a new key, which would hide the loss until decryption failed.

### What the encryption does and does not do

With the key in the same volume, encryption protects against a leaked copy of `state.enc` alone (for example a stray backup file), not against someone who has the whole volume or the Docker host. To separate them, supply the key as a Docker secret. A key you supply through `AUTH_KEY_FILE` is never auto-created, and the service will not start without it.

```sh
umask 077
mkdir -p secrets
openssl rand 32 > secrets/storage.key
```

Add this to a `compose.override.yaml` next to the Compose file (adapt the service name if you use another file):

```yaml
services:
  mcp:
    environment:
      AUTH_KEY_FILE: /run/secrets/storage_key
    secrets:
      - storage_key

secrets:
  storage_key:
    file: ./secrets/storage.key
```

Compose mounts the secret file with its host ownership and permissions, and the container runs as UID 1000 (`node`). If the service cannot read the key, make the file readable by that user, for example `chown 1000 secrets/storage.key`. Store a copy of the key somewhere other than your volume backups.

Switching an existing deployment to a secret key means supplying the same 32 bytes. Copy the existing `storage.key` out of the volume and use it as the secret. A different key cannot open the old `state.enc`.

### Back up

Back up the volume, and the key if it is a secret. Losing either one means every assistant must reconnect (the key is not recoverable). Stop the service for a consistent copy. Find the volume name with `docker volume ls` (`opengym_mcp-data` for the sidecar, `opengym-mcp_mcp-data` for standalone):

```sh
docker compose stop mcp
docker run --rm -v opengym-mcp_mcp-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mcp-data.tgz -C /data .
docker compose start mcp
```

Treat the archive like a password file, since it holds the key unless you use a secret.

### Restore or move to another host

Create the volume, unpack the archive into it, and fix ownership:

```sh
docker volume create opengym-mcp_mcp-data
docker run --rm -v opengym-mcp_mcp-data:/data -v "$PWD":/backup alpine \
  sh -c "tar xzf /backup/mcp-data.tgz -C /data && chown -R 1000:1000 /data"
```

Then start the service as usual. To keep existing assistants connected after a move, use the same `PUBLIC_ORIGIN`. The origin is part of every token's audience, so changing it invalidates all grants. The `OPENGYM_URL` may change freely.

Do not run `docker compose down -v` unless you intend to discard all connections.

### Deployments created before the `/data` layout

Earlier versions kept the store at `/app/auth/state.enc` in a volume named `auth-data`, with the key mounted as a Docker secret. To keep those connections working, point the service at the old locations in a `compose.override.yaml`:

```yaml
services:
  mcp:
    environment:
      AUTH_STORE_PATH: /app/auth/state.enc
      AUTH_KEY_FILE: /run/secrets/storage_key
    volumes:
      - auth-data:/app/auth
    secrets:
      - storage_key

volumes:
  auth-data:

secrets:
  storage_key:
    file: ./secrets/storage.key
```

Alternatively, copy `state.enc` into the new volume and set `AUTH_KEY_FILE` as shown above. The old volume was named `opengym-mcp_auth-data` under the standalone project name.

## Upgrading

With a registry image:

```sh
docker compose pull
docker compose up -d
```

With a local build, update the source and rebuild:

```sh
git pull
docker build -t opengym-mcp:local .
docker compose up -d
```

(For standalone, `docker compose up -d --build` does both steps.) Connections survive upgrades. Sign-in pages that were open during the restart must be started again from the assistant.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Container exits with `Configuration error: ...` | A required variable is missing or invalid. The message names it. See [CONFIGURATION.md](CONFIGURATION.md). |
| Exits with "exists but its key ... is missing" | `state.enc` is present without its key. Restore the key. Only if it is lost for good, delete `state.enc` and reconnect every assistant. |
| HTTP 421 "Unrecognized host" | The proxy is not passing the original Host header, or `PUBLIC_ORIGIN` does not match the hostname people use. |
| Sign-in page shows no link to openGym | `OPENGYM_PUBLIC_URL` is not set and `OPENGYM_URL` is an internal address. |
| "That code was not accepted" | The code expired (5 minutes), was already used, or was created in a different openGym than `OPENGYM_URL` points at. |
| `/mcp` returns 401 after working before | The grant expired (30 days), was revoked, or "Sign out everywhere" was used in openGym. Reconnect. |
| Rate limited (HTTP 429) | All visitors look like one address. Check `TRUST_PROXY_HOPS` matches your proxy chain. |
| `docker compose` complains `PUBLIC_ORIGIN` is not set | Standalone needs `.env`. Sidecar needs `MCP_PUBLIC_ORIGIN` in openGym's `.env`. |

Logs, which never contain tokens, pairing codes or workout data:

```sh
docker compose logs --tail 50 mcp
```
