import { BeeperAudio } from "./audio.js";
import { ASSEMBLER_REFERENCE } from "./assembler-reference.js";
import { exportBasicProgram, loadBasicProgram, renumberBasicProgram } from "./basic.js";
import {
  disassembleWindow,
  hexByte,
  hexWord,
  readBasicStatus,
  readMemoryRows,
  readSystemVariables
} from "./debugger.js";
import { MachineHistory } from "./history.js";
import { initializeDebugWindows } from "./debug-windows.js";
import { Spectrum48 } from "../src/spectrum48.js";
import {
  basicTextToSpectrumKeyTaps,
  shouldCaptureModernKeyEvent,
  shouldPreventBrowserScrollKey,
  spectrumKeysForModernKey
} from "./keyboard.js?v=20261005-play-first";
import { applySpectrumSnapshot, createZ80Snapshot } from "./snapshot.js";
import { parseRzx, RzxPlayback } from "./rzx.js";
import { parseTapeFile } from "./tape.js?v=20261004-tzx-url";
import { unwrapSpectrumMedia } from "./media.js?v=20261005-unified-media";
import { normalizeRemoteFileUrl, normalizeTapeUrl } from "./tape-url.js?v=20261005-zxinfo-mirror";

const canvas = document.querySelector("#screen");
const context = canvas.getContext("2d");
const frameImageData = context.createImageData(Spectrum48.FRAME_WIDTH, Spectrum48.FRAME_HEIGHT);
const rasterOverlay = document.querySelector("#rasterOverlay");
const audioStartGate = document.querySelector("#audioStartGate");
const rasterContext = rasterOverlay.getContext("2d");
const statusOutput = document.querySelector("#status");
const frameOutput = document.querySelector("#frame");
const pcOutput = document.querySelector("#pc");
const borderOutput = document.querySelector("#border");
const rasterLineOutput = document.querySelector("#rasterLine");
const rasterColumnOutput = document.querySelector("#rasterColumn");
const rasterTStateOutput = document.querySelector("#rasterTState");
const screenRasterOutput = document.querySelector("#screenRaster");
const lastKeyOutput = document.querySelector("#lastKey");
const mappedKeysOutput = document.querySelector("#mappedKeys");
const heldKeysOutput = document.querySelector("#heldKeys");
const runPauseButton = document.querySelector("#runPause");
const stepFrameButton = document.querySelector("#stepFrame");
const stepInstructionButton = document.querySelector("#stepInstruction");
const stepBackButton = document.querySelector("#stepBack");
const rewindTimelineInput = document.querySelector("#rewindTimeline");
const rewindDepthOutput = document.querySelector("#rewindDepth");
const resetButton = document.querySelector("#reset");
const typeHelloButton = document.querySelector("#typeHello");
const audioToggleButton = document.querySelector("#audioToggle");
const romFileInput = document.querySelector("#romFile");
const immediateScreenInput = document.querySelector("#immediateScreen");
const showRasterOverlayInput = document.querySelector("#showRasterOverlay");
const pasteForm = document.querySelector("#pasteForm");
const pasteTextInput = document.querySelector("#pasteText");
const basicFileInput = document.querySelector("#basicFile");
const basicExportButton = document.querySelector("#basicExport");
const mediaFileInput = document.querySelector("#mediaFile");
const mediaUrlInput = document.querySelector("#mediaUrl");
const mediaUrlLoadButton = document.querySelector("#mediaUrlLoad");
const mediaStatusOutput = document.querySelector("#mediaStatus");
const mediaFileLabelOutput = document.querySelector("#mediaFileLabel");
const snapshotSaveButton = document.querySelector("#snapshotSave");
const rzxStepButton = document.querySelector("#rzxStep");
const rzxPlayPauseButton = document.querySelector("#rzxPlayPause");
const rzxStatusOutput = document.querySelector("#rzxStatus");
const toolTabButtons = document.querySelectorAll("[data-tool-tab]");
const toolPanels = document.querySelectorAll("[data-tool-panel]");
const registerGrid = document.querySelector("#registerGrid");
const flagGrid = document.querySelector("#flagGrid");
const basicStatusPanel = document.querySelector("#basicStatus");
const disassemblyPanel = document.querySelector("#disassembly");
const memoryInspector = document.querySelector("#memoryInspector");
const sourceFileInput = document.querySelector("#sourceFile");
const sourceListing = document.querySelector("#sourceListing");
const assemblerSearchInput = document.querySelector("#assemblerSearch");
const assemblerCategoryInput = document.querySelector("#assemblerCategory");
const assemblerReference = document.querySelector("#assemblerReference");
const softKeyboard = document.querySelector("#spectrumKeyboard");
const advancedToolsDetails = document.querySelector("#advancedTools");
const debugWorkbenchDetails = document.querySelector("#debugWorkbench");

let rom;
let machine;
let audio;
let audioEnabled = true;
const TAPE_TURBO_BUDGET_MS = 8;
const SPECTRUM_FRAME_MS = 20;
const MAX_FRAME_CATCHUP = 5;
let running = true;
let flashOn = false;
let physicalShiftDown = false;
const activeChords = new Map();
let lastModernKey = "-";
let lastMappedKeys = [];
const executionHistory = new MachineHistory({ limit: 6000, byteLimit: 64 * 1024 * 1024 });
let rzxPlayback;
let rzxPlaying = false;
let sourceRows = [];
let assemblerReferenceInitialized = false;
let lastDrawTime;
let frameAccumulatorMs = 0;
let mediaRequestGeneration = 0;
let mediaRequestController;

initializeDebugWindows({ onStatus: (message) => { statusOutput.value = message; } });

function formatWord(value) {
  return value.toString(16).padStart(4, "0").toUpperCase();
}

