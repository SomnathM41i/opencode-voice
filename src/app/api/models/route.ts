import { listModelOptions, OpenCodeError } from "@/lib/opencode";
import { ensureEventStream } from "@/lib/events";
import { guardRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  ensureEventStream();

  try {
    const models = await listModelOptions();
    return Response.json({ ok: true, models });
  } catch (error) {
    const message =
      error instanceof OpenCodeError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OpenCode is unavailable.";

    return Response.json({ ok: false, error: message, models: [] });
  }
}
