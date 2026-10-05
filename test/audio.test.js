import assert from "node:assert/strict";
import test from "node:test";
import { BeeperAudio, createBeeperSamples } from "../public/audio.js";

test("creates beeper samples from timed transitions", () => {
  const result = createBeeperSamples(
    [
      { tState: 2, on: true },
      { tState: 6, on: false }
    ],
    {
      fromTState: 0,
      toTState: 10,
      initialLevel: false,
      sampleRate: 10,
      tStatesPerSecond: 10,
      amplitude: 0.5
    }
  );

  assert.deepEqual(Array.from(result.samples), [0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
  assert.equal(result.level, false);
});

test("continues beeper level when no transition occurs", () => {
  const result = createBeeperSamples([], {
    fromTState: 0,
    toTState: 4,
    initialLevel: true,
    sampleRate: 4,
    tStatesPerSecond: 4,
    amplitude: 0.25
  });

  assert.deepEqual(Array.from(result.samples), [0.25, 0.25, 0.25, 0.25]);
  assert.equal(result.level, true);
});


class FakeAudioContext {
  constructor() {
    this.currentTime = 1;
    this.sampleRate = 1000;
    this.state = "running";
    this.destination = {};
    this.createdSources = [];
  }

  createBuffer(_channels, length, sampleRate) {
    return { duration: length / sampleRate, copyToChannel() {} };
  }

  createBufferSource() {
    const source = {
      stopped: false,
      disconnected: false,
      connect() {},
      start(time) { this.startTime = time; },
      stop() { this.stopped = true; },
      disconnect() { this.disconnected = true; },
      onended: null
    };
    this.createdSources.push(source);
    return source;
  }

  async resume() {}
}

test("reset cancels queued beeper sources", () => {
  const audio = new BeeperAudio({ AudioContextClass: FakeAudioContext });
  audio.push([], 69_888);
  const source = audio.context.createdSources[0];
  assert.equal(source.stopped, false);
  audio.reset(1234);
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
  assert.equal(audio.sources.size, 0);
  assert.equal(audio.lastTState, 1234);
  assert.equal(audio.nextTime, audio.context.currentTime);
});

test("beeper drops excessive scheduling lead instead of growing an endless queue", () => {
  const audio = new BeeperAudio({ AudioContextClass: FakeAudioContext, maxLeadSeconds: 0.03 });
  audio.push([], 69_888);
  const first = audio.context.createdSources[0];
  audio.push([], 139_776);
  audio.push([], 209_664);
  assert.equal(first.stopped, true);
  assert.ok(audio.nextTime - audio.context.currentTime <= 0.05);
});
