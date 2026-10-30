# Communication Notes — 30 Oct 2026

Working notes from a review with Emperor on how Ravonna communicates.
Purpose: fix the habits, then measure against them next time.

---

## Problem 1 — I read results aloud instead of answering

**What Emperor said:** the task itself gets done properly, but I narrate the raw
output — file extensions, timestamps, byte sizes, PIDs, `0.0`, process counts —
as if a text-to-speech engine were reading a log. Spoken, that is noise.

**Why it matters:** the answer gets buried. The detail exists to support a
decision; when it is read out unprompted, it costs attention and delivers nothing.

**Agreed fix:**
- Answer first, in plain words.
- Numbers and metadata only when they change the next decision.
- Everything else stays in the file, not in the reply.
- Test: "say the answer, then stop."

---

## Problem 2 — The exported transcript is written like a log, not like reading material

**What Emperor said:** the exported `.md` file is not right either — the same
machine-reading problem, now baked into the document.

**What is wrong with it:**
- Metadata header: session ID, model string, directory path.
- A timestamp on every single block.
- `actions:` lines dumping tool names and raw code next to the conversation.

**Agreed fix:**
- Drop the metadata header, keep one date at the top.
- Drop per-message timestamps.
- Replace tool dumps with one plain line where it actually mattered.
- Keep it as a clean, readable dialogue: Emperor's messages and my replies, in order.

**Status:** not yet rewritten.

---

## Open

- Two more problems were left to be raised — not yet stated.
- Nothing changed yet in behaviour or in the export file; this note is the record.
