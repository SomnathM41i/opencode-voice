/**
 * Checks the speech chunker against the cases that actually break TTS:
 * markdown, code fences split across chunks, dashes, run-on text.
 * Run: node scripts/verify-speech.mjs
 */
import {
  correctTranscript,
  createRecognition,
  sanitizeForSpeech,
  speakablePart,
  takeSpeakable,
} from "../src/lib/speech.ts";

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

console.log("\nwhat gets spoken");
{
  check("emoji is not announced", sanitizeForSpeech("Hey Sir. 👋") === "Hey Sir.", sanitizeForSpeech("Hey Sir. 👋"));
  check("linked emoji is removed", sanitizeForSpeech("Enjoy ☕ it ❤️") === "Enjoy it", sanitizeForSpeech("Enjoy ☕ it ❤️"));
  check("paths are not read out", sanitizeForSpeech("Saved in /mnt/c/Users/x.md today") === "Saved in today", sanitizeForSpeech("Saved in /mnt/c/Users/x.md today"));
  check("and/or is kept", sanitizeForSpeech("this and/or that") === "this and/or that");
  check("details after a blank line stay silent", speakablePart("It's done.\n\nPID 18680") === "It's done.");
  check("a list stays silent", speakablePart("Three apps:\n- Edge\n- Chrome") === "Three apps:");
  check("a table stays silent", speakablePart("Here you go:\n| a | b |") === "Here you go:");
  check("a numbered list stays silent", speakablePart("Steps:\n1. Open") === "Steps:");
  check("a plain answer is spoken whole", speakablePart("It's 6:37 PM.") === "It's 6:37 PM.");
  check("a line starting with a number is kept", speakablePart("Sure.\n2 windows are open.").includes("2 windows"));
  check(
    "corrections leave ordinary words alone",
    correctTranscript("the cloud is dark, open brave") === "the cloud is dark, open brave",
  );
  check("foreground is restored", correctTranscript("what is on 4 ground") === "what is on foreground");
  const { segments } = takeSpeakable("हो गया। अब देखो।", true);
  check("hindi sentence ends split", segments.length === 2, JSON.stringify(segments));
}

console.log("\nend of speech");
{
  class FakeRecognition {
    start() {}
    stop() {
      this.onend();
    }
    abort() {
      this.onend();
    }
  }
  globalThis.window = { webkitSpeechRecognition: FakeRecognition };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });

  function listen() {
    const sent = [];
    const recognition = createRecognition({
      lang: "en-IN",
      onInterim: () => {},
      onFinal: (text) => sent.push(text),
      onError: () => {},
      onEnd: () => {},
    });
    return { sent, recognition };
  }

  let live;
  globalThis.window.webkitSpeechRecognition = class extends FakeRecognition {
    constructor() {
      super();
      live = this;
    }
  };

  {
    const { sent } = listen();
    live.onresult({ resultIndex: 0, results: [result("turn off the", true)] });
    await sleep(1_000);
    live.onresult({ resultIndex: 1, results: [result("turn off the", true), result("kitchen light", true)] });
    await sleep(1_000);
    check("a short pause does not split the turn", sent.length === 0, JSON.stringify(sent));
    await sleep(1_100);
    check("silence sends the whole turn once", sent.length === 1 && sent[0] === "turn off the kitchen light", JSON.stringify(sent));
    live.onend();
    check("the end event does not send it twice", sent.length === 1, JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({ resultIndex: 0, results: [result("send this", false)] });
    recognition.stop();
    check("tap to send keeps unconfirmed words", sent[0] === "send this", JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({ resultIndex: 0, results: [result("never mind", false)] });
    recognition.abort();
    await sleep(2_400);
    check("abort discards what was heard", sent.length === 0, JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    recognition.stop();
    check("silence sends nothing", sent.length === 0, JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({ resultIndex: 0, results: [result("so I want you to", true)] });
    await sleep(2_400);
    check("an unfinished sentence waits longer", sent.length === 0, JSON.stringify(sent));
    recognition.abort();
  }
  {
    const { sent, recognition } = listen();
    live.onresult({ resultIndex: 0, results: [result("open the cloud extension", true)] });
    recognition.stop();
    check("known mishearings are corrected before sending", sent[0] === "open the Claude extension", JSON.stringify(sent));
  }

  // Android re-reports the sentence as a new result each time it grows.
  const growing = (sentence, finalFrom = 0) => {
    const words = sentence.split(" ");
    const results = [];
    words.forEach((_, i) => {
      const text = words.slice(0, i + 1).join(" ");
      results.push(result(text, i >= finalFrom));
      if (i % 3 === 0) results.push(result(text, i >= finalFrom));
      live.onresult({ resultIndex: results.length - 1, results: [...results] });
    });
  };

  {
    const { sent, recognition } = listen();
    const sentence = "okay so tell me can you have access of all the sessions";
    growing(sentence);
    recognition.stop();
    check("growing results are not repeated", sent[0] === sentence, JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    growing("hello are you able to listen me", 3);
    recognition.stop();
    check("mixed interim results are not repeated", sent[0] === "hello are you able to listen me", JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({
      resultIndex: 0,
      results: [result("are you able to listen", true), result("are you able to listen me", true), result("are you", true)],
    });
    recognition.stop();
    check("a shorter revision is ignored", sent[0] === "are you able to listen me", JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({
      resultIndex: 0,
      results: [result("are you able to listen", true), result("are you abel to listen me", true)],
    });
    recognition.stop();
    check("a corrected word replaces the old line", sent[0] === "are you abel to listen me", JSON.stringify(sent));
  }
  {
    const { sent, recognition } = listen();
    live.onresult({
      resultIndex: 0,
      results: [result("turn off the light", true), result("and lock the door", true)],
    });
    recognition.stop();
    check("separate sentences are both kept", sent[0] === "turn off the light and lock the door", JSON.stringify(sent));
  }
  {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile" },
      configurable: true,
    });
    const { sent } = listen();
    check("android uses single-shot recognition", live.continuous === false, String(live.continuous));
    live.onresult({ resultIndex: 0, results: [result("still thinking about", false)] });
    await sleep(1_700);
    check("android waits for the browser to end the turn", sent.length === 0, JSON.stringify(sent));
    live.onresult({ resultIndex: 0, results: [result("still thinking about it", true)] });
    live.onend();
    check("android sends when recognition ends", sent[0] === "still thinking about it", JSON.stringify(sent));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
