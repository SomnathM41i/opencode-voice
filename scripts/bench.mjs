#!/usr/bin/env node
/**
 * Latency benchmark for voice tuning.
 * Usage: node scripts/bench.mjs [provider/model ...]
 * Defaults to the free OpenCode models. Runs two turns per model:
 * the first is cold, the second reuses the warm session.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
}

const BASE = env.OPENCODE_URL || "http://127.0.0.1:4096";
const AUTH = "Basic " + Buffer.from("opencode:" + env.OPENCODE_PASSWORD).toString("base64");
const DIRECTORY = env.OPENCODE_DIRECTORY || process.cwd();
const AGENT = env.OPENCODE_AGENT || "ravonna";

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "opencode/big-pickle",
      "opencode/glm-5.3-flash-free",
      "opencode/nemotron-3.5-lightning-free",
      "opencode/deepseek-v4.1-flash-free",
    ];

const PROMPT = "Say hello in one short sentence.";

async function api(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    ...options,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function runModel(spec) {
  const [providerID, ...rest] = spec.split("/");
  const id = rest.join("/");

  const created = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      location: { directory: DIRECTORY },
      agent: AGENT,
      model: { providerID, id },
    }),
  });

  const sessionID = created.data.id;
  const controller = new AbortController();
  const response = await fetch(BASE + "/api/event", {
    headers: { Authorization: AUTH },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let current = null;

  const drain = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          if (event.data?.sessionID !== sessionID) continue;
          if (event.type === "session.text.delta" && current && current.first === null) {
            current.first = Date.now() - current.at;
            current.deltaAt = event.created;
          }
          if (event.type === "session.execution.succeeded" && current) {
            current.total = Date.now() - current.at;
            current.resolve();
          }
          if (event.type === "session.execution.failed" && current) {
            current.failed = true;
            current.resolve();
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 250));

  const turns = [];

  for (let turn = 0; turn < 2; turn += 1) {
    const at = Date.now();
    const done = new Promise((resolve) => {
      current = { at, first: null, total: null, resolve };
    });

    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: PROMPT }),
    });

    const timeout = new Promise((resolve) => setTimeout(resolve, 60_000));
    await Promise.race([done, timeout]);

    turns.push({
      turn: turn === 0 ? "cold" : "warm",
      firstTextMs: current.first,
      totalMs: current.total,
      failed: Boolean(current.failed),
    });
    current = null;
  }

  controller.abort();
  await drain;
  await api(`/api/session/${sessionID}`, { method: "DELETE" }).catch(() => {});

  return { model: spec, agent: created.data.agent, turns };
}

for (const spec of MODELS) {
  try {
    console.log(JSON.stringify(await runModel(spec)));
  } catch (error) {
    console.log(JSON.stringify({ model: spec, error: String(error.message || error) }));
  }
}
