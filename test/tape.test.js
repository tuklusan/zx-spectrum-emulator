import assert from "node:assert/strict";
import test from "node:test";
import { tokenizeBasicLine } from "../public/basic.js";
import { parseTapeFile, parseTap, parseTzx } from "../public/tape.js";
import { loadTapEntry, tapEntries } from "../public/tape-tools.js";
import { Spectrum48 } from "../src/spectrum48.js";

function checksum(bytes) {
  return bytes.reduce((value, byte) => value ^ byte, 0);
}

function tapBlock(bytes) {
  return [bytes.length & 0xff, bytes.length >> 8, ...bytes];
}

function headerBlock({ type = 0, name = "HELLO", length, param1 = 0x8000, param2 = length }) {
  const nameBytes = Array.from(name.padEnd(10, " ").slice(0, 10), (char) => char.charCodeAt(0));
  const body = [
    0x00,
    type,
    ...nameBytes,
    length & 0xff,
    length >> 8,
    param1 & 0xff,
    param1 >> 8,
    param2 & 0xff,
    param2 >> 8
  ];
  return tapBlock([...body, checksum(body)]);
}

function dataBlock(payload) {
  const body = [0xff, ...payload];
  return tapBlock([...body, checksum(body)]);
}

function makeTap(blocks) {
  return new Uint8Array(blocks.flat());
}

function standardTzxBlock(bytes, pauseMs = 1000) {
  return [0x10, pauseMs & 0xff, pauseMs >> 8, bytes.length & 0xff, bytes.length >> 8, ...bytes];
}

function makeTzx(blocks) {
  return new Uint8Array([
    ..."ZXTape!\x1a".split("").map((char) => char.charCodeAt(0)),
    1,
    10,
    0x30,
    4,
    ..."test".split("").map((char) => char.charCodeAt(0)),
    ...blocks.flat()
  ]);
}

function makeMachine() {
  const machine = new Spectrum48({ rom: new Uint8Array(0x4000) });
  machine.write16(0x5c53, 0x5ccb);
  return machine;
}

test("parses TAP header and data blocks", () => {
  const program = tokenizeBasicLine("10 PRINT \"TAPE\"");
  const blocks = parseTap(makeTap([
    headerBlock({ name: "HELLO", length: program.length, param1: 10, param2: program.length }),
    dataBlock(program)
  ]));

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].checksumValid, true);
  assert.equal(blocks[0].header.typeName, "Program");
  assert.equal(blocks[0].header.name, "HELLO");
  assert.equal(blocks[1].payload.length, program.length);
});

test("pairs TAP headers with following data blocks", () => {
  const program = tokenizeBasicLine("10 PRINT \"TAPE\"");
  const entries = tapEntries(parseTap(makeTap([
    headerBlock({ name: "HELLO", length: program.length, param1: 10, param2: program.length }),
    dataBlock(program)
  ])));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].loadable, true);
  assert.equal(entries[0].header.name, "HELLO");
});

test("fast-loads BASIC TAP entries into program memory", () => {
  const program = tokenizeBasicLine("10 PRINT \"TAPE\"");
  const entry = tapEntries(parseTap(makeTap([
    headerBlock({ name: "HELLO", length: program.length, param1: 10, param2: program.length }),
    dataBlock(program)
  ])))[0];
  const machine = makeMachine();

  const result = loadTapEntry(machine, entry);

  assert.equal(result.kind, "BASIC");
  assert.equal(result.autoStartLine, 10);
  assert.deepEqual(
    Array.from({ length: program.length }, (_, offset) => machine.read8(0x5ccb + offset)),
    program
  );
  assert.equal(machine.read16(0x5c4b), 0x5ccb + program.length);
});

