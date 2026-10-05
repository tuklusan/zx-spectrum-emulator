import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRemoteFileUrl, normalizeTapeUrl } from "../public/tape-url.js";

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