function renderKeyValueGrid(container, rows, className = "") {
  container.replaceChildren(
    ...rows.map(([label, value]) => {
      const item = document.createElement("div");
      if (className) item.className = className;
      const labelElement = document.createElement("span");
      labelElement.textContent = label;
      const valueElement = document.createElement("strong");
      valueElement.textContent = value;
      item.append(labelElement, valueElement);
      return item;
    })
  );
}

async function loadRom() {
  const response = await fetch(new URL("../ROM/48.rom", import.meta.url));
  if (!response.ok) throw new Error(`ROM load failed: ${response.status}`);
  rom = new Uint8Array(await response.arrayBuffer());
}

function resetMachine() {
  const insertedTape = machine?.tapeBlocks ?? [];
  machine = new Spectrum48({ rom });
  if (insertedTape.length > 0) machine.setTapeBlocks(insertedTape, { cursor: 0 });
  running = true;
  frameAccumulatorMs = 0;
  runPauseButton.textContent = "Pause";
  runPauseButton.setAttribute("aria-label", "Pause");
  clearInputState();
  audio?.reset(machine.cpu.tStates);
  clearExecutionHistory();
  clearRzxPlayback();
  statusOutput.value = "Running";
}

function mountRom(bytes, message) {
  const nextRom = Uint8Array.from(bytes);
  const insertedTape = machine?.tapeBlocks ?? [];
  const nextMachine = new Spectrum48({ rom: nextRom });
  if (insertedTape.length > 0) nextMachine.setTapeBlocks(insertedTape, { cursor: 0 });

  rom = nextRom;
  machine = nextMachine;
  running = true;
  runPauseButton.textContent = "Pause";
  runPauseButton.setAttribute("aria-label", "Pause");
  audio?.reset(machine.cpu.tStates);
  clearExecutionHistory();
  clearRzxPlayback();
  statusOutput.value = message;
  refreshDebugDisplay();
}

function updateHistoryControls() {
  stepBackButton.disabled = executionHistory.size === 0;
  rewindTimelineInput.disabled = executionHistory.size === 0;
  rewindTimelineInput.max = String(executionHistory.size);
  if (document.activeElement !== rewindTimelineInput) rewindTimelineInput.value = String(executionHistory.size);
  rewindDepthOutput.value = `${executionHistory.size} checkpoint${executionHistory.size === 1 ? "" : "s"}`;
}

function clearExecutionHistory() {
  executionHistory.clear();
  updateHistoryControls();
}

function captureExecutionState(label) {
  executionHistory.capture(machine, label, rzxPlayback
    ? { rzxEventIndex: rzxPlayback.eventIndex, rzxFrameIndex: rzxPlayback.frameIndex }
    : null);
  updateHistoryControls();
}

function clearRzxPlayback() {
  rzxPlayback = undefined;
  rzxPlaying = false;
  if (!rzxStepButton) return;
  rzxStepButton.disabled = true;
  rzxPlayPauseButton.disabled = true;
  rzxPlayPauseButton.textContent = "Play RZX";
  rzxStatusOutput.value = "No RZX recording loaded";
}

function pumpAudio() {
  const events = machine.drainBeeperEvents();
  if (!audioEnabled || !audio) return;
  audio.push(events, machine.cpu.tStates);
}

function runMachineFrame({ audioOutput = true } = {}) {
  machine.runFrame();
  if (audioOutput) pumpAudio();
  else machine.drainBeeperEvents();
}

function runFastTapeBurst() {
  const started = performance.now();
  do {
    machine.runFrame();
    machine.drainBeeperEvents();
  } while (machine.tapePlaying && performance.now() - started < TAPE_TURBO_BUDGET_MS);
  if (!machine.tapePlaying && audio) audio.reset(machine.cpu.tStates);
}

function stepInstruction() {
  machine.step();
  pumpAudio();
}

function runFrames(count, { audioOutput = false } = {}) {
  for (let frame = 0; frame < count; frame += 1) {
    runMachineFrame({ audioOutput });
  }
  if (!audioOutput) audio?.reset(machine.cpu.tStates);
}

function drawSpectrumScreen() {
  machine.renderFrameRgba({ flashOn, target: frameImageData.data });
  context.putImageData(frameImageData, 0, 0);
  if (advancedToolsDetails?.open && showRasterOverlayInput.checked) drawRasterOverlay();
}

function drawRasterOverlay() {
  rasterContext.clearRect(0, 0, rasterOverlay.width, rasterOverlay.height);
  if (!showRasterOverlayInput.checked || !machine) return;

  const raster = machine.getRasterPosition();
  if (!raster.inVisibleFrame) return;
  rasterContext.save();
  rasterContext.strokeStyle = "rgba(243, 212, 71, 0.95)";
  rasterContext.fillStyle = "rgba(243, 212, 71, 0.95)";
  rasterContext.lineWidth = 1;
  rasterContext.shadowColor = "rgba(243, 212, 71, 0.85)";
  rasterContext.shadowBlur = 5;
  rasterContext.beginPath();
  rasterContext.moveTo(0, raster.visibleY + 0.5);
  rasterContext.lineTo(Spectrum48.FRAME_WIDTH, raster.visibleY + 0.5);
  rasterContext.stroke();
  rasterContext.beginPath();
  rasterContext.arc(raster.visibleX, raster.visibleY, 3, 0, Math.PI * 2);
  rasterContext.fill();
  rasterContext.restore();
}

function updateRasterTelemetry() {
  const raster = machine.getRasterPosition();
  rasterLineOutput.textContent = String(raster.line);
  rasterColumnOutput.textContent = String(raster.column);
  rasterTStateOutput.textContent = String(raster.tStateInFrame);
  screenRasterOutput.value = `Raster ${raster.line}:${raster.column} · T ${raster.tStateInFrame}`;
}

function refreshDebugDisplay() {
  drawSpectrumScreen();
  if (!advancedToolsDetails?.open) return;
  updateRasterTelemetry();
  if (debugWorkbenchDetails?.open) updateDebugger();
}

