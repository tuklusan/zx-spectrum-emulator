import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { detokenizeBasicProgram } from "../public/basic.js";
import { unwrapSpectrumMedia } from "../public/media.js";
import { parseTapeFile } from "../public/tape.js";
import { worldOfSpectrumCompatibilityUrl } from "../public/tape-url.js";

const ROOT = resolve("dist");
const OUTPUT = resolve("browser-regression-artifacts");
const PORT = Number(process.env.BROWSER_REGRESSION_PORT ?? 4173);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}/`;

const fixtures = [
  {
    name: "carrom",
    url: "https://raw.githubusercontent.com/tuklusan/ZX-Carrom/main/dist/zxcarrom.tzx",
    budgetMs: 12_000
  },
  {
    name: "dreamwalker",
    sourceUrl: "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip",
    browserPath: "/__fixtures/DreamWalker(48K).tzx.zip",
    budgetMs: 12_000
  }
];

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 }
];

const mediaSwitchTargets = [
  {
    name: "dreamwalker",
    url: "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip",
    labelNeedle: "DreamWalker(48K).tzx.zip"
  },
  {
    name: "hate",
    url: "https://www.worldofspectrum.org//pub/sinclair/games/h/H.A.T.E..tzx.zip",
    labelNeedle: "H.A.T.E..tzx.zip",
    screenProof: "hate-title"
  }
];

const fixtureBodies = new Map();

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
    if (requestUrl.pathname === "/__media-switch") {
      const targetName = requestUrl.searchParams.get("target") || "dreamwalker";
      const target = mediaSwitchTargets.find((candidate) => candidate.name === targetName);
      if (!target) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Unknown media switch target");
        return;
      }
      const body = mediaSwitchHarness(target);
      response.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": "text/html; charset=utf-8"
      });
      response.end(body);
      return;
    }
    const fixture = fixtureBodies.get(requestUrl.pathname);
    if (fixture) {
      response.writeHead(200, {
        "content-length": fixture.length,
        "content-type": "application/zip"
      });
      response.end(fixture);
      return;
    }
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

function runChrome(chrome, args, timeoutMs = 45_000) {
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

function directLaunchUrl(fixture) {
  const tapeUrl = fixture.browserPath
    ? new URL(fixture.browserPath, BASE).href
    : fixture.url;
  const url = new URL(BASE);
  url.searchParams.set("tape", tapeUrl);
  url.searchParams.set("autoload", "1");
  return url.href;
}

function mediaSwitchHarness(target) {
  const carrom = fixtures.find((fixture) => fixture.name === "carrom");
  const initialUrl = directLaunchUrl(carrom);
  return `<!doctype html>
