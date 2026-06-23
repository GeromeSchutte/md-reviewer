import pino from "pino";
import { brokerLogPath } from "./paths";

export type Logger = pino.Logger;

/**
 * Structured JSON logger writing to ~/.plan-review/broker.log. Used by the live daemon.
 * `sync: true` keeps the fd ready immediately (so logging-then-exit can't race the
 * async open) and flushes each line promptly for live `tail`-ing. Volume is low.
 */
export function createLogger(): Logger {
  return pino(
    { level: process.env.PLAN_REVIEW_LOG_LEVEL ?? "info" },
    pino.destination({ dest: brokerLogPath(), mkdir: true, sync: true }),
  );
}

/** No-op logger; the default so tests and embeddings don't write to disk. */
export const silentLogger: Logger = pino({ level: "silent" });