function tapSpectrumKeys(keys, holdFrames = 4, gapFrames = 4) {
  for (const key of keys) machine.pressKey(key);
  runFrames(holdFrames);
  for (const key of keys) machine.releaseKey(key);
  runFrames(gapFrames);
}

function typeHelloWorldProgram() {
  resetMachine();
  runFrames(180);

  const sequence = [
    ["1"],
    ["0"],
    ["P"],
    ["SYMBOL SHIFT", "P"],
    ["H"],
    ["E"],
    ["L"],
    ["L"],
    ["O"],
    ["SPACE"],
    ["W"],
    ["O"],
    ["R"],
    ["L"],
    ["D"],
    ["SYMBOL SHIFT", "P"],
    ["ENTER"],
    ["R"],
    ["ENTER"]
  ];

  for (const keys of sequence) tapSpectrumKeys(keys);
  runFrames(60);
  statusOutput.value = "HELLO WORLD typed";
}

function typeModernText(text, { reset = false } = {}) {
  if (reset) {
    resetMachine();
    runFrames(180);
  }

  let normalizedText = String(text).replace(/\r\n?/g, "\n");
  let lines = normalizedText.split("\n");
  let numberedLines = lines.filter((line) => /^\s*\d+/.test(line));
  let commandLines = lines.filter((line) => line.trim() && !/^\s*\d+/.test(line));
  let didRenumber = false;

  if (numberedLines.length > 0) {
    try {
      loadBasicProgram(machine, numberedLines.join("\n"));
    } catch (error) {
      if (!/Invalid BASIC line number/.test(error.message)) throw error;
      normalizedText = renumberBasicProgram(normalizedText);
      pasteTextInput.value = normalizedText;
      lines = normalizedText.split("\n");
      numberedLines = lines.filter((line) => /^\s*\d+/.test(line));
      commandLines = lines.filter((line) => line.trim() && !/^\s*\d+/.test(line));
      loadBasicProgram(machine, numberedLines.join("\n"));
      didRenumber = true;
    }
  }

  const commandText = commandLines.length > 0 ? `${commandLines.join("\n")}\n` : "RUN\n";
  const submittedText = numberedLines.length > 0 ? commandText : /\r?\n$/.test(text) ? text : `${text}\n`;
  const taps = basicTextToSpectrumKeyTaps(submittedText);
  for (const keys of taps) tapSpectrumKeys(keys);
  runFrames(20);
  statusOutput.value = numberedLines.length > 0 && didRenumber
    ? `Renumbered and loaded ${numberedLines.length} lines, typed ${taps.length} keys`
    : numberedLines.length > 0
      ? `Loaded ${numberedLines.length} lines, typed ${taps.length} keys`
    : `Typed ${taps.length} keys`;
}

function typeCommand(text) {
  const submittedText = /\n$/.test(text) ? text : `${text}\n`;
  const taps = basicTextToSpectrumKeyTaps(submittedText);
  for (const keys of taps) tapSpectrumKeys(keys);
  runFrames(20);
  return taps.length;
}

function shortMediaName(value) {
  const label = String(value ?? "media");
  try {
    const pathname = new URL(label, window.location.href).pathname;
    const name = pathname.split("/").pop();
    return name ? decodeURIComponent(name) : label;
  } catch {
    return label.split(/[\\/]/).pop() || label;
  }
}

function displayMediaName(media) {
  const name = shortMediaName(media.name);
  return media.archive ? `${shortMediaName(media.archive)} → ${name}` : name;
}

function setLoadedMediaLabel(label) {
  mediaFileLabelOutput.textContent = label || "No media loaded";
}

function mountTapeBytes(input, label = "tape") {
  const blocks = parseTapeFile(input);
  machine.setTapeBlocks(blocks);
  setLoadedMediaLabel(label);
  statusOutput.value = "Mounted " + blocks.length + " tape block" + (blocks.length === 1 ? "" : "s") + " from " + label;
  return blocks;
}

function autoloadMountedTape() {
  resetMachine();
  running = true;
  runPauseButton.textContent = "Pause";
  runPauseButton.setAttribute("aria-label", "Pause");
  runFrames(180);
  const taps = basicTextToSpectrumKeyTaps('LOAD ""');
  for (const keys of taps) tapSpectrumKeys(keys);
  machine.setTapeCursor(0);
  machine.startTapePlayback({ startIndex: 0, initialPauseMs: SPECTRUM_FRAME_MS * 4 });
  tapSpectrumKeys(["ENTER"], 2, 2);
  statusOutput.value = 'Autoload started with LOAD ""';
}

function audioIsRunning() {
  return audio?.context?.state === "running";
}

function prepareAutoloadAudio() {
  if (!audioEnabled) return true;
  try {
    audio ??= new BeeperAudio();
    if (!audioIsRunning()) return false;
    audio.reset(machine.cpu.tStates);
    return true;
  } catch (error) {
    statusOutput.value = error.message;
    return true;
  }
}

function mediaAbortError() {
  const error = new Error("Media load superseded by a newer request");
  error.name = "AbortError";
  return error;
}

function isMediaAbort(error) {
  return error?.name === "AbortError";
}

function beginMediaRequest() {
  mediaRequestController?.abort();
  const controller = new AbortController();
  const request = { generation: ++mediaRequestGeneration, controller };
  mediaRequestController = controller;
  return request;
}

function mediaRequestIsCurrent(request) {
  return request.generation === mediaRequestGeneration && !request.controller.signal.aborted;
}

function assertCurrentMediaRequest(request) {
  if (!mediaRequestIsCurrent(request)) throw mediaAbortError();
}

function finishMediaRequest(request) {
  if (mediaRequestIsCurrent(request)) mediaRequestController = undefined;
}

