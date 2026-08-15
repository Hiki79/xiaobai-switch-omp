/** Family prefix used to cluster model ids, e.g. `gpt-4.1` → `gpt`. */
export function modelFamilyPrefix(modelId: string): string {
  const raw = modelId.trim();
  if (!raw) return "";

  const afterSlash = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
  const afterColon = afterSlash.includes(":")
    ? (afterSlash.split(":").pop() ?? afterSlash)
    : afterSlash;
  const token = afterColon.split("-")[0]?.trim() ?? afterColon;
  return (token || afterColon).toLowerCase();
}

export interface ModelPrefixGroup<T> {
  prefix: string;
  models: T[];
}

/** Group models by family prefix. Group order follows first appearance; items keep list order. */
export function groupModelsByPrefix<T extends { modelId: string }>(
  models: T[],
): ModelPrefixGroup<T>[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();

  for (const model of models) {
    const prefix = modelFamilyPrefix(model.modelId) || model.modelId.toLowerCase();
    const list = buckets.get(prefix);
    if (list) {
      list.push(model);
      continue;
    }
    order.push(prefix);
    buckets.set(prefix, [model]);
  }

  return order.map((prefix) => ({
    prefix,
    models: buckets.get(prefix) ?? [],
  }));
}
