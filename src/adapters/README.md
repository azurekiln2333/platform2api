# Adapter contract

Every service is reached through an adapter registered in `src/channels.mjs`.
Adding a channel means adding its adapter module and one registry entry
(`system`, `label`, `color`, `defaultUrl`, `envPrefix`, `adapterUrl`). Channel IDs
use lower-case letters, digits, hyphens and underscores; `unified` is reserved.
The application, management aggregators and inference gateway iterate this
registry. Do not add channel-name branches to these shared layers.

## Module shape

```js
// src/adapters/<system>.mjs
export default function createAdapter(context) {
  return {
    system: "<system>",
    health,
    overview,
    listAccounts,
    accountAction,
    startAuth,     // optional
    pollAuth,      // optional
    completeAuth,  // optional
    call,
  };
}
```

`createAdapter` may be `async`; the registry awaits it. A module may also
`export const adapter = {...}` or default-export an object instead of a
factory — the registry normalizes all three forms.

### context

```js
{
  system: "cnb",
  baseUrl: "http://cnb:9002",   // no trailing slash
  token: "…" | "",              // panel key (management bearer); empty means no Authorization header
  timeoutMs: 15000,
  client,                       // see below — use this, not bare fetch
  logger: { warn(message), error(message) },
}
```

`client` (`src/adapters/client.mjs`) is the only sanctioned way to talk to a
service. It joins `baseUrl`, sends `Authorization: Bearer <token>` when a token
is configured, applies a timeout, caps the response size and maps transport
failures to `AdapterError`. Do not read panel env vars inside an adapter.

```js
await client.request("/api/accounts", { method: "GET", query: { limit: 20 } });
// -> { status, ok, contentType, headers, body, text }
```

`body` is parsed JSON when the response is `application/json`, otherwise the
text, and `buffer` is always present for byte-exact passthrough.

## Methods

All methods may throw. The router converts `AdapterError` into a per-system
error payload and never lets one service break another.

| method | contract |
| --- | --- |
| `health()` | `{ status: "ok" \| "degraded" \| "down", detail? }`. Never throws for an expected outage; return `down` with `detail`. |
| `overview()` | That system's own summary object, returned **flat** (design.md): `accounts`, `quota`, `usage`, `generatedAt`, any provider-specific extras. Never a blended or summed figure (R10). The panel adds `system`, `ok`, the normalized `health` string and `detail` next to these fields, and overrides any `health` the adapter returned. |
| `listAccounts()` | `Array<{ nativeId, label, status, enabled?, quota?, lastUsedAt?, primary?, display?, actions?, raw? }>`. Keep native IDs unchanged, including email/Unicode labels; validate with `isAccountNativeId` and encode once as a URL segment. `raw` must contain only public/redacted fields. |
| `accountAction(nativeId, action, payload)` | Runs one provider-specific action (`probe`, `quota`, `wake`, `reveal`, `rotate`, …). `action` is a lowercase token; unknown actions throw `InputError(400)`. |
| `startAuth(payload)` | `{ flowId, ...native }` for an interactive authorization/enrollment flow. |
| `pollAuth(flowId)` | `{ status: "pending" \| "done" \| "error", ...native }`. |
| `completeAuth(flowId, payload)` | Final step when the provider needs a code/redeem step; omit if the flow has none. |
| `call(path, opts)` | Raw management passthrough for `/api/p/<system>/<path>`. `opts = { method, query, body, headers }`; returns `{ status, body, contentType?, headers? }`. |

`call` is the escape hatch that guarantees "no existing feature is silently
omitted" (R8/AC8): every remaining management route reaches the console
through it. Body is a parsed JSON object for JSON requests, or a `Buffer` for
`multipart/form-data` and other binary uploads. Response `body` may be an
object (serialized as JSON), a string (sent as `text/plain` unless
`contentType` says otherwise) or a `Buffer` (sent as-is).

### Errors

Throw `AdapterError` (from `client.mjs`) for upstream failures:

```js
throw new AdapterError("CodeBuddy 服务返回 503", { status: 502, code: "upstream_unavailable" });
```