function clearStartupMediaQuery() {
  const url = new URL(window.location.href);
  const hadStartupMedia = url.searchParams.has("tape") || url.searchParams.has("autoload");
  if (!hadStartupMedia) return;
  url.searchParams.delete("tape");
  url.searchParams.delete("autoload");
  history.replaceState(history.state, "", url.href);
}

function waitForAutoloadAudioGesture(signal) {
  audioStartGate.hidden = false;
  statusOutput.value = "Tap to start with sound";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audioStartGate.removeEventListener("click", startWithSound);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      audioStartGate.hidden = true;
      audioStartGate.disabled = false;
      reject(mediaAbortError());
    };
    const startWithSound = async () => {
      audioStartGate.disabled = true;
      try {
        audio ??= new BeeperAudio();
        await audio.resume();
        if (!audioIsRunning()) throw new Error("Audio is still blocked");
        if (signal?.aborted) throw mediaAbortError();
        audio.reset(machine.cpu.tStates);
        audioStartGate.hidden = true;
        audioStartGate.disabled = false;
        cleanup();
        resolve();
      } catch (error) {
        if (isMediaAbort(error)) {
          cancel();
          return;
        }
        audioStartGate.disabled = false;
        audioStartGate.querySelector("small").textContent = "Audio is still blocked. Tap again.";
        statusOutput.value = "Waiting for sound";
      }
    };

    audioStartGate.addEventListener("click", startWithSound);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function loadTapeQueryParameters() {
  const params = new URLSearchParams(window.location.search);
  const tapeUrl = params.get("tape");
  if (!tapeUrl) return;

  const request = beginMediaRequest();
  try {
    await loadSpectrumMedia(tapeUrl, {
      requireTape: true,
      deferTapeAutoload: true,
      request
    });
    if (!prepareAutoloadAudio()) await waitForAutoloadAudioGesture(request.controller.signal);
    assertCurrentMediaRequest(request);
    autoloadMountedTape();
  } finally {
    finishMediaRequest(request);
  }
}

function clearMountedTape() {
  machine.clearTape();
}

function loadSnapshotBytes(input, label, type) {
  const snapshot = applySpectrumSnapshot(machine, input, type);
  clearMountedTape();
  audio?.reset(machine.cpu.tStates);
  clearExecutionHistory();
  clearRzxPlayback();
  statusOutput.value = `Loaded ${snapshot.format} snapshot ${label}`;
  refreshDebugDisplay();
  return snapshot;
}

async function loadRzxBytes(input, label, { beforeApply = () => {} } = {}) {
  const recording = await parseRzx(input);
  beforeApply();
  clearMountedTape();
  rzxPlayback = new RzxPlayback(machine, recording);
  rzxPlaying = false;
  running = false;
  runPauseButton.textContent = "Run";
  runPauseButton.setAttribute("aria-label", "Run");
  clearExecutionHistory();
  rzxStepButton.disabled = false;
  rzxPlayPauseButton.disabled = false;
  rzxPlayPauseButton.textContent = "Play RZX";
  rzxStatusOutput.value = `0/${recording.frameCount} frames · ${recording.creator}`;
  statusOutput.value = `Loaded RZX ${label}`;
  refreshDebugDisplay();
  return recording;
}

async function loadSpectrumMedia(source, {
  label = "media",
  requireTape = false,
  deferTapeAutoload = false,
  request
} = {}) {
  let input = source;
  let sourceLabel = label;
  let resolvedUrl = null;

  if (typeof source === "string") {
    resolvedUrl = normalizeRemoteFileUrl(source, window.location.href, "Media");
    statusOutput.value = "Fetching media from " + resolvedUrl;
    const response = await fetch(resolvedUrl, {
      mode: "cors",
      signal: request?.controller.signal
    });
    if (!response.ok) throw new Error("Media fetch failed: HTTP " + response.status);
    input = await response.arrayBuffer();
    sourceLabel = response.url || resolvedUrl;
  } else if (source && typeof source.arrayBuffer === "function") {
    input = await source.arrayBuffer();
    sourceLabel = source.name || label;
  }

  if (request) assertCurrentMediaRequest(request);
  const media = await unwrapSpectrumMedia(input, sourceLabel);
  if (request) assertCurrentMediaRequest(request);
  const displayLabel = displayMediaName(media);
  if (requireTape && media.type !== "tap" && media.type !== "tzx") {
    throw new Error(`Tape URL contains ${media.type.toUpperCase()} media, not TAP/TZX`);
  }

  if (media.type === "tap" || media.type === "tzx") {
    if (request) assertCurrentMediaRequest(request);
    clearRzxPlayback();
    mountTapeBytes(media.bytes, displayLabel);
    if (!deferTapeAutoload) autoloadMountedTape();
    return { media, resolvedUrl };
  }
  if (media.type === "sna" || media.type === "z80") {
    if (request) assertCurrentMediaRequest(request);
    loadSnapshotBytes(media.bytes, displayLabel, media.type);
    setLoadedMediaLabel(displayLabel);
    return { media, resolvedUrl };
  }
  if (media.type === "rzx") {
    await loadRzxBytes(media.bytes, displayLabel, {
      beforeApply: () => request && assertCurrentMediaRequest(request)
    });
    setLoadedMediaLabel(displayLabel);
    return { media, resolvedUrl };
  }
  throw new Error(`Unsupported Spectrum media type ${media.type}`);
}

async function replaceSpectrumMedia(source, options = {}) {
  const request = beginMediaRequest();
  try {
    const result = await loadSpectrumMedia(source, { ...options, request });
    assertCurrentMediaRequest(request);
    clearStartupMediaQuery();
    return result;
  } finally {
    finishMediaRequest(request);
  }
}

function clearMediaError() {
  mediaStatusOutput.textContent = "";
  mediaStatusOutput.hidden = true;
}

