import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  AnswerRequest,
  AttachRequest,
  CreateFeedbackRequest,
  CreateQuestionRequest,
  CreateSessionRequest,
  FinalizeRequest,
  ReworkDoneRequest,
  type ServerEvent,
} from "@plan-review/shared";
import { Broker, SessionNotFound } from "./broker";

export function createServer(broker: Broker): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.onError((err, c) => {
    if (err instanceof SessionNotFound) return c.json({ error: err.message }, 404);
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
  });

  app.get("/health", (c) => c.json(broker.health));

  // ---- viewer-side ----
  app.post("/sessions", async (c) => {
    const { planPath, expectAgent } = CreateSessionRequest.parse(await c.req.json());
    const { sid, state } = await broker.openSession(planPath, { expectAgent });
    return c.json({ sid, state });
  });

  app.get("/sessions/:sid/stream", (c) => {
    const sid = c.req.param("sid");
    return streamSSE(c, async (stream) => {
      // Serialize writes so concurrent broadcasts don't interleave on the wire.
      let chain: Promise<unknown> = Promise.resolve();
      const push = (fn: () => Promise<void>) => {
        chain = chain.then(fn);
      };
      const client = {
        send: (event: ServerEvent) => push(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })),
      };
      const unsubscribe = broker.subscribe(sid, client);
      // Keepalive comment well within Bun's 255s idleTimeout so an idle stream isn't dropped.
      const ping = setInterval(() => push(() => stream.writeSSE({ event: "ping", data: "" })), 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.post("/sessions/:sid/questions", async (c) => {
    const { anchor, text } = CreateQuestionRequest.parse(await c.req.json());
    const id = broker.createQuestion(c.req.param("sid"), anchor ?? null, text);
    return c.json({ id });
  });

  app.post("/sessions/:sid/questions/:id/retry", (c) => {
    broker.retryQuestion(c.req.param("sid"), c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/sessions/:sid/feedback", async (c) => {
    const { anchor, text } = CreateFeedbackRequest.parse(await c.req.json());
    const id = broker.createFeedback(c.req.param("sid"), anchor ?? null, text);
    return c.json({ id });
  });

  app.delete("/sessions/:sid/feedback/:id", (c) => {
    broker.deleteFeedback(c.req.param("sid"), c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/sessions/:sid/finalize", async (c) => {
    const { reviewNote } = FinalizeRequest.parse(await c.req.json().catch(() => ({})));
    broker.finalize(c.req.param("sid"), reviewNote ?? null);
    return c.json({ ok: true });
  });

  app.post("/sessions/:sid/end", (c) => {
    broker.end(c.req.param("sid"));
    return c.json({ ok: true });
  });

  // ---- agent-side ----
  app.post("/sessions/:sid/attach", async (c) => {
    const { source } = AttachRequest.parse(await c.req.json());
    const state = broker.attach(c.req.param("sid"), source);
    return c.json({ ok: true, state });
  });

  app.get("/sessions/:sid/wait", async (c) => {
    const events = await broker.wait(c.req.param("sid"), c.req.raw.signal);
    return c.json({ events, cursor: String(Date.now()) });
  });

  app.post("/sessions/:sid/answers", async (c) => {
    const { questionId, markdown, error } = AnswerRequest.parse(await c.req.json());
    broker.answer(c.req.param("sid"), questionId, { markdown, error });
    return c.json({ ok: true });
  });

  app.post("/sessions/:sid/rework-done", async (c) => {
    const { ok, error } = ReworkDoneRequest.parse(await c.req.json());
    broker.reworkDone(c.req.param("sid"), ok, error);
    return c.json({ ok: true });
  });

  return app;
}
