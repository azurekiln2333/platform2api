# Coverage matrix (skeleton)

- Purpose: one row per existing management workflow of CNB, CodeBuddy and ZCode, so AC1/AC8 can be checked row by row.
- Source: `research/cnb-management.md`, `research/codebuddy-management.md`, `research/zcode-management.md`.
- Status: **skeleton** (P4 initial pass). Rows are seeded from the inventories; owners fill `panel page`, `adapter method`, `test` and flip `status`.
- Rule: a row is `covered` only when the panel exposes the workflow itself. A link to the original panel is **not** coverage (R8/AC8).

## Column contract

| Column | Meaning |
| --- | --- |
| `id` | Stable row id: `<sys>-<area>-<n>`. Used by tests and by the supervisor review. |
| `system` | `cnb` \| `codebuddy` \| `zcode`. |
| `area` | Functional area: overview/accounts/models/keys/settings/logs/usage/access/enrollment/ops/deploy. |
| `workflow` | The user-visible action that must still work after the migration. |
| `upstream` | Existing route(s) in the service repo from the inventory (path only; line anchors stay in the per-service note). |
| `panel page` | Route/file in `web/src/views/<sys>/**` that implements it. Owner fills. |
| `adapter` | Method on `src/adapters/<sys>.mjs` used (`health`, `overview`, `listAccounts`, `accountAction`, `startAuth`, `pollAuth`, `call`). Owner fills. |
| `test` | Test id in `test/adapter-<sys>*` or `web/e2e/*`. Owner fills. |
| `status` | `todo` \| `wip` \| `covered` \| `deferred`. Deferred needs a written reason in `notes`. |
| `notes` | Shape caveats: response envelope, revision/CSRF, long-running ops, unavailable-data states. |

## Status legend

- `todo` — inventoried, not implemented.
- `wip` — being implemented by the row owner.
- `covered` — implemented **and** covered by an automated test; only then AC1/AC8 may cite it.
- `deferred` — consciously not in v1; `notes` must state why and what replaces it.

## Ownership

| System | Adapter + pages owner | Matrix rows owner |
| --- | --- | --- |
| cnb | P3 | P3 |
| zcode | P3 | P3 |
| codebuddy | P4 | P4 |
| shared/core (`/api/overview`, `/api/accounts`, auth) | P1 backend + P2 frontend | P1 |

## CNB (owner P3)

Source: `research/cnb-management.md`. Routes relative to `src/app.mjs`. Envelope note: list endpoints return `{ accounts }`, item returns `{ account }`; mutations validate `Origin` when supplied; sessions are process-local and expire, so the adapter must handle re-auth.

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cnb-auth-1 | cnb | auth | panel key login -> service session | `POST /api/session` | — (panel server) | `call` | | todo | token patch replaces key login for panel-originated calls |
| cnb-overview-1 | cnb | overview | overview cards (accounts, credit rates, hourly) | `GET /api/overview` | `web/src/views/cnb/OverviewView.vue` | `overview` | | todo | per-system card only; never blended (R10) |
| cnb-accounts-1 | cnb | accounts | list accounts | `GET /api/accounts` | `web/src/views/cnb/AccountsView.vue` | `listAccounts` | | todo | `{ accounts }` |
| cnb-accounts-2 | cnb | accounts | create account | `POST /api/accounts` | same | `call` | | todo | |
| cnb-accounts-3 | cnb | accounts | edit / delete account | `PATCH,DELETE /api/accounts/:id` | same | `accountAction` | | todo | profile-level fields only |
| cnb-accounts-4 | cnb | accounts | probe / inference probe | `POST /api/accounts/:id/probe`, `/inference-probe` | same | `accountAction` | | todo | upstream work; needs timeout + progress UI |
| cnb-accounts-5 | cnb | accounts | quota refresh | `POST /api/accounts/:id/quota` | same | `accountAction` | | todo | |
| cnb-accounts-6 | cnb | accounts | wake | `POST /api/accounts/:id/wake` | same | `accountAction` | | todo | |
| cnb-accounts-7 | cnb | accounts | registration / pat / credentials actions | `POST /api/accounts/:id/{registration,pat,credentials}` | same | `accountAction` | | todo | reveals secrets; mask by default |
| cnb-models-1 | cnb | models | model list | `GET /api/models` | `web/src/views/cnb/ModelsView.vue` | `call` | | todo | `{ models }` |
| cnb-usage-1 | cnb | usage | credit rates | `GET /api/credits/rates` | `web/src/views/cnb/UsageView.vue` | `call` | | todo | |
| cnb-usage-2 | cnb | usage | usage history | `GET /api/usage/history` | same | `call` | | todo | |
| cnb-usage-3 | cnb | usage | usage comparison | `GET,POST /api/usage/comparison` | same | `call` | | todo | |
| cnb-settings-1 | cnb | settings | read/update settings | `GET,PATCH /api/settings` | `web/src/views/cnb/SettingsView.vue` | `call` | | todo | `{ settings }` |
| cnb-logs-1 | cnb | logs | request logs (+detail) | `GET /api/logs/requests`, `/logs/requests/:id` | `web/src/views/cnb/LogsView.vue` | `call` | | todo | offset pagination |
| cnb-logs-2 | cnb | logs | audit logs | `GET /api/logs/audit` | same | `call` | | todo | |
| cnb-logs-3 | cnb | logs | system logs | `GET /api/logs/system` | same | `call` | | todo | |
| cnb-logs-4 | cnb | logs | log export | `GET /api/logs` (export) | same | `call` | | todo | stream to file, not memory |
| cnb-access-1 | cnb | access | gateway key read (masked) | `GET /api/access` | `web/src/views/cnb/AccessView.vue` | `call` | | todo | |
| cnb-access-2 | cnb | access | gateway key rotate/reveal | `POST /api/access/key` | same | `call` | | todo | explicit confirm before reveal |
| cnb-auth-2 | cnb | auth | OIDC login/callback | `/api/oidc/*` | — | — | | todo | stays service-owned; record decision |