function mediaErrorMessage(error) {
  const message = String(error?.message ?? error ?? "Media load failed");
  if (/^(load failed|failed to fetch|network request failed|networkerror when attempting to fetch resource\.?|the internet connection appears to be offline\.?)/i.test(message)
      || /fetch failed/i.test(message)) {
    return "Could not load this URL. The remote server blocked browser access (CORS), or the network request failed. Download the file and use From device instead.";
  }
  return message;
}

function showMediaError(error) {
  mediaStatusOutput.textContent = mediaErrorMessage(error);
  mediaStatusOutput.hidden = false;
}

function downloadBytes(bytes, filename, type = "application/octet-stream") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function selectToolPanel(name) {
  for (const button of toolTabButtons) {
    const selected = button.dataset.toolTab === name;
    button.setAttribute("aria-selected", String(selected));
  }

  for (const panel of toolPanels) {
    const selected = panel.dataset.toolPanel === name;
    panel.hidden = !selected;
    panel.classList.toggle("active", selected);
  }
}

function runRzxFrame(advancedActive = false) {
  try {
    if (advancedActive) captureExecutionState("RZX frame");
    const frame = rzxPlayback.stepFrame();
    pumpAudio();
    if (!frame || rzxPlayback.done) {
      rzxPlaying = false;
      running = false;
      rzxPlayPauseButton.textContent = "Play RZX";
      statusOutput.value = `RZX playback complete (${rzxPlayback.frameIndex} frames)`;
    }
    rzxStatusOutput.value = `${rzxPlayback.frameIndex}/${rzxPlayback.recording.frameCount} frames`;
  } catch (error) {
    rzxPlaying = false;
    running = false;
    rzxPlayPauseButton.textContent = "Play RZX";
    statusOutput.value = error.message;
  }
}

function draw(timestamp) {
  if (!machine) return;
  const advancedActive = advancedToolsDetails?.open === true;
  const now = Number.isFinite(timestamp) ? timestamp : performance.now();
  if (lastDrawTime === undefined) lastDrawTime = now;
  const elapsed = Math.max(0, Math.min(now - lastDrawTime, SPECTRUM_FRAME_MS * MAX_FRAME_CATCHUP));
  lastDrawTime = now;

  if (running) {
    if (machine.tapePlaying && !rzxPlaying) {
      frameAccumulatorMs = 0;
      runFastTapeBurst();
    } else {
      frameAccumulatorMs += elapsed;
      let frames = 0;
      while (frameAccumulatorMs >= SPECTRUM_FRAME_MS && frames < MAX_FRAME_CATCHUP && running) {
        if (rzxPlaying && rzxPlayback) runRzxFrame(advancedActive);
        else {
          if (advancedActive) captureExecutionState("Frame");
          runMachineFrame();
        }
        frameAccumulatorMs -= SPECTRUM_FRAME_MS;
        frames += 1;
      }
    }
    flashOn = Math.floor(machine.frame / 16) % 2 === 1;
  } else {
    frameAccumulatorMs = 0;
    machine.drainBeeperEvents();
  }

  drawSpectrumScreen();

  if (advancedActive) {
    frameOutput.textContent = String(machine.frame);
    pcOutput.textContent = formatWord(machine.cpu.PC);
    borderOutput.textContent = String(machine.borderColor);
    updateRasterTelemetry();
    lastKeyOutput.textContent = lastModernKey;
    mappedKeysOutput.textContent = lastMappedKeys.length ? lastMappedKeys.join(" + ") : "-";
    heldKeysOutput.textContent = machine.getPressedKeys().join(" + ") || "-";
    if (debugWorkbenchDetails?.open) updateDebugger();
  }

  requestAnimationFrame(draw);
}
function updateDebugger() {
  const state = machine.cpu.getState();
  const registers = state.registers;
  renderKeyValueGrid(registerGrid, [
    ["AF", hexWord(registers.AF)],
    ["BC", hexWord(registers.BC)],
    ["DE", hexWord(registers.DE)],
    ["HL", hexWord(registers.HL)],
    ["IX", hexWord(registers.IX)],
    ["IY", hexWord(registers.IY)],
    ["SP", hexWord(registers.SP)],
    ["PC", hexWord(registers.PC)],
    ["I", hexByte(registers.I)],
    ["R", hexByte(registers.R)],
    ["IM", String(state.interruptMode)],
    ["T", String(state.tStates)]
  ], "register-cell");

  flagGrid.replaceChildren(
    ...["S", "Z", "Y", "H", "X", "PV", "N", "C"].map((flag) => {
      const flagElement = document.createElement("span");
      flagElement.className = state.flags[flag] ? "flag on" : "flag";
      flagElement.textContent = flag;
      return flagElement;
    })
  );

  const basic = readBasicStatus(machine);
  const pointerRows = Object.entries(basic.pointers).map(([name, value]) => [name, hexWord(value)]);
  renderKeyValueGrid(basicStatusPanel, [
    ["ERR", basic.errText],
    ["LINE", String(basic.currentLine)],
    ["SUB", String(basic.subStatement)],
    ...pointerRows
  ], "basic-cell");

  disassemblyPanel.replaceChildren(
    ...disassembleWindow((address) => machine.read8(address), registers.PC, { beforeBytes: 6, count: 9 }).map((row) => {
      const item = document.createElement("li");
      item.className = row.isPc ? "current" : "";
      const address = document.createElement("span");
      address.className = "addr";
      address.textContent = hexWord(row.address);
      const bytes = document.createElement("span");
      bytes.className = "bytes";
      bytes.textContent = row.bytes.map(hexByte).join(" ");
      const text = document.createElement("span");
      text.className = "asm";
      text.textContent = row.text;
      item.append(address, bytes, text);
      return item;
    })
  );

  const memorySections = [
    ["PROG", basic.pointers.PROG, 3],
    ["VARS", basic.pointers.VARS, 2],
    ["E_LINE", basic.pointers.E_LINE, 2],
    ["Screen", 0x4000, 2],
    ["SysVars", 0x5c00, 4]
  ];
  memoryInspector.replaceChildren(
    ...memorySections.map(([title, address, rows]) => {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = `${title} ${hexWord(address)}`;
      const listing = document.createElement("pre");
      listing.textContent = readMemoryRows((readAddress) => machine.read8(readAddress), address, {
        rows,
        bytesPerRow: 8
      }).map((row) => `${hexWord(row.address)}  ${row.bytes.map(hexByte).join(" ")}`).join("\n");
      section.append(heading, listing);
      return section;
    })
  );

  const systemVariableRows = readSystemVariables(machine).slice(0, 6);
  const systemSection = document.createElement("section");
  const systemHeading = document.createElement("h3");
  systemHeading.textContent = "Pointers";
  const systemList = document.createElement("pre");
  systemList.textContent = systemVariableRows
    .map((item) => `${item.name.padEnd(6, " ")} ${hexWord(item.address)} ${item.size === 1 ? hexByte(item.value) : hexWord(item.value)}`)
    .join("\n");
  systemSection.append(systemHeading, systemList);
  memoryInspector.append(systemSection);
  highlightSourceLine(registers.PC);
}

