const V1_HEADER_LENGTH = 30;
const RAM_LENGTH = 0xc000;
const PAGE_LENGTH = 0x4000;
const SNA_HEADER_LENGTH = 27;
const SNA_48K_LENGTH = SNA_HEADER_LENGTH + RAM_LENGTH;
const V1_END_MARKER = [0x00, 0xed, 0xed, 0x00];
const PAGE_TO_RAM_OFFSET = new Map([
  [8, 0x0000],
  [4, 0x4000],
  [5, 0x8000]
]);
const EXTENDED_HEADER_VERSIONS = new Map([
  [23, 2],
  [54, 3],
  [55, 3]
]);
const Z80_HARDWARE_MODES = {
  2: new Map([
    [0, "48K"],
    [1, "48K + Interface 1"],
    [2, "SamRam"],
    [3, "128K"],
    [4, "128K + Interface 1"]
  ]),
  3: new Map([
    [0, "48K"],
    [1, "48K + Interface 1"],
    [2, "SamRam"],
    [3, "48K + M.G.T."],
    [4, "128K"],
    [5, "128K + Interface 1"],
    [6, "128K + M.G.T."],
    [7, "+3"],
    [8, "+3"],
    [9, "Pentagon 128K"],
    [10, "Scorpion 256K"],
    [11, "Didaktik-Kompakt"],
    [12, "+2"],
    [13, "+2A"],
    [14, "Timex TC2048"],
    [15, "Timex TC2068"],
    [128, "Timex TS2068"]
  ])
};
const Z80_48K_MODES = {
  2: new Set([0]),
  3: new Set([0])
};

