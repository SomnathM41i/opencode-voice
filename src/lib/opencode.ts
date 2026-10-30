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

const sessionOverrides: {
  agent?: string;
  model?: OpenCodeModel;
  variant?: string;
} = {};

export function setSessionOverrides(overrides: {
  agent?: string;
  model?: OpenCodeModel;
  variant?: string;
}): void {
  if (overrides.agent !== undefined) sessionOverrides.agent = overrides.agent;
  if (overrides.model) sessionOverrides.model = overrides.model;
  if (overrides.variant !== undefined) sessionOverrides.variant = overrides.variant;
}

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outerSignal = init.signal;

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
};

const globalState = globalThis as unknown as {
  __ocVoiceSession?: SessionState;
};

const state: SessionState = (globalState.__ocVoiceSession ??= {
  session: null,
  creating: null,
});

async function createSession(): Promise<OpenCodeSession> {
  const body: Record<string, unknown> = {
    location: { directory: agentConfig.directory },
    agent: sessionOverrides.agent ?? agentConfig.agent,
    model: {
      providerID: sessionOverrides.model?.providerID ?? agentConfig.providerID,
      id: sessionOverrides.model?.id ?? agentConfig.modelID,
      ...(sessionOverrides.model?.variant ||
      sessionOverrides.variant ||
      agentConfig.variant
        ? {
            variant:
              sessionOverrides.model?.variant || sessionOverrides.variant || agentConfig.variant,
          }
        : {}),
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
 * model change belongs to a new context.
 */
export async function ensureSessionFor(overrides: {
  agent?: string;
  model?: OpenCodeModel;
  variant?: string;
}): Promise<OpenCodeSession> {
  setSessionOverrides(overrides);
  const session = await ensureSession(true);
  return session;
}

export function cachedSession(): OpenCodeSession | null {
  return state.session;
}

async function prompt(sessionID: string, text: string): Promise<string> {
  const result = await oc<{ data: { id: string } }>(
    `/api/session/${sessionID}/prompt`,
    { method: "POST", body: JSON.stringify({ text }) },
    30_000,
  );
  return result.data.id;
}

export async function sendPrompt(text: string): Promise<{
  session: OpenCodeSession;
  messageID: string;
}> {
  let session = await ensureSession();

  try {
    const messageID = await prompt(session.id, text);
    return { session, messageID };
  } catch (error) {
    // A deleted session means "recreate once and retry".
    if (error instanceof OpenCodeError && error.status === 404) {
      session = await ensureSession(true);
      const messageID = await prompt(session.id, text);
      return { session, messageID };
    }
    throw error;
  }
}

export async function interruptSession(sessionID?: string): Promise<void> {
  const id = sessionID || state.session?.id;
  if (!id) return;
  try {
    await oc(`/api/session/${id}/interrupt`, { method: "POST" }, 8_000);
  } catch {
    // Interrupt is best-effort; a stopped turn is still a stopped turn.
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
