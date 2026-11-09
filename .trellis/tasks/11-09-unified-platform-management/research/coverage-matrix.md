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

P3 status: adapter `src/adapters/cnb.mjs` and pages under `web/src/views/cnb/**` are implemented and covered by `test/adapter-cnb.test.mjs` (21 tests, including five that boot the real panel server and go through `/api/accounts`, `/api/overview`, `/api/p/cnb/*` and `/api/accounts/auth/cnb/*`). Rows marked `covered` cite a test that fails if that route contract breaks. `cnb-auth-2` is `deferred` with a recorded decision: CNB's `/api/oidc/*` is the *service console's own* browser login, not a management call, and the panel's admin login is P1's SSO (R13).

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cnb-auth-1 | cnb | auth | panel key login -> service session | `POST /api/session` | — (panel server) | `service()` bearer | adapter-cnb: bearer on every call | covered | token patch replaces key login for panel-originated calls; no `Origin` is sent so mutations skip the CSRF branch |
| cnb-overview-1 | cnb | overview | overview cards (accounts, credit rates, hourly) | `GET /api/overview` | `web/src/views/cnb/OverviewView.vue` | `overview` | adapter-cnb: overview quota | covered | per-system card only; never blended (R10) |
| cnb-accounts-1 | cnb | accounts | list accounts | `GET /api/accounts` | `web/src/views/cnb/AccountsView.vue` | `listAccounts` | adapter-cnb: list shape | covered | adapter unwraps `{ accounts }` into the bare array the panel aggregates |
| cnb-accounts-2 | cnb | accounts | create account | `POST /api/accounts` | same | `startAuth`/`pollAuth` | adapter-cnb: enrollment creates the account | covered | console has no blank-create form; the panel creates during enrollment |
| cnb-accounts-3 | cnb | accounts | edit / delete account | `PATCH,DELETE /api/accounts/:id` | same | `accountAction` | adapter-cnb: account actions | covered | profile-level fields only |
| cnb-accounts-4 | cnb | accounts | probe / inference probe | `POST /api/accounts/:id/probe`, `/inference-probe` | same | `accountAction` | adapter-cnb: account actions | covered | upstream work; page shows a busy state per row |
| cnb-accounts-5 | cnb | accounts | quota refresh | `POST /api/accounts/:id/quota` | same | `accountAction` | adapter-cnb: account actions | covered | |
| cnb-accounts-6 | cnb | accounts | wake | `POST /api/accounts/:id/wake` | same | `accountAction` | adapter-cnb: account actions | covered | |
| cnb-accounts-7 | cnb | accounts | registration / pat / credentials actions | `POST /api/accounts/:id/{registration,pat,credentials}` | same | `accountAction` | adapter-cnb: account actions | covered | reveals secrets; the page masks by default and reveals on demand |
| cnb-models-1 | cnb | models | model list | `GET /api/models` | `web/src/views/cnb/ModelsView.vue` | `call` | adapter-cnb: management routes | covered | `{ models }`; passthrough keeps the envelope |
| cnb-usage-1 | cnb | usage | credit rates | `GET /api/credits/rates` | `web/src/views/cnb/UsageView.vue` | `call` | adapter-cnb: management routes | covered | `window` query forwarded verbatim |
| cnb-usage-2 | cnb | usage | usage history | `GET /api/usage/history` | same | `call` | adapter-cnb: management routes | covered | `days` query |
| cnb-usage-3 | cnb | usage | usage comparison | `GET,POST /api/usage/comparison` | same | `call` | adapter-cnb: management routes | covered | both verbs mapped |
| cnb-settings-1 | cnb | settings | read/update settings | `GET,PATCH /api/settings` | `web/src/views/cnb/SettingsView.vue` | `call` | adapter-cnb: management routes | covered | `{ settings }` |
| cnb-logs-1 | cnb | logs | request logs (+detail) | `GET /api/logs/requests`, `/logs/requests/:id` | `web/src/views/cnb/LogsView.vue` | `call` | adapter-cnb: management routes | covered | offset pagination |
| cnb-logs-2 | cnb | logs | audit logs | `GET /api/logs/audit` | same | `call` | adapter-cnb: management routes | covered | |
| cnb-logs-3 | cnb | logs | system logs | `GET /api/logs/system` | same | `call` | adapter-cnb: management routes | covered | |
| cnb-logs-4 | cnb | logs | log export | `GET /api/logs/requests?download=1` | same | `call` | adapter-cnb: management routes | covered | the page hands the export URL to the browser so the body is streamed, not buffered in memory |
| cnb-access-1 | cnb | access | gateway key read (masked) | `GET /api/access` | `web/src/views/cnb/AccessView.vue` | `call` | adapter-cnb: management routes | covered | |
| cnb-access-2 | cnb | access | gateway key rotate/reveal | `POST /api/access/key` | same | `call` | adapter-cnb: management routes | covered | explicit confirm before reveal |
| cnb-settings-2 | cnb | settings | registration relay status + manual sync | `GET /api/registration-relay`, `POST /api/registration-relay/sync` | `web/src/views/cnb/SettingsView.vue` | `call` | adapter-cnb: management routes | covered | sync is long-running; page keeps the button disabled until it returns |
| cnb-settings-3 | cnb | settings | service OIDC settings read/update | `GET,PATCH /api/auth/settings` | `web/src/views/cnb/SettingsView.vue` | `call` | adapter-cnb: management routes | covered | edits the *service* login config, not the panel's own SSO |
| cnb-auth-2 | cnb | auth | OIDC login/callback | `/api/oidc/*` | — | — | — | deferred | stays service-owned: these are browser redirects for the CNB console's own login, not management calls. Panel admin login is P1's SSO (R13). No silent omission — recorded here so 3.3 can cite the decision. |

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
| cb-accounts-3 | codebuddy | accounts | credential upload / refresh-import | `POST /admin/credentials/upload`, `POST /admin/credentials/refresh-import` | `web/src/views/codebuddy/AccountsView.vue` | `uploadCredentials`/`refreshImport` | adapter-codebuddy: `credential upload posts the JSON file batch the service expects`, `credential upload rejects malformed batches before calling the service`, `refresh-import validates the endpoint profile and token batch` | covered | JSON body not multipart (`files: [{name, content}]`, 1-100 files); refresh-import takes 1-50 tokens and one of `cn-cli`/`cn-work`/`intl-cli`/`intl-work` |
| cb-accounts-4 | codebuddy | accounts | credential export (binary attachment) | `POST /admin/credentials/export` | — | — | — | deferred | service answers a single file as `application/octet-stream` and several as a zip; the console needs a non-JSON response path in `web/src/api.ts`, which P4 does not own. Replacement: use the service's own UI or `curl` with the `PLATFORM_TOKEN` bearer until that path exists |
| cb-models-1 | codebuddy | models | model list (+revision, policy, catalog) | `GET /admin/models` | `web/src/views/codebuddy/ModelsView.vue` | `listModels` | adapter-codebuddy: keys and models | covered | carry `revision` |
| cb-models-2 | codebuddy | models | create/update/delete model | `POST /admin/models`, `PUT|DELETE /admin/models/:id` | same | `createModel`/`updateModel`/`deleteModel`/`previewModel` | adapter-codebuddy: `model create and update carry the revision and keep 409 a conflict`, `model delete and preview target the model path` | covered | `revision` travels in the body for POST/PUT and as a query parameter for DELETE; 409 stays a conflict |
| cb-models-3 | codebuddy | models | scan / probe | `POST|GET /admin/models/scan`, `POST|GET /admin/models/rate-probe`, `GET /admin/models/output-probes` | same | `startScan`/`scanState`/`startRateProbe`/`rateProbeState`/`outputProbes` | adapter-codebuddy: `catalog scan and rate probe expose start plus state` | covered | scan is user-triggered only, never periodic; rate probe can spend credit and is confirmed client-side |
| cb-keys-1 | codebuddy | keys | key list | `GET /admin/keys` | `web/src/views/codebuddy/KeysView.vue` | `listKeys` | adapter-codebuddy: keys and models | covered | `{ external, items }` |
| cb-keys-2 | codebuddy | keys | create / patch / delete key | `POST /admin/keys`, `PATCH|DELETE /admin/keys/:id` | same | `createKey`/`updateKey`/`deleteKey` | adapter-codebuddy: `key create returns the one-time secret and the created item`, `key update and delete use the service optimistic lock` | covered | create answers the secret once; PATCH carries `version` and 409 stays a conflict |
| cb-keys-3 | codebuddy | keys | rotate / reveal | `POST /admin/keys/:id/reveal`, `POST /admin/keys/:id/rotate` | same | `revealKey`/`rotateKey` | adapter-codebuddy: `key reveal and rotate stay explicit calls` | covered | both are explicit, confirmed client-side and never fetched while listing |
| cb-settings-1 | codebuddy | settings | read settings | `GET /admin/settings` | `web/src/views/codebuddy/SettingsView.vue` | `getSettings` | adapter-codebuddy: settings revision | covered | |
| cb-settings-2 | codebuddy | settings | patch settings (revision-aware) | `PATCH /admin/settings` (`values`+`revision`) | same | `patchSettings` | adapter-codebuddy: settings conflict | covered | 409 -> user-visible conflict; locked fields read-only |
| cb-logs-1 | codebuddy | logs | log list (request/runtime/admin/credit) | `GET /admin/logs` | `web/src/views/codebuddy/LogsView.vue` | `listLogs` | adapter-codebuddy: log pagination | covered | cursor pagination, limit 1-200 |
| cb-logs-2 | codebuddy | logs | log detail | `GET /admin/logs/:id` | same | `getLog` | adapter-codebuddy: `log detail is fetched by id and a cleaned-up entry stays a 404` | covered | 404 means cleaned up and 503 means the audit store cannot answer; neither renders as an empty record |
| cb-ops-1 | codebuddy | ops | media management | `GET /admin/media` | `web/src/views/codebuddy/OpsView.vue` | `getMedia` | adapter-codebuddy: `media, storage, update and automation use the real admin routes` | covered | read-only overview; media files stay owned by the service |
| cb-ops-2 | codebuddy | ops | storage / backups | `GET /admin/storage`, `POST /admin/storage/archive`, `POST /admin/storage/backups`, `DELETE /admin/storage/backups/:name` | same | `getStorage`/`archiveStorage`/`createBackup`/`deleteBackup` | adapter-codebuddy: same test | covered | every write is a service route; the panel never touches service files directly |
| cb-ops-3 | codebuddy | ops | updates | `GET /admin/update`, `POST /admin/update/check` | same | `getUpdate`/`checkUpdate` | adapter-codebuddy: same test | covered | install stays operator-run; the page only reads state and triggers a check |
| cb-ops-4 | codebuddy | ops | performance / account automation | `GET /admin/performance`, `GET /admin/growth-jobs` | same | `getPerformance`/`getGrowthJobs` | adapter-codebuddy: same test | covered | growth jobs are read-only; per-credential automation toggles live in cb-accounts-2 |
| cb-deploy-1 | codebuddy | deploy | SSO-independent panel access | `PLATFORM_TOKEN` | — | — | `test_platform_token.py` (service repo) | covered | resolves the open service-auth question |

