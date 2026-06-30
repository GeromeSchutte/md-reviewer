import {
  DEFAULT_PORT,
  brokerBaseUrl,
  routes,
  type HealthResponse,
  type UpdateApplyResponse,
  type UpdateStatus,
} from "@plan-review/shared";
import { isMock } from "./mock";

const base = brokerBaseUrl(DEFAULT_PORT);

// In mock mode there's no broker — report "up to date" so the control renders inert.
const MOCK_STATUS: UpdateStatus = {
  version: "0.0.0-mock",
  branch: "main",
  sha: "0000000",
  remoteSha: "0000000",
  behind: 0,
  ahead: 0,
  clean: true,
  canApply: false,
  commits: [],
  error: null,
};

/** Read-only update status from the broker (it fetches the upstream branch). */
export async function checkUpdate(): Promise<UpdateStatus> {
  if (isMock()) return MOCK_STATUS;
  const res = await fetch(base + routes.updateCheck);
  if (!res.ok) throw new Error(`update check -> ${res.status}`);
  return (await res.json()) as UpdateStatus;
}

/** Kick off an update. Returns immediately; poll {@link fetchHealthSha} for completion. */
export async function applyUpdate(): Promise<UpdateApplyResponse> {
  if (isMock()) return { started: false, targetSha: null, error: "mock mode" };
  const res = await fetch(base + routes.updateApply, { method: "POST" });
  if (!res.ok) throw new Error(`update apply -> ${res.status}`);
  return (await res.json()) as UpdateApplyResponse;
}

/** The broker's checked-out commit, or null while it's restarting / unreachable. */
export async function fetchHealthSha(): Promise<string | null> {
  if (isMock()) return null;
  try {
    const res = await fetch(base + routes.health);
    if (!res.ok) return null;
    return ((await res.json()) as HealthResponse).sha ?? null;
  } catch {
    return null; // broker mid-restart during an apply — keep polling
  }
}
