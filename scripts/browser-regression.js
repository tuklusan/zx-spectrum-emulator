import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve("dist");
const OUTPUT = resolve("browser-regression-artifacts");
const PORT = Number(process.env.BROWSER_REGRESSION_PORT ?? 4173);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}/`;

const fixtures = [
  {
    name: "carrom",
    url: "https://raw.githubusercontent.com/tuklusan/ZX-Carrom/main/dist/zxcarrom.tzx",
    budgetMs: 30_000
  },
  {
    name: "dreamwalker",
    url: "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip",
    budgetMs: 30_000
  }
];

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 }
];

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".rom", "application/octet-stream"]
]);

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error("Headless Chrome was not found on this runner");
  return chrome;
}

function staticServer() {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url, BASE);
    const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.replace(/^\/+/, "");
    const path = resolve(ROOT, relative);
    if (!path.startsWith(ROOT)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentTypes.get(extname(path)) ?? "application/octet-stream"
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

function runChrome(chrome, args, timeoutMs = 75_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("Headless Chrome timed out"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(`Headless Chrome exited ${code}: ${stderr.slice(-4000)}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function directLaunchUrl(tapeUrl) {
  const url = new URL(BASE);
  url.searchParams.set("tape", tapeUrl);
  url.searchParams.set("autoload", "1");
  return url.href;
}

function assertHealthyDom(html, label) {
  if (!html.includes('id="screen"')) throw new Error(`${label}: Spectrum canvas is missing`);
  if (/Load failed:|Media fetch failed:|Tape URL contains|Unsupported Spectrum media/i.test(html)) {
    throw new Error(`${label}: browser page reports a media-load failure`);
  }
  const gate = html.match(/<button[^>]*id="audioStartGate"[^>]*>/i)?.[0] ?? "";
  if (gate && !/hidden(?:=""|\s|>)/i.test(gate)) {
    throw new Error(`${label}: audio gate was still blocking direct autoload`);
  }
}

await mkdir(OUTPUT, { recursive: true });
const chrome = findChrome();
const server = staticServer();
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(PORT, HOST, resolveListen);
});

try {
  for (const fixture of fixtures) {
    for (const viewport of viewports) {
      const label = `${fixture.name}-${viewport.name}`;
      const profile = await mkdtemp(join(tmpdir(), "zx-browser-"));
      const screenshot = join(OUTPUT, `${label}.png`);
      const domPath = join(OUTPUT, `${label}.html`);
      const url = directLaunchUrl(fixture.url);
      console.log(`Browser regression: ${label}`);
      try {
        const { stdout } = await runChrome(chrome, [
          "--headless=new",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--run-all-compositor-stages-before-draw",
          "--force-device-scale-factor=1",
          `--user-data-dir=${profile}`,
          `--window-size=${viewport.width},${viewport.height}`,
          `--virtual-time-budget=${fixture.budgetMs}`,
          `--screenshot=${screenshot}`,
          "--dump-dom",
          url
        ]);
        await writeFile(domPath, stdout);
        assertHealthyDom(stdout, label);
        if (!existsSync(screenshot) || statSync(screenshot).size < 10_000) {
          throw new Error(`${label}: screenshot was not created correctly`);
        }
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("Headless Chrome regression screenshots captured.");