## ZCode (owner P3)

Source: `research/zcode-management.md`. Routes in `zcgw-server.mjs`. Envelope notes: `PATCH /api/accounts/:id` returns `{ ok, account }` (not CNB's full payload); settings write returns applied fields + resulting settings; several legacy root routes (`/keys`, `/logs`, `/pool/settings`, `/stats`, `/quota`, `/security`) supplement or duplicate console routes.

P3 status: adapter `src/adapters/zcode.mjs` and pages under `web/src/views/zcode/**` are implemented and covered by `test/adapter-zcode.test.mjs` (16 tests, including five that boot the real panel server). Rows marked `covered` cite a test that fails if that route contract breaks. `zc-ops-2` stays `wip` on purpose: the legacy `/accounts/add|update` routes remain reachable for scripts, but the page uses the console `PATCH /api/accounts/:id` because the two envelopes disagree. `zc-auth-2` is `deferred` with a recorded decision: the panel authenticates with `PLATFORM_TOKEN` only and must never depend on the unauthenticated `PANEL_KEY` mode.

### P3 integration gaps (reported, not fixed here)

These live outside P3's owned paths, so they are recorded instead of patched:

1. `src/overview.mjs` (P1) nests adapter output as `{ system, ok, health, overview }`, but `web/src/systems.ts` (P2) reads `accounts` / `quota` / `usage` / `health` from the section **top level**. Overview cards therefore render empty even though `/api/overview` carries the right data (proved by the panel tests). Fix belongs to P1 (flatten) or P2 (read `.overview`).
2. Even after (1) is fixed, `systemCard` looks for a string `health`, but P1 emits `{ status, detail }`. `normalizeHealth` returns `'unknown'` for an object, so every card would still show an unknown/offline health chip. Either P1 flattens `health: health.status` + `healthMessage: health.detail`, or P2 reads `health.status`.
3. The panel has no route that streams binary exports, so both log-export buttons hand a URL to the browser (`/api/p/<system>/api/logs?...&download=1`). That works for same-origin session cookies but is untested end-to-end — a Playwright case belongs to P2's smoke suite.

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zc-auth-1 | zcode | auth | panel-originating management auth | `PLATFORM_TOKEN` bearer | — (panel server) | `service()` bearer | adapter-zcode: bearer on every call | covered | `PANEL_KEY` stays untouched; the panel authenticates with the bearer only |
| zc-overview-1 | zcode | overview | overview (accounts, scheduler, usage) | `GET /api/overview` | `web/src/views/zcode/OverviewView.vue` | `overview` | adapter-zcode: overview quota | covered | per-system card only (R10). ZCode has **no** `GET /api/accounts`, so `listAccounts` reads this feed |
| zc-accounts-1 | zcode | accounts | account patch | `PATCH /api/accounts/:id` | `web/src/views/zcode/AccountsView.vue` | `accountAction` | adapter-zcode: account actions | covered | returns `{ ok, account: <label> }`; adapter reports the label, not the patched record |
| zc-accounts-2 | zcode | accounts | refresh account | `POST /api/accounts/:id/refresh` | same | `accountAction` | adapter-zcode: account actions | covered | upstream work; row shows a busy state |
| zc-accounts-3 | zcode | accounts | background self-test | `POST /api/accounts/:id/selftest` -> 202 `{ jobId }` | same | `accountAction` | adapter-zcode: account actions | covered | long-running: the page polls `/api/accounts/:id/selftest/:jobId` |
| zc-accounts-4 | zcode | accounts | claim start / claim | `POST /api/accounts/:id/claim-start`, `/claim` | same | `accountAction` | adapter-zcode: account actions | covered | two-step claim keeps the account id explicit |
| zc-accounts-5 | zcode | accounts | self-test result poll | `GET /api/accounts/:id/selftest/:jobId` | same | `accountAction` | adapter-zcode: account actions | covered | terminal state ends the poll loop |
| zc-accounts-6 | zcode | accounts | identify account from a credential | `POST /accounts/identify` | `web/src/views/zcode/AccountEditor.vue` | `call` | adapter-zcode: console and legacy routes | covered | legacy root route kept; used by the enrollment form |
| zc-enroll-1 | zcode | enrollment | onboard start | `POST /api/onboard/start` | `web/src/views/zcode/EnrollView.vue` | `startAuth` | adapter-zcode: enrollment | covered | provider-aware flow (`zai` / `bigmodel`) |
| zc-enroll-2 | zcode | enrollment | onboard poll | `GET /api/onboard/poll/:flowId` | same | `pollAuth` | adapter-zcode: enrollment | covered | native states map onto `pending|success|failed|expired`; 410 -> expired |
| zc-enroll-3 | zcode | enrollment | onboard redeem | `POST /api/onboard/redeem` | same | `call` | adapter-zcode: console and legacy routes | covered | manual paste path when the browser callback is lost |
| zc-enroll-4 | zcode | enrollment | claim automation read/update/run/cancel | `GET,PATCH /api/claim-automation`, `POST /api/claim-automation/{run,cancel}` | `web/src/views/zcode/EnrollView.vue` | `call` | adapter-zcode: console and legacy routes | covered | automation is service-owned; the panel only toggles it |
| zc-models-1 | zcode | models | model list (configured/discovered/eligible) | `GET /api/models` | `web/src/views/zcode/ModelsView.vue` | `call` | adapter-zcode: console and legacy routes | covered | `{ models }` passthrough |
| zc-settings-1 | zcode | settings | patch settings | `PATCH /api/settings` | `web/src/views/zcode/SettingsView.vue` | `call` | adapter-zcode: console and legacy routes | covered | returns applied fields + resulting settings; page merges both |
| zc-settings-2 | zcode | settings | legacy pool settings | `GET,POST /pool/settings` | same | `call` | adapter-zcode: console and legacy routes | covered | resolution: read both, console wins; the legacy form writes back to `/pool/settings` when a script needs it |
| zc-logs-1 | zcode | logs | console logs (q, outcome, offset) | `GET /api/logs` | `web/src/views/zcode/LogsView.vue` | `call` | adapter-zcode: console and legacy routes | covered | `{ logs, total }`; empty params are sent so the service keeps its defaults explicit |
| zc-logs-2 | zcode | logs | legacy logs | `GET /logs` | same | `call` | adapter-zcode: console and legacy routes | covered | labelled in the page as "recent records only" so its shorter retention is not misread |
| zc-logs-3 | zcode | logs | log export | `GET /api/logs?download=1` | same | `call` | adapter-zcode: console and legacy routes | covered | export URL goes to the browser; body is not buffered |
| zc-access-1 | zcode | access | access metadata | `GET /api/access` | `web/src/views/zcode/AccessView.vue` | `call` | adapter-zcode: console and legacy routes | covered | masked by default |
| zc-access-2 | zcode | access | master key set/rotate | `POST /api/access/key` | same | `call` | adapter-zcode: console and legacy routes | covered | explicit confirm before the call |
| zc-keys-1 | zcode | keys | key list | `GET /keys` | `web/src/views/zcode/KeysView.vue` | `call` | adapter-zcode: console and legacy routes | covered | root path, not `/api/keys`; `openMode: true` means no master key and no active key, so the page warns |
| zc-keys-2 | zcode | keys | key create | `POST /keys` | same | `call` | adapter-zcode: console and legacy routes | covered | the plaintext secret is returned exactly once, so the page forces a copy-and-confirm dialog |
| zc-keys-3 | zcode | keys | key update/delete/reset | `POST /keys/:id/{update,delete,reset}` | `web/src/views/zcode/KeysView.vue` | `call` | adapter-zcode: console and legacy routes | covered | `reset` only zeroes `usedTokens`/`requests` (it does **not** rotate the secret — read `handleKeyReset`); `delete` is a soft delete. The page labels the button 清零 so nobody expects rotation |
| zc-ops-1 | zcode | ops | legacy stats/quota/security | `/stats`, `/quota`, `/security` | `web/src/views/zcode/OpsView.vue` | `call` | adapter-zcode: console and legacy routes | covered | decision: still needed — `/stats` has the only per-model/token counters and `/security` has no console equivalent |
| zc-ops-2 | zcode | ops | legacy account add/update | `POST /accounts/add`, `POST /accounts/update` | `web/src/views/zcode/AccountsView.vue` (uses the console route) | `call` | adapter-zcode: console and legacy routes | deferred | Raw passthrough is reachable and tested (the legacy-route table asserts `POST /accounts/add` and `POST /accounts/update`). No *normalized* panel action is wired, on purpose: (1) `/accounts/update` keys off `{ label, disabled }` while console `PATCH /api/accounts/:id` uses `{ enabled }`, so a shim would have to invert one flag against the other and any future field would drift silently; (2) `/accounts/add` requires a raw `eyJ…` zJWT and fires activation + claim + quota side effects server-side — that is enrollment work the panel already does via `/api/onboard/*`; (3) `grep` shows no page or module calls either route, so a compat layer would be dead code. Decision: the panel writes through the console route only; scripts keep the raw escape hatch. |
| zc-ops-3 | zcode | ops | pool status / cooldown reset | `GET /pool`, `POST /pool/reset` | `web/src/views/zcode/OpsView.vue` | `call` | adapter-zcode: console and legacy routes | covered | reset is destructive-ish (clears cooldown + failure counts); page confirms by button label |
| zc-ops-4 | zcode | ops | legacy self-test all | `POST /selftest` | same | `call` | adapter-zcode: console and legacy routes | covered | synchronous service call; the page shows the returned summary |
| zc-deploy-1 | zcode | deploy | health check | `GET /health` | — (panel server) | `health` | adapter-zcode: health degrades to down | covered | already in service Compose; `health()` never throws so a dead service renders as `down` |
| zc-auth-2 | zcode | auth | optional `PANEL_KEY` mode | `POST /api/session` | — | — | — | deferred | doc only: panel must not depend on the unauthenticated mode, so nothing is wired to it. Recorded here so 3.3 can cite the decision. |

## Shared / cross-cutting (owners P1 + P2)

| id | system | area | workflow | upstream | panel page | adapter | test | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sh-auth-1 | all | auth | panel admin-key login + cookie session | `POST /api/session` | `web/src/views/LoginView.vue` | — | `web/e2e/smoke.spec.ts` "key login…", "signing out returns to the login form" | covered | Real server in the browser fixture: form → `POST /api/session` → opaque cookie → console; logout → `DELETE /api/session`. Mirrors cnb2api-panel (R13). `/api/login`+`/api/logout` stay as 404 fallbacks. |
| sh-auth-2 | all | auth | OIDC SSO panel login | `/api/auth/oidc/login`, `/api/auth/oidc/callback` | same | — | `web/e2e/smoke.spec.ts` "the SSO entry point…", `test/core-panel.test.mjs` "OIDC login issues a panel session end to end" | covered | UI half: `/api/auth/config` reports SSO → login page offers "使用 <provider> 登录" → redirect to `/api/auth/oidc/login` → discovery failure returns `auth_error` and the notice renders (10/10 e2e). Server half: real fixture-IdP login → token exchange → panel session (`provider: oidc`) in P1's e2e test. **Not covered:** a browser-side handshake against a live IdP — no IdP runs in the Playwright harness, so that path is asserted only server-side. |
| sh-overview-1 | all | overview | three separate quota cards | `/api/overview` | `web/src/views/OverviewView.vue`, `web/src/components/QuotaCard.vue` | all | `web/e2e/smoke.spec.ts` "each overview card…", `web/test/systems.test.mjs` "overview keeps one card per system…" | covered | One flat card per system key, each rendering its own `unit` (credits / 积分 / 点); e2e asserts CNB shows `credits` and never `积分`. Never summed (R10); unit test asserts no combined total exists. |
| sh-overview-2 | all | overview | partial failure isolation | `/api/overview` | same | all | `web/e2e/smoke.spec.ts` "each overview card…", `web/test/systems.test.mjs` "a failing system only blanks its own card" | covered | zcode card shows its own `error.message` and no quota block while CNB/CodeBuddy keep their data (real server returns `error` on that key only). |
| sh-accounts-1 | all | accounts | unified account list + system badge | `/api/accounts` | `web/src/views/AccountsView.vue` | all | `web/e2e/smoke.spec.ts` "one unified account list…", `web/test/systems.test.mjs` "accounts are normalized…" | covered | Single table across all three systems; automatic system badge per row; system filter narrows the same list. id `<system>:<nativeId>` (R11), native id may contain ':' (`zc-team:1` asserted). |
| sh-accounts-2 | all | accounts | tag filter + edit | `/api/accounts/{id}/tags` + tag store | same, `web/src/components/TagEditor.vue` | all | `web/e2e/smoke.spec.ts` "one unified account list…", `web/test/systems.test.mjs` "system tag is automatic…" | covered | Server publishes `PATCH /api/accounts/{id}/tags` → `{id,system,tags,userTags}`; e2e asserts the PATCH body and that the new chip renders. Tag filter is applied in the console over the automatic + user tags. Store: `data/panel/tags.json`. |
| sh-accounts-3 | all | accounts | authorize flows for all 3 systems | `/api/accounts/auth/{system}/{start,poll,complete}` | same, `web/src/components/AuthFlowDialog.vue` | all | `web/e2e/smoke.spec.ts` "{cnb,codebuddy,zcode} authorization runs entirely inside the panel" | covered | Three separate e2e cases: start → poll → success → close for each system; the zcode case asserts the adapter-driven `inputs` step. Generic dialog driven by `steps`/`inputs`/`pollIntervalMs`; no provider field is hardcoded. |
| sh-proxy-1 | all | proxy | `/api/p/<sys>/*` passthrough | — | — | `call` | | todo | normalizing proxy |
| sh-settings-1 | all | settings | panel settings page | `GET /api/settings` | `web/src/views/SettingsView.vue` | — | `web/e2e/smoke.spec.ts` "settings page reports each service address…", `web/test/systems.test.mjs` "settings read a systems array…" | covered | Reads `{serviceUrls, systems:[{system,url,tokenConfigured,stub}], ssoCallbackUrl}`; shows each internal address, token state and stub marker. Tokens are never displayed. Degrades to an explicit "endpoint missing" state when the route is absent. |

## Deferred / open

Nothing deferred yet. Scope is "all existing functions" (R8); any `deferred` row needs a note here with reason and the accepted replacement.

## How to keep this honest

1. Owners fill their own rows only; never flip another owner's row to `covered`.
2. `covered` requires a named automated test that fails when the route is removed.
3. Row ids are stable; add new rows at the end of the section instead of renumbering.
