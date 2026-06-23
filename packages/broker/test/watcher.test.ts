import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import { Broker, type SSEClient } from "../src/broker";
import { FileWatcher } from "../src/watcher";
import type { ServerEvent } from "@plan-review/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("file watcher -> live doc push", () => {
  it("pushes a doc event over SSE when the plan file changes on disk", async () => {
    const path = join(tmpdir(), `pr-watch-${randomUUID()}.md`);
    await Bun.write(path, "# original\n");

    const watcher = new FileWatcher((abspath, content) => broker.updateDoc(abspath, content), 40);
    const broker = new Broker({
      store: new Store(":memory:"),
      holdMs: 50,
      disconnectGraceMs: 10_000,
      onSessionOpened: (abspath) => watcher.watch(abspath),
    });

    const { sid } = await broker.openSession(path);
    const events: ServerEvent[] = [];
    const client: SSEClient = { send: (e) => events.push(e) };
    broker.subscribe(sid, client);
    events.length = 0; // drop initial snapshot

    await Bun.write(path, "# edited out of band\n");
    await sleep(250); // debounce + fs latency

    const doc = events.find((e) => e.type === "doc");
    expect(doc).toBeDefined();
    expect(doc && doc.type === "doc" && doc.markdown).toContain("edited out of band");
    watcher.close();
  });
});
