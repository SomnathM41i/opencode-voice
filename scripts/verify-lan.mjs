/**
 * Checks the LAN gateway's request handling against a fake app.
 * Run: node scripts/verify-lan.mjs
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { createGateway, isPrivatePeer } from "./lan.mjs";

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

const HOST = "10.90.249.230:3443";
const seen = [];
let upstreamClosed = false;

const app = createServer((req, res) => {
  seen.push(req);
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "http://localhost:3000/next" });
    return res.end();
  }
  if (req.url === "/stream") {
    res.writeHead(200);
    res.write("first\n");
    res.on("close", () => {
      upstreamClosed = true;
    });
    return;
  }
  res.end(`app ${req.url}`);
});
app.on("upgrade", (req, socket) => {
  seen.push(req);
  socket.end("HTTP/1.1 101 Switching Protocols\r\nX-Upgraded: yes\r\n\r\n");
});
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));

const gateway = createGateway({
  upstreamPort: app.address().port,
  password: "correct horse",
  caPath: new URL("./verify-lan.mjs", import.meta.url),
  allowedHosts: () => new Set(["10.90.249.230"]),
  isTrustedPeer: (address) => address !== "127.0.0.2",
});
const server = createServer(gateway.onRequest);
server.on("upgrade", gateway.onUpgrade);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function call(path, { method = "GET", headers = {}, body, host = HOST, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1", localAddress }, () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, ...rest] = raw.split("\r\n\r\n");
      resolve({
        status: Number(head.split(" ")[1]),
        head,
        body: rest.join("\r\n\r\n"),
      });
    });
  });
}

const form = { "Content-Type": "application/x-www-form-urlencoded", Origin: `https://${HOST}` };

async function login(password, headers = form) {
  return call("/__login", {
    method: "POST",
    headers,
    body: `password=${encodeURIComponent(password)}`,
  });
}

console.log("\nlogin");
{
  const home = await call("/");
  check("a page redirects to login", home.status === 302 && home.head.includes("Location: /__login"), home.head);
  const api = await call("/api/status");
  check("an API call is refused, not redirected", api.status === 401, String(api.status));
  check("nothing reached the app", seen.length === 0, String(seen.length));

  const page = await call("/__login");
  check("the login page is served", page.status === 200 && page.body.includes("password"), String(page.status));

  const wrong = await login("wrong");
  check("a wrong password is refused", wrong.status === 401 && !/set-cookie/i.test(wrong.head), wrong.head);
}

let cookie;
{
  const good = await login("correct horse");
  check("the right password signs in", good.status === 303, good.head);
  const header = good.head.split("\r\n").find((line) => /^set-cookie/i.test(line)) ?? "";
  check("the cookie is locked down", /HttpOnly/.test(header) && /Secure/.test(header) && /SameSite=Lax/.test(header), header);
  cookie = header.replace(/^set-cookie:\s*/i, "").split(";")[0];

  const home = await call("/", { headers: { Cookie: cookie } });
  check("a signed-in page reaches the app", home.status === 200 && home.body === "app /", home.body);

  const forged = await call("/", { headers: { Cookie: `${cookie.split("=")[0]}=9999999999.deadbeef` } });
  check("a forged cookie is refused", forged.status === 302, String(forged.status));

  const other = createGateway({
    upstreamPort: app.address().port,
    password: "changed",
    caPath: new URL("./verify-lan.mjs", import.meta.url),
    allowedHosts: () => new Set(["10.90.249.230"]),
    isTrustedPeer: () => true,
  });
  check("changing the password ends old sessions", !other.isSignedIn(cookie), cookie);
}

console.log("\nwhat the app sees");
{
  seen.length = 0;
  await call("/api/chat", {
    method: "POST",
    headers: { Cookie: `theme=dark; ${cookie}`, Origin: `https://${HOST}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const req = seen[0];
  check("host is rewritten to localhost", req?.headers.host === "localhost:3000", req?.headers.host);
  check("origin is rewritten to localhost", req?.headers.origin === "http://localhost:3000", req?.headers.origin);
  check("the session cookie stays at the gateway", req?.headers.cookie === "theme=dark", req?.headers.cookie);

  const redirect = await call("/redirect", { headers: { Cookie: cookie } });
  check("redirects stay on the gateway", /location: \/next/i.test(redirect.head), redirect.head);

  const spoofed = await call("/", { headers: { Cookie: cookie, "X-Forwarded-Host": "evil.example" } });
  check("forwarding headers are dropped", spoofed.status === 200 && !seen.at(-1).headers["x-forwarded-host"]);
}

console.log("\nrequest checks");
{
  const rebind = await call("/", { host: "evil.example:3443", headers: { Cookie: cookie } });
  check("an unknown host is refused", rebind.status === 421, String(rebind.status));

  const crossSite = await call("/api/stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://evil.example" },
  });
  check("a cross-site POST is refused", crossSite.status === 403, String(crossSite.status));

  const noOrigin = await call("/api/stop", { method: "POST", headers: { Cookie: cookie } });
  check("a POST with no origin is refused", noOrigin.status === 403, String(noOrigin.status));

  check("hotspot peers are private", isPrivatePeer("10.90.249.5") && isPrivatePeer("::ffff:192.168.1.9"));
  check("public peers are not", !isPrivatePeer("8.8.8.8") && !isPrivatePeer("::ffff:172.32.0.1"));

  const outsider = await call("/", { headers: { Cookie: cookie }, localAddress: "127.0.0.2" });
  check("a peer outside the network is refused", outsider.status === 403, String(outsider.status));

  const ca = await call("/ca.crt");
  check("the CA certificate is public", ca.status === 200, String(ca.status));
  const manifest = await call("/manifest.webmanifest");
  check("the app manifest needs no login", manifest.status === 200, String(manifest.status));
}

console.log("\nstreaming");
{
  seen.length = 0;
  upstreamClosed = false;
  await new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`GET /stream HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${cookie}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      check("output arrives before the response ends", chunk.toString().includes("first"), chunk.toString());
      socket.destroy();
      setTimeout(resolve, 150);
    });
  });
  check("a closed client closes the app stream", upstreamClosed);

  const upgrade = await new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET /_next/hmr HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: https://${HOST}\r\n\r\n`,
      );
    });
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("close", () => resolve(raw));
  });
  check("websockets reach the app", upgrade.includes("X-Upgraded: yes"), upgrade);

  const anonymous = await new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`GET /_next/hmr HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("close", () => resolve(raw));
  });
  check("websockets need a login", anonymous.startsWith("HTTP/1.1 401"), anonymous);
}

console.log("\nbrute force");
{
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push((await login("guess")).status);
  check("repeated guesses get locked out", results.at(-1) === 429, results.join(","));
  const right = await login("correct horse");
  check("the lockout also blocks the right password", right.status === 429, String(right.status));
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
