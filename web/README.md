# platform2api console (`web/`)

Vue 3 + Vite shell for the unified panel. Layout, styling and interaction are copied from
`D:/My2KProjects/cnb2api-panel/web` (AGPL-3.0-only) so both consoles stay visually aligned:

- `src/styles.css` — base sheet copied verbatim; re-sync from upstream, do not restyle.
- `src/platform.css` — every addition of this console (system badges, per-system quota cards,
  tag chips, auth flow, settings grid). Additive only.
- `src/api.ts` — copied request/error/diagnostics layer.

## Commands

```bash
npm install
npm run build        # vue-tsc --noEmit && vite build
npm test             # node --test test/*.test.mjs (imports src/*.ts directly)
npm run test:e2e     # Playwright smoke against e2e/support/panel-fixture.mjs
npm run dev          # needs a panel server on 127.0.0.1:9000
```

`test:e2e` builds the console first (`vite build`, no type-check) and then serves `dist/`. The
fixture boots the **real panel server** (`src/app.mjs`) with three fake adapters and a temp data dir, so the
browser tests exercise the actual panel routes (login, overview, accounts, tags, auth flows, settings, static
serving). No service, no credentials, no upstream calls.

## Page ownership

| Path | Owner |
| --- | --- |
| `src/*.ts`, `src/App.vue`, `src/components/**`, `src/views/{Login,Overview,Accounts,Settings,Pending}View.vue` | shell (P2) |
| `src/views/cnb/**`, `src/views/zcode/**` | P3 |
| `src/views/codebuddy/**` | P4 |

Per-system pages are discovered by convention, not registered by hand: a file
`src/views/<system>/<Slug>View.vue` becomes the sidebar entry and route
`#<system>/<slug>` (`LogsView.vue` → `#cnb/logs`, new files appear on next build).
A slug dictionary (`router.ts`) provides Chinese labels; unknown slugs are prettified.
Routes without a page render `PendingView`, so a missing page is visible instead of a dead link.

## Panel API contract consumed by the shell

`design.md` in `.trellis/tasks/11-09-unified-platform-management` is authoritative; the shell
degrades when an endpoint is absent. Shapes verified against the shipped server (`src/app.mjs`,
`src/overview.mjs`, `src/accounts.mjs`):

- `GET /api/auth/config` → `{ keyLoginEnabled, sso: { enabled, providerName, loginUrl } }`.
  Missing/erroring = key login only.
- `POST /api/session` `{ key }`, `DELETE /api/session`, `GET /api/session` →
  `{ authenticated, user?, systems? }`. `POST /api/login`/`POST /api/logout` are tried as 404
  fallbacks so cnb2api-panel-style servers also work.
- `GET /api/overview` → `{ generatedAt, cnb: <card>, codebuddy: <card>, zcode: <card> }`. Each card is
  the adapter payload **flat** (no nested `overview` key) plus `{ system, ok, health, detail,
  healthMessage }`. Health is a plain string (`ok|degraded|down|unknown`); `down` renders as offline.
  A failing system carries `error: { message, code }` on its own key only (R10/sh-overview-2).
- `GET /api/accounts[?system=][&tag=]` → `{ accounts, errors, systems }`. Row:
  `{ id: "<system>:<nativeId>", system, nativeId, label, status, enabled?, quota?, tags[], systemTags,
  userTags, raw? }`. `tags[0]` is the automatic system tag. `errors: [{ system, error: {message, code} }]`
  lists per-system read failures and is rendered as a banner without hiding the other systems.
- `PATCH /api/accounts/{id}/tags` `{ tags }` → `{ id, system, tags, userTags }` (URL-encoded id; a
  full account row is also accepted). `id` native parts may contain colons.
- `POST /api/accounts/auth/{system}/{start|poll|complete}` → `{ system, flowId, result }` where
  `result` is the adapter flow: `{ flowId, status: pending|success|failed|expired, message?, url?,
  steps?, inputs?, accountId?, pollIntervalMs? }`. The shell unwraps `result` and never hardcodes
  provider fields: `inputs` (`{ name, label, secret?, required? }`) are rendered generically and
  posted back to `poll` as `{ flowId, values: { [name]: string } }`. Without `inputs`, the flow is
  polled every `pollIntervalMs` (default 2000 ms).
- `GET /api/settings` → `{ serviceUrls, systems: [{ system, url, tokenConfigured, stub }], ssoCallbackUrl }`.
  A `services` map is also read. Absent endpoint = the settings page says so; nothing else breaks.

### Overview card shape

Consumed fields per system card (extra keys are ignored; the server adds `system`/`ok`/`detail`):

```json
{
  "health": "ok | degraded | offline | unknown",
  "healthMessage": "optional text",
  "accounts": { "total": 4, "ready": 3, "paused": 0 },
  "quota": {
    "label": "组织额度",
    "unit": " credits",
    "total": 2000,
    "used": 500,
    "remaining": 1500,
    "syncedAt": "ISO-8601",
    "metrics": [{ "label": "开发额度", "unit": " credits", "total": 100, "used": 10, "remaining": 90 }],
    "note": "optional"
  },
  "usage": [{ "label": "今日请求", "value": 42, "unit": "", "digits": 0 }],
  "generatedAt": "ISO-8601"
}
```

Each system reports its own `unit`; cards are rendered side by side and never combined, so
credits, 积分 and 点 stay separate.

## Tests

- `test/systems.test.mjs` — pure helpers: per-system cards (flat panel shape, `down` health) and error
  isolation, no summed totals, account/tag normalization, per-system account errors, settings
  `systems`/`services`/`serviceUrls`, filters, quota percent.
- `e2e/smoke.spec.ts` — key login, SSO entry point + failure notice, three independent overview cards,
  unified account list with system badge/filter/tag editing, panel-only authorization for all three
  systems, settings page, route slot placeholder, sign-out. Runs against the real panel server via
  `e2e/support/panel-fixture.mjs` (10 cases).

Not covered here: the three real service containers (adapters are faked in the browser fixture), a
browser-side OIDC handshake against a live IdP (only the panel-side entry point and the failure notice
are in Playwright; the full handshake is covered by `test/core-panel.test.mjs`), and per-system pages
owned by P3/P4 beyond the sidebar/route-slot wiring.