<meta charset="utf-8">
<title>Media switch regression</title>
<output id="result">Waiting for ZX Carrom</output>
<iframe id="emulator" style="width:100%;height:900px;border:0"></iframe>
<script>
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = document.querySelector("#result");
const frame = document.querySelector("#emulator");
const targetUrl = ${JSON.stringify(target.url)};
const targetLabel = ${JSON.stringify(target.labelNeedle)};
const targetName = ${JSON.stringify(target.name)};
const screenProof = ${JSON.stringify(target.screenProof ?? null)};
const initialUrl = ${JSON.stringify(initialUrl)};
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for " + label);
}
function hateTitleVisible(doc) {
  const canvas = doc.querySelector("#screen");
  const context = canvas?.getContext("2d");
  if (!context) return false;
  const data = context.getImageData(32, 24, 256, 192).data;
  let black = 0;
  let yellow = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    if (r < 24 && g < 24 && b < 24) black += 1;
    if (r > 180 && g > 180 && b < 96) yellow += 1;
  }
  return black > 40_000 && yellow > 80;
}
frame.addEventListener("load", async () => {
  try {
    const doc = frame.contentDocument;
    await waitFor(
      () => doc.querySelector("#status")?.value === 'Autoload started with LOAD ""',
      20_000,
      "ZX Carrom autoload"
    );
    const input = doc.querySelector("#mediaUrl");
    frame.contentWindow.scrollTo(0, doc.documentElement.scrollHeight);
    if (frame.contentWindow.scrollY === 0) throw new Error("Could not move viewport before URL switch test");
    input.value = targetUrl;
    const loadButton = doc.querySelector("#mediaUrlLoad");
    loadButton.click();
    const mediaStatusAtStart = doc.querySelector("#mediaStatus");
    if (!loadButton.disabled) throw new Error("Load URL button did not disable while fetching");
    if (!/^Please wait…/i.test(mediaStatusAtStart?.textContent ?? "")) {
      throw new Error("Please wait message was not shown while fetching");
    }
    let headerPolluted = false;
    await waitFor(
      () => {
        const status = doc.querySelector("#status")?.value ?? "";
        const mediaStatus = doc.querySelector("#mediaStatus");
        if (/CORS bridge/i.test(status)) headerPolluted = true;
        if (!mediaStatus.hidden && mediaStatus.dataset.state === "error") {
          throw new Error(targetName + " media error: " + mediaStatus.textContent);
        }
        return (doc.querySelector("#mediaFileLabel")?.textContent ?? "").includes(targetLabel)
          && status === 'Autoload started with LOAD ""';
      },
      55_000,
      targetName + " URL switch"
    );
    const mediaStatus = doc.querySelector("#mediaStatus");
    if (!mediaStatus.hidden) throw new Error("media status was not cleared after a successful switch");
    if (frame.contentWindow.scrollY !== 0) throw new Error("viewport did not return to the top after a successful URL load");
    if (screenProof === "hate-title") {
      await waitFor(
        () => hateTitleVisible(doc),
        45_000,
        "H.A.T.E. title screen"
      );
    }
    if (headerPolluted) throw new Error("CORS progress leaked into the Spectrum screen header");
    result.dataset.state = "pass";
    result.textContent = "PASS: ZX Carrom switched to " + targetName + " from the real public URL";
  } catch (error) {
    const doc = frame.contentDocument;
    const status = doc?.querySelector("#status")?.value ?? "(no Spectrum status)";
    const mediaStatus = doc?.querySelector("#mediaStatus")?.textContent ?? "(no media status)";
    const mediaLabel = doc?.querySelector("#mediaFileLabel")?.textContent ?? "(no media label)";
    const pc = doc?.querySelector("#pc")?.textContent ?? "(no PC)";
    const frameCount = doc?.querySelector("#frame")?.textContent ?? "(no frame)";
    const border = doc?.querySelector("#border")?.textContent ?? "(no border)";
    result.dataset.state = "fail";
    result.textContent = "FAIL: " + error.message
      + " | Spectrum: " + status
      + " | Media: " + mediaStatus
      + " | Label: " + mediaLabel
      + " | PC: " + pc
      + " | Frame: " + frameCount
      + " | Border: " + border;
  }
}, { once: true });
frame.src = initialUrl;
<\/script>`;
}

function assertHealthyDom(html, label) {
  if (!html.includes('id="screen"')) throw new Error(`${label}: Spectrum canvas is missing`);
  const status = html.match(/<output[^>]*id="status"[^>]*>([^<]*)<\/output>/i)?.[1]?.trim() ?? "";
  const mediaStatusTag = html.match(/<output[^>]*id="mediaStatus"[^>]*>/i)?.[0] ?? "";
  const mediaStatus = html.match(/<output[^>]*id="mediaStatus"[^>]*>([^<]*)<\/output>/i)?.[1]?.trim() ?? "";
  if (status !== 'Autoload started with LOAD ""'
      || (/fail|error|unsupported/i.test(mediaStatus) && !/hidden(?:=""|\s|>)/i.test(mediaStatusTag))) {
    throw new Error(`${label}: browser tape did not reach autoload: ${status || mediaStatus || "(no status)"}`);
  }
  const gate = html.match(/<button[^>]*id="audioStartGate"[^>]*>/i)?.[0] ?? "";
  if (gate && !/hidden(?:=""|\s|>)/i.test(gate)) {
    throw new Error(`${label}: audio gate was still blocking direct autoload`);
  }
}

await mkdir(OUTPUT, { recursive: true });
for (const fixture of fixtures) {
  if (!fixture.browserPath) continue;
  const mirrors = [
    fixture.sourceUrl,
    fixture.sourceUrl.replace(
      "https://spectrumcomputing.co.uk/zxdb/",
      "https://zxinfo.dk/media/zxdb/"
    )
  ];
  let bytes = null;
  let lastError = null;
  for (const sourceUrl of mirrors) {
    try {
      const response = await fetch(sourceUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const candidate = new Uint8Array(await response.arrayBuffer());
      if (candidate.length < 1_000) throw new Error("download is unexpectedly small");
      bytes = candidate;
      console.log(`Fetched ${fixture.name} fixture from ${sourceUrl}: ${bytes.length} bytes`);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!bytes) throw new Error(`${fixture.name}: fixture fetch failed: ${lastError?.message ?? "unknown error"}`);
  fixtureBodies.set(fixture.browserPath, bytes);
}
const hateTarget = mediaSwitchTargets.find((target) => target.name === "hate");
{
  const hateProbeUrl = worldOfSpectrumCompatibilityUrl(hateTarget.url) || hateTarget.url;
  const relay = new URL("https://zx-spectrum-emulator.vagabondcouple.workers.dev/media");
  relay.searchParams.set("url", hateProbeUrl);
  const response = await fetch(relay, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("H.A.T.E. tape probe failed: HTTP " + response.status);
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const media = await unwrapSpectrumMedia(archiveBytes, hateProbeUrl);
  const blocks = parseTapeFile(media.bytes);
  const summary = blocks.slice(0, 40).map((block, index) => {
    const bits = [index + ":" + block.type];
    if (block.flag !== null && block.flag !== undefined) bits.push("flag=" + block.flag);
    if (block.payload) bits.push("payload=" + block.payload.length);
    if (block.checksumValid !== undefined) bits.push("checksum=" + block.checksumValid);
    if (block.header) {
      bits.push("headerType=" + block.header.type);
      bits.push("headerName=" + JSON.stringify(block.header.name));
      bits.push("headerLength=" + block.header.length);
      bits.push("param1=" + block.header.param1);
      bits.push("param2=" + block.header.param2);
    }
    if (block.signal?.kind) bits.push("signal=" + block.signal.kind);
    if (block.generalized) bits.push("generalized");
    if (block.pauseMs) bits.push("pause=" + block.pauseMs);
    if (block.stopTape) bits.push("stop");
    return bits.join("/");
  }).join(", ");
  console.log("H.A.T.E. tape probe: " + media.name + " | " + blocks.length + " blocks | " + summary);
  if (blocks[0]?.header?.type === 0 && blocks[1]?.payload) {
    console.log("H.A.T.E. BASIC loader: " + JSON.stringify(detokenizeBasicProgram(blocks[1].payload)));
  }
  if (blocks[5]?.payload) {
    console.log("H.A.T.E. 50-byte loader: " + Array.from(blocks[5].payload, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }
}
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
      const url = directLaunchUrl(fixture);
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
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }

  const carrom = fixtures.find((fixture) => fixture.name === "carrom");
  const socialProfile = await mkdtemp(join(tmpdir(), "zx-browser-social-"));
  const socialScreenshot = resolve("dist/public/assets/zx-spectrum-emulator-social.png");
  console.log("Browser regression: social-preview");
  try {
    await runChrome(chrome, [
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
      `--user-data-dir=${socialProfile}`,
      "--window-size=1200,630",
      `--virtual-time-budget=${carrom.budgetMs}`,
      `--screenshot=${socialScreenshot}`,
      directLaunchUrl(carrom)
    ]);
    if (!existsSync(socialScreenshot) || statSync(socialScreenshot).size < 10_000) {
      throw new Error("social preview screenshot was not created correctly");
    }
  } finally {
    await rm(socialProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  for (const target of mediaSwitchTargets) {
    const profile = await mkdtemp(join(tmpdir(), "zx-browser-switch-"));
    const screenshot = join(OUTPUT, `media-switch-${target.name}-desktop.png`);
    const domPath = join(OUTPUT, `media-switch-${target.name}-desktop.html`);
    console.log(`Browser regression: media-switch-${target.name}-desktop`);
    try {
      const switchUrl = new URL("/__media-switch", BASE);
      switchUrl.searchParams.set("target", target.name);
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
        "--window-size=1440,1000",
        "--virtual-time-budget=75000",
        `--screenshot=${screenshot}`,
        "--dump-dom",
        switchUrl.href
      ], 105_000);
      await writeFile(domPath, stdout);
      if (!/id="result"[^>]*data-state="pass"/i.test(stdout)) {
        const result = stdout.match(/<output[^>]*id="result"[^>]*>([^<]*)<\/output>/i)?.[1] ?? "switch result missing";
        throw new Error(`${target.name} media switch regression failed: ${result}`);
      }
      if (!existsSync(screenshot) || statSync(screenshot).size < 10_000) {
        throw new Error(`${target.name} media switch screenshot was not created correctly`);
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("Headless Chrome regression screenshots captured.");
