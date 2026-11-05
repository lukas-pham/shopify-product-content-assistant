import { useEffect } from "react";
import { useRevalidator } from "react-router";

/** Re-runs the loader every few seconds while background work is in progress. */
export function useAutoRefresh(active: boolean, ms = 4000) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => state === "idle" && revalidate(), ms);
    return () => clearInterval(t);
  }, [active, ms, revalidate, state]);
}
