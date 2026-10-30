/**
 * One in-flight voice turn per Next.js process.
 *
 * A turn is identified by a random token from the client. Stop requests carry
 * that token, so a late Stop from an old turn can never interrupt a newer one.
 */
const globalState = globalThis as {
  __ocVoiceTurnId?: string | null;
  __ocVoiceSettling?: Promise<void> | null;
};

/** How long the next turn will wait for an old one to finish dying. */
const SETTLE_LIMIT_MS = 3_000;

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

/** Registers the shutdown of an abandoned turn for later turns to wait on. */
export function trackSettling(work: Promise<void>): void {
  const next: Promise<void> = Promise.all([globalState.__ocVoiceSettling, work]).then(
    () => {
      if (globalState.__ocVoiceSettling === next) {
        globalState.__ocVoiceSettling = null;
      }
    },
  );
  globalState.__ocVoiceSettling = next;
}

/** Resolves when no abandoned turn is still running on the session. */
export async function settled(): Promise<void> {
  const settling = globalState.__ocVoiceSettling;
  if (!settling) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settling,
    new Promise((resolve) => {
      timer = setTimeout(resolve, SETTLE_LIMIT_MS);
    }),
  ]);
  clearTimeout(timer);
}
