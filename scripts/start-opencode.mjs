#!/usr/bin/env node
/**
 * Starts a dedicated OpenCode server for the voice app.
 * Reads connection details from .env.local so the password is never
 * typed in a shell or committed anywhere.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
const env = {};

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const url = env.OPENCODE_URL || "http://127.0.0.1:4096";
let host = "127.0.0.1";
let port = "4096";
try {
  const parsed = new URL(url);
  host = parsed.hostname;
  port = parsed.port || "4096";
} catch {
  /* keep defaults */
}

const password = env.OPENCODE_PASSWORD || randomBytes(24).toString("hex");

console.log(`\n  OpenCode voice server`);
console.log(`  URL:  http://${host}:${port}`);
console.log(`  Auth: configured from .env.local`);
console.log(`  Stop: Ctrl+C\n`);

const child = spawn(
  "opencode",
  ["serve", "--hostname", host, "--port", port],
  {
    stdio: "inherit",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  },
);

child.on("error", (error) => {
  console.error(`\n  Could not start OpenCode: ${error.message}`);
  console.error(`  Is "opencode" on PATH?\n`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 0));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
