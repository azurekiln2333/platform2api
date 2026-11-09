import { AdapterError } from "./adapters/index.mjs";

// Per-system overview. Each system keeps its own section and its own units;
// values are never summed or blended across systems (R10). A failing system
// yields `{ ok: false, error }` for that key only (sh-overview-2).
const describeError = (error) => {
  if (error instanceof AdapterError || error?.name === "AdapterError")
    return {
      message: error.message,
      code: error.code || "upstream_error",
      ...(error.status ? { status: error.status } : {}),
    };
  if (error?.name === "InputError")
    return { message: error.message, code: error.code || "invalid_request" };
  return { message: "服务读取失败", code: "internal_error" };
};

export async function systemOverview(adapter) {
  const section = { system: adapter.system };
  let health = null;
  try {
    health = await adapter.health();
  } catch (error) {
    health = { status: "down", detail: describeError(error).message };
  }
  try {
    const overview = await adapter.overview();
    return { ...section, ok: true, health, overview };
  } catch (error) {
    if (!(error instanceof AdapterError) && error?.name !== "InputError" && !error?.status)
      throw error;
    return { ...section, ok: false, health, error: describeError(error) };
  }
}

export async function buildOverview(registry) {
  const systems = registry.systems();
  // Systems are independent: a slow or broken service must not hide the others.
  const sections = await Promise.all(
    systems.map((system) =>
      systemOverview(registry.get(system)).catch((error) => ({
        system,
        ok: false,
        error: describeError(error),
      })),
    ),
  );
  const result = { generatedAt: new Date().toISOString() };
  for (const section of sections) result[section.system] = section;
  return result;
}

export { describeError };
