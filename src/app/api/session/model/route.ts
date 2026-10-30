import type { NextRequest } from "next/server";
import { agentConfig, ensureSessionFor, OpenCodeError, type OpenCodeModel } from "@/lib/opencode";
import { guardRequest } from "@/lib/http";
import { activeTurnId } from "@/lib/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MODEL_LENGTH = 200;

/**
 * Applies a model to the next session and starts a fresh conversation on it.
 * Refused during a turn: replacing the session would orphan the running prompt.
 */
export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;

  if (activeTurnId()) {
    return Response.json(
      { ok: false, error: "Stop the current reply before switching models." },
      { status: 409 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const body = (payload ?? {}) as { providerID?: unknown; id?: unknown };
  const providerID =
    typeof body.providerID === "string" && body.providerID.trim()
      ? body.providerID.trim()
      : "";
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "";

  if (!providerID || !id || id.length > MAX_MODEL_LENGTH) {
    return Response.json(
      { ok: false, error: "A provider and model id are required." },
      { status: 400 },
    );
  }

  try {
    const model: OpenCodeModel = {
      providerID,
      id,
      ...(agentConfig.variant ? { variant: agentConfig.variant } : {}),
    };
    const session = await ensureSessionFor({ model });

    return Response.json({
      ok: true,
      session: { id: session.id, agent: session.agent, model: session.model },
    });
  } catch (error) {
    const message =
      error instanceof OpenCodeError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OpenCode is unavailable.";

    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