test("fast-loads CODE TAP entries to the header start address", () => {
  const code = [0x3e, 0x42, 0xc9];
  const entry = tapEntries(parseTap(makeTap([
    headerBlock({ type: 3, name: "ROUTINE", length: code.length, param1: 0x8000, param2: 0x8000 }),
    dataBlock(code)
  ])))[0];
  const machine = makeMachine();

  const result = loadTapEntry(machine, entry);

  assert.equal(result.kind, "CODE");
  assert.equal(result.start, 0x8000);
  assert.deepEqual([machine.read8(0x8000), machine.read8(0x8001), machine.read8(0x8002)], code);
});

test("rejects corrupt TAP checksums", () => {
  const program = tokenizeBasicLine("10 PRINT \"TAPE\"");
  const tap = makeTap([
    headerBlock({ name: "HELLO", length: program.length }),
    dataBlock(program)
  ]);
  tap[tap.length - 1] ^= 0xff;
  const entry = tapEntries(parseTap(tap))[0];

  assert.throws(() => loadTapEntry(makeMachine(), entry), /checksum/i);
});

test("bad-checksum tape blocks still produce their physical pulses", () => {
  const tap = makeTap([dataBlock([0x12, 0x34])]);
  tap[tap.length - 1] ^= 0xff;
  const [block] = parseTap(tap);
  assert.equal(block.checksumValid, false);

  const machine = makeMachine();
  machine.setTapeBlocks([block]);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0);

  assert.ok(sequence.durations.length > 0);
  machine.startTapePlayback();
  assert.equal(machine.tapePlaying, true);
  assert.ok(machine.tapePulseDurations.length > 0);
});

test("parses TZX standard-speed blocks as mountable tape blocks", () => {
  const program = tokenizeBasicLine("10 PRINT \"TZX\"");
  const blocks = parseTzx(makeTzx([
    standardTzxBlock(headerBlock({ name: "TZXTEST", length: program.length, param1: 10, param2: program.length }).slice(2)),
    standardTzxBlock(dataBlock(program).slice(2)),
    standardTzxBlock(dataBlock([0x3e, 0x42, 0xc9]).slice(2))
  ]));
  const entries = tapEntries(blocks);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].source, "TZX");
  assert.equal(blocks[0].pauseMs, 1000);
  assert.equal(blocks[0].fastLoadable, true);
  assert.equal(blocks[2].flag, 0xff);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].header.name, "TZXTEST");
  assert.equal(entries[0].loadable, true);
});

test("detects TZX files through the generic tape parser", () => {
  const blocks = parseTapeFile(makeTzx([
    standardTzxBlock(dataBlock([0x01, 0x02, 0x03]).slice(2), 500)
  ]));

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, "TZX");
  assert.equal(blocks[0].pauseMs, 500);
});

test("keeps standard TZX header and data blocks fast even when the filename has control bytes", () => {
  const loader = tokenizeBasicLine("10 RANDOMIZE USR 32768");
  const blocks = parseTzx(makeTzx([
    standardTzxBlock(headerBlock({
      name: "\x16\x01\x00 HATE",
      length: loader.length,
      param1: 10,
      param2: loader.length
    }).slice(2), 985),
    standardTzxBlock(dataBlock(loader).slice(2), 7629),
    turboTzxBlock(dataBlock([0x3e, 0x42, 0xc9]).slice(2), { pilotCount: 240, pauseMs: 10310 })
  ]));

  assert.equal(blocks[0].header.name.startsWith("\x16\x01\x00"), true);
  assert.deepEqual(blocks.map((block) => block.fastLoadable), [true, true, true]);
});

test("preserves TZX pause and stop-tape control blocks", () => {
  const blocks = parseTzx(makeTzx([
    [0x20, 0xfa, 0x00],
    [0x20, 0x00, 0x00],
    standardTzxBlock(dataBlock([0x01]).slice(2), 0)
  ]));

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "pause");
  assert.equal(blocks[0].pauseMs, 250);
  assert.equal(blocks[0].stopTape, false);
  assert.equal(blocks[1].type, "pause");
  assert.equal(blocks[1].stopTape, true);
});