function sourceAddress(line) {
  const match = line.match(/^\s*(?:\d+\s+)?(?:0x|\$)?([0-9a-f]{4})(?=[:\s])/i);
  return match ? Number.parseInt(match[1], 16) : null;
}

function renderSource(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  sourceListing.replaceChildren(...lines.map((line) => {
    const item = document.createElement("li");
    item.textContent = line || " ";
    const address = sourceAddress(line);
    if (address !== null) item.dataset.address = String(address);
    return item;
  }));
  sourceRows = Array.from(sourceListing.children);
  if (machine) highlightSourceLine(machine.cpu.PC);
}

function highlightSourceLine(pc) {
  for (const row of sourceRows) {
    row.classList.toggle("current", Number(row.dataset.address) === pc);
  }
}

function renderAssemblerReference(query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedCategory = assemblerCategoryInput.value;
  const entries = ASSEMBLER_REFERENCE.filter((entry) =>
    (!selectedCategory || entry.category === selectedCategory)
    && (!normalizedQuery || `${entry.category} ${entry.syntax} ${entry.description}`.toLowerCase().includes(normalizedQuery))
  );
  assemblerReference.replaceChildren(...entries.map((entry) => {
    const article = document.createElement("article");
    const category = document.createElement("small");
    category.textContent = entry.category;
    const syntax = document.createElement("code");
    syntax.textContent = entry.syntax;
    const description = document.createElement("p");
    description.textContent = entry.description;
    article.append(category, syntax, description);
    return article;
  }));
  if (entries.length === 0) assemblerReference.textContent = "No matching directives or functions";
}

function stepRzxFrame() {
  if (!rzxPlayback || rzxPlayback.done) return;
  captureExecutionState("RZX frame");
  const frame = rzxPlayback.stepFrame();
  pumpAudio();
  rzxStatusOutput.value = `${rzxPlayback.frameIndex}/${rzxPlayback.recording.frameCount} frames`;
  if (!frame || rzxPlayback.done) {
    rzxStepButton.disabled = true;
    rzxPlayPauseButton.disabled = true;
    statusOutput.value = `RZX playback complete (${rzxPlayback.frameIndex} frames)`;
  } else {
    statusOutput.value = `RZX frame ${rzxPlayback.frameIndex}`;
  }
  refreshDebugDisplay();
}

const SOFT_MODIFIERS = new Set(["CAPS SHIFT", "SYMBOL SHIFT"]);
const softPointers = new Map();
const latchedSoftModifiers = new Set();

function clearInputState() {
  for (const key of machine?.getPressedKeys() ?? []) machine.releaseKey(key);
  activeChords.clear();
  physicalShiftDown = false;
  softPointers.clear();
  latchedSoftModifiers.clear();
  lastModernKey = "-";
  lastMappedKeys = [];
  for (const button of softKeyboard?.querySelectorAll("[data-spectrum-key]") ?? []) {
    button.classList.remove("is-pressed", "is-latched");
    if (button.classList.contains("modifier")) button.setAttribute("aria-pressed", "false");
  }
}

function updateSoftModifierButtons() {
  for (const button of softKeyboard?.querySelectorAll(".modifier") ?? []) {
    const pressed = latchedSoftModifiers.has(button.dataset.spectrumKey);
    button.classList.toggle("is-latched", pressed);
    button.setAttribute("aria-pressed", String(pressed));
  }
}

function consumeLatchedSoftModifiers() {
  for (const key of latchedSoftModifiers) machine?.releaseKey(key);
  latchedSoftModifiers.clear();
  updateSoftModifierButtons();
}

function releaseSoftPointer(pointerId) {
  const state = softPointers.get(pointerId);
  if (!state || !machine) return;
  softPointers.delete(pointerId);
  state.button.classList.remove("is-pressed");

  if (state.modifier) {
    if (state.usedInChord) machine.releaseKey(state.key);
    else latchedSoftModifiers.add(state.key);
    updateSoftModifierButtons();
    return;
  }

  machine.releaseKey(state.key);
  consumeLatchedSoftModifiers();
}

