export const SPECTRUM_T_STATES_PER_SECOND = 3_494_400;

export function createBeeperSamples(
  events,
  {
    fromTState,
    toTState,
    initialLevel,
    sampleRate,
    tStatesPerSecond = SPECTRUM_T_STATES_PER_SECOND,
    amplitude = 0.18
  }
) {
  const durationTStates = Math.max(0, toTState - fromTState);
  const sampleCount = Math.max(0, Math.round((durationTStates / tStatesPerSecond) * sampleRate));
  const samples = new Float32Array(sampleCount);
  let level = initialLevel;
  let eventIndex = 0;
  const tStatesPerSample = tStatesPerSecond / sampleRate;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const tState = fromTState + Math.floor(sampleIndex * tStatesPerSample);
    while (eventIndex < events.length && events[eventIndex].tState <= tState) {
      level = events[eventIndex].on;
      eventIndex += 1;
    }
    samples[sampleIndex] = level ? amplitude : 0;
  }

  while (eventIndex < events.length && events[eventIndex].tState <= toTState) {
    level = events[eventIndex].on;
    eventIndex += 1;
  }

  return { samples, level };
}

export class BeeperAudio {
  constructor({
    AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
    maxLeadSeconds = 0.1
  } = {}) {
    if (!AudioContextClass) throw new Error("Web Audio is not available");
    this.context = new AudioContextClass();
    this.maxLeadSeconds = maxLeadSeconds;
    this.nextTime = this.context.currentTime;
    this.level = false;
    this.lastTState = 0;
    this.sources = new Set();
  }

  async resume() {
    if (this.context.state !== "running") await this.context.resume();
  }

  cancelScheduled() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped. Web Audio is fussy about goodbyes.
      }
      try {
        source.disconnect();
      } catch {
        // Some test doubles and old browsers do not care.
      }
    }
    this.sources.clear();
    this.nextTime = this.context.currentTime;
  }

  reset(tState = 0) {
    this.cancelScheduled();
    this.level = false;
    this.lastTState = tState;
  }

  push(events, toTState) {
    const { samples, level } = createBeeperSamples(events, {
      fromTState: this.lastTState,
      toTState,
      initialLevel: this.level,
      sampleRate: this.context.sampleRate
    });

    this.level = level;
    this.lastTState = toTState;
    if (samples.length === 0) return;

    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    buffer.copyToChannel(samples, 0);

    if (this.nextTime - this.context.currentTime > this.maxLeadSeconds) {
      this.cancelScheduled();
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      try {
        source.disconnect();
      } catch {
        // Nothing left to unplug.
      }
    };
    this.sources.add(source);
    const startTime = Math.max(this.context.currentTime + 0.02, this.nextTime);
    source.start(startTime);
    this.nextTime = startTime + buffer.duration;
  }
}
