const SUPPORTED_MEDIA_TYPES = new Set(["tap", "tzx", "sna", "z80", "rzx"]);
const SUPPORTED_ARCHIVE_TYPES = new Set([...SUPPORTED_MEDIA_TYPES, "zip"]);
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_DEPTH = 3;

function bytesFrom(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("Expected binary media data");
}

function extensionFromLabel(label) {
  let pathname = String(label ?? "").trim();
  try {
    pathname = new URL(pathname, "https://example.invalid/").pathname;
  } catch {
    // A local filename is already good enough.
  }
  const filename = pathname.split(/[\\/]/).pop() ?? "";
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function startsWithAscii(bytes, text) {
  if (bytes.length < text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function looksLikeZip(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

function looksLikeTap(bytes) {
  let offset = 0;
  let blocks = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes[offset] | (bytes[offset + 1] << 8);
    if (length === 0 || offset + 2 + length > bytes.length) return false;
    offset += 2 + length;
    blocks += 1;
  }
  return blocks > 0 && offset === bytes.length;
}

export function detectSpectrumMediaType(input, label = "") {
  const bytes = bytesFrom(input);
  if (looksLikeZip(bytes)) return "zip";
  if (bytes.length >= 8
    && startsWithAscii(bytes, "ZXTape!")
    && bytes[7] === 0x1a) return "tzx";
  if (startsWithAscii(bytes, "RZX!")) return "rzx";

  const extension = extensionFromLabel(label);
  if (SUPPORTED_ARCHIVE_TYPES.has(extension)) return extension;
  if (bytes.length === 49179) return "sna";
  if (looksLikeTap(bytes)) return "tap";

  throw new Error("Cannot determine Spectrum media type; use TAP, TZX, SNA, Z80, RZX or ZIP");
}

function makeView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes, view) {
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("ZIP central directory was not found");
}

function readZipDirectory(input) {
  const bytes = bytesFrom(input);
  if (bytes.length > MAX_ZIP_BYTES) throw new Error("ZIP archive is too large");
  if (bytes.length < 22) throw new Error("ZIP archive is truncated");
  const view = makeView(bytes);
  const eocd = findEndOfCentralDirectory(bytes, view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("Multi-part ZIP archives are not supported");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("ZIP archive contains too many entries");
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory is invalid");

  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error("ZIP central directory entry is truncated");
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = end;
  }
  return { bytes, view, entries };
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot unpack compressed ZIP files");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractZipEntry(archive, entry) {
  const { bytes, view } = archive;
  if (entry.flags & 0x01) throw new Error(`ZIP entry ${entry.name} is encrypted`);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`ZIP entry ${entry.name} is too large`);
  if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    throw new Error(`ZIP entry ${entry.name} has an invalid local header`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error(`ZIP entry ${entry.name} is truncated`);
  const compressed = bytes.slice(dataOffset, dataEnd);
  let output;
  if (entry.method === 0) output = compressed;
  else if (entry.method === 8) output = await inflateRaw(compressed);
  else throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`);
  if (output.length !== entry.uncompressedSize) throw new Error(`ZIP entry ${entry.name} has the wrong unpacked size`);
  if (crc32(output) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its CRC check`);
  return Uint8Array.from(output);
}

function candidateEntries(entries) {
  return entries.filter((entry) => {
    if (!entry.name || entry.name.endsWith("/")) return false;
    return SUPPORTED_ARCHIVE_TYPES.has(extensionFromLabel(entry.name));
  });
}

function archiveMediaHint(label) {
  let pathname = String(label ?? "").trim();
  try {
    pathname = new URL(pathname, "https://example.invalid/").pathname;
  } catch {
    // A local filename is already good enough.
  }
  const filename = pathname.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const match = filename.match(/\.([a-z0-9]+)\.zip$/);
  return match && SUPPORTED_MEDIA_TYPES.has(match[1]) ? match[1] : null;
}

export async function unwrapSpectrumMedia(input, label = "media", depth = 0, preferredEntryName = null) {
  const bytes = bytesFrom(input);
  const type = detectSpectrumMediaType(bytes, label);
  if (type !== "zip") return { bytes: Uint8Array.from(bytes), type, name: label, archive: null };
  if (depth >= MAX_ZIP_DEPTH) throw new Error("ZIP nesting is too deep");

  const archive = readZipDirectory(bytes);
  let candidates = candidateEntries(archive.entries);
  if (preferredEntryName) {
    const wanted = preferredEntryName.toLowerCase();
    const preferred = candidates.find((entry) => entry.name.toLowerCase() === wanted);
    if (!preferred) throw new Error(`ZIP does not contain expected Spectrum file ${preferredEntryName}`);
    candidates = [preferred];
  } else if (candidates.length > 1) {
    const hintedType = archiveMediaHint(label);
    if (hintedType) {
      const hinted = candidates.filter((entry) => extensionFromLabel(entry.name) === hintedType);
      if (hinted.length > 0) candidates = [hinted[0]];
    }
  }
  if (candidates.length === 0) {
    throw new Error("ZIP contains no supported Spectrum media (TAP, TZX, SNA, Z80 or RZX)");
  }
  if (candidates.length > 1) {
    const names = candidates.slice(0, 6).map((entry) => entry.name).join(", ");
    const more = candidates.length > 6 ? `, and ${candidates.length - 6} more` : "";
    throw new Error(`ZIP contains multiple supported Spectrum files: ${names}${more}. Extract it and choose one file.`);
  }

  const entry = candidates[0];
  const unpacked = await extractZipEntry(archive, entry);
  const childType = detectSpectrumMediaType(unpacked, entry.name);
  if (childType === "zip") {
    const nested = await unwrapSpectrumMedia(unpacked, entry.name, depth + 1, preferredEntryName);
    return { ...nested, archive: label };
  }
  return { bytes: unpacked, type: childType, name: entry.name, archive: label };
}