for (const button of softKeyboard?.querySelectorAll("[data-spectrum-key]") ?? []) {
  button.addEventListener("pointerdown", (event) => {
    if (!machine) return;
    event.preventDefault();
    const key = button.dataset.spectrumKey;
    const modifier = SOFT_MODIFIERS.has(key);

    if (modifier && latchedSoftModifiers.has(key)) {
      machine.releaseKey(key);
      latchedSoftModifiers.delete(key);
      updateSoftModifierButtons();
      return;
    }

    for (const state of softPointers.values()) {
      if (state.modifier) state.usedInChord = true;
    }

    machine.pressKey(key);
    button.classList.add("is-pressed");
    softPointers.set(event.pointerId, { key, button, modifier, usedInChord: false });
    button.setPointerCapture?.(event.pointerId);
    lastModernKey = key;
    lastMappedKeys = [key];
  });

  button.addEventListener("pointerup", (event) => {
    event.preventDefault();
    releaseSoftPointer(event.pointerId);
  });
  button.addEventListener("pointercancel", (event) => releaseSoftPointer(event.pointerId));
  button.addEventListener("lostpointercapture", (event) => releaseSoftPointer(event.pointerId));
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

window.addEventListener("keydown", (event) => {
  if (!shouldCaptureModernKeyEvent(event)) return;
  if (shouldPreventBrowserScrollKey(event)) event.preventDefault();
  if (event.repeat) return;

  const keys = spectrumKeysForModernKey(event);
  if (keys?.length && machine) {
    event.preventDefault();
    lastModernKey = event.key === " " ? "Space" : event.key;
    lastMappedKeys = keys;
    activeChords.set(event.code, keys);
    if (keys[0] === "CAPS SHIFT" && keys.length === 1) physicalShiftDown = true;
    if (physicalShiftDown && keys.includes("SYMBOL SHIFT")) machine.releaseKey("CAPS SHIFT");
    for (const key of keys) machine.pressKey(key);
    return;
  }
});

window.addEventListener("keyup", (event) => {
  if (!shouldCaptureModernKeyEvent(event)) return;
  const keys = activeChords.get(event.code) ?? spectrumKeysForModernKey(event);
  if (keys?.length && machine) {
    event.preventDefault();
    activeChords.delete(event.code);
    for (const key of keys) machine.releaseKey(key);
    if (keys[0] === "CAPS SHIFT" && keys.length === 1) physicalShiftDown = false;
    if (physicalShiftDown && keys.includes("SYMBOL SHIFT")) machine.pressKey("CAPS SHIFT");
    return;
  }
});

window.addEventListener("blur", clearInputState);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInputState();
});

runPauseButton.addEventListener("click", () => {
  running = !running;
  runPauseButton.textContent = running ? "Pause" : "Run";
  runPauseButton.setAttribute("aria-label", running ? "Pause" : "Run");
  statusOutput.value = running ? "Running" : "Paused";
});

stepFrameButton.addEventListener("click", () => {
  running = false;
  rzxPlaying = false;
  rzxPlayPauseButton.textContent = "Play RZX";
  runPauseButton.textContent = "Run";
  runPauseButton.setAttribute("aria-label", "Run");
  captureExecutionState("Frame");
  runMachineFrame();
  if (immediateScreenInput.checked) refreshDebugDisplay();
  else updateDebugger();
  statusOutput.value = "Stepped one frame";
});

stepInstructionButton.addEventListener("click", () => {
  running = false;
  rzxPlaying = false;
  rzxPlayPauseButton.textContent = "Play RZX";
  runPauseButton.textContent = "Run";
  runPauseButton.setAttribute("aria-label", "Run");
  captureExecutionState("Instruction");
  stepInstruction();
  if (immediateScreenInput.checked) refreshDebugDisplay();
  else updateDebugger();
  statusOutput.value = "Stepped one instruction";
});

function reverseExecutionOnce() {
  running = false;
  rzxPlaying = false;
  runPauseButton.textContent = "Run";
  runPauseButton.setAttribute("aria-label", "Run");
  rzxPlayPauseButton.textContent = "Play RZX";
  const entry = executionHistory.stepBack(machine);
  if (!entry) return null;
  if (entry.metadata && rzxPlayback) {
    rzxPlayback.eventIndex = entry.metadata.rzxEventIndex;
    rzxPlayback.frameIndex = entry.metadata.rzxFrameIndex;
    rzxStepButton.disabled = false;
    rzxPlayPauseButton.disabled = false;
    rzxStatusOutput.value = `${rzxPlayback.frameIndex}/${rzxPlayback.recording.frameCount} frames`;
  }
  updateHistoryControls();
  audio?.reset(machine.cpu.tStates);
  refreshDebugDisplay();
  statusOutput.value = `Reversed ${entry.label.toLowerCase()}`;
  return entry;
}

stepBackButton.addEventListener("click", () => {
  reverseExecutionOnce();
});

rewindTimelineInput.addEventListener("change", () => {
  const target = Math.max(0, Math.min(executionHistory.size, Number(rewindTimelineInput.value)));
  let reversed = 0;
  while (executionHistory.size > target && reverseExecutionOnce()) reversed += 1;
  if (reversed > 0) statusOutput.value = `Rewound ${reversed} checkpoint${reversed === 1 ? "" : "s"}`;
});

resetButton.addEventListener("click", () => {
  resetMachine();
  refreshDebugDisplay();
});

romFileInput.addEventListener("change", async () => {
  const file = romFileInput.files?.[0];
  if (!file) return;

  try {
    mountRom(new Uint8Array(await file.arrayBuffer()), `Loaded ${file.name}`);
  } catch (error) {
    statusOutput.value = error.message;
  } finally {
    romFileInput.value = "";
  }
});

typeHelloButton.addEventListener("click", () => {
  typeHelloWorldProgram();
});

async function enableDefaultAudioFromGesture() {
  if (!audioEnabled || !machine) return;
  try {
    audio ??= new BeeperAudio();
    await audio.resume();
    if (!audioIsRunning()) return;
    audio.reset(machine.cpu.tStates);
    document.removeEventListener("pointerdown", enableDefaultAudioFromGesture);
    document.removeEventListener("keydown", enableDefaultAudioFromGesture);
  } catch (error) {
    statusOutput.value = error.message;
  }
}

document.addEventListener("pointerdown", enableDefaultAudioFromGesture);
document.addEventListener("keydown", enableDefaultAudioFromGesture);

