# platform2api

One management console and one Compose deployment for three independent services:
[CNB](https://github.com/azurekiln2333/cnb2api-panel), CodeBuddy and ZCode.

The three services keep their own repositories, images, data directories and
model-call endpoints. The panel manages them; it never proxies inference traffic
and never reads their data files.

```
platform2api  :9000  panel (this repo)
cnb           :9002  independent image + ./data/cnb/{data,logs}
codebuddy     :8787  independent image + ./data/codebuddy
zcode         :12283 independent image + ./data/zcode
```

## Status

| Area | State |
| --- | --- |
| Panel server, login, session, SSO | implemented (`src/app.mjs`, `src/session.mjs`, `src/oidc.mjs`) |
| `/api/p/<system>/*` proxy, `/api/overview`, `/api/accounts`, tags, auth routing | implemented |
| Compose with four services, four data dirs, health checks | implemented |
| Console (Vue) | P2 – `web/` not in this commit |
| CNB / ZCode adapters and pages | P3 |
| CodeBuddy adapter and service `PLATFORM_TOKEN` patches | P4 |

Until P2/P3/P4 land, `/api/overview` reports `codebuddy` as
`adapter_not_implemented` and the panel still boots and serves. That is
intentional: one missing service must never take the console down.

## Local development

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"  # panel key
PLATFORM_ADMIN_KEY=<key> \
CNB_URL=http://127.0.0.1:9002 \
CODEBUDDY_URL=http://127.0.0.1:8787 \
ZCODE_URL=http://127.0.0.1:12283 \
npm start
```

`npm start` reads `.env` when present. Node >= 22.12. The console is served
from `web/dist`; without a build, `/` answers 404 with a build hint and the API
still works.

```bash
npm test        # node:test, no network, no services required
```

## Compose deployment

```bash
cp .env.example .env
# required: PLATFORM_ADMIN_KEY, CNB_PANEL_ADMIN_KEY, CNB_GATEWAY_KEY
mkdir -p data/panel data/cnb/data data/cnb/logs data/codebuddy data/zcode
docker compose pull
docker compose up -d
```

Source build (each service from its own checkout, never from this repo):

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

`docker-compose.build.yaml` points at `../cnb2api-panel`,
`../codebuddy2api-main/codebuddy2api` and `../zcode2api/ZCode2api`; override the
`*_BUILD_CONTEXT` variables for a different layout.

Notes:

- Panel and services publish on `127.0.0.1` by default (`PLATFORM_BIND_HOST`,
  `SERVICE_BIND_HOST`). The service ports also carry model traffic, so they stay
  independent of the panel (AC7).
- Each service keeps its own data directory. CodeBuddy's SQLite directory is
  never shared between instances.
- CNB's `/health` returns 503 while its account pool is empty, so the Compose
  probe uses `/`. CodeBuddy exposes no liveness route, so it uses a TCP connect.
- SSO is CodeBuddy's own service setting (`CODEBUDDY2API_SSO_ENABLED`). The panel
  reaches CodeBuddy through the `PLATFORM_TOKEN` branch added by P4; it does not
  reuse browser sessions.

## Panel API

Same conventions as cnb2api-panel (R12): `{ error: { message, type, param?, code? } }`,
opaque session cookie, no roles.

| Route | Purpose |
| --- | --- |
| `POST /api/session` | Admin-key login (`{ key }`), 10 failures per IP per 10 min → 429 |
| `GET /api/session` | Current session + available systems |
| `DELETE /api/session` | Logout |
| `GET /api/auth/config` | Key-login flag and SSO login URL |
| `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback` | PKCE SSO login |
| `GET/PATCH /api/auth/settings` | SSO settings; the client secret is never echoed |
| `GET/PATCH /api/settings` | Service URLs (per-system overrides) + token *presence* |
| `GET /api/overview` | `{ cnb, codebuddy, zcode }`, each `{ ok, health, overview }` or `{ ok, health, error }` |
| `GET /api/accounts?system=&tag=` | Unified list, id `<system>:<nativeId>`, automatic system tag |
| `GET/PUT /api/accounts/:id/tags` | Panel-owned tags (`data/panel/tags.json`) |
| `POST /api/accounts/auth/:system/{start,poll,complete}` | Wraps each service's own authorization flow |
| `* /api/p/:system/*` | Normalizing passthrough to that service's management routes |
| `GET /health`, `GET /api/health` | Panel liveness / per-system health, no session |

Overview sections are always per system and never summed or blended (R10). A
failing system yields an error for its own key only.

## Service authentication

The panel never drives a browser session. Each service repository gets one small
env-gated patch (P4): `PLATFORM_TOKEN`, plus an
`Authorization: Bearer <PLATFORM_TOKEN>` branch that bypasses session/OIDC/CSRF
on management routes only. Unset means the service behaves exactly as before.
Panel env holds the three tokens (`CNB_PLATFORM_TOKEN`,
`CODEBUDDY_PLATFORM_TOKEN`, `ZCODE_PLATFORM_TOKEN`); they are never returned by
the API.

## Adapter contract

See [`src/adapters/README.md`](src/adapters/README.md). One module per system;
`src/adapters/index.mjs` resolves injection → `<system>.mjs` → stub.

## Persistent state

`data/panel/panel.json` (SSO settings, service URL overrides, client secret
encrypted with `data/panel/master.key`) and `data/panel/tags.json`. Losing
`master.key` makes the stored client secret unrecoverable; back up the whole
`data/panel` directory.
