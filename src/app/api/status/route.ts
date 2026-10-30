import { agentConfig, ensureSession, OpenCodeError } from "@/lib/opencode";
import { ensureEventStream, streamStatus } from "@/lib/events";
import { guardRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  ensureEventStream();

  try {
    const session = await ensureSession();
    return Response.json({
      ok: true,
      session: {
        id: session.id,
        agent: session.agent,
        model: session.model,
      },
      agent: agentConfig.agent,
      eventStream: streamStatus(),
    });
  } catch (error) {
    const message =
      error instanceof OpenCodeError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OpenCode is unavailable.";

    return Response.json({
      ok: false,
      error: message,
      agent: agentConfig.agent,
      eventStream: streamStatus(),
    });
  }
}
