/**
 * Request guards for the local API routes.
 *
 * The app can control OpenCode and read files, so a random web page must not
 * be able to drive it through the browser. Two checks:
 *  - Origin must be one we know (or absent, for curl and scripts).
 *  - JSON routes require `Content-Type: application/json`, which a cross-origin
 *    "simple" request cannot set without a CORS preflight we never approve.
 */

function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS;
  const list = configured
    ? configured.split(",")
    : ["http://localhost:3000", "http://127.0.0.1:3000"];

  return list.map((origin) => origin.trim()).filter(Boolean);
}

export function guardRequest(
  request: Request,
  options: { json?: boolean } = {},
): Response | null {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().includes(origin)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403 });
  }

  if (options.json) {
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return Response.json(
        { error: "Content-Type must be application/json." },
        { status: 415 },
      );
    }
  }

  return null;
}
