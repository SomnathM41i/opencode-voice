/**
 * Server-only client for the OpenCode v2 HTTP API.
 * The password never leaves the server process.
 */
export type OpenCodeModel = {
  id: string;
  providerID: string;
  variant?: string;
};

export type OpenCodeModelVariant = {
  id: string;
};

export type OpenCodeModelOption = {
  id: string;
  modelID?: string;
  providerID: string;
  name?: string;
  status?: string;
  enabled?: boolean;
  variants?: OpenCodeModelVariant[];
};

export type OpenCodeSession = {
  id: string;
  agent?: string;
  model?: OpenCodeModel;
};

export const agentConfig = {
  agent: process.env.OPENCODE_AGENT || "ravonna",
  providerID: process.env.OPENCODE_PROVIDER || "opencode",
  modelID: process.env.OPENCODE_MODEL || "big-pickle",
  variant: process.env.OPENCODE_VARIANT || "",
  directory: process.env.OPENCODE_DIRECTORY || process.cwd(),
};

function baseUrl(): string {
  return (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
}

function authHeader(): string {
  const password = process.env.OPENCODE_PASSWORD || "";
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

export type SessionOverrides = {
  agent?: string;
  model?: OpenCodeModel;
  variant?: string;
};

export class OpenCodeError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "OpenCodeError";
    this.status = status;
  }
}

function describe(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const candidate =
      record.message ?? record.error ?? record.detail ?? record._tag ?? null;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

export async function oc<T = unknown>(
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  const outerSignal = init.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(baseUrl() + pathname, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    if (!response.ok) {
      throw new OpenCodeError(
        describe(body, `OpenCode returned ${response.status}`),
        response.status,
      );
    }

    return body as T;
  } catch (error) {
    if (error instanceof OpenCodeError) throw error;
    if (outerSignal?.aborted) throw error;
    if (timedOut) {
      throw new OpenCodeError(
        `OpenCode did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        504,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenCodeError(
      `Cannot reach OpenCode at ${baseUrl()} (${message})`,
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function openEventStream(signal: AbortSignal): Promise<Response> {
  const response = await fetch(baseUrl() + "/api/event", {
    headers: {
      Authorization: authHeader(),
      Accept: "text/event-stream",
    },
    cache: "no-store",
    signal,
  });

  if (!response.ok || !response.body) {
    throw new OpenCodeError(
      `OpenCode event stream failed (${response.status})`,
      response.status,
    );
  }

  return response;
}

type SessionState = {
  session: OpenCodeSession | null;
  creating: Promise<OpenCodeSession> | null;
  overrides?: SessionOverrides;
};

const globalState = globalThis as unknown as {
  __ocVoiceSession?: SessionState;
};

const state: SessionState = (globalState.__ocVoiceSession ??= {
  session: null,
  creating: null,
});

async function createSession(
  overrides: SessionOverrides = state.overrides ?? {},
): Promise<OpenCodeSession> {
  const variant = overrides.model?.variant || overrides.variant || agentConfig.variant;
  const body: Record<string, unknown> = {
    location: { directory: agentConfig.directory },
    agent: overrides.agent ?? agentConfig.agent,
    model: {
      providerID: overrides.model?.providerID ?? agentConfig.providerID,
      id: overrides.model?.id ?? agentConfig.modelID,
      ...(variant ? { variant } : {}),
    },
  };

  const result = await oc<{ data: OpenCodeSession }>(
    "/api/session",
    { method: "POST", body: JSON.stringify(body) },
    30_000,
  );

  const session = result.data;
  if (!session?.id) {
    throw new OpenCodeError("OpenCode did not return a session id");
  }
  return session;
}

export async function ensureSession(force = false): Promise<OpenCodeSession> {
  if (force) state.session = null;
  if (state.session) return state.session;

  if (!state.creating) {
    state.creating = createSession()
      .then((session) => {
        state.session = session;
        return session;
      })
      .finally(() => {
        state.creating = null;
      });
  }

  return state.creating;
}

/**
 * Creates the next session with explicit overrides, for example the model the
 * user picked in the settings sheet. Conversation history resets on purpose: a
 * model change belongs to a new context. The new settings apply only once the
 * session exists, so a failed switch leaves the current conversation intact.
 */
export async function ensureSessionFor(
  overrides: SessionOverrides,
): Promise<OpenCodeSession> {
  await state.creating?.catch(() => undefined);

  const next = { ...state.overrides, ...overrides };
  const session = await createSession(next);
  state.overrides = next;
  state.session = session;
  return session;
}

export function cachedSession(): OpenCodeSession | null {
  return state.session;
}

/**
 * Sent with every message: the prompt API has no per-message system field, and
 * the agent's own file also serves the terminal, where long answers are fine.
 */
const VOICE_RULES = `[Voice mode. Your reply is heard through text-to-speech, and this message may be misheard speech recognition.
- Answer first, in one or two plain sentences, then stop. No IDs, PIDs, sizes, paths, timestamps, or raw output in that answer.
- Anything extra goes after a blank line. It is shown on screen, not spoken.
- Before using tools, say in a few words what you are about to do.
- If a word looks misheard, use the likely meaning for harmless requests.
- Before deleting, force-closing, sending, or anything hard to undo, say the exact target in one sentence and wait for a yes. If a short command could affect more than was meant, ask one short question first.]

`;

async function prompt(sessionID: string, text: string): Promise<string> {
  const result = await oc<{ data: { id: string } }>(
    `/api/session/${sessionID}/prompt`,
    { method: "POST", body: JSON.stringify({ text: VOICE_RULES + text }) },
    30_000,
  );
  return result.data.id;
}

/**
 * `onSession` runs before each attempt, so a caller filtering events by session
 * is already following a replacement session when its first event arrives.
 */
export async function sendPrompt(
  text: string,
  onSession: (session: OpenCodeSession) => void = () => {},
): Promise<{
  session: OpenCodeSession;
  messageID: string;
}> {
  let session = await ensureSession();
  onSession(session);

  try {
    const messageID = await prompt(session.id, text);
    return { session, messageID };
  } catch (error) {
    // A deleted session means "recreate once and retry".
    if (error instanceof OpenCodeError && error.status === 404) {
      session = await ensureSession(true);
      onSession(session);
      const messageID = await prompt(session.id, text);
      return { session, messageID };
    }
    throw error;
  }
}

/**
 * Returns false when OpenCode says nothing was running, and null when it could
 * not be asked. A true result means "stopping", not "stopped": the terminal
 * event arrives after this response.
 */
export async function interruptSession(sessionID?: string): Promise<boolean | null> {
  const id = sessionID || state.session?.id;
  if (!id) return false;
  try {
    const body = await oc<{ interrupted?: boolean }>(
      `/api/session/${id}/interrupt`,
      { method: "POST" },
      8_000,
    );
    return body?.interrupted ?? null;
  } catch {
    // Interrupt is best-effort; a stopped turn is still a stopped turn.
    return null;
  }
}

export async function listModels(): Promise<unknown> {
  return oc(`/api/model?directory=${encodeURIComponent(agentConfig.directory)}`);
}

export async function listModelOptions(): Promise<OpenCodeModelOption[]> {
  const body = await oc<{ data?: OpenCodeModelOption[] }>(
    `/api/model?directory=${encodeURIComponent(agentConfig.directory)}`,
  );
  const data = Array.isArray(body?.data) ? (body.data as OpenCodeModelOption[]) : [];
  return data.filter((m) => Boolean(m && typeof m.id === "string"));
}
