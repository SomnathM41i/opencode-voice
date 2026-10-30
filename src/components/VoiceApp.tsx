"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Speaker,
  createRecognition,
  friendlySpeechError,
  speechSupported,
  takeSpeakable,
  warmUpVoices,
} from "@/lib/speech";
import type { OpenCodeModelOption } from "@/lib/opencode";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

type Message = {
  id: number;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
};

type Metrics = {
  firstToken: number | null;
  firstAudio: number | null;
  total: number | null;
};

type SessionInfo = {
  id: string;
  agent?: string;
  model?: { id: string; providerID: string };
};

type Notice = {
  message: string;
  source: "opencode" | "speech" | "app";
};

type LinkState = "checking" | "online" | "offline";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const SUGGESTIONS = [
  "What can you do?",
  "Brief me on today",
  "Plan my next hour",
];

const modelKey = (providerID: string, id: string) => `${providerID}:${id}`;

const SPEECH_PRESETS = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];
const DEFAULT_SPEECH_RATE = 1.1;
const RATE_STORAGE_KEY = "opencode-voice.speechRate";

function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

type Turn = {
  id: string;
  abort: AbortController;
  startedAt: number;
  pending: string;
  firstToken: boolean;
  firstAudio: boolean;
  streamDone: boolean;
  cancelled: boolean;
  autoStarted: boolean;
  hadText: boolean;
};

type ChatEvent =
  | { type: "session"; sessionID: string; agent?: string; model?: SessionInfo["model"] }
  | { type: "admitted"; messageID: string; at: number }
  | { type: "delta"; text: string; at: number }
  | { type: "done"; outcome: string; at: number }
  | { type: "error"; code: string; message: string; at: number };

const EMPTY_METRICS: Metrics = { firstToken: null, firstAudio: null, total: null };

/** Quiet gap after speech before the mic reopens, so it cannot hear its own tail. */
const AUTO_LISTEN_DELAY_MS = 420;

function seconds(value: number | null): string {
  if (value === null) return "—";
  return `${(value / 1000).toFixed(2)}s`;
}

function newTurnId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2.8" width="6" height="11" rx="3" />
      <path d="M5.2 11a6.8 6.8 0 0 0 13.6 0" />
      <path d="M12 17.9V21" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h13" />
      <path d="M12.5 5.5 19 12l-6.5 6.5" />
    </svg>
  );
}

function SendUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 10.5v3" />
      <path d="M8 7.5v9" />
      <path d="M12 4.5v15" />
      <path d="M16 7.5v9" />
      <path d="M20 10.5v3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="19"
      height="19"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 8h9" />
      <path d="M17 8h3" />
      <circle cx="15" cy="8" r="2" />
      <path d="M4 16h3" />
      <path d="M11 16h9" />
      <circle cx="9" cy="16" r="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

