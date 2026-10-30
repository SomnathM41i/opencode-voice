import { cachedSession } from "@/lib/opencode";
import { interruptAndWait } from "@/lib/events";
import { guardRequest } from "@/lib/http";
import { activeTurnId, settled, trackSettling } from "@/lib/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  let turnId: string | undefined;

  if ((request.headers.get("content-type") || "").includes("application/json")) {
    const body = (await request.json().catch(() => null)) as
      | { turnId?: unknown }
      | null;
    if (body && typeof body.turnId === "string" && body.turnId) {
      turnId = body.turnId.slice(0, 128);
    }
  }

  // A stop aimed at an old turn is ignored once that turn is over, but still
  // waits for its shutdown: the browser treats this response as the all-clear
  // to reopen the mic. Without an id (curl, scripts), interrupt what is running.
  if (turnId && activeTurnId() !== turnId) {
    await settled();
    return Response.json({ ok: true, ignored: true });
  }

  const session = cachedSession();
  if (session) trackSettling(interruptAndWait(session.id));
  await settled();
  return Response.json({ ok: true });
}