audioToggleButton.addEventListener("click", async () => {
  try {
    const nextEnabled = !audioEnabled;
    if (nextEnabled) {
      audio ??= new BeeperAudio();
      await audio.resume();
      audio.reset(machine.cpu.tStates);
    }
    audioEnabled = nextEnabled;
    if (!audioEnabled) audio?.reset(machine.cpu.tStates);
    audioToggleButton.textContent = audioEnabled ? "Sound On" : "Sound Off";
    audioToggleButton.setAttribute("aria-pressed", String(audioEnabled));
    statusOutput.value = audioEnabled ? "Sound enabled" : "Sound disabled";
  } catch (error) {
    statusOutput.value = error.message;
  }
});

for (const button of toolTabButtons) {
  button.addEventListener("click", () => {
    selectToolPanel(button.dataset.toolTab);
  });
}

showRasterOverlayInput.addEventListener("change", () => {
  if (showRasterOverlayInput.checked && advancedToolsDetails?.open) drawRasterOverlay();
  else rasterContext.clearRect(0, 0, rasterOverlay.width, rasterOverlay.height);
});

advancedToolsDetails?.addEventListener("toggle", () => {
  if (!advancedToolsDetails.open) {
    rasterContext.clearRect(0, 0, rasterOverlay.width, rasterOverlay.height);
    return;
  }
  if (!assemblerReferenceInitialized) {
    renderAssemblerReference();
    assemblerReferenceInitialized = true;
  }
  refreshDebugDisplay();
});

debugWorkbenchDetails?.addEventListener("toggle", () => {
  if (debugWorkbenchDetails.open && advancedToolsDetails?.open && machine) updateDebugger();
});

mediaFileInput.addEventListener("click", () => {
  mediaFileInput.value = "";
});

mediaFileInput.addEventListener("change", async () => {
  const file = mediaFileInput.files?.[0];
  if (!file) return;

  clearMediaError();
  try {
    await replaceSpectrumMedia(file, { label: file.name });
  } catch (error) {
    if (!isMediaAbort(error)) showMediaError(error);
  }
});

mediaUrlLoadButton.addEventListener("click", async () => {
  const rawUrl = mediaUrlInput.value.trim();
  clearMediaError();
  if (!rawUrl) {
    showMediaError(new Error("Media URL is empty"));
    mediaUrlInput.focus();
    return;
  }

  try {
    await replaceSpectrumMedia(rawUrl);
  } catch (error) {
    if (!isMediaAbort(error)) showMediaError(error);
  }
});

mediaUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    mediaUrlLoadButton.click();
  }
});

snapshotSaveButton.addEventListener("click", () => {
  const bytes = createZ80Snapshot(machine);
  downloadBytes(bytes, "zx-spectrum-state.z80");
  statusOutput.value = "Saved current machine state as a Z80 snapshot";
});

rzxStepButton.addEventListener("click", () => {
  try {
    running = false;
    rzxPlaying = false;
    runPauseButton.textContent = "Run";
    rzxPlayPauseButton.textContent = "Play RZX";
    stepRzxFrame();
  } catch (error) {
    statusOutput.value = error.message;
  }
});

rzxPlayPauseButton.addEventListener("click", () => {
  if (!rzxPlayback || rzxPlayback.done) return;
  rzxPlaying = !rzxPlaying;
  running = rzxPlaying;
  runPauseButton.textContent = rzxPlaying ? "Pause" : "Run";
  runPauseButton.setAttribute("aria-label", rzxPlaying ? "Pause" : "Run");
  rzxPlayPauseButton.textContent = rzxPlaying ? "Pause RZX" : "Play RZX";
  statusOutput.value = rzxPlaying ? "Playing RZX recording" : "RZX playback paused";
});

basicFileInput.addEventListener("change", async () => {
  const file = basicFileInput.files?.[0];
  if (!file) return;

  try {
    let text = await file.text();
    try {
      loadBasicProgram(machine, text);
    } catch (error) {
      if (!/Invalid BASIC line number/.test(error.message)) throw error;
      text = renumberBasicProgram(text);
      loadBasicProgram(machine, text);
    }
    pasteTextInput.value = text;
    statusOutput.value = `Loaded BASIC source ${file.name}`;
    refreshDebugDisplay();
  } catch (error) {
    statusOutput.value = error.message;
  } finally {
    basicFileInput.value = "";
  }
});

basicExportButton.addEventListener("click", () => {
  try {
    const text = `${exportBasicProgram(machine)}\n`;
    downloadBytes(text, "zx-spectrum-program.bas", "text/plain;charset=utf-8");
    statusOutput.value = "Exported current BASIC program";
  } catch (error) {
    statusOutput.value = error.message;
  }
});

sourceFileInput.addEventListener("change", async () => {
  const file = sourceFileInput.files?.[0];
  if (!file) return;
  try {
    renderSource(await file.text());
    statusOutput.value = `Loaded source ${file.name}`;
  } catch (error) {
    statusOutput.value = error.message;
  } finally {
    sourceFileInput.value = "";
  }
});

assemblerSearchInput.addEventListener("input", () => {
  renderAssemblerReference(assemblerSearchInput.value);
});

for (const category of [...new Set(ASSEMBLER_REFERENCE.map((entry) => entry.category))].sort()) {
  const option = document.createElement("option");
  option.value = category;
  option.textContent = category;
  assemblerCategoryInput.append(option);
}
assemblerCategoryInput.addEventListener("change", () => renderAssemblerReference(assemblerSearchInput.value));

pasteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    typeModernText(pasteTextInput.value, { reset: true });
  } catch (error) {
    statusOutput.value = error.message;
  }
});

try {
  await loadRom();
  resetMachine();
  try {
    await loadTapeQueryParameters();
  } catch (error) {
    if (!isMediaAbort(error)) statusOutput.value = error.message;
  }
  draw();
} catch (error) {
  statusOutput.value = error.message;
}
