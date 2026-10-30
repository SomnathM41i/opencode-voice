/**
 * One in-flight voice turn per Next.js process.
 *
 * A turn is identified by a random token from the client. Stop requests carry
 * that token, so a late Stop from an old turn can never interrupt a newer one.
 */
const globalState = globalThis as { __ocVoiceTurnId?: string | null };

export function activeTurnId(): string | null {
  const id = globalState.__ocVoiceTurnId;
  return typeof id === "string" && id ? id : null;
}

/** Check-and-set in one synchronous step, so two requests cannot both win. */
export function beginTurn(id: string): boolean {
  if (activeTurnId()) return false;
  globalState.__ocVoiceTurnId = id;
  return true;
}

export function endTurn(id: string): void {
  if (globalState.__ocVoiceTurnId === id) {
    globalState.__ocVoiceTurnId = null;
  }
}
