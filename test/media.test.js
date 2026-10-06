import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { detectSpectrumMediaType, unwrapSpectrumMedia } from "../public/media.js";

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function makeZip(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(value);
    const compressed = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, compressed
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(localBytes.length), u16(0)
  ]);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

const tzx = Buffer.from([0x5a, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1a, 1, 20]);

test("detects media from signatures and filenames", () => {
  assert.equal(detectSpectrumMediaType(tzx, "whatever.bin"), "tzx");
  assert.equal(detectSpectrumMediaType(Buffer.from("RZX!xxxx"), "recording.bin"), "rzx");
  assert.equal(detectSpectrumMediaType(Buffer.alloc(50), "state.z80"), "z80");
});

test("unwraps one stored Spectrum file and ignores documentation", async () => {
  const archive = makeZip([["README.txt", "hello"], ["game.tzx", tzx]]);
  const media = await unwrapSpectrumMedia(archive, "bundle.zip");
  assert.equal(media.type, "tzx");
  assert.equal(media.name, "game.tzx");
  assert.deepEqual(Buffer.from(media.bytes), tzx);
});

test("unwraps deflated Spectrum media", async () => {
  const archive = makeZip([["game.tzx", tzx]], { deflate: true });
  const media = await unwrapSpectrumMedia(archive, "bundle.zip");
  assert.equal(media.type, "tzx");
  assert.deepEqual(Buffer.from(media.bytes), tzx);
});

test("can select one known entry from an otherwise ambiguous ZIP", async () => {
  const archive = makeZip([
    ["v1.0/Spectrum-48/DreamWalker48.tap", Buffer.from([1, 0, 0])],
    ["v1.0/Spectrum-48/DreamWalker48.tzx", tzx],
    ["v1.0/Spectrum-128/DreamWalker.tzx", Buffer.concat([tzx, Buffer.from([1])])]
  ]);
  const media = await unwrapSpectrumMedia(
    archive,
    "dreamwalker.zip",
    0,
    "v1.0/Spectrum-48/DreamWalker48.tzx"
  );
  assert.equal(media.type, "tzx");
  assert.equal(media.name, "v1.0/Spectrum-48/DreamWalker48.tzx");
  assert.deepEqual(Buffer.from(media.bytes), tzx);
});

test("rejects an absent preferred ZIP entry cleanly", async () => {
  const archive = makeZip([["game.tzx", tzx], ["game.tap", Buffer.from([1, 0, 0])]]);
  await assert.rejects(
    () => unwrapSpectrumMedia(archive, "bundle.zip", 0, "missing.tzx"),
    /does not contain expected Spectrum file/
  );
});

test("rejects ambiguous and empty ZIP archives cleanly", async () => {
  await assert.rejects(
    () => unwrapSpectrumMedia(makeZip([
      ["one.tap", Buffer.from([1, 0, 0])],
      ["two.z80", Buffer.alloc(40)]
    ]), "many.zip"),
    /multiple supported Spectrum files/
  );
  await assert.rejects(
    () => unwrapSpectrumMedia(makeZip([["README.txt", "hello"]]), "none.zip"),
    /no supported Spectrum media/
  );
});