export default function VoiceApp() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lang, setLang] = useState("en-IN");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [draft, setDraft] = useState("");
  const [autoListen, setAutoListen] = useState(true);
  const [voiceLabel, setVoiceLabel] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [link, setLink] = useState<LinkState>("checking");
  const [eventsLive, setEventsLive] = useState<boolean | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [speechRate, setSpeechRate] = useState(DEFAULT_SPEECH_RATE);
  const [models, setModels] = useState<OpenCodeModelOption[]>([]);
  const [modelKeyValue, setModelKeyValue] = useState("");

  const recognitionRef = useRef<ReturnType<typeof createRecognition>>(null);
  const turnRef = useRef<Turn | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const previewRef = useRef<Speaker | null>(null);
  const rateRef = useRef(DEFAULT_SPEECH_RATE);
  const sendGuardRef = useRef(false);
  const idRef = useRef(1);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const settingsCloseRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const autoListenRef = useRef(true);
  const startListeningRef = useRef<() => void>(() => {});

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    autoListenRef.current = autoListen;
  }, [autoListen]);

  const applySpeechRate = useCallback((next: number) => {
    const value = Math.min(
      2,
      Math.max(0.8, Number.isFinite(next) ? next : DEFAULT_SPEECH_RATE),
    );
    setSpeechRate(value);
    rateRef.current = value;
    speakerRef.current?.setRate(value);
    previewRef.current?.setRate(value);
    try {
      window.localStorage.setItem(RATE_STORAGE_KEY, String(value));
    } catch {
      /* storage may be unavailable in private mode */
    }
  }, []);

  // Restore the saved speed after mount, so server and client render the same.
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(RATE_STORAGE_KEY));
      if (Number.isFinite(stored) && stored >= 0.8 && stored <= 2) {
        applySpeechRate(stored);
      }
    } catch {
      /* first run, or storage blocked */
    }
  }, [applySpeechRate]);

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Load the available OpenCode models for the settings picker.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/models");
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          models?: OpenCodeModelOption[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!data?.ok || !Array.isArray(data.models)) {
          setModels([]);
          return;
        }
        const list = data.models;
        setModels(list);
        const currentKey = sessionInfo?.model
          ? modelKey(sessionInfo.model.providerID, sessionInfo.model.id)
          : "";
        setModelKeyValue((current) => current || currentKey);
      } catch {
        if (!cancelled) setModels([]);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionInfo?.model?.providerID, sessionInfo?.model?.id]);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const readStandalone = () =>
      media.matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const update = () => setStandalone(readStandalone());

    update();
    media.addEventListener?.("change", update);

    const ua = navigator.userAgent;
    setIsIOS(
      /iPad|iPhone|iPod/.test(ua) ||
        (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)),
    );

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      media.removeEventListener?.("change", update);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => undefined);
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    settingsCloseRef.current?.focus();

    return () => {
      document.body.style.overflow = previous;
    };
  }, [settingsOpen]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 116)}px`;
  }, [draft]);

  // Rebuild the speaker when the language changes; voices follow the language.
  useEffect(() => {
    warmUpVoices();
    speakerRef.current?.stop();
    const speaker = new Speaker(lang, rateRef.current);
    speakerRef.current = speaker;
    setVoiceLabel(speaker.voiceName);

    // Chrome often loads voices asynchronously after the first paint.
    const timer = setTimeout(
      () => setVoiceLabel(speakerRef.current?.voiceName ?? null),
      900,
    );

    return () => clearTimeout(timer);
  }, [lang]);

  const appendAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: idRef.current++, role: "assistant", text, streaming: true }];
    });
  }, []);

  const finalizeAssistant = useCallback(() => {
    setMessages((prev) =>
      prev.map((message, index) =>
        index === prev.length - 1 && message.streaming
          ? { ...message, streaming: false, text: message.text || "(no text)" }
          : message,
      ),
    );
  }, []);

  const stopEverything = useCallback((): Promise<void> => {
    const turn = turnRef.current;
    if (turn) {
      turn.cancelled = true;
      turn.abort.abort();
      turn.streamDone = true;
      turnRef.current = null;
    }

    speakerRef.current?.stop();

    try {
      recognitionRef.current?.abort();
    } catch {
      /* already stopped */
    }
    recognitionRef.current = null;

    // Resolve only once OpenCode has actually acknowledged the interrupt, so a
    // barge-in cannot start the next prompt before this turn is dead. The turn
    // id makes a late stop harmless to any newer turn.
    const acknowledged = turn
      ? Promise.race([
          fetch("/api/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ turnId: turn.id }),
          })
            .then(() => undefined)
            .catch(() => undefined),
          // Never leave the mic closed behind a hung server; the turn token
          // makes a stop that lands later harmless to the next turn.
          new Promise<void>((resolve) => window.setTimeout(resolve, 2_500)),
        ])
      : Promise.resolve();

    setPhase("idle");
    setInterim("");
    finalizeAssistant();

    return acknowledged;
  }, [finalizeAssistant]);

  const runTurn = useCallback(
    async (text: string) => {
      previewRef.current?.stop();
      previewRef.current = null;
      setNotice(null);
      setInterim("");
      setMetrics(EMPTY_METRICS);
      setPhase("thinking");
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, { id: idRef.current++, role: "user", text }]);

      const speaker = speakerRef.current ?? new Speaker(lang);
      if (!speakerRef.current) speakerRef.current = speaker;
      const turn: Turn = {
        id: newTurnId(),
        abort: new AbortController(),
        startedAt: performance.now(),
        pending: "",
        firstToken: false,
        firstAudio: false,
        streamDone: false,
        cancelled: false,
        autoStarted: false,
        hadText: false,
      };
      turnRef.current = turn;

      speaker.onStart = () => {
        setVoiceLabel(speaker.voiceName);
        if (!turn.firstAudio) {
          turn.firstAudio = true;
          setMetrics((current) => ({
            ...current,
            firstAudio: Math.round(performance.now() - turn.startedAt),
          }));
        }
        setPhase("speaking");
      };

      speaker.onIdle = () => {
        if (turn.cancelled) return;

        if (!turn.streamDone) {
          setPhase("thinking");
          return;
        }

        setPhase("idle");

        if (turnRef.current === turn) turnRef.current = null;

        if (autoListenRef.current && !turn.autoStarted) {
          turn.autoStarted = true;
          window.setTimeout(() => {
            if (!autoListenRef.current) return;
            if (phaseRef.current !== "idle") return;
            startListeningRef.current();
          }, AUTO_LISTEN_DELAY_MS);
        }
      };

      const handleEvent = (event: ChatEvent) => {
        switch (event.type) {
          case "session":
            setSessionInfo({
              id: event.sessionID,
              agent: event.agent,
              model: event.model,
            });
            setLink("online");
            break;

          case "delta": {
            turn.hadText = true;
            if (!turn.firstToken) {
              turn.firstToken = true;
              setMetrics((current) => ({
                ...current,
                firstToken: Math.round(performance.now() - turn.startedAt),
              }));
            }

            appendAssistant(event.text);

            const { segments, rest } = takeSpeakable(turn.pending + event.text, false);
            turn.pending = rest;
            for (const segment of segments) speaker.enqueue(segment);
            break;
          }

          case "done": {
            turn.streamDone = true;
            const { segments } = takeSpeakable(turn.pending, true);
            turn.pending = "";
            for (const segment of segments) speaker.enqueue(segment);
            setMetrics((current) => ({
              ...current,
              total: Math.round(performance.now() - turn.startedAt),
            }));
            if (!turn.hadText) {
              setMessages((prev) => [
                ...prev,
                { id: idRef.current++, role: "assistant", text: "(no text)", streaming: false },
              ]);
            }
            finalizeAssistant();
            if (!speaker.busy) {
              setPhase("idle");
              turnRef.current = null;
              if (autoListenRef.current && !turn.autoStarted) {
                turn.autoStarted = true;
                window.setTimeout(() => {
                  if (!autoListenRef.current) return;
                  if (phaseRef.current !== "idle") return;
                  startListeningRef.current();
                }, AUTO_LISTEN_DELAY_MS);
              }
            }
            break;
          }

          case "error": {
            setNotice({ message: event.message, source: "opencode" });
            turn.cancelled = true;
            turn.streamDone = true;
            speaker.stop();
            finalizeAssistant();
            setPhase("idle");
            break;
          }

          default:
            break;
        }
      };

      const watchdog = window.setTimeout(() => {
        if (turnRef.current !== turn || turn.streamDone) return;
        turn.cancelled = true;
        turn.abort.abort();
        speaker.stop();
        finalizeAssistant();
        setPhase("idle");
        turnRef.current = null;
        setNotice({
          message: "No response after 95 seconds — the turn was cancelled.",
          source: "opencode",
        });
        void fetch("/api/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId: turn.id }),
        }).catch(() => {});
      }, 95_000);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, turnId: turn.id }),
          signal: turn.abort.signal,
        });

        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => null);
          throw new Error(
            (data && typeof data.error === "string" && data.error) ||
              `Request failed (${response.status}).`,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line) as ChatEvent);
            } catch {
              /* ignore malformed line */
            }
          }
        }
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        const message =
          caught instanceof Error ? caught.message : "The request failed.";
        setNotice({ message, source: "opencode" });
        turn.cancelled = true;
        speaker.stop();
        finalizeAssistant();
        setPhase("idle");
        return;
      } finally {
        window.clearTimeout(watchdog);
      }

      if (!turn.streamDone) {
        const { segments } = takeSpeakable(turn.pending, true);
        for (const segment of segments) speaker.enqueue(segment);
        finalizeAssistant();
        if (!speaker.busy) {
          setPhase("idle");
          turnRef.current = null;
        }
      }
    },
    [appendAssistant, finalizeAssistant, lang],
  );

  const startListening = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
    setNotice(null);

    if (!speechSupported()) {
      setNotice({
        message:
          "This browser has no speech recognition. Use Chrome or Edge on the laptop, or type below.",
        source: "speech",
      });
      setPhase("error");
      return;
    }

    sendGuardRef.current = false;
    setInterim("");

    const recognition = createRecognition({
      lang,
      onInterim: (text) => setInterim(text),
      onFinal: (text) => {
        if (sendGuardRef.current) return;
        sendGuardRef.current = true;
        setInterim("");
        try {
          recognitionRef.current?.stop();
        } catch {
          /* already stopped */
        }
        recognitionRef.current = null;
        void runTurn(text);
      },
      onError: (code) => {
        if (code === "aborted") return;
        setNotice({ message: friendlySpeechError(code), source: "speech" });
        setPhase("idle");
        // Put the cursor where the user can keep going without the mic.
        inputRef.current?.focus();
      },
      onEnd: () => {
        if (!sendGuardRef.current && phaseRef.current === "listening") {
          setPhase("idle");
          setInterim("");
        }
      },
    });

    if (!recognition) {
      setNotice({
        message: "Speech recognition is not available in this browser.",
        source: "speech",
      });
      setPhase("error");
      return;
    }

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setPhase("listening");
    } catch {
      setNotice({
        message:
          "Could not start the microphone. Close other tabs using it and try again.",
        source: "speech",
      });
      setPhase("idle");
    }
  }, [lang, runTurn]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const onMicClick = useCallback(() => {
    if (phase === "listening") {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* already stopped */
      }
      return;
    }

    if (phase === "thinking" || phase === "speaking") {
      const acknowledged = stopEverything();
      // Interrupt, wait for OpenCode to confirm, then go straight back to the
      // mic — like a real conversation, without racing the old turn.
      if (autoListenRef.current) {
        void acknowledged.then(() => {
          if (autoListenRef.current) startListeningRef.current();
        });
      }
      return;
    }

    startListening();
  }, [phase, startListening, stopEverything]);

  const sendText = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (!text) return false;

      if (phase === "listening") {
        // Typing or a suggestion takes over from the microphone.
        sendGuardRef.current = true;
        try {
          recognitionRef.current?.abort();
        } catch {
          /* already stopped */
        }
        recognitionRef.current = null;
        setInterim("");
      } else if (phase !== "idle") {
        return false;
      }

      void runTurn(text);
      return true;
    },
    [phase, runTurn],
  );

  const onTextSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (sendText(draft)) setDraft("");
    },
    [draft, sendText],
  );

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      const current = phaseRef.current;
      if (current === "listening" || current === "thinking" || current === "speaking") {
        stopEverything();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, stopEverything]);

  const applyModel = useCallback(
    async (nextProviderID: string, nextId: string) => {
      const nextKey = modelKey(nextProviderID, nextId);
      setModelKeyValue(nextKey);

      try {
        const response = await fetch("/api/session/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerID: nextProviderID, id: nextId }),
        });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          session?: { id?: string; agent?: string; model?: { id?: string; providerID?: string } };
          error?: string;
        } | null;

        if (response.ok && data?.ok && data.session?.id) {
          setSessionInfo({
            id: data.session.id,
            agent: data.session.agent,
            model: {
              id: data.session.model?.id ?? nextId,
              providerID: data.session.model?.providerID ?? nextProviderID,
            },
          });
          return;
        }

        setNotice({
          message: data?.error || "Could not switch the model.",
          source: "opencode",
        });
      } catch {
        setNotice({
          message: "Could not switch the model right now.",
          source: "app",
        });
      }
    },
    [],
  );

  const previewVoice = useCallback(() => {
    if (phase !== "idle") return;

    previewRef.current?.stop();
    const preview = new Speaker(lang, speechRate);
    preview.onStart = () => setVoiceLabel(preview.voiceName);
    previewRef.current = preview;
    preview.enqueue(
      `This is Ravonna, speaking at ${Number(
        speechRate.toFixed(2),
      )} times speed.`,
    );
  }, [lang, phase, speechRate]);

  const toggleAutoListen = useCallback(() => {
    setAutoListen((value) => {
      const next = !value;
      autoListenRef.current = next;
      if (!next) {
        sendGuardRef.current = true;
        try {
          recognitionRef.current?.abort();
        } catch {
          /* already stopped */
        }
        recognitionRef.current = null;
        if (phaseRef.current === "listening") setPhase("idle");
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;

        if (data?.ok && data.session) {
          setSessionInfo({
            id: data.session.id,
            agent: data.agent,
            model: data.session.model,
          });
          setLink("online");
        } else {
          setLink("offline");
          setNotice({
            message: data?.error || "OpenCode is not available.",
            source: "opencode",
          });
        }
        setEventsLive(Boolean(data?.eventStream?.connected));
      } catch {
        if (!cancelled) {
          setLink("offline");
          setEventsLive(false);
          setNotice({
            message: "Cannot reach the local Next.js server.",
            source: "app",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      turnRef.current?.abort.abort();
      turnRef.current = null;
      speakerRef.current?.stop();
      previewRef.current?.stop();
      previewRef.current = null;
      try {
        recognitionRef.current?.abort();
      } catch {
        /* already stopped */
      }
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* nothing playing */
      }
    };
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const streaming = messages.some((message) => message.streaming);
    logEndRef.current?.scrollIntoView({
      behavior: streaming ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, interim]);

  const statusLabel =
    phase === "listening"
      ? "Listening"
      : phase === "thinking"
        ? "Thinking"
        : phase === "speaking"
          ? "Speaking"
          : "Ready";

  const micTitle =
    phase === "listening"
      ? "I'm listening"
      : phase === "thinking"
        ? "Thinking"
        : phase === "speaking"
          ? "Speaking"
          : "Tap to talk";

  const hint =
    phase === "listening"
      ? "Tap the arrow to send now."
      : phase === "thinking" || phase === "speaking"
        ? "Tap the mic to interrupt."
        : autoListen
          ? "It reopens after each answer."
          : "Hands-free is off.";

  const busy = phase === "thinking" || phase === "speaking";
  const linkState: LinkState = !isOnline ? "offline" : link;
  const linkText = !isOnline
    ? "Offline"
    : link === "online"
      ? `${sessionInfo?.agent ?? "Ravonna"} · ready`
      : link === "offline"
        ? "OpenCode offline"
        : "Connecting…";

  const latency =
    metrics.total !== null
      ? `${
          metrics.firstAudio !== null
            ? `${seconds(metrics.firstAudio)} voice · `
            : ""
        }${seconds(metrics.total)} total`
      : null;

  const installApp = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      /* the prompt can be dismissed by the browser */
    }
    setInstallPrompt(null);
  };

  return (
    <main className="shell">
      <header className="appHeader">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            <WaveIcon />
          </span>
          <div className="brandText">
            <h1>OpenCode Voice</h1>
            <p className="brandSub">
              <span className={`connDot ${linkState}`} aria-hidden="true" />
              {linkText}
            </p>
          </div>
        </div>

        <div className="headerActions">
          <button
            type="button"
            className="iconButton"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`notice ${notice.source}`} role="alert">
          <div className="noticeBody">
            <strong>
              {notice.source === "speech"
                ? "Microphone"
                : notice.source === "opencode"
                  ? "OpenCode"
                  : "App"}
            </strong>
            <span>{notice.message}</span>
            {notice.source === "opencode" ? (
              <span className="noticeHint">
                If OpenCode is not running: <code>npm run opencode</code>
              </span>
            ) : null}
            {notice.source === "speech" ? (
              <span className="noticeHint">
                The mic uses Chrome&apos;s speech service, not OpenCode. Type
                below or try Microsoft Edge.
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="noticeClose"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <section
        className="conversation"
        aria-label="Conversation"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          // Stay glued to the newest text only while the reader is at the
          // bottom; scrolling up to re-read must not be yanked back down.
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && !interim ? (
          <div className="welcome">
            <div className="welcomeOrb" aria-hidden="true">
              <MicIcon />
            </div>
            <h2>Talk to Ravonna</h2>
            <p>
              Tap the mic and speak. She answers out loud while the words appear
              here.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  onClick={() => sendText(suggestion)}
                  disabled={phase !== "idle"}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="welcomeHint">
              Hands-free is {autoListen ? "on" : "off"} · <kbd>Esc</kbd> stops a
              reply
            </p>
          </div>
        ) : null}

        {messages.map((message) => (
          <article
            key={message.id}
            className={`message ${message.role}`}
            aria-label={message.role === "assistant" ? "Ravonna" : "You"}
          >
            {message.role === "assistant" ? (
              <span className="avatar" aria-hidden="true">
                <WaveIcon />
              </span>
            ) : null}
            <div className="bubble">
              {message.text}
              {message.streaming ? <span className="caret" /> : null}
            </div>
          </article>
        ))}

        {interim ? (
          <article className="message user interim" aria-label="You, speaking">
            <div className="bubble">
              {interim}
              <span className="typingDots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          </article>
        ) : null}

        <div ref={logEndRef} className="scrollAnchor" />
      </section>

      <footer className="dockArea">
        <section className="voiceDock" aria-label="Voice controls">
          <div className="dockStatus">
            <span className={`statusDot ${phase}`} aria-hidden="true" />
            <span className="statusText">{statusLabel}</span>
            {latency ? <span className="latency">{latency}</span> : null}
          </div>

          <div className="micRow">
            <div className="micSlot">
              <button
                type="button"
                className={`mic ${phase}`}
                onClick={onMicClick}
                aria-label={
                  phase === "listening"
                    ? "Stop listening and send"
                    : phase === "thinking" || phase === "speaking"
                      ? "Interrupt and talk"
                      : "Start listening"
                }
              >
                {phase === "thinking" ? (
                  <span className="spinner" />
                ) : phase === "listening" ? (
                  <SendIcon />
                ) : phase === "speaking" ? (
                  <StopIcon />
                ) : (
                  <MicIcon />
                )}
              </button>
            </div>

            <div className="micCopy">
              <strong>{micTitle}</strong>
              <span>{hint}</span>
            </div>

            <div className="micActions">
              {busy ? (
                <button
                  type="button"
                  className="pill danger"
                  onClick={() => void stopEverything()}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className={`pill ${autoListen ? "on" : ""}`}
                  onClick={toggleAutoListen}
                  aria-pressed={autoListen}
                  aria-label={
                    autoListen
                      ? "Turn hands-free off"
                      : "Turn hands-free on"
                  }
                >
                  <span
                    className={`switch ${autoListen ? "on" : ""}`}
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                  <span className="pillLabel">Hands-free</span>
                </button>
              )}
            </div>
          </div>
        </section>

        <form className="composer" onSubmit={onTextSubmit}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            placeholder="Message Ravonna…"
            maxLength={4000}
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="send"
            aria-label="Message Ravonna"
          />
          <button
            type="submit"
            className="sendButton"
            disabled={
              !draft.trim() || (phase !== "idle" && phase !== "listening")
            }
            aria-label="Send message"
          >
            <SendUpIcon />
          </button>
        </form>

        <button
          type="button"
          className="footnote"
          onClick={() => setSettingsOpen(true)}
          title="Voice settings"
        >
          <span>{voiceLabel ?? "System voice"}</span>
          <span aria-hidden="true">·</span>
          <span>{rateLabel(speechRate)} speed</span>
        </button>
      </footer>

      {settingsOpen ? (
        <div
          className="sheetBackdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settingsTitle"
          >
            <div className="sheetGrip" aria-hidden="true" />
            <div className="sheetHead">
              <h2 id="settingsTitle">Settings</h2>
              <button
                ref={settingsCloseRef}
                type="button"
                className="iconButton"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="sheetSection">
              <h3>Voice</h3>
              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Language</strong>
                  <span>Recognition and spoken replies</span>
                </div>
                <select
                  className="select"
                  value={lang}
                  onChange={(event) => setLang(event.target.value)}
                  disabled={busy}
                  aria-label="Speech language"
                >
                  <option value="en-IN">English (IN)</option>
                  <option value="en-US">English (US)</option>
                  <option value="hi-IN">हिंदी</option>
                </select>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Hands-free</strong>
                  <span>Listen again after each reply</span>
                </div>
                <button
                  type="button"
                  className={`switchButton ${autoListen ? "on" : ""}`}
                  onClick={toggleAutoListen}
                  aria-pressed={autoListen}
                  aria-label="Hands-free mode"
                >
                  <span />
                </button>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Voice</strong>
                  <span>{voiceLabel ?? "System default"}</span>
                </div>
              </div>
            </div>

            <div className="sheetSection">
              <div className="rateHead">
                <div>
                  <h3>Speech speed</h3>
                  <span>How fast Ravonna talks</span>
                </div>
                <strong>{rateLabel(speechRate)}</strong>
              </div>

              <input
                className="range"
                type="range"
                min={0.8}
                max={2}
                step={0.05}
                value={speechRate}
                onChange={(event) =>
                  applySpeechRate(Number(event.target.value))
                }
                aria-label="Speech speed"
              />

              <div className="rateChips">
                {SPEECH_PRESETS.map((rate) => {
                  const active = Math.abs(rate - speechRate) < 0.001;
                  return (
                    <button
                      key={rate}
                      type="button"
                      className={`rateChip ${active ? "on" : ""}`}
                      onClick={() => applySpeechRate(rate)}
                      aria-pressed={active}
                    >
                      {rateLabel(rate)}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                className="previewButton"
                onClick={previewVoice}
                disabled={phase !== "idle"}
              >
                Preview voice
              </button>
            </div>

            <div className="sheetSection">
              <h3>Connection</h3>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>OpenCode</strong>
                  <span>
                    {link === "online"
                      ? "Answering"
                      : link === "offline"
                        ? "Not reachable"
                        : "Checking…"}
                  </span>
                </div>
                <span
                  className={`badge ${
                    link === "online"
                      ? "on"
                      : link === "offline"
                        ? "off"
                        : ""
                  }`}
                >
                  {link === "online"
                    ? "Online"
                    : link === "offline"
                      ? "Offline"
                      : "Checking"}
                </span>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Event stream</strong>
                  <span>Live updates from the agent</span>
                </div>
                <span
                  className={`badge ${
                    eventsLive === null ? "" : eventsLive ? "on" : "off"
                  }`}
                >
                  {eventsLive === null
                    ? "—"
                    : eventsLive
                      ? "Live"
                      : "Reconnecting"}
                </span>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Model</strong>
                  <span>Which OpenCode model Ravonna answers with</span>
                </div>
                <select
                  className="select"
                  value={modelKeyValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    const separator = value.indexOf(":");
                    const nextProviderID = separator > 0 ? value.slice(0, separator) : "";
                    const nextId = separator > 0 ? value.slice(separator + 1) : "";
                    if (!nextProviderID || !nextId) return;
                    void applyModel(nextProviderID, nextId);
                  }}
                  disabled={phase === "thinking" || phase === "speaking"}
                  aria-label="Model"
                >
                  {models.length === 0 ? (
                    <option value="">Loading…</option>
                  ) : (
                    models.map((option) => (
                      <option key={modelKey(option.providerID, option.id)} value={modelKey(option.providerID, option.id)}>
                        {option.name ? `${option.name} · ${option.id}` : option.id}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Agent</strong>
                  <span>{sessionInfo?.agent ?? "ravonna"}</span>
                </div>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  <strong>Model</strong>
                  <span>{sessionInfo?.model?.id ?? "connecting…"}</span>
                </div>
              </div>
            </div>

            <div className="sheetSection">
              <h3>App</h3>

              {installPrompt && !standalone ? (
                <button
                  type="button"
                  className="installButton"
                  onClick={() => void installApp()}
                >
                  Install OpenCode Voice
                </button>
              ) : null}

              <p className="sheetNote">
                {standalone
                  ? "Installed. This window is running as a standalone app."
                  : isIOS
                    ? "On iPhone or iPad: Share → Add to Home Screen."
                    : "In Chrome, use the Install app icon in the address bar if the button is not shown."}
              </p>

              <p className="sheetNote">
                <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds
                a line · <kbd>Esc</kbd> stops a turn.
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
