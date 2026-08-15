import { useEffect, useState } from "react";

/**
 * Yield one paint frame before marking ready.
 * Use for route/tab switches so the shell (or skeleton) paints before heavy content mounts.
 */
export function useDeferredReady(key: string | number | null | undefined): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [key]);

  return ready;
}
