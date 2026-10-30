import { interruptSession } from "@/lib/opencode";
import { guardRequest } from "@/lib/http";
import { activeTurnId } from "@/lib/turn";

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

  // A stop aimed at an old turn is ignored once that turn is over. Without an
  // id (curl, scripts), interrupt whatever is running.
  if (turnId && activeTurnId() !== turnId) {
    return Response.json({ ok: true, ignored: true });
  }

  await interruptSession();
  return Response.json({ ok: true });
}
