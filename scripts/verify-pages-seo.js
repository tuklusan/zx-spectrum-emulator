import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const canonical = "https://tuklusan.github.io/zx-spectrum-emulator/";
const requiredTitle = "ZX Spectrum 48K Online Emulator | JavaScript Web Emulator";
const requiredDescription = "Play ZX Spectrum 48K games and software in your browser. Load TAP/TZX tapes, ZIP files, SNA/Z80 snapshots or URLs with sound and fast tape loading.";
const socialImage = "https://tuklusan.github.io/zx-spectrum-emulator/public/assets/zx-spectrum-emulator-social.png";

function requireText(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`Pages SEO verification failed: ${label}`);
  }
}

function forbidText(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`Pages SEO verification failed: ${label}`);
  }
}

const [indexHtml, spectrumHtml, machinesHtml, sitemap, robots, socialPng] = await Promise.all([
  readFile("dist/index.html", "utf8"),
  readFile("dist/spectrum.html", "utf8"),
  readFile("dist/machines.html", "utf8"),
  readFile("dist/sitemap.xml", "utf8"),
  readFile("dist/robots.txt", "utf8"),
  readFile("dist/public/assets/zx-spectrum-emulator-social.png")
]);

for (const [name, html] of [["index.html", indexHtml], ["spectrum.html", spectrumHtml]]) {
  requireText(html, `<title>${requiredTitle}</title>`, `${name} title`);
  requireText(html, `<meta name="description" content="${requiredDescription}">`, `${name} description`);
  requireText(html, '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">', `${name} robots`);
  requireText(html, `<link rel="canonical" href="${canonical}">`, `${name} canonical`);
  requireText(html, "<h1>ZX Spectrum 48K Online Emulator</h1>", `${name} H1`);
  requireText(html, "<!-- Open Graph: Facebook, LinkedIn, Discord and other link previews -->", `${name} Open Graph section`);
  requireText(html, '<meta property="og:title" content="ZX Spectrum 48K Online Emulator">', `${name} Open Graph title`);
  requireText(html, `<meta property="og:image" content="${socialImage}">`, `${name} Open Graph image`);
  requireText(html, '<meta property="og:image:width" content="1200">', `${name} Open Graph width`);
  requireText(html, '<meta property="og:image:height" content="630">', `${name} Open Graph height`);
  requireText(html, "<!-- X / Twitter -->", `${name} X/Twitter section`);
  requireText(html, '<meta name="twitter:card" content="summary_large_image">', `${name} large X/Twitter card`);
  requireText(html, `<meta name="twitter:image" content="${socialImage}">`, `${name} X/Twitter image`);
  requireText(html, '"@type": "WebApplication"', `${name} structured app data`);
  requireText(html, '"isAccessibleForFree": true', `${name} free structured app data`);
  const body = html.slice(html.indexOf("<body"));
  forbidText(body, "zx-spectrum-emulator-social.png", `${name} social screenshot must stay out of the visible page`);
  requireText(html, "JavaScript web emulator", `${name} JavaScript/browser copy`);
  requireText(html, "timed TZX", `${name} TZX accuracy qualifier`);
  requireText(html, "SNA and Z80 snapshot support", `${name} snapshot copy`);
  requireText(html, "Browser Z80 debugger", `${name} debugger copy`);
  requireText(html, 'href="./machines.html">Machines</a>', `${name} Machines navigation`);
  forbidText(html, 'name="keywords"', `${name} must not use obsolete meta keywords`);
}

if (indexHtml !== spectrumHtml) {
  throw new Error("Pages SEO verification failed: index.html and spectrum.html diverged");
}

requireText(
  machinesHtml,
  'class="machine-link spectrum-link" href="./"',
  "machines.html must link to the canonical Spectrum root"
);
requireText(
  machinesHtml,
  '<link rel="canonical" href="https://tuklusan.github.io/zx-spectrum-emulator/machines.html">',
  "machines.html canonical"
);
requireText(sitemap, `<loc>${canonical}</loc>`, "sitemap canonical root");
requireText(robots, "User-agent: *", "robots user agent");
requireText(robots, "Allow: /", "robots allow");
requireText(robots, "Sitemap: https://tuklusan.github.io/zx-spectrum-emulator/sitemap.xml", "robots sitemap");

if (socialPng.length < 10_000) {
  throw new Error("Pages SEO verification failed: social screenshot is unexpectedly small");
}
const pngSignature = socialPng.subarray(0, 8).toString("hex");
if (pngSignature !== "89504e470d0a1a0a") {
  throw new Error("Pages SEO verification failed: social screenshot is not a PNG");
}
const socialWidth = socialPng.readUInt32BE(16);
const socialHeight = socialPng.readUInt32BE(20);
if (socialWidth !== 1200 || socialHeight !== 630) {
  throw new Error(`Pages SEO verification failed: social screenshot is ${socialWidth}x${socialHeight}, expected 1200x630`);
}
forbidText(
  sitemap,
  "<loc>https://tuklusan.github.io/zx-spectrum-emulator/spectrum.html</loc>",
  "sitemap must not list the duplicate spectrum.html URL"
);

for (const rawShell of ["index.html", "spectrum.html", "cpm.html", "trs80.html", "ti85.html"]) {
  if (existsSync(`dist/public/${rawShell}`)) {
    throw new Error(`Pages SEO verification failed: duplicate raw HTML shell dist/public/${rawShell}`);
  }
}

console.log("GitHub Pages SEO verification: PASS");
