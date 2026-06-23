import { createSession } from "./broker";
import { isMock } from "./mock";

interface LaunchTarget {
  session: string | null;
  path: string | null;
}

/**
 * Resolve which session to show. Order: explicit ?session= / ?path= query params
 * (dev/browser), then the Tauri-provided launch target (PLAN_REVIEW_SESSION /
 * PLAN_REVIEW_PATH env, read by the Rust side). A bare path is turned into a
 * session via the broker.
 */
export async function resolveSession(): Promise<string | null> {
  if (isMock()) return "mock";
  const params = new URLSearchParams(location.search);
  if (params.get("session")) return params.get("session");
  let path = params.get("path");

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const t = await invoke<LaunchTarget>("launch_target");
    if (t.session) return t.session;
    if (t.path) path = t.path;
  } catch {
    /* not running inside Tauri */
  }

  if (path) return (await createSession(path)).sid;
  return null;
}