test("TZX millisecond pauses finish the pulse then settle EAR low", () => {
  const blocks = parseTzx(makeTzx([[0x20, 0xe8, 0x03]]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0, false);
  assert.deepEqual(Array.from(sequence.durations), [3_494, 3_490_906]);
  assert.deepEqual(Array.from(sequence.levels), [1, 0]);
  assert.equal(sequence.endingLevel, false);
});

test("zero-gap tape blocks do not invent a pause or reset the EAR phase", () => {
  const raw = dataBlock([0x80]).slice(2);
  const blocks = parseTzx(makeTzx([
    turboTzxBlock(raw, { pilotCount: 3, pauseMs: 0 }),
    turboTzxBlock(raw, { pilotCount: 3, pauseMs: 0 })
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  const first = machine.buildTapeBlockPulseSequence(0, 0, false);
  const second = machine.buildTapeBlockPulseSequence(1, 0, first.endingLevel);
  assert.equal(second.levels[0], Number(first.endingLevel));
});

test("feeds a playing TAP block to the ROM tape load routine", () => {
  const header = headerBlock({ type: 3, name: "CODE", length: 3, param1: 0x8000, param2: 0x8000 });
  const blocks = parseTap(makeTap([header]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.startTapePlayback();
  machine.cpu.PC = 0x0556;
  machine.cpu.SP = 0x7000;
  machine.cpu.A = 0x00;
  machine.cpu.IX = 0x6000;
  machine.cpu.DE = 17;
  machine.write16(machine.cpu.SP, 0x1234);

  const cycles = machine.step();

  assert.equal(cycles, 32);
  assert.equal(machine.cpu.PC, 0x1234);
  assert.equal(machine.cpu.SP, 0x7002);
  assert.equal(machine.cpu.IX, 0x6011);
  assert.equal(machine.cpu.DE, 0);
  assert.equal(machine.tapeCursor, 1);
  assert.deepEqual(
    Array.from({ length: 17 }, (_, offset) => machine.read8(0x6000 + offset)),
    Array.from(blocks[0].payload)
  );
});

test("keeps a multi-file TAP armed across ROM header boundaries", () => {
  const firstData = [0x11, 0x22];
  const secondData = [0x33, 0x44, 0x55];
  const blocks = parseTap(makeTap([
    headerBlock({ type: 3, name: "ONE", length: firstData.length, param1: 0x8000, param2: 0x8000 }),
    dataBlock(firstData),
    headerBlock({ type: 3, name: "TWO", length: secondData.length, param1: 0x9000, param2: 0x9000 }),
    dataBlock(secondData)
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.startTapePlayback();

  const requestLoad = (flag, length, destination, returnAddress) => {
    machine.cpu.PC = 0x0556;
    machine.cpu.SP = 0x7000;
    machine.cpu.A = flag;
    machine.cpu.IX = destination;
    machine.cpu.DE = length;
    machine.write16(machine.cpu.SP, returnAddress);
    assert.equal(machine.step(), 32);
  };

  requestLoad(0x00, 17, 0x6000, 0x2000);
  assert.equal(machine.tapeCursor, 1);
  assert.equal(machine.tapePlaying, true);
  assert.equal(machine.tapeWaitForRomLoader, true);

  requestLoad(0xff, firstData.length, 0x8000, 0x2001);
  assert.equal(machine.tapeCursor, 2);
  assert.equal(machine.tapePlaying, true);
  assert.equal(machine.tapeWaitForRomLoader, true);

  requestLoad(0x00, 17, 0x6100, 0x2002);
  assert.equal(machine.tapeCursor, 3);
  assert.equal(machine.tapePlaying, true);
  assert.equal(machine.tapeWaitForRomLoader, true);

  requestLoad(0xff, secondData.length, 0x9000, 0x2003);
  assert.equal(machine.tapeCursor, 4);
  assert.equal(machine.tapePlaying, false);
  assert.deepEqual([machine.read8(0x8000), machine.read8(0x8001)], firstData);
  assert.deepEqual([machine.read8(0x9000), machine.read8(0x9001), machine.read8(0x9002)], secondData);
});

test("does not fast-load a mounted cassette while the tape is stopped", () => {
  const header = headerBlock({ type: 3, name: "CODE", length: 3, param1: 0x8000, param2: 0x8000 });
  const blocks = parseTap(makeTap([header]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.cpu.PC = 0x0556;
  machine.cpu.SP = 0x7000;
  machine.cpu.A = 0x00;
  machine.cpu.IX = 0x6000;
  machine.cpu.DE = 17;
  machine.write16(machine.cpu.SP, 0x1234);

  machine.step();

  assert.equal(machine.cpu.PC, 0x0557);
  assert.equal(machine.tapeCursor, 0);
});

test("armed tape waits for the ROM loader before consuming pilot pulses", () => {
  const blocks = parseTap(makeTap([dataBlock([0x80])]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.startTapePlayback({ waitForRomLoader: true });

  assert.equal(machine.tapeWaitForRomLoader, true);
  assert.equal(machine.tapeNextPulseTState, 0);
  const pulseIndex = machine.tapePulseIndex;
  machine.cpu.PC = 0x1000;
  machine.cpu.tStates = 100000;
  assert.equal(machine.readTapeEarBit(), 0x40);
  assert.equal(machine.tapePulseIndex, pulseIndex);

  machine.cpu.PC = 0x0560;
  machine.readTapeEarBit();
  assert.equal(machine.tapeWaitForRomLoader, false);
  assert.equal(machine.tapePulseIndex, pulseIndex);
  assert.ok(machine.tapeNextPulseTState > machine.cpu.tStates);
});

test("leaves the ROM tape routine alone when the next TAP block does not match", () => {
  const blocks = parseTap(makeTap([dataBlock([0x3e, 0x42, 0xc9])]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.cpu.PC = 0x0556;
  machine.cpu.A = 0x00;
  machine.cpu.IX = 0x6000;
  machine.cpu.DE = 17;

  machine.step();

  assert.equal(machine.cpu.PC, 0x0557);
  assert.equal(machine.tapeCursor, 0);
});

test("standard tape pulse playback drives the EAR bit on port fe", () => {
  const blocks = parseTzx(makeTzx([
    standardTzxBlock(dataBlock([0x00]).slice(2), 0)
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.startTapePlayback({ startIndex: 0, initialPauseMs: 0 });

  const firstLevel = machine.readPort(0xfe) & 0x40;
  machine.cpu.tStates += 2168;
  const secondLevel = machine.readPort(0xfe) & 0x40;

  assert.notEqual(firstLevel, secondLevel);
});

test("tape playback from the cursor waits for the previous block pause", () => {
  const blocks = parseTzx(makeTzx([
    standardTzxBlock(dataBlock([0x00]).slice(2), 2),
    standardTzxBlock(dataBlock([0xff]).slice(2), 0)
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks, { cursor: 1 });
  machine.startTapePlaybackFromCursor();

  const firstLevel = machine.readPort(0xfe) & 0x40;
  machine.cpu.tStates += 6999;
  assert.equal(machine.readPort(0xfe) & 0x40, firstLevel);

  machine.cpu.tStates += 2169;
  assert.notEqual(machine.readPort(0xfe) & 0x40, firstLevel);
});


function le16(value) { return [value & 0xff, (value >> 8) & 0xff]; }
function le24(value) { return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]; }
function le32(value) { return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]; }
function turboTzxBlock(bytes, options = {}) {
  const pilotPulse = options.pilotPulse ?? 2168, sync1 = options.sync1 ?? 667, sync2 = options.sync2 ?? 735;
  const zero = options.zero ?? 855, one = options.one ?? 1710, pilotCount = options.pilotCount ?? 2824;
  const usedBitsLastByte = options.usedBitsLastByte ?? 8, pauseMs = options.pauseMs ?? 0;
  return [0x11, ...le16(pilotPulse), ...le16(sync1), ...le16(sync2), ...le16(zero), ...le16(one),
    ...le16(pilotCount), usedBitsLastByte, ...le16(pauseMs), ...le24(bytes.length), ...bytes];
}
function generalizedFastTzxBlock(data) {
  const body = [...le16(0), ...le32(2), 2, 2, ...le32(data.length * 8), 1, 2,
    0, ...le16(1710), ...le16(1710), 0, ...le16(667), ...le16(735),
    0, ...le16(128), 1, ...le16(1), 0, ...le16(855), 0, ...le16(1710), ...data];
  return [0x19, ...le32(body.length), ...body];
}
function pureToneTzxBlock(pulseTStates, pulseCount) {
  return [0x12, ...le16(pulseTStates), ...le16(pulseCount)];
}
function pulseSequenceTzxBlock(pulses) {
  return [0x13, pulses.length, ...pulses.flatMap(le16)];
}
function pureDataTzxBlock(data, { zero = 855, one = 1710, usedBitsLastByte = 8, pauseMs = 0 } = {}) {
  return [0x14, ...le16(zero), ...le16(one), usedBitsLastByte, ...le16(pauseMs), ...le24(data.length), ...data];
}
function directRecordingTzxBlock(data, { sampleTStates = 79, usedBitsLastByte = 8, pauseMs = 0 } = {}) {
  return [0x15, ...le16(sampleTStates), ...le16(pauseMs), usedBitsLastByte, ...le24(data.length), ...data];
}

test("plays TZX pure tone and pulse sequence blocks", () => {
  const blocks = parseTzx(makeTzx([
    pureToneTzxBlock(100, 3),
    pulseSequenceTzxBlock([10, 20, 30])
  ]));
  assert.deepEqual(blocks.map((block) => block.type), ["pure-tone", "pulse-sequence"]);

  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  const tone = machine.buildTapeBlockPulseSequence(0, 0, false);
  assert.deepEqual(Array.from(tone.durations), [100, 100, 100]);
  assert.deepEqual(Array.from(tone.levels), [0, 1, 0]);
  const sequence = machine.buildTapeBlockPulseSequence(1, 0, tone.endingLevel);
  assert.deepEqual(Array.from(sequence.durations), [10, 20, 30]);
  assert.deepEqual(Array.from(sequence.levels), [1, 0, 1]);
});

test("plays TZX pure-data bits without pilot or sync pulses", () => {
  const [block] = parseTzx(makeTzx([
    pureDataTzxBlock([0x80], { zero: 20, one: 40, usedBitsLastByte: 2 })
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks([block]);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0, false);

  assert.equal(block.type, "pure-data");
  assert.deepEqual(Array.from(sequence.durations), [40, 40, 20, 20]);
  assert.deepEqual(Array.from(sequence.levels), [0, 1, 0, 1]);
});

test("plays TZX direct recording as literal EAR sample levels", () => {
  const [block] = parseTzx(makeTzx([
    directRecordingTzxBlock([0xa0], { sampleTStates: 5, usedBitsLastByte: 4 })
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks([block]);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0, false);

  assert.equal(block.type, "direct-recording");
  assert.deepEqual(Array.from(sequence.durations), [5, 5, 5, 5]);
  assert.deepEqual(Array.from(sequence.levels), [1, 0, 1, 0]);
  assert.equal(sequence.endingLevel, false);
});

test("honours TZX set-level and stop-if-48K control blocks", () => {
  const blocks = parseTzx(makeTzx([
    [0x2b, ...le32(1), 1],
    pureToneTzxBlock(100, 2),
    [0x2a, ...le32(0)],
    pureToneTzxBlock(200, 2)
  ]));
  assert.deepEqual(blocks.map((block) => block.type), ["set-signal-level", "pure-tone", "stop-48k", "pure-tone"]);

  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  machine.startTapePlayback();
  assert.equal(machine.tapePlaybackBlockIndex, 1);
  assert.equal(machine.tapePulseLevels[0], 1);

  const duration = machine.tapePulseDurations.reduce((sum, value) => sum + value, 0);
  machine.cpu.tStates = duration;
  machine.advanceTapePlayback();
  assert.equal(machine.tapePlaying, false);
  assert.equal(machine.tapeCursor, 3);
});

test("names unsupported TZX signal blocks precisely", () => {
  assert.throws(() => parseTzx(makeTzx([[0x18]])), /0x18 \(CSW recording\)/);
});

test("parses TZX turbo blocks with their recorded timings", () => {
  const blocks = parseTzx(makeTzx([turboTzxBlock(dataBlock([0x80]).slice(2), { pilotCount: 2420, pauseMs: 0 })]));
  assert.equal(blocks[0].type, "turbo");
  assert.equal(blocks[0].fastLoadable, true);
  assert.equal(blocks[0].timing.pilotPulse, 2168);
  assert.equal(blocks[0].timing.pilotCount, 2420);
  assert.equal(blocks[0].timing.zero, 855);
  assert.equal(blocks[0].timing.one, 1710);
});

test("plays TZX turbo blocks using their recorded timings", () => {
  const raw = dataBlock([0x80]).slice(2);
  const blocks = parseTzx(makeTzx([turboTzxBlock(raw, {pilotPulse:1000,sync1:200,sync2:300,zero:400,one:800,pilotCount:2})]));
  const machine = makeMachine(); machine.setTapeBlocks(blocks);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0);
  assert.deepEqual(Array.from(sequence.durations.slice(0, 4)), [1000,1000,200,300]);
  assert.equal(sequence.durations[4], 800);
  assert.equal(sequence.durations[5], 800);
});

test("parses and expands generalized TZX fast-loader data", () => {
  const blocks = parseTzx(makeTzx([generalizedFastTzxBlock([0x80])]));
  const machine = makeMachine(); machine.setTapeBlocks(blocks);
  const sequence = machine.buildTapeBlockPulseSequence(0, 0);
  assert.equal(blocks[0].type, "generalized");
  assert.equal(blocks[0].generalized.pilotStream[0].repetitions, 128);
  assert.equal(blocks[0].generalized.dataSymbolCount, 8);
  assert.equal(sequence.durations.length, 266);
  assert.deepEqual(Array.from(sequence.durations.slice(0,256)), new Array(256).fill(1710));
  assert.deepEqual(Array.from(sequence.durations.slice(256,258)), [667,735]);
  assert.deepEqual(Array.from(sequence.durations.slice(258)), [1710,855,855,855,855,855,855,855]);
  assert.equal(sequence.levels.length, sequence.durations.length);
});


test("ZX Carrom-style zero-gap TZX streams blocks without losing EAR phase", () => {
  const blocks = parseTzx(makeTzx([
    turboTzxBlock(dataBlock([0x80]).slice(2), { pilotCount: 2824, pauseMs: 0 }),
    turboTzxBlock(dataBlock([0x40]).slice(2), { pilotCount: 2420, pauseMs: 0 }),
    generalizedFastTzxBlock([0x80, 0x00]),
    generalizedFastTzxBlock([0x40, 0x00])
  ]));
  const machine = makeMachine();
  machine.setTapeBlocks(blocks);
  const first = machine.buildTapeBlockPulseSequence(0, 0, false);
  machine.startTapePlayback();

  const firstDuration = machine.tapePulseDurations.reduce((sum, duration) => sum + duration, 0);
  assert.equal(machine.tapePlaybackBlockIndex, 0);
  assert.equal(machine.tapePulseDurations.length, first.durations.length);

  machine.cpu.tStates = firstDuration;
  machine.advanceTapePlayback();

  assert.equal(machine.tapePlaybackBlockIndex, 1);
  assert.equal(machine.tapeCursor, 1);
  assert.equal(Boolean(machine.tapePulseLevels[0]), first.endingLevel);
  assert.equal(machine.tapePlaying, true);
});
