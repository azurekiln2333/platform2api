# platform2api

One management console and one Compose deployment for three independent services:
[CNB](https://github.com/azurekiln2333/cnb2api-panel), CodeBuddy and ZCode.

Each service keeps its own repository, image, data directory and model-call
endpoint. The panel manages them; it never proxies inference traffic and never
reads their data files.

```
platform2api  :9000  panel (this repo)
cnb           :9002  ./data/cnb/{data,logs}
codebuddy     :8787  ./data/codebuddy
zcode         :12283 ./data/zcode
```

## One key, four consoles

`PANEL_ADMIN_KEY` is the key. It logs into all four consoles and it is also
what the panel presents to each service as a management bearer, so the unified
deployment needs no per-service token.

A deployment with distinct keys overrides one service at a time:

| Variable | Effect |
| --- | --- |
| `PANEL_ADMIN_KEY` | Console login key for all four; default service credential (>= 12 chars) |
| `CNB_ADMIN_KEY` / `CODEBUDDY_ADMIN_KEY` / `ZCODE_ADMIN_KEY` | Optional per-service credential override |
| `PLATFORM_ADMIN_KEY` | Legacy alias for `PANEL_ADMIN_KEY`; the new name wins |

The pre-0.2 `CNB_PLATFORM_TOKEN`, `CODEBUDDY_PLATFORM_TOKEN` and
`ZCODE_PLATFORM_TOKEN` names are still read as a last fallback so existing
deployments keep working, but the shipped compose and `.env.example` no longer
use them.

Login itself is unchanged: panel key **or** SSO. SSO is configured in each
console and stored by that service, never in `.env`.

## Compose deployment

```bash
cp .env.example .env         # set PANEL_ADMIN_KEY, nothing else is required
mkdir -p data/panel data/cnb/data data/cnb/logs data/codebuddy data/zcode
docker compose pull
docker compose up -d
```

`docker-compose.yaml` loads `.env` with `env_file` for all four application
containers, so `PANEL_ADMIN_KEY` reaches every one of them without being
repeated. Container ports, data paths and health checks come from the images.
A scoped Watchtower container updates the four images when a new tag is
published.

Source build (each service from its own checkout, never from this repo):

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

`docker-compose.build.yaml` points at `../cnb2api-panel`,
`../codebuddy2api-main/codebuddy2api` and `../zcode2api/ZCode2api`; override
`CNB_BUILD_CONTEXT`, `CODEBUDDY_BUILD_CONTEXT` or `ZCODE_BUILD_CONTEXT` for a
different layout.

### Optional knobs

Only needed when you deviate from the defaults; put them in `.env`, which every
container reads.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIND_HOST` | `127.0.0.1` | Host interface the four ports are published on |
| `WATCHTOWER_POLL_INTERVAL` | `600` | Seconds between image checks |
| `TZ` | image default | Container time zone |
| `PLATFORM_PUBLIC_URL` | request origin | Panel console origin, for reverse proxies and the SSO redirect URI |
| `CNB_PUBLIC_URL` / `CODEBUDDY_PUBLIC_URL` / `ZCODE_PUBLIC_URL` | request origin | Origin browsers use when a service console is on its own domain |
| `PLATFORM_IMAGE` / `CNB_IMAGE` / `CODEBUDDY_IMAGE` / `ZCODE_IMAGE` | `ghcr.io/azurekiln2333/*:latest` | Pin another tag or registry |

Notes:

- Each service keeps its own data directory under `./data`. CodeBuddy's SQLite
  directory is never shared between instances.
- Gateway keys, upstream origins and model names are console settings or code
  defaults; they are not part of the deployment file.

## Local development

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"  # panel key
PANEL_ADMIN_KEY=<key> \
CNB_URL=http://127.0.0.1:9002 \
CODEBUDDY_URL=http://127.0.0.1:8787 \
ZCODE_URL=http://127.0.0.1:12283 \
npm start
```

`npm start` reads `.env` when present. Node >= 22.12. The console is served
from `web/dist`; without a build, `/` answers 404 with a build hint and the API
still works.

```bash
npm test                              # backend suites, no network or services
npm run build --prefix web            # console
npm test --prefix web                 # console unit tests
```

## Panel API

Same conventions as cnb2api-panel: `{ error: { message, type, param?, code? } }`,
opaque session cookie, no roles.

| Route | Purpose |
| --- | --- |
| `POST /api/session` | Admin-key login (`{ key }`), 10 failures per IP per 10 min → 429 |
| `GET /api/session` | Current session + available systems |
| `DELETE /api/session` | Logout |
| `GET /api/auth/config` | Key-login flag and SSO login URL |
| `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback` | PKCE SSO login |
| `GET/PATCH /api/auth/settings` | SSO settings; the client secret is never echoed |
| `GET/PATCH /api/settings` | Service URLs (per-system overrides) + credential *presence* |
| `GET /api/overview` | `{ generatedAt, cnb, codebuddy, zcode }`, each with `health`, `detail`, `quota`, `accounts`, `usage` or an isolated `error` |
| `GET /api/accounts?system=&tag=` | Unified list, id `<system>:<nativeId>`, automatic system tag |
| `GET/PUT /api/accounts/:id/tags` | Panel-owned tags (`data/panel/tags.json`) |
| `POST /api/accounts/auth/:system/{start,poll,complete}` | Wraps each service's own authorization flow |
| `* /api/p/:system/*` | Normalizing passthrough to that service's management routes |
| `GET /health`, `GET /api/health` | Panel liveness / per-system health, no session |

Overview sections are always per system and never summed or blended. A failing
system yields an error for its own key only.

## Service authentication

Browsers never talk to a service; the panel proxies every management request.
Each service accepts `Authorization: Bearer <PANEL_ADMIN_KEY>` on its management
routes (constant-time compare, never on model/data-plane routes), which is why
the unified deployment needs no token variables. `GET /api/settings` shows per
service whether a credential is present, never its value.

## Adapter contract

See [`src/adapters/README.md`](src/adapters/README.md). One module per system;
`src/adapters/index.mjs` resolves injection → `<system>.mjs` → stub.

## Persistent state

`data/panel/panel.json` (SSO settings, service URL overrides, client secret
encrypted with `data/panel/master.key`) and `data/panel/tags.json`. Losing
`master.key` makes the stored client secret unrecoverable; back up the whole
`data/panel` directory.
