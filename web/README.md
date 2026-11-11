# platform2api console (`web/`)

Vue 3 + Vite console with six shared pages: overview, accounts, keys, models,
logs, and settings. The design contract is
`.trellis/tasks/11-11-true-unified-console/design.md`.

## Development and checks

Run from `web/` with Node 24 or newer:

```bash
npm install
npm run dev          # proxies the panel on 127.0.0.1:9000
npm run build        # type-check and production build
npm test            # pure route, registry, formatting, and redaction tests
npm run test:e2e     # production build and Playwright browser checks
```

`src/styles.css` retains the CNB panel's base design (AGPL-3.0-only).
Console-specific additions belong in `src/platform.css`; no additional UI
library is required.

## Pages and extension points

`src/routes.ts` owns the six hash routes and redirects old channel routes to
their merged page. Filters live in the hash query string; account display mode
and theme live in local storage. `src/console.ts` coordinates navigation,
unsaved-form guards, and channel discovery.

`GET /api/channels` supplies channel identifiers, labels, colors, capabilities,
and inference addresses. Channel identifiers are strings. Lists, key scopes,
badges, settings navigation, and gateway routing use this registry, so adding
a backend channel does not require editing the generic pages.

`src/api.ts` implements the aggregate endpoints described in design section 5;
`src/console-types.ts` defines their frontend contract. Aggregate failures are
shown per channel while successful results remain visible. Account and model
fields use descriptors; settings use field schemas. Lists never combine quota
values with different units.

Complex native controls live under `src/channels/<system>/` and use the existing
authenticated `/api/p/<system>/...` proxy where necessary. Account editors and
optional settings/usage components are discovered by filename; schema embed
identifiers are registered in `src/channels/registry.ts`. They are embedded in
the six pages and do not introduce channel-specific routes.

Unified and direct keys share one table. Unified keys support all current and
future channels or an explicit subset, with model, expiry, request/token quota,
and IP limits. Direct-key fields and actions follow channel capabilities.
Returned full secrets stay in a protected result dialog until acknowledged;
they are not persisted by the frontend. Gateway order, participation, and
failover are edited under settings. Request logs include an entry filter for
unified and direct traffic and use server cursors with stable filter bounds.

`LoginView.vue` and `components/settings/AuthSettingsSection.vue` are owned by
the separate PI-1 package. Settings imports the latter without props.

## Test boundaries

`e2e/support/panel-fixture.mjs` is an independent deterministic HTTP fixture
serving the production frontend. It models four channels, partial outages,
one-time key creation, mutation failures, settings, and cursor pagination. It
does not launch the real panel or upstream services, read real credentials,
or create a service data directory. Its route responses are contract fixtures,
not evidence of backend or native-service correctness.

`e2e/smoke.spec.ts` covers the six pages, old-route redirects, hash filters,
account views/tags, key scopes and limits, merged models, redacted logs,
settings and unsaved-form behavior, and responsive/keyboard interactions.
Backend integration and real credential loading are validated separately with
read-only source copies in temporary directories; no credential data belongs
in browser fixtures, artifacts, or this repository.