## CodeBuddy (owner P4)

Source: `research/codebuddy-management.md`. Routes in `app/admin_api.py`. Envelope notes: revisions matter — stale `revision` is HTTP 409 and must surface as a conflict, not be retried blindly; writes and `GET /admin/oauth/poll` need CSRF in SSO mode, which the `PLATFORM_TOKEN` patch bypasses; unavailable audit store returns 503 and must **not** render as zero.

P4 status: adapter `src/adapters/codebuddy.mjs` and pages under `web/src/views/codebuddy/**` are implemented and covered by `test/adapter-codebuddy.test.mjs`. Rows below marked `covered` cite a test that fails if the route contract breaks. `cb-ops-*` stay `wip`: the panel page renders the passthrough but the exact service sub-routes still need confirmation against the service source.

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cb-auth-1 | codebuddy | auth | panel-originating management auth | `PLATFORM_TOKEN` bearer | — (panel server) | `call` | `test_platform_token.py` (service repo) | covered | env-gated patch; unset = original behaviour |
| cb-overview-1 | codebuddy | overview | dashboard (days 1/7/30/90, auto/hour/day) | `GET /admin/dashboard` | `web/src/views/codebuddy/OverviewView.vue` | `overview` | adapter-codebuddy: overview/unavailable | covered | 503 audit-unavailable stays distinct from 0 |
| cb-accounts-1 | codebuddy | accounts | credential list | `GET /admin/credentials` | `web/src/views/codebuddy/AccountsView.vue` | `listAccounts` | adapter-codebuddy: credentials normalized | covered | `{ credentials }`; labelled per credential nickname |
| cb-accounts-2 | codebuddy | accounts | credential patch / delete | `PATCH,DELETE /admin/credentials/:id` | same | `accountAction` | adapter-codebuddy: PATCH/DELETE | covered | one boolean field per PATCH; adapter rejects wider payloads |
| cb-auth-2 | codebuddy | enrollment | OAuth enrollment start/poll | `POST /admin/oauth/start`, `GET /admin/oauth/poll` | `web/src/views/codebuddy/EnrollView.vue` | `startAuth`/`pollAuth` | adapter-codebuddy: enrollment | covered | enrollment != console login; panel polls server-side |
| cb-accounts-3 | codebuddy | accounts | credential upload / refresh-import | `/admin/credentials` upload, refresh-import | `web/src/views/codebuddy/AccountsView.vue` | `call` | — | wip | multipart; size limits; needs panel-side upload route |
| cb-models-1 | codebuddy | models | model list (+revision, policy, catalog) | `GET /admin/models` | `web/src/views/codebuddy/ModelsView.vue` | `listModels` | adapter-codebuddy: keys and models | covered | carry `revision` |
| cb-models-2 | codebuddy | models | create/update/delete model | mutations on `/admin/models` | same | `call` | adapter-codebuddy: settings conflict path | wip | 409 conflict path shares the settings convention |
| cb-models-3 | codebuddy | models | scan / probe | `/admin/models` scan+probe | same | `call` | — | wip | upstream work; progress UI still needed |
| cb-keys-1 | codebuddy | keys | key list | `GET /admin/keys` | `web/src/views/codebuddy/KeysView.vue` | `listKeys` | adapter-codebuddy: keys and models | covered | `{ external, items }` |
| cb-keys-2 | codebuddy | keys | create / patch / delete key | `POST /admin/keys`, item patch/delete | same | `call` | — | wip | page wired; contract test pending |
| cb-keys-3 | codebuddy | keys | rotate / reveal | `/admin/keys` rotate+reveal | same | `call` | — | wip | explicit confirm implemented client-side |
| cb-settings-1 | codebuddy | settings | read settings | `GET /admin/settings` | `web/src/views/codebuddy/SettingsView.vue` | `getSettings` | adapter-codebuddy: settings revision | covered | |
| cb-settings-2 | codebuddy | settings | patch settings (revision-aware) | `PATCH /admin/settings` (`values`+`revision`) | same | `patchSettings` | adapter-codebuddy: settings conflict | covered | 409 -> user-visible conflict; locked fields read-only |
| cb-logs-1 | codebuddy | logs | log list (request/runtime/admin/credit) | `GET /admin/logs` | `web/src/views/codebuddy/LogsView.vue` | `listLogs` | adapter-codebuddy: log pagination | covered | cursor pagination, limit 1-200 |
| cb-logs-2 | codebuddy | logs | log detail | `GET /admin/logs/:id` | same | `call` | — | wip | detail drawer pending |
| cb-ops-1 | codebuddy | ops | media management | `app/admin_api.py` media routes | `web/src/views/codebuddy/OpsView.vue` | `call` | — | wip | exact sub-routes to confirm in implementation |
| cb-ops-2 | codebuddy | ops | storage / backups | `app/admin_api.py` storage routes | same | `call` | — | wip | never write service files directly |
| cb-ops-3 | codebuddy | ops | updates | `app/admin_api.py` update routes | same | `call` | — | wip | |
| cb-ops-4 | codebuddy | ops | performance / account automation | `app/admin_api.py` automation routes | same | `call` | — | wip | exact route set TBD |
| cb-deploy-1 | codebuddy | deploy | SSO-independent panel access | `PLATFORM_TOKEN` | — | — | `test_platform_token.py` (service repo) | covered | resolves the open service-auth question |

