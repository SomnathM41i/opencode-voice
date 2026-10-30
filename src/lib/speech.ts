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

export function createRecognition(handlers: RecognitionHandlers) {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, any>;
  const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = handlers.lang;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalized = false;
  let finalText = "";

  recognition.onresult = (event: any) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result?.[0];
      if (!alternative) continue;

      if (result.isFinal) {
        finalText += alternative.transcript + " ";
      } else {
        interim += alternative.transcript;
      }
    }

    if (interim) handlers.onInterim(interim.trim());

    if (!finalized && finalText.trim()) {
      finalized = true;
      handlers.onFinal(finalText.trim());
    }
  };

  recognition.onerror = (event: any) => {
    const code = typeof event?.error === "string" ? event.error : "unknown";
    if (code === "no-speech" || code === "aborted") return;
    handlers.onError(code);
  };

  recognition.onend = () => handlers.onEnd();

  return recognition as {
    start: () => void;
    stop: () => void;
    abort: () => void;
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

    if (this.voice) {
      utterance.voice = this.voice;
      utterance.lang = this.voice.lang;
    } else {
      utterance.lang = this.lang;
    }

    utterance.rate = this.rateValue;
    utterance.pitch = 1.02;
    utterance.volume = 1;

    utterance.onstart = () => this.onStart?.();
    utterance.onend = () => this.next(generation);
    utterance.onerror = () => this.next(generation);

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      this.next(generation);
    }
  }

  get busy(): boolean {
    return this.speaking || this.queue.length > 0;
  }

  stop() {
    this.generation += 1;
    this.queue = [];
    this.speaking = false;
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

      if (char === "." || char === "!" || char === "?" || char === "…") {
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
