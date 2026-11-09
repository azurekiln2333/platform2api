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

`test:e2e` serves `dist/`, so build first (`npx vite build`). The fixture implements the panel
API surface below with fixtures only: no service, no credentials, no upstream calls.

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
degrades when an endpoint is absent.

- `GET /api/auth/config` → `{ keyLoginEnabled, sso: { enabled, providerName, loginUrl } }`.
  Missing/erroring = key login only.
- `POST /api/login` `{ key }` (+ `POST /api/logout`), `GET /api/session` →
  `{ authenticated, user? }`. `POST/DELETE /api/session` (cnb2api-panel naming) is accepted as a
  404 fallback so either server shape works; remove the fallback once P1 fixes the route.
- `GET /api/overview` → `{ cnb: <card>, codebuddy: <card>, zcode: <card> }`. One card per system,
  never summed (R10). A failing system returns `{ "error": { "message": "…" } }` for its key only.
- `GET /api/accounts[?system=cnb]` → `{ accounts: [...] }` or a bare array. Each row:
  `{ id: "<system>:<nativeId>", system, label, status, quota?, tags[], detail?, error? }`.
  `tags` always contains the automatic system tag; user tags come from the panel tag store.
- `PATCH /api/accounts/{id}/tags` `{ tags: string[] }` → `{ account }` (also accepts `{ accounts }`
  or a bare row). `id` is URL-encoded `<system>:<nativeId>`; native ids may contain colons.
- `POST /api/accounts/auth/{system}/{start|poll|complete}` → `AuthFlow`:
  `{ flowId, status: pending|success|failed|expired, message?, url?, steps?, inputs?, accountId?, pollIntervalMs? }`.
  The shell never hardcodes provider fields: `inputs` (`{ name, label, secret?, required? }`) are
  rendered generically and posted back to `poll` as `{ flowId, values: { [name]: string } }`.
  A flow without `inputs` is polled every `pollIntervalMs` (default 2000 ms).
- `GET /api/settings` (optional) → `{ services: { cnb|codebuddy|zcode: { url, tokenConfigured, health, message } }, panelUrl?, version?, dataDir? }`.
  Absent = the settings page states that the endpoint is missing; nothing else breaks.

### Overview card shape

Consumed fields per system card (extra keys are ignored):

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

- `test/systems.test.mjs` — pure helpers: per-system cards and error isolation, no summed totals,
  account/tag normalization, filters, quota percent.
- `e2e/smoke.spec.ts` — key login, three independent overview cards, unified account list with
  system badge/filter/tag editing, panel-only authorization for all three systems, settings page,
  route slot placeholder, sign-out.

Not covered here (integration pass): real panel server routes, Playwright against the real
`src/app.mjs`, and per-system pages owned by P3/P4.
