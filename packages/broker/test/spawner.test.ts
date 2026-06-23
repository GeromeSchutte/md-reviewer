import { describe, it, expect } from "bun:test";
import { Store } from "../src/store";
import { buildSeed } from "../src/spawner"; // importing this also asserts the Agent SDK module loads

describe("spawner seed construction", () => {
  it("seeds an agent with session details and prior review history", () => {
    const store = new Store(":memory:");
    const abspath = "/tmp/some-plan.md";
    const now = Date.now();
    store.upsertPlan(abspath, "some-plan.md", now);
    store.insertQuestion({
      id: "q1",
      abspath,
      anchor: null,
      docVersion: "v1",
      text: "why this approach?",
      createdAt: now,
      status: "answered",
      answerMarkdown: "because it is simplest",
      answeredAt: now,
      errorMessage: null,
      agentSource: "agent",
    });
    store.insertFeedback({
      id: "f1",
      abspath,
      anchor: null,
      docVersion: "v1",
      text: "tighten the intro",
      createdAt: now,
      kind: "comment",
      status: "queued",
    });

    const seed = buildSeed({ store, baseUrl: "http://localhost:8787" }, { sid: "sess-1", abspath, title: "some-plan.md" });
    expect(seed).toContain("sess-1");
    expect(seed).toContain(abspath);
    expect(seed).toContain("--source spawned");
    expect(seed).toContain("why this approach?");
    expect(seed).toContain("because it is simplest");
    expect(seed).toContain("tighten the intro");
    expect(seed).toContain(`bun `); // CLI invocation prefix
  });

  it("notes when there is no prior history", () => {
    const store = new Store(":memory:");
    store.upsertPlan("/tmp/fresh.md", "fresh.md", Date.now());
    const seed = buildSeed({ store, baseUrl: "http://localhost:8787" }, { sid: "s", abspath: "/tmp/fresh.md", title: "fresh.md" });
    expect(seed).toContain("No prior review history.");
  });
});