## ZCode (owner P3)

Source: `research/zcode-management.md`. Routes in `zcgw-server.mjs`. Envelope notes: `PATCH /api/accounts/:id` returns `{ ok, account }` (not CNB's full payload); settings write returns applied fields + resulting settings; several legacy root routes (`/keys`, `/logs`, `/pool/settings`, `/stats`, `/quota`, `/security`) supplement or duplicate console routes.

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zc-auth-1 | zcode | auth | panel-originating management auth | `PLATFORM_TOKEN` bearer | — (panel server) | `call` | | todo | must not rely on `PANEL_KEY` being unset |
| zc-overview-1 | zcode | overview | overview (accounts, scheduler, usage) | `GET /api/overview` | `web/src/views/zcode/OverviewView.vue` | `overview` | | todo | per-system card only (R10) |
| zc-accounts-1 | zcode | accounts | account patch | `PATCH /api/accounts/:id` | `web/src/views/zcode/AccountsView.vue` | `accountAction` | | todo | `{ ok, account }` |
| zc-accounts-2 | zcode | accounts | refresh account | refresh subroute on `/api/accounts/:id` | same | `accountAction` | | todo | upstream work |
| zc-accounts-3 | zcode | accounts | background self-test | self-test subroute | same | `accountAction` | | todo | long-running; progress UI |
| zc-accounts-4 | zcode | accounts | claim / claim subroutes | claim subroutes | same | `accountAction` | | todo | |
| zc-enroll-1 | zcode | enrollment | onboard start | `POST /api/onboard/start` | `web/src/views/zcode/EnrollView.vue` | `startAuth` | | todo | provider-aware flow |
| zc-enroll-2 | zcode | enrollment | onboard poll | `GET /api/onboard/poll/:flowId` | same | `pollAuth` | | todo | keep flowId across reloads |
| zc-enroll-3 | zcode | enrollment | onboard redeem | `POST /api/onboard/redeem` | same | `call` | | todo | |
| zc-models-1 | zcode | models | model list (configured/discovered/eligible) | `GET /api/models` | `web/src/views/zcode/ModelsView.vue` | `call` | | todo | `{ models }` |
| zc-settings-1 | zcode | settings | patch settings | `PATCH /api/settings` | `web/src/views/zcode/SettingsView.vue` | `call` | | todo | returns applied + resulting |
| zc-settings-2 | zcode | settings | legacy pool settings | `GET,POST /pool/settings` | same | `call` | | todo | decide console vs legacy source |
| zc-logs-1 | zcode | logs | console logs (offset, export) | `GET /api/logs` | `web/src/views/zcode/LogsView.vue` | `call` | | todo | |
| zc-logs-2 | zcode | logs | legacy logs | `GET /logs` | same | `call` | | todo | |
| zc-access-1 | zcode | access | access metadata | `GET /api/access` | `web/src/views/zcode/AccessView.vue` | `call` | | todo | |
| zc-access-2 | zcode | access | master key set/rotate | `POST /api/access/key` | same | `call` | | todo | explicit confirm |
| zc-keys-1 | zcode | keys | key list | `GET /keys` | `web/src/views/zcode/KeysView.vue` | `call` | | todo | root path, not `/api/keys` |
| zc-keys-2 | zcode | keys | key create | `POST /keys` | same | `call` | | todo | |
| zc-keys-3 | zcode | keys | key update/delete/reset | `POST /keys/:id/{update,delete,reset}` | same | `call` | | todo | |
| zc-ops-1 | zcode | ops | legacy stats/quota/security | `/stats`, `/quota`, `/security` | `web/src/views/zcode/OpsView.vue` | `call` | | todo | confirm which are still needed |
| zc-ops-2 | zcode | ops | legacy account add/update | `/accounts/add`, `/accounts/update` | same | `call` | | todo | prefer console routes |
| zc-deploy-1 | zcode | deploy | health check | `GET /health` | — (panel server) | `health` | | todo | already in service Compose |
| zc-auth-2 | zcode | auth | optional `PANEL_KEY` mode | `POST /api/session` | — | `call` | | todo | doc only: panel must not depend on unauthenticated mode |

## Shared / cross-cutting (owners P1 + P2)

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sh-auth-1 | all | auth | panel admin-key login + cookie session | — | `web/src/views/LoginView.vue` | — | | todo | mirrors cnb2api-panel (R13) |
| sh-auth-2 | all | auth | OIDC SSO panel login | — | same | — | | todo | mirrors cnb2api-panel (R13) |
| sh-overview-1 | all | overview | three separate quota cards | `/api/overview` | `web/src/views/OverviewView.vue` | all | | todo | never summed (R10) |
| sh-overview-2 | all | overview | partial failure isolation | `/api/overview` | same | all | | todo | one failing system -> `{error}` for that key |
| sh-accounts-1 | all | accounts | unified account list + system badge | `/api/accounts` | `web/src/views/AccountsView.vue` | all | | todo | id `<system>:<nativeId>` (R11) |
| sh-accounts-2 | all | accounts | tag filter + edit | `/api/accounts` + tag store | same | all | | todo | `data/panel/tags.json` |
| sh-accounts-3 | all | accounts | authorize flows for all 3 systems | `/api/accounts/auth/*` | same | all | | todo | wraps each system's start/poll/complete |
| sh-proxy-1 | all | proxy | `/api/p/<sys>/*` passthrough | — | — | `call` | | todo | normalizing proxy |
| sh-settings-1 | all | settings | panel settings page | — | `web/src/views/SettingsView.vue` | — | | todo | service URLs + tokens |

## Deferred / open

Nothing deferred yet. Scope is "all existing functions" (R8); any `deferred` row needs a note here with reason and the accepted replacement.

## How to keep this honest

1. Owners fill their own rows only; never flip another owner's row to `covered`.
2. `covered` requires a named automated test that fails when the route is removed.
3. Row ids are stable; add new rows at the end of the section instead of renumbering.
