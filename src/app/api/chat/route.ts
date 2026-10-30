import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ensureSession, sendPrompt } from "@/lib/opencode";
import {
  interruptAndWait,
  subscribe,
  streamStatus,
  waitForEventStream,
  type OpenCodeEvent,
} from "@/lib/events";
import { guardRequest } from "@/lib/http";
import { activeTurnId, beginTurn, endTurn, settled, trackSettling } from "@/lib/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 4_000;
/** A turn may run long while the agent works, but not go silent. */
const TURN_IDLE_TIMEOUT_MS = 90_000;
const TURN_MAX_MS = 10 * 60_000;
/** Tells the browser the agent is alive during silent work such as tool calls. */
const ACTIVITY_INTERVAL_MS = 10_000;

function failureMessage(data: Record<string, unknown>): string {
  for (const key of ["message", "error", "reason", "detail"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as { message?: unknown }).message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "OpenCode reported a failed turn.";
}

export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;

  if (activeTurnId()) {
    return Response.json(
      { error: "A turn is already running. Stop it before sending another." },
      { status: 409 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const body = (payload ?? {}) as { text?: unknown; turnId?: unknown };

  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return Response.json({ error: "Message is empty." }, { status: 400 });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return Response.json(
      { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` },
      { status: 400 },
    );
  }

  const turnId =
    typeof body.turnId === "string" && body.turnId.trim()
      ? body.turnId.trim().slice(0, 128)
      : randomUUID();

  // Authoritative check-and-set. The earlier check is only a fast path; this
  // one cannot race because there is no await between check and set.
  if (!beginTurn(turnId)) {
    return Response.json(
      { error: "A turn is already running. Stop it before sending another." },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: () => void = () => {};
  let sessionID = "";
  let promptSentAt = 0;
  let promptInFlight: Promise<unknown> | null = null;
  // Set once this turn's prompt is seen running. Only then can a terminal
  // event be ours and not the tail of the previous turn.
  let executionSeen = false;
  let killed = false;
  let lastActivityAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const release = () => {
    unsubscribe();
    unsubscribe = () => {};
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    if (connectionTimer) clearInterval(connectionTimer);
    connectionTimer = undefined;
    endTurn(turnId);
  };

  /**
   * Ends a prompt nobody will read. The next turn waits on this, because a
   * prompt sent into a dying run is merged into it.
   */
  const killTurn = () => {
    if (killed || !promptInFlight) return;
    killed = true;
    trackSettling(
      promptInFlight
        .catch(() => undefined)
        .then(() => (sessionID ? interruptAndWait(sessionID) : undefined)),
    );
  };

  const push = (event: Record<string, unknown>) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
    } catch {
      // The browser went away between reads. Release the turn and kill the
      // prompt, otherwise the global guard would block every later message.
      closed = true;
      release();
      killTurn();
    }
  };

  const closeStream = () => {
    if (!controllerRef) return;
    try {
      controllerRef.close();
    } catch {
      /* already closed */
    }
  };

  const finish = (event: Record<string, unknown>) => {
    if (closed) return;
    push(event);
    closed = true;
    release();
    closeStream();
  };

  const fail = (message: string, code = "error") => {
    finish({ type: "error", code, message, at: Date.now() });
  };

  const abandon = () => {
    if (closed) return;
    closed = true;
    release();
    closeStream();
    killTurn();
  };

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      fail(
        `OpenCode went quiet for ${TURN_IDLE_TIMEOUT_MS / 1000} seconds.`,
        "timeout",
      );
      killTurn();
    }, TURN_IDLE_TIMEOUT_MS);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      if (request.signal.aborted) {
        abandon();
        return;
      }

      request.signal.addEventListener("abort", abandon);

      armIdleTimer();
      maxTimer = setTimeout(() => {
        fail(
          `The turn hit the ${TURN_MAX_MS / 60_000} minute limit.`,
          "timeout",
        );
        killTurn();
      }, TURN_MAX_MS);

      void (async () => {
        try {
          const connected = await waitForEventStream(5_000);
          if (closed) return;
          if (!connected) {
            const status = streamStatus();
            fail(
              `OpenCode's event stream is not connected${
                status.error ? ` (${status.error})` : ""
              }. Check the server, then try again.`,
              "events",
            );
            return;
          }

          await settled();
          if (closed) return;

          const session = await ensureSession();
          if (closed) return;
          sessionID = session.id;

          push({
            type: "session",
            sessionID: session.id,
            agent: session.agent,
            model: session.model,
            at: Date.now(),
          });

          connectionTimer = setInterval(() => {
            if (closed) return;
            if (!streamStatus().connected) {
              fail(
                "Lost the connection to OpenCode's event stream. Try again.",
                "events",
              );
              killTurn();
            }
          }, 1_500);

          unsubscribe = subscribe((event: OpenCodeEvent) => {
            if (closed) return;

            const data = (event.data ?? {}) as Record<string, unknown>;
            if (data.sessionID !== sessionID) return;

            if (
              typeof event.created === "number" &&
              event.created < promptSentAt - 250
            ) {
              return;
            }

            armIdleTimer();
            if (Date.now() - lastActivityAt >= ACTIVITY_INTERVAL_MS) {
              lastActivityAt = Date.now();
              push({ type: "activity", at: lastActivityAt });
            }

            switch (event.type) {
              // A prompt sent mid-run is delivered without a new execution.
              case "session.execution.started":
              case "session.inbox.enqueued":
              case "session.inbox.delivered":
                executionSeen = true;
                break;
              case "session.text.delta": {
                const delta = data.delta;
                if (typeof delta === "string" && delta.length > 0) {
                  push({ type: "delta", text: delta, at: event.created ?? Date.now() });
                }
                break;
              }
              case "session.tool.input.started":
                if (typeof data.name === "string") {
                  push({ type: "tool", name: data.name, at: event.created ?? Date.now() });
                }
                break;
              case "session.text.ended":
                push({ type: "text-end", at: event.created ?? Date.now() });
                break;
              case "session.execution.succeeded":
                // Ignore a late execution event from the previous turn.
                if (!executionSeen) break;
                finish({
                  type: "done",
                  outcome: "succeeded",
                  at: event.created ?? Date.now(),
                });
                break;
              case "session.execution.failed":
                if (!executionSeen) break;
                finish({
                  type: "error",
                  code: "failed",
                  message: failureMessage(data),
                  at: event.created ?? Date.now(),
                });
                break;
              case "session.execution.interrupted":
                if (!executionSeen) break;
                finish({
                  type: "done",
                  outcome: "interrupted",
                  at: event.created ?? Date.now(),
                });
                break;
              default:
                break;
            }
          });

          // The client may have stopped or timed out while the session was
          // being created. Never start a prompt nobody is listening for.
          if (closed) {
            unsubscribe();
            unsubscribe = () => {};
            return;
          }

          promptSentAt = Date.now();
          const sent = sendPrompt(text, (active) => {
            sessionID = active.id;
          });
          promptInFlight = sent;
          const { messageID } = await sent;

          push({ type: "admitted", messageID, at: promptSentAt });
        } catch (error) {
          // A prompt that was refused has nothing to interrupt.
          promptInFlight = null;
          const message =
            error instanceof Error ? error.message : "OpenCode request failed.";
          fail(message, "opencode");
        }
      })();
    },

    cancel() {
      abandon();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
