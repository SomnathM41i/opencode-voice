/**
 * Drives the real API route handlers against a fake OpenCode server, covering
 * the turn orderings a live model only hits occasionally: session recovery,
 * replies that beat their own prompt response, late events, and barge-in.
 * Run: node scripts/verify-chat.mjs
 */
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

// Route files use the "@/" alias and extensionless imports, which only Next
// resolves on its own.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const file = path.join(SRC, specifier.slice(2)) + ".ts";
      return nextResolve(pathToFileURL(file).href, context);
    }
    if (specifier.startsWith("./") && context.parentURL?.includes("/src/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- fake OpenCode ---------- */

const log = [];
const clients = new Set();
let nextSession = 1;
let nextMessage = 1;
let onPrompt = () => {};
let onInterrupt = () => {};
let failSessionCreate = false;
let lastPrompt = "";

function emit(type, data = {}) {
  const event = { type, created: Date.now(), data };
  for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const fake = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};

  if (url.pathname === "/api/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    clients.add(res);
    res.on("close", () => clients.delete(res));
    res.write(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`);
    return;
  }

  if (url.pathname === "/api/session" && req.method === "POST") {
    if (failSessionCreate) return json(res, 500, { message: "no capacity" });
    const id = `ses_${nextSession++}`;
    log.push(`create ${id} ${body.model?.id}`);
    return json(res, 200, { data: { id, agent: body.agent, model: body.model } });
  }

  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/(prompt|interrupt)$/);
  if (match?.[2] === "prompt") {
    // The last line is what was said; the rest is the voice-mode preamble.
    const said = body.text.split("\n").pop();
    log.push(`prompt ${match[1]} ${said}`);
    lastPrompt = body.text;
    const id = `msg_${nextMessage++}`;
    return onPrompt({ sessionID: match[1], id, text: said, res });
  }
  if (match?.[2] === "interrupt") {
    log.push(`interrupt ${match[1]}`);
    return onInterrupt({ sessionID: match[1], res });
  }

  json(res, 404, { message: "not found" });
});

await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OPENCODE_PASSWORD = "test";
process.env.OPENCODE_MODEL = "env-model";

const chat = await import(pathToFileURL(path.join(SRC, "app/api/chat/route.ts")).href);
const stop = await import(pathToFileURL(path.join(SRC, "app/api/stop/route.ts")).href);
const model = await import(pathToFileURL(path.join(SRC, "app/api/session/model/route.ts")).href);

/* ---------- helpers ---------- */

const accepted = (p) => json(p.res, 200, { data: { id: p.id, sessionID: p.sessionID } });

/** The event order a real turn produces, per a captured OpenCode trace. */
function reply(sessionID, text) {
  emit("session.inbox.enqueued", { sessionID, inboxID: "x" });
  emit("session.execution.started", { sessionID });
  emit("session.text.started", { sessionID, ordinal: 0 });
  emit("session.text.delta", { sessionID, ordinal: 0, delta: text });
  emit("session.text.ended", { sessionID, ordinal: 0, text });
  emit("session.execution.succeeded", { sessionID });
}

function post(handler, url, body, signal) {
  return handler(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

/** Reads the NDJSON stream, giving up after `limit` so a hang is a failure. */
async function collect(response, limit = 2_500) {
  const events = [];
  if (!response.body) return events;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = sleep(limit).then(() => "timeout");
  let buffer = "";

  while (true) {
    const result = await Promise.race([reader.read(), deadline]);
    if (result === "timeout") {
      events.push({ type: "HUNG" });
      reader.cancel().catch(() => {});
      return events;
    }
    if (result.done) return events;
    buffer += decoder.decode(result.value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
}

const terminal = (events) => events.find((e) => e.type === "done" || e.type === "error" || e.type === "HUNG");
const text = (events) => events.filter((e) => e.type === "delta").map((e) => e.text).join("");

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Isolates tests: nothing a hung turn leaves behind reaches the next one. */
async function reset() {
  await sleep(50);
  globalThis.__ocVoiceTurnId = null;
  log.length = 0;
  onPrompt = (p) => {
    accepted(p);
    reply(p.sessionID, "Hello.");
  };
  onInterrupt = ({ res }) => json(res, 200, { interrupted: false });
  failSessionCreate = false;
}

/* ---------- scenarios ---------- */

console.log("\nnormal turn");
{
  await reset();
  const events = await collect(await post(chat.POST, "/api/chat", { text: "hi", turnId: "t1" }));
  check("streams the reply", text(events) === "Hello.", JSON.stringify(events));
  check("ends with done", terminal(events)?.outcome === "succeeded", JSON.stringify(terminal(events)));
  check(
    "marks the end of the text block",
    events.some((e) => e.type === "text-end"),
    JSON.stringify(events.map((e) => e.type)),
  );
  check("sends the voice rules with the message", lastPrompt.startsWith("[Voice mode."), lastPrompt.slice(0, 60));
}

console.log("\ntool progress");
{
  await reset();
  onPrompt = (p) => {
    accepted(p);
    emit("session.execution.started", { sessionID: p.sessionID });
    emit("session.tool.input.started", { sessionID: p.sessionID, name: "shell" });
    emit("session.execution.succeeded", { sessionID: p.sessionID });
  };
  const events = await collect(await post(chat.POST, "/api/chat", { text: "hi", turnId: "t0" }));
  check("reports the running tool", events.some((e) => e.type === "tool" && e.name === "shell"), JSON.stringify(events));
}

console.log("\nreply beats the prompt response");
{
  await reset();
  onPrompt = async (p) => {
    reply(p.sessionID, "Fast.");
    await sleep(100);
    accepted(p);
  };
  const events = await collect(await post(chat.POST, "/api/chat", { text: "hi", turnId: "t2" }));
  check("turn still finishes", terminal(events)?.type === "done", JSON.stringify(terminal(events)));
  await sleep(150);
  check("a finished turn is not interrupted", !log.some((l) => l.startsWith("interrupt")), log.join(" | "));
}

console.log("\ndeleted session recovery");
{
  await reset();
  // Force a session to exist, then have OpenCode forget it.
  await collect(await post(chat.POST, "/api/chat", { text: "hi", turnId: "t3" }));
  let first = true;
  onPrompt = (p) => {
    if (first) {
      first = false;
      return json(p.res, 404, { message: "session not found" });
    }
    accepted(p);
    reply(p.sessionID, "Recovered.");
  };
  const events = await collect(await post(chat.POST, "/api/chat", { text: "again", turnId: "t4" }));
  check("reply from the new session arrives", text(events) === "Recovered.", JSON.stringify(events));
  check("turn finishes", terminal(events)?.type === "done", JSON.stringify(terminal(events)));
}

console.log("\nlate event from the previous turn");
{
  await reset();
  onPrompt = async (p) => {
    // An old execution finishing must not end the turn that just started.
    emit("session.execution.succeeded", { sessionID: p.sessionID });
    await sleep(60);
    accepted(p);
    await sleep(60);
    reply(p.sessionID, "Mine.");
  };
  const events = await collect(await post(chat.POST, "/api/chat", { text: "hi", turnId: "t5" }));
  check("waits for its own execution", text(events) === "Mine.", JSON.stringify(events));
}

console.log("\nbarge-in");
{
  await reset();
  let active = null;
  onPrompt = (p) => {
    accepted(p);
    if (p.text === "long") {
      active = p.sessionID;
      emit("session.execution.started", { sessionID: p.sessionID });
      emit("session.text.delta", { sessionID: p.sessionID, delta: "Partial" });
      return;
    }
    reply(p.sessionID, "New answer.");
  };
  onInterrupt = async ({ sessionID, res }) => {
    await sleep(40);
    json(res, 200, { interrupted: true });
    // Real order: the HTTP response lands first, the terminal event later.
    await sleep(250);
    active = null;
    log.push("interrupted-event");
    emit("session.execution.interrupted", { sessionID, reason: "user" });
  };

  const controller = new AbortController();
  const response = await post(chat.POST, "/api/chat", { text: "long", turnId: "t6" }, controller.signal);
  const reading = collect(response);
  await sleep(120);

  // What the browser does: abort the stream, then wait for /api/stop.
  controller.abort();
  const stopped = await post(stop.POST, "/api/stop", { turnId: "t6" });
  check("stop resolves", stopped.ok, String(stopped.status));
  check("stop waits for the old turn to die", active === null, log.join(" | "));
  await reading;

  const events = await collect(await post(chat.POST, "/api/chat", { text: "next", turnId: "t7" }));
  check("next turn answers", text(events) === "New answer.", JSON.stringify(events));
  const died = log.indexOf("interrupted-event");
  const next = log.findIndex((l) => l.endsWith(" next"));
  check("next prompt follows the old turn's end", died >= 0 && died < next, log.join(" | "));
}

console.log("\nimmediate new turn without waiting for stop");
{
  await reset();
  let dying = false;
  onPrompt = (p) => {
    accepted(p);
    if (p.text === "long") {
      emit("session.execution.started", { sessionID: p.sessionID });
      return;
    }
    if (dying) log.push("STEERED-INTO-DYING-TURN");
    reply(p.sessionID, "Fresh.");
  };
  onInterrupt = async ({ sessionID, res }) => {
    dying = true;
    json(res, 200, { interrupted: true });
    await sleep(200);
    dying = false;
    emit("session.execution.interrupted", { sessionID, reason: "user" });
  };

  const controller = new AbortController();
  const response = await post(chat.POST, "/api/chat", { text: "long", turnId: "t8" }, controller.signal);
  const reading = collect(response);
  await sleep(100);
  controller.abort();
  await sleep(10);
  const events = await collect(await post(chat.POST, "/api/chat", { text: "next", turnId: "t9" }));
  await reading;
  check("new turn answers", text(events) === "Fresh.", JSON.stringify(events));
  check("prompt never lands in the dying turn", !log.includes("STEERED-INTO-DYING-TURN"), log.join(" | "));
}

console.log("\nmodel switching");
{
  await reset();
  onPrompt = (p) => {
    accepted(p);
    emit("session.execution.started", { sessionID: p.sessionID });
  };
  const controller = new AbortController();
  const response = await post(chat.POST, "/api/chat", { text: "long", turnId: "t10" }, controller.signal);
  const reading = collect(response, 400);
  await sleep(100);
  const busy = await post(model.POST, "/api/session/model", { providerID: "p", id: "other" });
  check("refused during a turn", busy.status === 409, String(busy.status));
  controller.abort();
  await reading;

  await reset();
  const ok = await post(model.POST, "/api/session/model", { providerID: "p", id: "picked" });
  check("switches between turns", ok.status === 200, String(ok.status));

  await reset();
  failSessionCreate = true;
  const failed = await post(model.POST, "/api/session/model", { providerID: "p", id: "broken" });
  check("failed switch reports an error", failed.status === 502, String(failed.status));
  failSessionCreate = false;

  const events = await collect(await post(chat.POST, "/api/chat", { text: "still there", turnId: "t11" }));
  check("failed switch keeps the conversation", !log.some((l) => l.startsWith("create")), log.join(" | "));
  check("next turn works", terminal(events)?.type === "done", JSON.stringify(terminal(events)));

  // Recovery must recreate on the picked model, not fall back to the env one.
  let first = true;
  await reset();
  onPrompt = (p) => {
    if (first) {
      first = false;
      return json(p.res, 404, { message: "session not found" });
    }
    accepted(p);
    reply(p.sessionID, "Hi.");
  };
  await collect(await post(chat.POST, "/api/chat", { text: "x", turnId: "t12" }));
  check("recovery keeps the picked model", log.some((l) => l.endsWith(" picked")), log.join(" | "));
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