function bytesFrom(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readWord(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function writeWord(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function parseHeader(bytes, pc) {
  return {
    A: bytes[0],
    F: bytes[1],
    B: bytes[3],
    C: bytes[2],
    D: bytes[14],
    E: bytes[13],
    H: bytes[5],
    L: bytes[4],
    PC: pc,
    SP: readWord(bytes, 8),
    I: bytes[10],
    R: ((bytes[12] & 0x01) << 7) | (bytes[11] & 0x7f),
    B_: bytes[16],
    C_: bytes[15],
    D_: bytes[18],
    E_: bytes[17],
    H_: bytes[20],
    L_: bytes[19],
    A_: bytes[21],
    F_: bytes[22],
    IY: readWord(bytes, 23),
    IX: readWord(bytes, 25),
    IFF1: bytes[27] !== 0,
    IFF2: bytes[28] !== 0,
    interruptMode: bytes[29] & 0x03
  };
}

function isV1EndMarker(bytes, offset) {
  return V1_END_MARKER.every((byte, index) => bytes[offset + index] === byte);
}

function decodeCompressed(bytes, offset, expectedLength, { stopAtV1Marker = false } = {}) {
  const output = new Uint8Array(expectedLength);
  let source = offset;
  let target = 0;

  while (target < expectedLength && source < bytes.length) {
    if (stopAtV1Marker && source + 3 < bytes.length && isV1EndMarker(bytes, source)) break;
    if (source + 3 < bytes.length && bytes[source] === 0xed && bytes[source + 1] === 0xed) {
      const count = bytes[source + 2];
      const value = bytes[source + 3];
      if (target + count > expectedLength) throw new Error("Z80 snapshot compressed data overruns RAM");
      output.fill(value, target, target + count);
      target += count;
      source += 4;
      continue;
    }
    output[target] = bytes[source];
    target += 1;
    source += 1;
  }

  if (target < expectedLength) {
    throw new Error(stopAtV1Marker
      ? "Z80 v1 snapshot compressed data ended before 48K RAM was complete"
      : "Z80 snapshot ended before the RAM page was complete");
  }
  return output;
}

function parseV1(bytes, pc) {
  const compressed = (bytes[12] & 0x20) !== 0;
  if (!compressed) {
    if (bytes.length < V1_HEADER_LENGTH + RAM_LENGTH) throw new Error("Z80 v1 snapshot is missing 48K RAM");
    return bytes.slice(V1_HEADER_LENGTH, V1_HEADER_LENGTH + RAM_LENGTH);
  }
  return decodeCompressed(bytes, V1_HEADER_LENGTH, RAM_LENGTH, { stopAtV1Marker: true });
}

function parseExtendedRam(bytes, blockOffset) {
  const ram = new Uint8Array(RAM_LENGTH);
  const loadedPages = new Set();
  let offset = blockOffset;

  while (offset + 3 <= bytes.length) {
    const length = readWord(bytes, offset);
    const page = bytes[offset + 2];
    offset += 3;
    const ramOffset = PAGE_TO_RAM_OFFSET.get(page);

    if (length === 0xffff) {
      if (offset + PAGE_LENGTH > bytes.length) throw new Error("Z80 snapshot page is truncated");
      if (ramOffset !== undefined) {
        ram.set(bytes.slice(offset, offset + PAGE_LENGTH), ramOffset);
        loadedPages.add(page);
      }
      offset += PAGE_LENGTH;
      continue;
    }

    if (offset + length > bytes.length) throw new Error("Z80 snapshot compressed page is truncated");
    if (ramOffset !== undefined) {
      ram.set(decodeCompressed(bytes.slice(offset, offset + length), 0, PAGE_LENGTH), ramOffset);
      loadedPages.add(page);
    }
    offset += length;
  }

  for (const page of PAGE_TO_RAM_OFFSET.keys()) {
    if (!loadedPages.has(page)) throw new Error(`Z80 snapshot is missing 48K RAM page ${page}`);
  }
  return ram;
}

export function parseZ80Snapshot(input) {
  const bytes = bytesFrom(input);
  if (bytes.length < V1_HEADER_LENGTH) throw new Error("Z80 snapshot is too short");

  const headerPc = readWord(bytes, 6);
  const isV1 = headerPc !== 0;
  let pc = headerPc;
  let extendedRamOffset = 0;
  if (!isV1) {
    if (bytes.length < 38) throw new Error("Z80 extended snapshot header is truncated");
    const extendedHeaderLength = readWord(bytes, 30);
    const version = EXTENDED_HEADER_VERSIONS.get(extendedHeaderLength);
    if (!version || 32 + extendedHeaderLength > bytes.length) {
      throw new Error("Z80 extended snapshot header length is invalid");
    }

    const hardwareMode = bytes[34];
    const hardwareModified = (bytes[37] & 0x80) !== 0;
    const hardwareName = Z80_HARDWARE_MODES[version].get(hardwareMode) ?? `mode ${hardwareMode}`;
    if (hardwareModified || !Z80_48K_MODES[version].has(hardwareMode)) {
      throw new Error(`Only 48K Z80 snapshots are supported; Z80 v${version} hardware is ${hardwareModified ? "modified " : ""}${hardwareName}`);
    }

    pc = readWord(bytes, 32);
    extendedRamOffset = 32 + extendedHeaderLength;
  }
  const registers = parseHeader(bytes, pc);
  const borderColor = (bytes[12] >> 1) & 0x07;
  const ram = isV1
    ? parseV1(bytes, headerPc)
    : parseExtendedRam(bytes, extendedRamOffset);

  return {
    format: isV1 ? "Z80 v1" : "Z80 extended",
    registers,
    borderColor,
    ram
  };
}

export function parseSnaSnapshot(input) {
  const bytes = bytesFrom(input);
  if (bytes.length !== SNA_48K_LENGTH) {
    throw new Error(`Only 48K SNA snapshots (${SNA_48K_LENGTH} bytes) are supported`);
  }

  const ram = bytes.slice(SNA_HEADER_LENGTH);
  const savedSp = readWord(bytes, 23);
  if (savedSp < 0x4000 || savedSp > 0xfffe) {
    throw new Error("48K SNA snapshot stack pointer does not point into RAM");
  }
  const stackOffset = savedSp - 0x4000;
  const pc = ram[stackOffset] | (ram[stackOffset + 1] << 8);
  const iff = (bytes[19] & 0x04) !== 0;

  return {
    format: "SNA 48K",
    registers: {
      I: bytes[0],
      L_: bytes[1], H_: bytes[2],
      E_: bytes[3], D_: bytes[4],
      C_: bytes[5], B_: bytes[6],
      F_: bytes[7], A_: bytes[8],
      L: bytes[9], H: bytes[10],
      E: bytes[11], D: bytes[12],
      C: bytes[13], B: bytes[14],
      IY: readWord(bytes, 15),
      IX: readWord(bytes, 17),
      IFF1: iff,
      IFF2: iff,
      R: bytes[20],
      F: bytes[21],
      A: bytes[22],
      SP: (savedSp + 2) & 0xffff,
      PC: pc,
      interruptMode: Math.min(2, bytes[25] & 0x03)
    },
    borderColor: bytes[26] & 0x07,
    ram
  };
}

export function parseSpectrumSnapshot(input, extension = "") {
  const normalized = String(extension).replace(/^\./, "").toUpperCase();
  if (normalized === "SNA") return parseSnaSnapshot(input);
  if (normalized === "Z80") return parseZ80Snapshot(input);
  throw new Error(`Snapshot type ${normalized || "(missing)"} is not supported by the 48K machine`);
}

export function applyZ80Snapshot(machine, snapshotOrBytes) {
  const snapshot = snapshotOrBytes?.ram ? snapshotOrBytes : parseZ80Snapshot(snapshotOrBytes);
  const cpu = machine.cpu;
  Object.assign(cpu, snapshot.registers);
  cpu.interruptMode = Math.min(2, snapshot.registers.interruptMode);
  cpu.interruptDelay = 0;
  cpu.pendingInterrupt = false;
  cpu.pendingNmi = false;
  cpu.interruptData = 0xff;
  cpu.Q = 0;
  cpu.WZ = cpu.PC;
  cpu.halted = false;
  cpu.tStates = 0;

  machine.ram.set(snapshot.ram);
  machine.borderColor = snapshot.borderColor & 0x07;
  machine.beeperOn = false;
  machine.beeperEvents = [];
  machine.frame = 0;
  machine.releaseAllKeys();
  machine.clearTape();
  return snapshot;
}

export function applySpectrumSnapshot(machine, snapshotOrBytes, extension = "Z80") {
  const snapshot = snapshotOrBytes?.ram
    ? snapshotOrBytes
    : parseSpectrumSnapshot(snapshotOrBytes, extension);
  return applyZ80Snapshot(machine, snapshot);
}

function writeSnapshotHeader(bytes, machine, pc) {
  const cpu = machine.cpu;
  bytes[0] = cpu.A & 0xff;
  bytes[1] = cpu.F & 0xff;
  bytes[2] = cpu.C & 0xff;
  bytes[3] = cpu.B & 0xff;
  bytes[4] = cpu.L & 0xff;
  bytes[5] = cpu.H & 0xff;
  writeWord(bytes, 6, pc);
  writeWord(bytes, 8, cpu.SP);
  bytes[10] = cpu.I & 0xff;
  bytes[11] = cpu.R & 0x7f;
  bytes[12] = ((cpu.R & 0x80) >> 7) | ((machine.borderColor & 0x07) << 1);
  bytes[13] = cpu.E & 0xff;
  bytes[14] = cpu.D & 0xff;
  bytes[15] = cpu.C_ & 0xff;
  bytes[16] = cpu.B_ & 0xff;
  bytes[17] = cpu.E_ & 0xff;
  bytes[18] = cpu.D_ & 0xff;
  bytes[19] = cpu.L_ & 0xff;
  bytes[20] = cpu.H_ & 0xff;
  bytes[21] = cpu.A_ & 0xff;
  bytes[22] = cpu.F_ & 0xff;
  writeWord(bytes, 23, cpu.IY);
  writeWord(bytes, 25, cpu.IX);
  bytes[27] = cpu.IFF1 ? 1 : 0;
  bytes[28] = cpu.IFF2 ? 1 : 0;
  bytes[29] = cpu.interruptMode & 0x03;
}

export function createZ80Snapshot(machine) {
  if ((machine.cpu.PC & 0xffff) !== 0) {
    const bytes = new Uint8Array(V1_HEADER_LENGTH + RAM_LENGTH);
    writeSnapshotHeader(bytes, machine, machine.cpu.PC);
    bytes.set(machine.ram, V1_HEADER_LENGTH);
    return bytes;
  }

  // PC=0000 is the extended-format sentinel, so a v1 file would describe itself
  // as the wrong format. Use a plain 48K v2 snapshot instead.
  const extendedHeaderLength = 23;
  const headerLength = 32 + extendedHeaderLength;
  const bytes = new Uint8Array(headerLength + (3 * (3 + PAGE_LENGTH)));
  writeSnapshotHeader(bytes, machine, 0);
  writeWord(bytes, 30, extendedHeaderLength);
  writeWord(bytes, 32, machine.cpu.PC);
  bytes[34] = 0;

  let offset = headerLength;
  for (const [page, ramOffset] of [[8, 0x0000], [4, 0x4000], [5, 0x8000]]) {
    writeWord(bytes, offset, 0xffff);
    bytes[offset + 2] = page;
    bytes.set(machine.ram.subarray(ramOffset, ramOffset + PAGE_LENGTH), offset + 3);
    offset += 3 + PAGE_LENGTH;
  }
  return bytes;
}
