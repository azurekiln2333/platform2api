import { AdapterError } from "./adapters/client.mjs";
import { describeError } from "./overview.mjs";

// Channel-level operations (design.md / ui-fixes.md F11). A channel declares
// them in `capabilities.accounts.channelActions`, and the adapter exposes the
// matching definitions (id, label, account action) as `channelActions`. The
// panel never hard-codes a vendor: it validates the declared id and then either
// uses the adapter's native batch method or fans out per account.
export const MAX_CHANNEL_CONCURRENCY = 4;

/** Public shape for `capabilities.accounts.channelActions`. */
export const publicChannelActions = (definitions) =>
  (Array.isArray(definitions) ? definitions : [])
    .filter((entry) => entry && typeof entry.id === "string" && typeof entry.label === "string")
    .map(({ id, label }) => ({ id, label }));

export const isFanOutTarget = (row) =>
  row && row.enabled !== false && row.status !== "disabled" && row.disabled !== true;

/**
 * Runs one account action per enabled account with a bounded concurrency so a
 * channel-wide wake never floods the upstream service. Failures are collected,
 * never thrown: the caller reports `{ total, started, failed }`.
 */
export async function fanOutAccountAction({ system, adapter, action, concurrency = MAX_CHANNEL_CONCURRENCY }) {
  const rows = await adapter.listAccounts();
  if (!Array.isArray(rows)) throw new AdapterError(`${system} 适配器未返回账号数组`, { code: "adapter_contract" });
  const targets = rows.filter(isFanOutTarget);
  const failed = [];
  let started = 0;
  let index = 0;
  const worker = async () => {
    while (index < targets.length) {
      const row = targets[index++];
      const nativeId = String(row.nativeId ?? row.id ?? "");
      const id = `${system}:${nativeId}`;
      try {
        await adapter.accountAction(nativeId, action);
        started++;
      } catch (error) {
        failed.push({ id, label: String(row.label ?? nativeId), message: describeError(error).message });
      }
    }
  };
  const width = Math.max(1, Math.min(MAX_CHANNEL_CONCURRENCY, concurrency, targets.length));
  await Promise.all(Array.from({ length: targets.length ? width : 0 }, worker));
  return { total: targets.length, started, failed };
}