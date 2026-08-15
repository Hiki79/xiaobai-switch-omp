import { startTransition, useEffect, useState } from "react";

/**
 * Switch the chrome immediately, then mount heavy tab content after paint
 * and reveal it on the following macrotask. Already-revealed tabs stay
 * mounted so return visits are instant.
 */
export function useDeferredTabContent<T extends string>(active: T): {
  mounted: ReadonlySet<T>;
  showSkeleton: boolean;
} {
  const [mounted, setMounted] = useState<Set<T>>(() => new Set());
  const [revealed, setRevealed] = useState<Set<T>>(() => new Set());

  useEffect(() => {
    if (mounted.has(active)) return;
    const id = window.setTimeout(() => {
      startTransition(() => {
        setMounted((prev) => {
          if (prev.has(active)) return prev;
          const next = new Set(prev);
          next.add(active);
          return next;
        });
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [active, mounted]);

  useEffect(() => {
    if (!mounted.has(active) || revealed.has(active)) return;
    const id = window.setTimeout(() => {
      setRevealed((prev) => {
        if (prev.has(active)) return prev;
        const next = new Set(prev);
        next.add(active);
        return next;
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [active, mounted, revealed]);

  return {
    mounted,
    showSkeleton: !revealed.has(active),
  };
}
