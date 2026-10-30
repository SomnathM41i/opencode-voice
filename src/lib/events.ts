/**
 * One persistent SSE connection to OpenCode, shared by every turn.
 * Events are fanned out to in-process listeners (the chat route).
 */
import { openEventStream } from "./opencode";

export type OpenCodeEvent = {
  id?: string;
  type: string;
  created?: number;
  data?: Record<string, unknown>;
};

type Listener = (event: OpenCodeEvent) => void;

type EventBus = {
  listeners: Set<Listener>;
  running: boolean;
  connected: boolean;
  lastError: string | null;
  controller: AbortController | null;
};

const globalState = globalThis as unknown as {
  __ocVoiceEvents?: EventBus;
};

const bus: EventBus = (globalState.__ocVoiceEvents ??= {
  listeners: new Set(),
  running: false,
  connected: false,
  lastError: null,
  controller: null,
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatch(event: OpenCodeEvent) {
  for (const listener of bus.listeners) {
    try {
      listener(event);
    } catch {
      // One bad listener must not kill the stream.
    }
  }
}

function handleBlock(block: string) {
  const lines = block.split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return;

  let payload: OpenCodeEvent;
  try {
    payload = JSON.parse(dataLines.join("\n")) as OpenCodeEvent;
  } catch {
    return;
  }

  if (payload?.type === "server.connected") {
    bus.connected = true;
    bus.lastError = null;
  }

  dispatch(payload);
}

async function connectLoop() {
  if (bus.running) return;
  bus.running = true;

  let backoff = 400;

  while (bus.running) {
    const controller = new AbortController();
    bus.controller = controller;

    try {
      const response = await openEventStream(controller.signal);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      bus.connected = true;
      bus.lastError = null;
      backoff = 400;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let index: number;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleBlock(block);
        }

        // Protect against a malformed peer that never sends a blank line.
        if (buffer.length > 1_000_000) buffer = "";
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        bus.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      bus.connected = false;
      if (bus.controller === controller) bus.controller = null;
    }

    if (!bus.running) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 5_000);
  }
}

export function ensureEventStream(): void {
  void connectLoop();
}

export function subscribe(listener: Listener): () => void {
  ensureEventStream();
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
  };
}

export function streamStatus() {
  return { connected: bus.connected, error: bus.lastError };
}

/**
 * Waits briefly for the shared SSE connection to come up.
 * A turn started while the bus is down would stream nothing and hang, so the
 * chat route refuses it instead with a clear error.
 */
export async function waitForEventStream(timeoutMs = 5_000): Promise<boolean> {
  ensureEventStream();
  const deadline = Date.now() + timeoutMs;

  while (!bus.connected && Date.now() < deadline) {
    await sleep(100);
  }

  return bus.connected;
}
