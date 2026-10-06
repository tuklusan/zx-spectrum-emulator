import assert from "node:assert/strict";
import test from "node:test";
import { allOriginsRawUrl, codeTabsUrl, normalizeRemoteFileUrl, normalizeTapeUrl, spectrumComputingMirrorUrl } from "../public/tape-url.js";

test("rewrites GitHub blob links to raw file URLs", () => {
  assert.equal(normalizeTapeUrl("https://github.com/tuklusan/ZX-Carrom/blob/main/dist/zxcarrom.tzx","https://tuklusan.github.io/zx-spectrum-emulator/"),
    "https://raw.githubusercontent.com/tuklusan/ZX-Carrom/main/dist/zxcarrom.tzx");
});
test("keeps ordinary https tape URLs intact", () => {
  assert.equal(normalizeTapeUrl("https://example.com/games/carrom.tzx","https://example.com/emulator/"),"https://example.com/games/carrom.tzx");
});
test("resolves relative tape URLs against the current page", () => {
  assert.equal(normalizeTapeUrl("games/carrom.tzx","https://example.com/emulator/"),"https://example.com/emulator/games/carrom.tzx");
});
test("rejects non-web tape URL schemes", () => {
  assert.throws(() => normalizeTapeUrl("javascript:alert(1)","https://example.com/"),/scheme/);
});

test("generic remote files also rewrite GitHub blob links", () => {
  assert.equal(
    normalizeRemoteFileUrl("https://github.com/example/snapshots/blob/main/game.z80", "https://example.com/", "Snapshot"),
    "https://raw.githubusercontent.com/example/snapshots/main/game.z80"
  );
});

test("generic remote file errors use the requested label", () => {
  assert.throws(
    () => normalizeRemoteFileUrl("", "https://example.com/", "Snapshot"),
    /Snapshot URL is empty/
  );
  assert.throws(
    () => normalizeRemoteFileUrl("file:///tmp/state.z80", "https://example.com/", "Snapshot"),
    /snapshot URL scheme/
  );
});

test("keeps Spectrum Computing ZXDB media on the URL the user supplied", () => {
  assert.equal(
    normalizeRemoteFileUrl(
      "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip",
      "https://tuklusan.github.io/zx-spectrum-emulator/",
      "Media"
    ),
    "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip"
  );
});

test("builds the ZXInfo mirror only as a backup", () => {
  assert.equal(
    spectrumComputingMirrorUrl(
      "https://spectrumcomputing.co.uk/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip"
    ),
    "https://zxinfo.dk/media/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip"
  );
  assert.equal(spectrumComputingMirrorUrl("https://example.com/game.tzx"), null);
});

test("keeps non-ZXDB Spectrum Computing URLs on their original host", () => {
  assert.equal(
    normalizeRemoteFileUrl(
      "https://spectrumcomputing.co.uk/entry/30084",
      "https://tuklusan.github.io/zx-spectrum-emulator/",
      "Media"
    ),
    "https://spectrumcomputing.co.uk/entry/30084"
  );
});


test("builds a CodeTabs fallback without changing the target URL", () => {
  const target = "https://example.com/games/Hello World.tzx?x=1&y=2";
  const proxied = new URL(codeTabsUrl(target));
  assert.equal(proxied.origin, "https://api.codetabs.com");
  assert.equal(proxied.pathname, "/v1/proxy");
  assert.equal(proxied.searchParams.get("quest"), new URL(target).href);
});

test("builds an AllOrigins raw fallback without changing the target URL", () => {
  const target = "https://example.com/games/Hello World.tzx?x=1&y=2";
  const proxied = new URL(allOriginsRawUrl(target));
  assert.equal(proxied.origin, "https://api.allorigins.win");
  assert.equal(proxied.pathname, "/raw");
  assert.equal(proxied.searchParams.get("url"), new URL(target).href);
});

test("rejects non-web URLs for the CORS bridges", () => {
  assert.throws(() => codeTabsUrl("file:///tmp/game.tzx"), /HTTP\(S\)/);
  assert.throws(() => allOriginsRawUrl("file:///tmp/game.tzx"), /HTTP\(S\)/);
});
