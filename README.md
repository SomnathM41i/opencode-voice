# OpenCode Voice

Minimal voice loop for OpenCode: tap the mic, speak, hear the answer.
One Next.js app (frontend + backend), one reused OpenCode session.

## Requirements

- Node 20+ (tested on 24)
- OpenCode 2.x on PATH (`opencode --version`)
- Chrome or Edge for speech recognition

## First run

```bash
cd ~/opencode-voice
npm install          # already done once
```

Terminal 1 — OpenCode server:

```bash
npm run opencode
```

It reads `OPENCODE_PASSWORD` from `.env.local` and listens on `127.0.0.1:4096`.
Leave it running.

Terminal 2 — the app:

```bash
npm run dev
```

On Windows, open **http://localhost:3000** in Chrome.

## How to use it

1. Tap the mic. The dot turns blue: **Listening**.
2. Speak. Chrome ends the turn when you stop talking.
3. Tap the mic again to send immediately instead of waiting.
4. Watch the reply stream in; it starts speaking at the first clause.
5. With **Hands-free** on, the mic reopens ~0.4 s after the reply finishes, so
   you can just keep talking. The gap is deliberate: it stops the mic hearing
   the last word of the reply.
6. Tap the mic while it is thinking or speaking to interrupt and talk over it.
   The **Stop** button (or **Escape**) stops without reopening the mic.

Text fallback works too — type and press Enter, even while the mic is listening;
typing takes over from the microphone.

The gear in the header opens settings: language, hands-free, speech speed,
connection details, the model picker, and the install button.

### Model picker

Settings lists the models your OpenCode server exposes (27 available right now)
and starts a fresh conversation on the chosen model. It lands on the next turn,
so you can also switch models between conversations without touching
`.env.local`.

### Speech speed

Settings → **Speech speed** has presets from 0.9× to 2×, plus a fine slider
from 0.8× to 2×. The choice is saved in `localStorage` and applied to every
later reply; **Preview voice** speaks the current speed without starting a turn.
The selected speed also appears under the composer.

The voice is chosen automatically: a female voice for the selected language is
preferred (Zira, Heera, Aria, Jenny, Samantha, Neerja …), local system voices
before network ones. The chosen voice name appears under the composer and in
settings once the browser has spoken.

## What the numbers mean

The status row under the conversation shows:

- `voice` — time from send to the first spoken word
- `total` — time to the end of the OpenCode turn

## Install as an app

The app ships a web manifest, icons, and a small service worker, so Chrome and
Edge can install it as a standalone window (no address bar), and iOS can add it
to the Home Screen via **Share → Add to Home Screen**.

- On desktop, open **http://localhost:3000**, then use the install icon in the
  address bar or **Settings → Install OpenCode Voice**.
- The service worker is network-first and never caches `/api/*`, so answers are
  always fresh; it only keeps the shell available if the network blips.
- A phone install needs HTTPS (both for the mic and for the service worker).
  Serve the app through a trusted TLS reverse proxy and add its origin to
  `ALLOWED_ORIGINS` before installing on a phone.

## Configuration

`.env.local` (server-only, never shipped to the browser):

| Key | Meaning |
|---|---|
| `OPENCODE_URL` | OpenCode server URL |
| `OPENCODE_PASSWORD` | Basic-auth password for that server |
| `OPENCODE_AGENT` | Agent to talk to (default `ravonna`) |
| `OPENCODE_PROVIDER` | Model provider (default `opencode`) |
| `OPENCODE_MODEL` | Model id (default `big-pickle` in code; `.env.local` ships `deepseek-v4.1-flash-free`, the fastest measured) |
| `OPENCODE_VARIANT` | Optional model variant |
| `OPENCODE_DIRECTORY` | Working directory for sessions |

## How it works

```
Browser (mic + speakers)
  │ POST /api/chat  → streamed NDJSON
  ▼
Next.js route handlers
  │ one persistent SSE connection → /api/event
  │ POST /api/session/:id/prompt
  ▼
OpenCode on 127.0.0.1:4096
```

- The OpenCode password stays in the server process.
- The session is created once and reused for every turn.
- `/api/chat` streams each `session.text.delta` to the browser as it arrives.
- `/api/stop` interrupts the running OpenCode turn.
- Turns are guarded by a random token, so a late Stop from an older turn cannot
  interrupt a newer one.
- Requests are checked for a known Origin and a JSON content type; the browser
  never talks to OpenCode directly.

## Security notes

- The app trusts `localhost` only by default. To use another origin (phone,
  LAN), add it to `ALLOWED_ORIGINS` in `.env.local`, comma-separated.
- Binding the OpenCode server to anything other than `127.0.0.1` is not
  recommended; the Next app exists to keep its password server-side.

## Tuning the model

Latency is ~90% model time. To re-measure candidates on your machine:

```bash
node scripts/bench.mjs
node scripts/bench.mjs opencode/big-pickle openai/gpt-6.1-sol-ultrafast
```

Each model runs twice (cold session, warm session) and reports time to first
text. Put the winner in `OPENCODE_MODEL`, then restart **`npm run dev`** — the
Next app reads the env, not the OpenCode server.

Measured on this laptop (single short prompt, same evening):

| Model | First text (cold / warm) |
|---|---:|
| `opencode/deepseek-v4.1-flash-free` | 2.05 s / 2.62 s |
| `opencode/big-pickle` | 5.75 s / 5.43 s |
| `opencode/nemotron-3.5-lightning-free` | 7.33 s / 4.29 s |
| `opencode/glm-5.3-flash-free` | 13.2 s / 6.66 s |

Free-tier latency moves around during the day, so re-run the benchmark if a
turn feels slow.

## Limitations

- Speech recognition is Chrome's built-in service; it needs a network connection and is not available in every browser.
- `localhost` is a secure context, so the mic works there. Opening this from a phone over LAN needs HTTPS first.
- One turn at a time by design. The mic stays available for barge-in, but a new spoken turn waits until the old one is stopped.
- The OpenCode session is kept in the Next.js process, so restarting the app starts a fresh conversation.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red notice: cannot reach OpenCode | Start `npm run opencode` in another terminal |
| Mic does nothing | Allow microphone access in Chrome's address-bar icon |
| "network" speech error | Chrome's speech service is blocked or unreachable. Try Microsoft Edge, turn off the VPN, or type below. |
| No sound | Check the Windows volume mixer for Chrome |
| Wrong voice | Chrome uses Windows system voices; install more in Windows Settings → Time & Language → Speech |
| Voice sounds male | No female voice for that language is installed. Add one in Windows Settings → Speech, or switch the language selector to English (US) |
