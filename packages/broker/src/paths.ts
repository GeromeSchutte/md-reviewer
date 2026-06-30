import { homedir } from "node:os";
import { join } from "node:path";

/** Root data directory for the daemon (DB, logs, pidfile). Overridable for tests. */
export const dataDir = (): string => process.env.PLAN_REVIEW_DATA_DIR ?? join(homedir(), ".plan-review");

export const storePath = (): string => join(dataDir(), "store.sqlite");
export const pidfilePath = (): string => join(dataDir(), "broker.pid");
export const logOutPath = (): string => join(dataDir(), "broker.out.log");
export const logErrPath = (): string => join(dataDir(), "broker.err.log");
/** Structured (pino JSON) event log. */
export const brokerLogPath = (): string => join(dataDir(), "broker.log");
/** Output of a self-update run (the detached `scripts/update` process). */
export const updateLogPath = (): string => join(dataDir(), "update.log");

export const LAUNCH_AGENT_LABEL = "ai.plan-review.broker";
export const launchAgentPlistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
