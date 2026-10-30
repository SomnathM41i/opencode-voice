/**
 * Checks the speech chunker against the cases that actually break TTS:
 * markdown, code fences split across chunks, dashes, run-on text.
 * Run: node scripts/verify-speech.mjs
 */
import { sanitizeForSpeech, takeSpeakable } from "../src/lib/speech.ts";

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Feeds text in small chunks, exactly like the streaming route does. */
function run(text, chunkSize = 7, flush = true) {
  let rest = "";
  const segments = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const out = takeSpeakable(rest + text.slice(i, i + chunkSize), false);
    rest = out.rest;
    segments.push(...out.segments);
  }
  if (flush) {
    const last = takeSpeakable(rest, true);
    segments.push(...last.segments);
    rest = last.rest;
  }
  return { segments, rest };
}

function joined(segments) {
  return segments.join(" ").replace(/\s+/g, " ").trim();
}

console.log("\nsentences");
{
  const { segments } = run("Hello there. How are you today?");
  check("splits two sentences", segments.length === 2, JSON.stringify(segments));
  check("keeps both sentences", joined(segments) === "Hello there. How are you today?", joined(segments));
  check("no empty segments", segments.every((s) => s.trim().length > 0));
}

console.log("\ndashes and clauses");
{
  const { segments } = run("Hello, Emperor — Ravonna here, ready when you are.");
  check("dash is not a chunk boundary", segments.length === 1, JSON.stringify(segments));
  check(
    "dash becomes a short pause",
    segments[0] === "Hello, Emperor, Ravonna here, ready when you are.",
    JSON.stringify(segments),
  );
}
{
  const source =
    "First, check the logs — then restart the app. Second, verify the fix, and only then close the ticket.";
  const { segments } = run(source);
  check("commas and dashes stay inside sentences", segments.length === 2, JSON.stringify(segments));
  check("all words survive", joined(segments).includes("verify the fix"), joined(segments));
}
{
  const runOn = `This clause keeps going ${"and going ".repeat(30)}without a full stop`;
  const { segments } = run(runOn);
  check("very long run-on is cut eventually", segments.length >= 2, `${segments.length} segments`);
  check(
    "run-on words are preserved",
    joined(segments).split(" ").filter(Boolean).length === runOn.split(" ").filter(Boolean).length,
    joined(segments),
  );
}
{
  check("dash starts a list item cleanly", sanitizeForSpeech("— first item") === "first item");
  check("space before comma is removed", sanitizeForSpeech("one , two") === "one, two");
  check("dash never reads as a word", sanitizeForSpeech("Wait — really?") === "Wait, really?");
  check("trailing dash is dropped", sanitizeForSpeech("Hello —") === "Hello");
}

console.log("\ncode and markdown");
{
  const { segments } = run("```js\nconst secret = 42;\nconsole.log(secret);\n```\nDone talking.");
  const text = joined(segments);
  check("code is not spoken", !text.includes("secret") && !text.includes("console"), text);
  check("text after code is spoken", text.includes("Done talking"), text);
}
{
  const { segments } = run("```python\nprint('x')\nprint('y')\nprint('z')\n```");
  check("unclosed code block stays silent", joined(segments) === "", joined(segments));
}
{
  const { segments } = run("**Bold** and `inline code` and [a link](https://example.com) and 2 * 3.");
  const text = joined(segments);
  check("markdown symbols removed", !/[*`\[\]()]|https?:/.test(text), text);
  check("words survive", text.includes("Bold") && text.includes("inline code"), text);
}
{
  check("fence-only text is empty", sanitizeForSpeech("```js\nlet x = 1;\n```") === "");
  check("emoji-only is empty", sanitizeForSpeech("🙂 🙂 🙂") === "");
}

console.log("\nstreaming integrity");
{
  const source =
    "The deploy failed because the token expired. Rotate it, then run the pipeline again. I can do that now.";
  const { segments } = run(source, 3);
  const text = joined(segments);
  check("no duplicated words", text === source, text);
  check("no text lost", text.length === source.length, `${text.length} vs ${source.length}`);
}
{
  const devanagari = "नमस्ते Emperor, how are you?";
  const { segments } = run(devanagari, 2);
  check("devanagari kept", joined(segments).includes("नमस्ते"), joined(segments));
}
{
  const big = "word ".repeat(200);
  const { segments } = run(big, 25);
  check("very long input is fully chunked", segments.length > 1 && joined(segments).split(" ").filter(Boolean).length >= 200, `${segments.length} segments`);
}

console.log("\nnumber handling");
{
  const { segments } = run("Version 2.5 is out. Upgrade to 3.1 today.");
  const text = joined(segments);
  check("decimals are not split", text.includes("2.5") && text.includes("3.1"), text);
}
{
  const source = "See example.com for details. Done.";
  const { segments } = run(source, 7);
  const text = joined(segments);
  check("domain is not split at the dot", text === source, text);
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
