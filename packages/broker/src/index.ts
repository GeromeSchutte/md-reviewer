import { writeFileSync, rmSync } from "node:fs";
import { DEFAULT_PORT, brokerBaseUrl } from "@plan-review/shared";
import { Broker } from "./broker";
import { createServer } from "./server";
import { FileWatcher } from "./watcher";
import { pidfilePath, brokerLogPath } from "./paths";
import { makeSpawner } from "./spawner";
import { createLogger } from "./logger";
import { currentSha, currentVersion } from "./updater";

// Sourced from the repo (root package.json + git HEAD) rather than hardcoded, so
// /health reflects the running checkout — the signal the viewer polls after an update.
const VERSION = currentVersion();
const SHA = currentSha();
// Bun caps idleTimeout at 255s; our long-poll hold (240s) fits under it.
const IDLE_TIMEOUT = 255;

function main(): void {
  const log = createLogger();
  const broker = new Broker({
    version: VERSION,
    sha: SHA,
    log,
    onSessionOpened: (abspath) => watcher.watch(abspath),
    spawnAgent: (info) => spawner(info),
  });
  const watcher = new FileWatcher((abspath, content) => broker.updateDoc(abspath, content));
  const spawner = makeSpawner({ store: broker.store, baseUrl: brokerBaseUrl(DEFAULT_PORT), log });
  const app = createServer(broker);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: DEFAULT_PORT, idleTimeout: IDLE_TIMEOUT, fetch: app.fetch });
  } catch (err) {
    // Atomic port bind is the singleton source of truth: another daemon won the race.
    log.error({ event: "broker.port_in_use", port: DEFAULT_PORT, err: String(err) }, "port in use; exiting");
    console.error(`[broker] port ${DEFAULT_PORT} already in use; another instance is running. (${String(err)})`);
    process.exit(0);
  }

  writeFileSync(pidfilePath(), String(process.pid));
  log.info({ event: "broker.start", port: DEFAULT_PORT, pid: process.pid, version: VERSION }, "broker listening");
  console.log(`[broker] listening on http://localhost:${DEFAULT_PORT} (pid ${process.pid}); logs: ${brokerLogPath()}`);

  const shutdown = () => {
    log.info({ event: "broker.stop", pid: process.pid }, "broker shutting down");
    try {
      rmSync(pidfilePath(), { force: true });
    } catch {
      /* ignore */
    }
    watcher.close();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) main();
