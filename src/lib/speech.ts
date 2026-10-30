/**
 * Browser speech helpers: recognition (STT) and a small speech queue (TTS).
 * Kept framework-free so it can be reused when this is packaged for mobile.
 */

export type RecognitionHandlers = {
  lang: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (code: string) => void;
  onEnd: () => void;
};

/**
 * Silence that ends a spoken turn. Recognition stays open across pauses, so a
 * breath mid-sentence no longer sends half a thought. Unconfirmed words wait
 * longer because Chrome may still be revising them.
 */
const END_OF_SPEECH_MS = 1_800;
const END_OF_SPEECH_INTERIM_MS = 2_200;
/** A sentence ending on one of these words is almost certainly not finished. */
const END_OF_SPEECH_UNFINISHED_MS = 3_500;
const UNFINISHED_ENDINGS = new Set([
  "a", "an", "and", "are", "because", "but", "can", "for", "from", "i", "if",
  "in", "is", "my", "of", "on", "or", "so", "that", "the", "to", "with", "you",
]);

/** Most sentences spoken from one block of text in short-reply mode. */
export const MAX_SPOKEN_SENTENCES = 3;

/**
 * Words speech recognition reliably gets wrong for this user. Each needs enough
 * context that it cannot rewrite an ordinary sentence: "cloud" alone is left be.
 */
const TRANSCRIPT_FIXES: [RegExp, string][] = [
  [/\bcl(?:audi|awdy|audy)\b/gi, "Claude"],
  [/\bcloud (extension|code)\b/gi, "Claude $1"],
  [/\bves ?code\b/gi, "VS Code"],
  [/\bbra(ve)? browser\b/gi, "Brave browser"],
  [/\b(?:4|four) ground\b/gi, "foreground"],
];

export function correctTranscript(text: string): string {
  return TRANSCRIPT_FIXES.reduce(
    (fixed, [pattern, replacement]) => fixed.replace(pattern, replacement),
    text,
  );
}

function endOfSpeechDelay(heard: string, settled: boolean): number {
  const last = heard.toLowerCase().split(" ").pop() ?? "";
  if (UNFINISHED_ENDINGS.has(last.replace(/[.,!?]/g, ""))) {
    return END_OF_SPEECH_UNFINISHED_MS;
  }
  return settled ? END_OF_SPEECH_MS : END_OF_SPEECH_INTERIM_MS;
}

/** Voices we prefer, in rough order of how good they sound. */
const FEMALE_HINTS = [
  "female",
  "zira",
  "heera",
  "hazel",
  "aria",
  "jenny",
  "neerja",
  "sonia",
  "samantha",
  "victoria",
  "karen",
  "moira",
  "tessa",
  "fiona",
  "serena",
  "allison",
  "ava",
  "susan",
  "michelle",
  "kalpana",
  "swara",
  "priya",
  "lekha",
  "veena",
  "natasha",
  "clara",
  "emma",
  "olivia",
  "sophia",
  "linda",
  "catherine",
  "kate",
  "stephanie",
];

const MALE_HINTS = [
  "david",
  "mark",
  "ravi",
  "guy",
  "ryan",
  "george",
  "james",
  "daniel",
  "alex",
  "fred",
  "harry",
  "oliver",
  "thomas",
  "prabhat",
  "hemant",
  "male",
];

let cachedVoices: SpeechSynthesisVoice[] = [];

/** Keeps a caller-supplied rate inside the range browsers render cleanly. */
export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.06;
  return Math.min(2.5, Math.max(0.5, rate));
}

function refreshVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const list = window.speechSynthesis.getVoices();
  if (list.length) cachedVoices = list;
}

export function warmUpVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}

function scoreVoice(voice: SpeechSynthesisVoice, lang: string): number {
  const name = voice.name.toLowerCase();
  const voiceLang = (voice.lang || "").toLowerCase().replace("_", "-");
  const target = lang.toLowerCase();

  if (!voiceLang.startsWith(target.slice(0, 2))) return -1000;

  let score = voiceLang === target ? 100 : 40;

  if (FEMALE_HINTS.some((hint) => name.includes(hint))) score += 55;

  for (const hint of MALE_HINTS) {
    if (new RegExp(`\\b${hint}\\b`).test(name)) {
      score -= 90;
      break;
    }
  }

  // Local voices start faster and work offline; slightly prefer them.
  if (voice.localService) score += 12;
  if (voice.default) score += 2;

  return score;
}

export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;

  refreshVoices();
  const voices = cachedVoices.length
    ? cachedVoices
    : window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1000;

  for (const voice of voices) {
    const score = scoreVoice(voice, lang);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }

  return bestScore > -1000 ? best : null;
}

export function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

function comparableWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?।]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when both are the same line, with one possibly further along. */
function sameLine(a: string, b: string): boolean {
  const left = comparableWords(a);
  const right = comparableWords(b);
  const shorter = Math.min(left.length, right.length);
  if (shorter === 0) return false;

  let matching = 0;
  for (let i = 0; i < shorter; i += 1) {
    if (left[i] === right[i]) matching += 1;
  }

  // Allows a corrected word, but a single shared opener is not a repeat.
  return matching === shorter || (shorter >= 3 && matching / shorter >= 0.6);
}

/**
 * Joins recognition results into what was actually said. Some browsers report
 * the same sentence again each time it grows, so a result that continues or
 * corrects the previous one replaces it instead of being appended.
 */
export function mergeTranscripts(parts: string[]): string {
  const lines: string[] = [];

  for (const part of parts) {
    const text = part.replace(/\s+/g, " ").trim();
    if (!text) continue;

    const last = lines[lines.length - 1];
    if (last === undefined || !sameLine(last, text)) {
      lines.push(text);
    } else if (comparableWords(text).length >= comparableWords(last).length) {
      lines[lines.length - 1] = text;
    }
  }

  return lines.join(" ");
}

export function createRecognition(handlers: RecognitionHandlers) {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, any>;
  const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = handlers.lang;
  // Android's continuous mode re-reports the sentence as it grows, and its own
  // single-shot mode already waits for the speaker to finish.
  const continuous = !/Android/i.test(navigator.userAgent);
  recognition.continuous = continuous;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let delivered = false;
  let heard = "";
  let silence: ReturnType<typeof setTimeout> | undefined;

  const deliver = () => {
    clearTimeout(silence);
    if (delivered || !heard) return;
    delivered = true;
    handlers.onFinal(correctTranscript(heard));
  };

  recognition.onresult = (event: any) => {
    const parts: string[] = [];
    let settled = true;

    // Rebuilt from the start each time, so a revised result cannot double up.
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result?.[0];
      if (!alternative) continue;

      parts.push(alternative.transcript);
      settled = Boolean(result.isFinal);
    }

    heard = mergeTranscripts(parts);
    if (!heard || delivered) return;

    handlers.onInterim(heard);
    if (!continuous) return;

    clearTimeout(silence);
    silence = setTimeout(deliver, endOfSpeechDelay(heard, settled));
  };

  recognition.onerror = (event: any) => {
    const code = typeof event?.error === "string" ? event.error : "unknown";
    if (code === "no-speech" || code === "aborted") return;
    // Words already heard are still worth sending; onend delivers them.
    if (heard) return;
    handlers.onError(code);
  };

  // Also covers a tap to send: stop() ends here with the words heard so far,
  // even if Chrome never confirmed them as final.
  recognition.onend = () => {
    deliver();
    handlers.onEnd();
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort: () => {
      delivered = true;
      clearTimeout(silence);
      recognition.abort();
    },
  };
}

export function friendlySpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone blocked. Allow mic access for this page in Chrome (lock icon in the address bar), then tap again.";
    case "audio-capture":
      return "No microphone found. Check that Windows sees a mic and that Chrome can use it.";
    case "network":
      return "Chrome could not reach its speech service. Check the internet connection or VPN, try Microsoft Edge, or type below.";
    case "no-speech":
      return "I didn't hear anything. Tap the mic and speak again.";
    case "language-not-supported":
      return "This language is not available in Chrome's speech recognition. Try English (US).";
    default:
      return `Speech recognition failed (${code}).`;
  }
}

/**
 * Queues sentences for speech and starts the first one immediately.
 * One instance is reused for the whole conversation so the voice stays stable.
 */
export class Speaker {
  private queue: string[] = [];
  private speaking = false;
  private generation = 0;
  private voice: SpeechSynthesisVoice | null;
  private readonly lang: string;
  private rateValue: number;
  // Chrome can garbage-collect a playing utterance and never fire its end
  // event, which would stall the whole conversation. Holding it prevents that.
  private current: SpeechSynthesisUtterance | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;

  onStart?: () => void;
  onIdle?: () => void;

  constructor(lang: string, rate = 1.06) {
    this.lang = lang;
    this.voice = pickVoice(lang);
    this.rateValue = clampSpeechRate(rate);
  }

  get voiceName(): string | null {
    return this.voice?.name ?? null;
  }

  get rate(): number {
    return this.rateValue;
  }

  setRate(rate: number) {
    this.rateValue = clampSpeechRate(rate);
  }

  enqueue(text: string) {
    const cleaned = text.trim();
    if (!cleaned) return;
    this.queue.push(cleaned);
    if (!this.speaking) this.next(this.generation);
  }

  private next(generation: number) {
    if (generation !== this.generation) return;

    if (!this.voice) this.voice = pickVoice(this.lang);

    const text = this.queue.shift();
    if (!text) {
      this.speaking = false;
      this.onIdle?.();
      return;
    }

    this.speaking = true;
    const utterance = new SpeechSynthesisUtterance(text);
    this.current = utterance;

    if (this.voice) {
      utterance.voice = this.voice;
      utterance.lang = this.voice.lang;
    } else {
      utterance.lang = this.lang;
    }

    utterance.rate = this.rateValue;
    utterance.pitch = 1.02;
    utterance.volume = 1;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(this.stallTimer);
      this.next(generation);
    };

