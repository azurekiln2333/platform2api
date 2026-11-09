# Adapter contract (P1 / contract-first)

Every service is reached through one adapter module per system:

| system | file | owner |
| --- | --- | --- |
| `cnb` | `src/adapters/cnb.mjs` | P3 |
| `codebuddy` | `src/adapters/codebuddy.mjs` | P4 |
| `zcode` | `src/adapters/zcode.mjs` | P3 |

`src/adapters/index.mjs`, `client.mjs` and `_stub.mjs` are P1-owned. Do not edit
them to special-case one system; extend the interface instead.

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
  token: "…" | "",              // PLATFORM_TOKEN; empty means no Authorization header
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
| `listAccounts()` | `Array<{ nativeId, label, status, enabled?, quota?, tags?, raw? }>`. `nativeId` must be stable and URL-safe. `raw` is passed through to the console for provider-specific fields. |
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

`GET /api/overview` returns `{ generatedAt, cnb, codebuddy, zcode }`. Each system
key is the adapter's flat payload plus the panel-owned fields:

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
