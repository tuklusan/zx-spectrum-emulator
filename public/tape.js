const HEADER_TYPES = ["Program", "Number array", "Character array", "Code"];
const TZX_BLOCK_NAMES = new Map([
  [0x10, "Standard speed data"],
  [0x11, "Turbo speed data"],
  [0x12, "Pure tone"],
  [0x13, "Pulse sequence"],
  [0x14, "Pure data"],
  [0x15, "Direct recording"],
  [0x18, "CSW recording"],
  [0x19, "Generalized data"],
  [0x20, "Pause or stop tape"],
  [0x21, "Group start"],
  [0x22, "Group end"],
  [0x23, "Jump to block"],
  [0x24, "Loop start"],
  [0x25, "Loop end"],
  [0x26, "Call sequence"],
  [0x27, "Return from sequence"],
  [0x28, "Select block"],
  [0x2a, "Stop tape in 48K mode"],
  [0x2b, "Set signal level"],
  [0x30, "Text description"],
  [0x31, "Message"],
  [0x32, "Archive info"],
  [0x33, "Hardware type"],
  [0x35, "Custom info"],
  [0x5a, "Glue"]
]);

function wordAt(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function tripletAt(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function longAt(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function checksumFor(bytes) {
  return bytes.reduce((checksum, value) => checksum ^ value, 0);
}

function decodeHeader(payload) {
  if (payload.length !== 17) return null;
  const type = payload[0];
  const name = String.fromCharCode(...payload.slice(1, 11)).trimEnd();
  return {
    type,
    typeName: HEADER_TYPES[type] ?? `Type ${type}`,
    name,
    length: wordAt(payload, 11),
    param1: wordAt(payload, 13),
    param2: wordAt(payload, 15)
  };
}

export function parseTap(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const blocks = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new Error("Truncated TAP block length");
    const length = wordAt(bytes, offset);
    offset += 2;
    if (length < 2) throw new Error(`Invalid TAP block length: ${length}`);
    if (offset + length > bytes.length) throw new Error("Truncated TAP block data");

    const raw = bytes.slice(offset, offset + length);
    const flag = raw[0];
    const payload = raw.slice(1, -1);
    const checksum = raw[raw.length - 1];
    blocks.push({
      index: blocks.length,
      length,
      flag,
      payload,
      checksum,
      checksumValid: checksumFor(raw) === 0,
      header: flag === 0x00 ? decodeHeader(payload) : null
    });
    offset += length;
  }

  return blocks;
}

function decodeTapeBlock(raw, index, source = "TAP", pauseMs = null, timing = null) {
  const flag = raw[0];
  const payload = raw.slice(1, -1);
  const checksum = raw[raw.length - 1];
  return {
    index, source,
    type: timing ? "turbo" : source === "TZX" ? "standard" : "tap",
    length: raw.length, pauseMs, flag, payload, checksum,
    checksumValid: checksumFor(raw) === 0,
    header: flag === 0x00 ? decodeHeader(payload) : null,
    timing, generalized: null, fastLoadable: true
  };
}

function requireBytes(bytes, offset, length, message) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error(message);
}
function alphabetSize(value) { return value === 0 ? 256 : value; }
function bitsPerSymbol(size) { return size <= 1 ? 0 : Math.ceil(Math.log2(size)); }

function parseSymbolTable(bytes, offset, count, maxPulses, end, label) {
  const symbols = [];
  let cursor = offset;
  for (let symbolIndex = 0; symbolIndex < count; symbolIndex += 1) {
    requireBytes(bytes, cursor, 1 + (maxPulses * 2), "Truncated TZX generalized " + label + " symbol table");
    const flags = bytes[cursor++];
    const pulses = [];
    for (let pulse = 0; pulse < maxPulses; pulse += 1) {
      pulses.push(wordAt(bytes, cursor));
      cursor += 2;
    }
    symbols.push({ flags: flags & 0x03, pulses });
  }
  if (cursor > end) throw new Error("Truncated TZX generalized " + label + " symbol table");
  return { symbols, offset: cursor };
}

function parseGeneralizedBlock(bytes, offset, index) {
  requireBytes(bytes, offset, 4, "Truncated TZX generalized block length");
  const blockLength = longAt(bytes, offset);
  const start = offset + 4;
  const end = start + blockLength;
  requireBytes(bytes, start, blockLength, "Truncated TZX generalized block");
  if (blockLength < 14) throw new Error("Invalid TZX generalized block length");

  const pauseMs = wordAt(bytes, start);
  const pilotStreamCount = longAt(bytes, start + 2);
  const maxPilotPulses = bytes[start + 6];
  const pilotAlphabetSize = alphabetSize(bytes[start + 7]);
  const dataSymbolCount = longAt(bytes, start + 8);
  const maxDataPulses = bytes[start + 12];
  const dataAlphabetSize = alphabetSize(bytes[start + 13]);

  let cursor = start + 14;
  let pilotSymbols = [];
  const pilotStream = [];
  if (pilotStreamCount > 0) {
    const parsed = parseSymbolTable(bytes, cursor, pilotAlphabetSize, maxPilotPulses, end, "pilot");
    pilotSymbols = parsed.symbols;
    cursor = parsed.offset;
    requireBytes(bytes, cursor, pilotStreamCount * 3, "Truncated TZX generalized pilot stream");
    for (let entry = 0; entry < pilotStreamCount; entry += 1) {
      const symbol = bytes[cursor++];
      const repetitions = wordAt(bytes, cursor);
      cursor += 2;
      if (symbol >= pilotSymbols.length) throw new Error("Invalid TZX generalized pilot symbol " + symbol);
      pilotStream.push({ symbol, repetitions });
    }
  }

  let dataSymbols = [];
  let dataStream = new Uint8Array();
  const dataWidth = bitsPerSymbol(dataAlphabetSize);
  if (dataSymbolCount > 0) {
    const parsed = parseSymbolTable(bytes, cursor, dataAlphabetSize, maxDataPulses, end, "data");
    dataSymbols = parsed.symbols;
    cursor = parsed.offset;
    const dataBytes = Math.ceil((dataSymbolCount * dataWidth) / 8);
    requireBytes(bytes, cursor, dataBytes, "Truncated TZX generalized data stream");
    dataStream = bytes.slice(cursor, cursor + dataBytes);
    cursor += dataBytes;
  }
  if (cursor !== end) throw new Error("TZX generalized block length mismatch");

  return {
    block: {
      index, source: "TZX", type: "generalized", length: blockLength + 4, pauseMs,
      flag: null, payload: new Uint8Array(), checksum: null, checksumValid: true,
      header: null, timing: null,
      generalized: { pilotSymbols, pilotStream, dataSymbols, dataStream, dataSymbolCount, dataBitsPerSymbol: dataWidth },
      fastLoadable: false
    },
    offset: end
  };
}

export function parseTzx(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = "ZXTape!\x1a";
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 8)) !== signature) throw new Error("Invalid TZX signature");

  const blocks = [];
  let offset = 10;
  while (offset < bytes.length) {
    const id = bytes[offset++];

    if (id === 0x10) {
      requireBytes(bytes, offset, 4, "Truncated TZX standard block header");
      const pauseMs = wordAt(bytes, offset);
      const length = wordAt(bytes, offset + 2);
      offset += 4;
      if (length < 2) throw new Error("Invalid TZX standard block length: " + length);
      requireBytes(bytes, offset, length, "Truncated TZX standard block data");
      blocks.push(decodeTapeBlock(bytes.slice(offset, offset + length), blocks.length, "TZX", pauseMs));
      offset += length;
      continue;
    }

    if (id === 0x11) {
      requireBytes(bytes, offset, 18, "Truncated TZX turbo block header");
      const timing = {
        pilotPulse: wordAt(bytes, offset),
        sync1: wordAt(bytes, offset + 2),
        sync2: wordAt(bytes, offset + 4),
        zero: wordAt(bytes, offset + 6),
        one: wordAt(bytes, offset + 8),
        pilotCount: wordAt(bytes, offset + 10),
        usedBitsLastByte: bytes[offset + 12]
      };
      const pauseMs = wordAt(bytes, offset + 13);
      const length = tripletAt(bytes, offset + 15);
      offset += 18;
      if (length < 2) throw new Error("Invalid TZX turbo block length: " + length);
      requireBytes(bytes, offset, length, "Truncated TZX turbo block data");
      blocks.push(decodeTapeBlock(bytes.slice(offset, offset + length), blocks.length, "TZX", pauseMs, timing));
      offset += length;
      continue;
    }

    if (id === 0x12) {
      requireBytes(bytes, offset, 4, "Truncated TZX pure tone block");
      const pulseTStates = wordAt(bytes, offset);
      const pulseCount = wordAt(bytes, offset + 2);
      if (pulseCount > 0 && pulseTStates === 0) throw new Error("Invalid TZX pure tone pulse length");
      blocks.push({
        index: blocks.length, source: "TZX", type: "pure-tone", length: 4, pauseMs: 0,
        flag: null, payload: new Uint8Array(), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false,
        signal: { kind: "pure-tone", pulseTStates, pulseCount }
      });
      offset += 4;
      continue;
    }

    if (id === 0x13) {
      requireBytes(bytes, offset, 1, "Truncated TZX pulse sequence block");
      const pulseCount = bytes[offset];
      requireBytes(bytes, offset + 1, pulseCount * 2, "Truncated TZX pulse sequence data");
      const pulses = [];
      for (let pulse = 0; pulse < pulseCount; pulse += 1) {
        const duration = wordAt(bytes, offset + 1 + (pulse * 2));
        if (duration === 0) throw new Error("Invalid TZX pulse sequence duration");
        pulses.push(duration);
      }
      blocks.push({
        index: blocks.length, source: "TZX", type: "pulse-sequence", length: 1 + (pulseCount * 2), pauseMs: 0,
        flag: null, payload: new Uint8Array(), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false,
        signal: { kind: "pulse-sequence", pulses }
      });
      offset += 1 + (pulseCount * 2);
      continue;
    }

    if (id === 0x14) {
      requireBytes(bytes, offset, 10, "Truncated TZX pure data block header");
      const zero = wordAt(bytes, offset);
      const one = wordAt(bytes, offset + 2);
      const usedBitsLastByte = bytes[offset + 4] || 8;
      const pauseMs = wordAt(bytes, offset + 5);
      const length = tripletAt(bytes, offset + 7);
      if (zero === 0 || one === 0) throw new Error("Invalid TZX pure data pulse length");
      if (usedBitsLastByte < 1 || usedBitsLastByte > 8) throw new Error("Invalid TZX pure data last-bit count");
      offset += 10;
      requireBytes(bytes, offset, length, "Truncated TZX pure data");
      blocks.push({
        index: blocks.length, source: "TZX", type: "pure-data", length: 10 + length, pauseMs,
        flag: null, payload: bytes.slice(offset, offset + length), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false,
        signal: { kind: "pure-data", zero, one, usedBitsLastByte }
      });
      offset += length;
      continue;
    }

    if (id === 0x15) {
      requireBytes(bytes, offset, 8, "Truncated TZX direct recording block header");
      const sampleTStates = wordAt(bytes, offset);
      const pauseMs = wordAt(bytes, offset + 2);
      const usedBitsLastByte = bytes[offset + 4] || 8;
      const length = tripletAt(bytes, offset + 5);
      if (sampleTStates === 0) throw new Error("Invalid TZX direct recording sample length");
      if (usedBitsLastByte < 1 || usedBitsLastByte > 8) throw new Error("Invalid TZX direct recording last-bit count");
      offset += 8;
      requireBytes(bytes, offset, length, "Truncated TZX direct recording data");
      blocks.push({
        index: blocks.length, source: "TZX", type: "direct-recording", length: 8 + length, pauseMs,
        flag: null, payload: bytes.slice(offset, offset + length), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false,
        signal: { kind: "direct-recording", sampleTStates, usedBitsLastByte }
      });
      offset += length;
      continue;
    }

    if (id === 0x19) {
      const parsed = parseGeneralizedBlock(bytes, offset, blocks.length);
      blocks.push(parsed.block);
      offset = parsed.offset;
      continue;
    }

    if (id === 0x2a) {
      requireBytes(bytes, offset, 4, "Truncated TZX stop-if-48K block");
      const length = longAt(bytes, offset);
      if (length !== 0) throw new Error("Invalid TZX stop-if-48K block length");
      blocks.push({
        index: blocks.length, source: "TZX", type: "stop-48k", length: 4, pauseMs: 0,
        flag: null, payload: new Uint8Array(), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false, stopTape: true
      });
      offset += 4;
      continue;
    }

    if (id === 0x2b) {
      requireBytes(bytes, offset, 5, "Truncated TZX set-signal-level block");
      const length = longAt(bytes, offset);
      if (length !== 1) throw new Error("Invalid TZX set-signal-level block length");
      const signalLevel = bytes[offset + 4];
      if (signalLevel > 1) throw new Error("Invalid TZX signal level");
      blocks.push({
        index: blocks.length, source: "TZX", type: "set-signal-level", length: 5, pauseMs: 0,
        flag: null, payload: new Uint8Array(), checksum: null, checksumValid: true,
        header: null, timing: null, generalized: null, fastLoadable: false,
        signal: { kind: "set-level", level: signalLevel }
      });
      offset += 5;
      continue;
    }

    if (id === 0x20) {
      requireBytes(bytes, offset, 2, "Truncated TZX pause block");
      const pauseMs = wordAt(bytes, offset);
      blocks.push({
        index: blocks.length,
        source: "TZX",
        type: "pause",
        length: 2,
        pauseMs,
        flag: null,
        payload: new Uint8Array(),
        checksum: null,
        checksumValid: true,
        header: null,
        timing: null,
        generalized: null,
        fastLoadable: false,
        stopTape: pauseMs === 0
      });
      offset += 2;
    } else if (id === 0x21 || id === 0x30) {
      requireBytes(bytes, offset, 1, "Truncated TZX text block");
      const length = bytes[offset];
      requireBytes(bytes, offset, 1 + length, "Truncated TZX text block"); offset += 1 + length;
    } else if (id === 0x22) {
      continue;
    } else if (id === 0x31) {
      requireBytes(bytes, offset, 2, "Truncated TZX message block");
      const length = bytes[offset + 1];
      requireBytes(bytes, offset, 2 + length, "Truncated TZX message block"); offset += 2 + length;
    } else if (id === 0x32) {
      requireBytes(bytes, offset, 2, "Truncated TZX archive block");
      const length = wordAt(bytes, offset);
      requireBytes(bytes, offset, 2 + length, "Truncated TZX archive block"); offset += 2 + length;
    } else if (id === 0x33) {
      requireBytes(bytes, offset, 1, "Truncated TZX hardware block");
      const length = 1 + (bytes[offset] * 3);
      requireBytes(bytes, offset, length, "Truncated TZX hardware block"); offset += length;
    } else if (id === 0x35) {
      requireBytes(bytes, offset, 20, "Truncated TZX custom block");
      const length = 20 + longAt(bytes, offset + 16);
      requireBytes(bytes, offset, length, "Truncated TZX custom block"); offset += length;
    } else {
      const name = TZX_BLOCK_NAMES.get(id);
      throw new Error("Unsupported TZX block 0x" + id.toString(16).padStart(2, "0") + (name ? " (" + name + ")" : ""));
    }
  }

  return blocks;
}

export function parseTapeFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const isTzx = bytes.length >= 8 && String.fromCharCode(...bytes.slice(0, 8)) === "ZXTape!\x1a";
  return isTzx ? parseTzx(bytes) : parseTap(bytes);
}