    utterance.onstart = () => this.onStart?.();
    utterance.onend = finish;
    utterance.onerror = finish;

    // If the voice engine hangs, skip the line rather than freeze the turn.
    const expectedMs = (text.length * 150) / this.rateValue;
    this.stallTimer = setTimeout(() => {
      if (finished || generation !== this.generation) return;
      window.speechSynthesis.cancel();
      finish();
    }, expectedMs + 5_000);

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  get busy(): boolean {
    return this.speaking || this.queue.length > 0;
  }

  stop() {
    this.generation += 1;
    this.queue = [];
    this.speaking = false;
    this.current = null;
    clearTimeout(this.stallTimer);
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* nothing to cancel */
    }
  }
}

/** Strips markdown so the speaker never reads symbols or code aloud. */
export function sanitizeForSpeech(input: string): string {
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, " ");
  const unfinishedFence = text.indexOf("```");
  if (unfinishedFence >= 0) text = text.slice(0, unfinishedFence);

  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/`/g, "");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, " link ");
  // File paths are for reading; spoken, they are a string of slashes.
  text = text.replace(/(^|\s)(?:~|\.{0,2})\/\S+/g, "$1");
  text = text.replace(/(^|\s)[A-Za-z]:\\\S+/g, "$1");
  // Otherwise voices announce them: "waving hand".
  text = text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ");
  text = text.replace(/^\s*[#>*\-+•—–]+\s*/gm, "");
  text = text.replace(/\*\*|__|~~|\|/g, "");
  text = text.replace(/[*~]/g, " ");
  // An em/en dash makes some voices stall or say "dash". A comma keeps the
  // clause break short and natural instead of adding a long silence.
  text = text.replace(/\s*[—–―]\s*/g, ", ");
  text = text.replace(/\s+([,.;:!?])/g, "$1");
  text = text.replace(/,{2,}/g, ",");
  text = text.replace(/,\s*([.!?])/g, "$1");
  text = text.replace(/\s+/g, " ").trim();
  // Trailing separators make the voice hang; drop them before speaking.
  text = text.replace(/[\s—–,;:]+$/g, "").trim();

  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text;
}

/**
 * The part of a reply worth hearing: everything before the first blank line,
 * list, table, heading, or code block. The rest stays on screen.
 */
export function speakablePart(text: string): string {
  const details = text.search(/\n[ \t]*\n|(?:^|\n)[ \t]*(?:\||[-*•+][ \t]|\d+[.)][ \t]|#{1,6}[ \t]|```)/);
  return details < 0 ? text : text.slice(0, details);
}

/**
 * Pulls complete, speakable segments out of a streaming buffer.
 * Only real sentence ends (and newlines) become utterance boundaries. Splitting
 * on commas or dashes made Chrome insert a gap at every clause, which sounded
 * like Ravonna was hesitating; punctuation stays inside one utterance now.
 */
export function takeSpeakable(
  buffer: string,
  flush: boolean,
): { segments: string[]; rest: string } {
  let rest = buffer.replace(/\r/g, "");
  const segments: string[] = [];

  // Code is never spoken. Drop complete fenced blocks, and hold an unfinished
  // one until it closes so its body cannot leak into speech.
  let held = "";
  rest = rest.replace(/```[\s\S]*?```/g, "\n");
  const openFence = rest.indexOf("```");
  if (openFence >= 0) {
    held = rest.slice(openFence);
    rest = rest.slice(0, openFence);
  }

  const findBoundary = (value: string): number => {
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];

      if (char === "\n") return i;

      if (char === "." || char === "!" || char === "?" || char === "…" || char === "।") {
        const next = value[i + 1];
        // Mid-stream, a terminator only counts once we see the whitespace
        // after it. Otherwise "example." would be spoken before "com".
        if (next !== undefined && /\s/.test(next)) return i;
        if (next === undefined && flush) return i;
      }
    }
    return -1;
  };

  while (true) {
    const index = findBoundary(rest);
    if (index < 0) break;

    const raw = rest.slice(0, index + 1);
    rest = rest.slice(index + 1);

    const cleaned = sanitizeForSpeech(raw);
    if (cleaned) segments.push(cleaned);
  }

  if (flush) {
    const cleaned = sanitizeForSpeech(rest);
    rest = "";
    held = "";
    if (cleaned) segments.push(cleaned);
  } else if (rest.length > 320) {
    // Do not hold a very long run-on segment forever.
    const cut = rest.lastIndexOf(" ", 200);
    if (cut > 0) {
      const cleaned = sanitizeForSpeech(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      if (cleaned) segments.push(cleaned);
    }
  }

  return { segments, rest: rest + held };
}
