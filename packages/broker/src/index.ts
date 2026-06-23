import { writeFileSync, rmSync } from "node:fs";
import { DEFAULT_PORT } from "@plan-review/shared";
import { Broker } from "./broker";
import { createServer } from "./server";
import { FileWatcher } from "./watcher";
import { pidfilePath } from "./paths";
import { makeSpawner } from "./spawner";

const VERSION = "0.0.0";
// Bun caps idleTimeout at 255s; our long-poll hold (240s) fits under it.
const IDLE_TIMEOUT = 255;

function main(): void {
  const broker = new Broker({
    version: VERSION,
    onSessionOpened: (abspath) => watcher.watch(abspath),
    spawnAgent: (info) => spawner(info),
  });
  const watcher = new FileWatcher((abspath, content) => broker.updateDoc(abspath, content));
  const spawner = makeSpawner();
  const app = createServer(broker);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: DEFAULT_PORT, idleTimeout: IDLE_TIMEOUT, fetch: app.fetch });
  } catch (err) {
    // Atomic port bind is the singleton source of truth: another daemon won the race.
    console.error(`[broker] port ${DEFAULT_PORT} already in use; another instance is running. (${String(err)})`);
    process.exit(0);
  }

  writeFileSync(pidfilePath(), String(process.pid));
  console.log(`[broker] listening on http://localhost:${DEFAULT_PORT} (pid ${process.pid})`);

  const shutdown = () => {
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