`status` is what the panel returns to the browser; `code` is a stable
snake_case token the console may branch on. Passthrough responses keep the
service's own status, so `409` stays a revision conflict and is never retried
blindly.

## Console-facing overview shape

`GET /api/overview` returns `totals`, `channels`, `hourly`, `attention` and
`errors`, plus the legacy per-channel keys for compatibility. Only request and
token counters are additive; quotas retain their native channel units. Each
legacy channel key is the adapter's flat payload plus the panel-owned fields:

```js
{
  system: "cnb",
  ok: true,                 // false when overview() failed
  health: "ok",             // ok | degraded | down | unknown (plain string)
  detail: "",               // health message, never an object
  healthMessage: "",        // same value; the console reads this name
  accounts: {...}, quota: {...}, usage: [...], generatedAt: "...",
  error: { message, code, status? }   // only when ok === false
}
```

A failing system keeps its own `error` and never affects the other keys.

## Registry

`createRegistry({ systems, adapters, logger })` resolves one adapter per system:

1. `adapters[system]` when injected (tests, integration smoke).
2. `./<system>.mjs` when the file exists.
3. Otherwise `_stub.mjs`: `health` reports `down`, `call` returns
   `501 adapter_not_implemented`, and every other method throws
   `AdapterError("… 适配器尚未实现")`. The panel therefore boots before P3/P4
   land, and `/api/overview` shows that system as unavailable instead of failing.

## Unified console methods

New normalized methods may live under `adapter.console` to preserve existing
adapter methods with native contracts. The console resolves that namespace
first. Implement `capabilities`, `listKeys`, `createKey`, `updateKey`,
`deleteKey`, `keyAction`, `listModels`, `modelAction`, `listLogs`, `getLog`,
`usage`, `settings` and `saveSettings` where supported. Missing operations
return `capability_unsupported` and are disabled in capability descriptors.
Probe with read-only calls; an authentication failure is not missing support.

Use `src/console-data.mjs` for normalization/redaction. List responses are
`{ items, errors: [{ system, message, code }] }`; native IDs gain a channel
prefix at the boundary. Account display descriptors use `text`, `mono`,
`time`, `badge`, `quota` or `bool`. Settings fields are schema-driven.
Create/rotate return `{ item, secret }` once; other reads never return secrets.
Versioned mutations forward the caller's `revision`; do not refresh/retry a
stale version before saving. Clients should return revisions on every write.

Logs accept the filters in task design §5 and return `{ items, nextCursor }`.
Consume native pages until the filtered page is filled or the source ends;
never discard unreturned tails. The panel merges per-channel pages behind
bounded opaque cursors. Usage should return `excludesInternalKeys: true` only
when `excludeKeys` was applied to every returned counter; the panel then adds
unified counters back once. Otherwise native totals already include forwarded
traffic and unified attribution stays in `extras.unified` / `byKey`.

## Inference methods

`inference()` returns `{ url, routes }`, with actual supported POST paths and
the internal upstream origin. Public direct URLs are separate deployment
metadata. `ensureUpstreamCredential({ force, previous })` returns
`{ secret, id, name }`; create a dedicated native key named
`platform2api 统一入口` without adopting an operator's same-name key. Only a
single-master-key service may return `shared: true` (currently CNB).

The gateway stores credentials encrypted, suppresses their IDs from console
key lists and native logs, and remembers retired IDs after replacement. A
native 401 triggers credential replacement once. Shared master-key traffic
cannot be deduplicated safely until native request-ID attribution exists.
Unified keys are hashed and scoped to `"*"` or explicit channel IDs; management
bearers and session cookies are never used for inference forwarding.

Adapters that expose native key management also declare `keyManagement`
(`list`, `items`, `prefix`, `revealSuffix` / `revealPaths`). The passthrough
uses it to filter internal key IDs and refuse their mutation, and refuses
secret-reveal endpoints. Create/rotate still return their one-time result.
Statistics use UTC+8 calendar days and complete ISO bucket instants. A
channel's missing/incomplete statistics must carry `partial: true` instead
of being presented as a complete zero count.
