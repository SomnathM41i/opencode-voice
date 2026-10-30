#!/usr/bin/env node
/**
 * HTTPS gateway for using the app from a phone on the local network.
 * Run on Windows, not in WSL: only Windows can be reached from the network.
 *
 *   phone → https://<laptop>:3443 (this file) → http://localhost:3000 (Next)
 *
 * Next and OpenCode stay on 127.0.0.1 and never see the network. This process
 * owns everything the network adds: TLS, the login, and who may connect. To the
 * app, a request looks like it came from localhost, which it did.
 */
import { spawnSync } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAN_DIR = path.join(ROOT, ".lan");
const ENV_PATH = path.join(ROOT, ".env.local");

const LISTEN_PORT = 3443;
const UPSTREAM_PORT = 3000;
const UPSTREAM_ORIGIN = `http://localhost:${UPSTREAM_PORT}`;
const ADDRESS_CHECK_MS = 30_000;

const COOKIE = "ocv_lan";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

/** Needed before signing in, so the phone can trust and install the app. */
const PUBLIC_PATHS = [/^\/manifest\.webmanifest$/, /^\/icons\//, /^\/favicon\.ico$/];

const LOGIN_PAGE = (notice = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Voice</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #05080f; color: #e8ecf4; font: 16px system-ui, sans-serif; }
  form { width: min(320px, 86vw); display: grid; gap: 12px; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
  input, button { font: inherit; padding: 14px; border-radius: 12px; border: 1px solid #2a3142; }
  input { background: #0e131d; color: inherit; }
  button { background: #2f62d0; border-color: #2f62d0; color: #fff; font-weight: 600; }
  p { margin: 0; color: #ff9a8b; font-size: 14px; }
</style></head><body>
<form method="post" action="/__login">
  <h1>OpenCode Voice</h1>
  ${notice ? `<p role="alert">${notice}</p>` : ""}
  <input name="password" type="password" placeholder="Password"
    aria-label="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`;

/** The private ranges of RFC 1918, plus loopback for the laptop itself. */
export function isPrivatePeer(address = "") {
  const ip = address.replace(/^::ffff:/, "");
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}

function sha256(text) {
  return createHash("sha256").update(text).digest();
}

/**
 * The request half of the gateway, kept free of TLS so it can be tested.
 * Sessions are signed with the password, so changing it signs everyone out.
 */
export function createGateway({
  upstreamPort = UPSTREAM_PORT,
  password,
  caPath,
  allowedHosts,
  isTrustedPeer = isPrivatePeer,
}) {
  const key = sha256(`ocv-lan-session\0${password}`);
  const failures = new Map();

  const sign = (expires) =>
    createHmac("sha256", key).update(String(expires)).digest("hex");

  const readCookie = (header = "") => {
    const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return match?.[1] ?? "";
  };

  const isSignedIn = (header) => {
    const [expires, signature = ""] = readCookie(header).split(".");
    if (!expires || Number(expires) < Date.now()) return false;
    const expected = Buffer.from(sign(expires));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const hostOf = (req) => (req.headers.host ?? "").replace(/:\d+$/, "");

  /** Returns [status, message] when the connection must not go further. */
  const refusal = (req) => {
    if (!isTrustedPeer(req.socket.remoteAddress)) return [403, "Not on this network."];

    // A DNS-rebinding page arrives with its own hostname here.
    if (!allowedHosts().has(hostOf(req))) return [421, "Unknown host."];

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers.origin !== `https://${req.headers.host}`) {
        return [403, "Origin not allowed."];
      }
    }
    return null;
  };

  const lockedOut = (peer) => {
    const entry = failures.get(peer);
    if (!entry || entry.until < Date.now()) return false;
    return entry.count >= MAX_FAILURES;
  };

  const recordFailure = (peer) => {
    const entry = failures.get(peer);
    const active = entry && entry.until >= Date.now();
    failures.set(peer, {
      count: active ? entry.count + 1 : 1,
      until: Date.now() + LOCKOUT_MS,
    });
  };

  const forwardedHeaders = (req) => {
    const headers = { ...req.headers, host: `localhost:${UPSTREAM_PORT}` };

    // Sent by the client, so meaningless here and unsafe to pass on.
    for (const name of Object.keys(headers)) {
      if (name.startsWith("x-forwarded-") || name === "forwarded") delete headers[name];
    }

    if (headers.origin) headers.origin = UPSTREAM_ORIGIN;
    if (headers.referer) {
      try {
        const { pathname, search } = new URL(headers.referer);
        headers.referer = `${UPSTREAM_ORIGIN}${pathname}${search}`;
      } catch {
        delete headers.referer;
      }
    }

    const rest = (headers.cookie ?? "")
      .split(/;\s*/)
      .filter((part) => part && !part.startsWith(`${COOKIE}=`))
      .join("; ");
    if (rest) headers.cookie = rest;
    else delete headers.cookie;

    return headers;
  };

  const handleLogin = (req, res, peer) => {
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };

    if (req.method === "GET") return send(200, LOGIN_PAGE());

    if (lockedOut(peer)) {
      return send(429, LOGIN_PAGE("Too many tries. Wait a minute."));
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4_096) req.destroy();
    });
    req.on("end", () => {
      const supplied = new URLSearchParams(body).get("password") ?? "";

      if (!timingSafeEqual(sha256(supplied), sha256(password))) {
        recordFailure(peer);
        return send(401, LOGIN_PAGE("Wrong password."));
      }

      failures.delete(peer);
      const expires = Date.now() + SESSION_MS;
      res.writeHead(303, {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${expires}.${sign(expires)}; Max-Age=${SESSION_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
      res.end();
    });
  };

  const onRequest = (req, res) => {
    const refused = refusal(req);
    if (refused) {
      res.writeHead(refused[0], { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(refused[1]);
    }

    const { pathname } = new URL(req.url, "https://gateway");
    const peer = req.socket.remoteAddress;

    if (pathname === "/ca.crt") {
      res.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="opencode-voice-ca.crt"',
      });
      return res.end(readFileSync(caPath));
    }

    if (pathname === "/__login") return handleLogin(req, res, peer);

    if (!isSignedIn(req.headers.cookie) && !PUBLIC_PATHS.some((p) => p.test(pathname))) {
      if (pathname.startsWith("/api/")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Sign in first." }));
      }
      res.writeHead(302, { Location: "/__login" });
      return res.end();
    }

    const upstream = request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req),
      },
      (reply) => {
        const headers = { ...reply.headers };
        if (headers.location?.startsWith(UPSTREAM_ORIGIN)) {
          headers.location = headers.location.slice(UPSTREAM_ORIGIN.length) || "/";
        }
        res.writeHead(reply.statusCode ?? 502, headers);
        reply.pipe(res);
      },
    );

    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("The app is not running on the laptop. Start it with npm run dev.");
    });

    // A dropped phone must end the turn, or the app would keep it running.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
  };

  const onUpgrade = (req, socket, head) => {
    const refused = refusal(req);
    if (refused || !isSignedIn(req.headers.cookie)) {
      const [status, message] = refused ?? [401, "Sign in first."];
      return socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    }

    const upstream = connect(upstreamPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(forwardedHeaders(req))) {
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  };

  return { onRequest, onUpgrade, isSignedIn };
}

/* ---------- running it ---------- */

function readEnv() {
  const env = {};
  if (!existsSync(ENV_PATH)) return env;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function ensurePassword() {
  const existing = readEnv().LAN_PASSWORD;
  if (existing) return existing;

  const password = randomBytes(9).toString("base64url").toLowerCase();
  appendFileSync(ENV_PATH, `\nLAN_PASSWORD=${password}\n`);
  return password;
}

/** The laptop's real network addresses, without WSL's internal adapters. */
function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|Loopback/i.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivatePeer(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found.sort();
}

function certificateAddresses(certPath) {
  if (!existsSync(certPath)) return [];
  const { subjectAltName = "" } = new X509Certificate(readFileSync(certPath));
  return [...subjectAltName.matchAll(/IP Address:([\d.]+)/g)].map((m) => m[1]).sort();
}

function issueCertificate(addresses) {
  const san = addresses.map((address) => `IP:${address}`).join(",");
  const result = spawnSync("wsl.exe", ["-e", "sh", "scripts/lan-cert.sh", san], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not issue the certificate: ${result.stderr || result.error}`);
  }
}

function tlsFiles() {
  return {
    key: readFileSync(path.join(LAN_DIR, "server.key")),
    cert: readFileSync(path.join(LAN_DIR, "server.crt")),
  };
}

function main() {
  if (process.platform !== "win32") {
    console.error("\n  Run this on Windows, not in WSL: npm run lan\n");
    process.exit(1);
  }

  const certPath = path.join(LAN_DIR, "server.crt");
  let addresses = lanAddresses();
  if (addresses.length === 0) {
    console.error("\n  No local network found. Join the hotspot or Wi-Fi first.\n");
    process.exit(1);
  }

  const sameAddresses = (a, b) => a.join() === b.join();
  if (!sameAddresses(addresses, certificateAddresses(certPath))) {
    issueCertificate(addresses);
  }

  const gateway = createGateway({
    password: ensurePassword(),
    caPath: path.join(LAN_DIR, "ca.crt"),
    allowedHosts: () => new Set(addresses),
  });

  const server = createServer(tlsFiles(), gateway.onRequest);
  server.on("upgrade", gateway.onUpgrade);

  // Hotspots hand out a new address now and then. The phone trusts the CA, not
  // this certificate, so reissuing is invisible to it.
  setInterval(() => {
    const current = lanAddresses();
    if (current.length === 0 || sameAddresses(current, addresses)) return;
    try {
      issueCertificate(current);
      server.setSecureContext(tlsFiles());
      addresses = current;
      console.log(`  Address changed: https://${current[0]}:${LISTEN_PORT}`);
    } catch (error) {
      console.error(`  ${error.message}`);
    }
  }, ADDRESS_CHECK_MS).unref();

  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log("\n  OpenCode Voice on the local network");
    for (const address of addresses) {
      console.log(`  Open:     https://${address}:${LISTEN_PORT}`);
    }
    console.log(`  CA cert:  https://${addresses[0]}:${LISTEN_PORT}/ca.crt`);
    console.log("  Password: LAN_PASSWORD in .env.local");
    console.log("  Stop:     Ctrl+C\n");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
