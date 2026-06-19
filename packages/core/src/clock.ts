import { monotonicNowMs } from "./time";

export interface ClockSample {
  seq: number;
  clientSendMs: number;
  serverReceiveMs: number;
  serverSendMs: number;
  clientReceiveMs: number;
  offsetMs: number;
  delayMs: number;
  capturedAtMs: number;
}

export interface ClockStats {
  offsetMs: number;
  delayMs: number;
  jitterMs: number;
  uncertaintyMs: number;
  sampleCount: number;
  quality: "tight" | "usable" | "loose" | "unsynced";
}

export function createClockSample(input: {
  seq: number;
  clientSendMs: number;
  serverReceiveMs: number;
  serverSendMs: number;
  clientReceiveMs: number;
}): ClockSample {
  const offsetMs =
    (input.serverReceiveMs - input.clientSendMs + input.serverSendMs - input.clientReceiveMs) / 2;
  const delayMs = Math.max(
    0,
    input.clientReceiveMs - input.clientSendMs - (input.serverSendMs - input.serverReceiveMs)
  );

  return {
    ...input,
    offsetMs,
    delayMs,
    capturedAtMs: monotonicNowMs()
  };
}

export class ClockEstimator {
  private readonly samples: ClockSample[] = [];

  constructor(private readonly maxSamples = 24) {}

  add(sample: ClockSample): ClockStats {
    this.samples.push(sample);

    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    return this.getStats();
  }

  clear(): void {
    this.samples.length = 0;
  }

  getStats(): ClockStats {
    if (this.samples.length === 0) {
      return {
        offsetMs: 0,
        delayMs: Number.POSITIVE_INFINITY,
        jitterMs: Number.POSITIVE_INFINITY,
        uncertaintyMs: Number.POSITIVE_INFINITY,
        sampleCount: 0,
        quality: "unsynced"
      };
    }

    const ranked = [...this.samples].sort((a, b) => a.delayMs - b.delayMs);
    const best = ranked.slice(0, Math.min(8, Math.max(3, Math.ceil(ranked.length / 2))));
    const offsets = best.map((sample) => sample.offsetMs).sort((a, b) => a - b);
    const delays = best.map((sample) => sample.delayMs).sort((a, b) => a - b);
    const offsetMs = median(offsets);
    const delayMs = median(delays);
    const deviations = offsets.map((offset) => Math.abs(offset - offsetMs)).sort((a, b) => a - b);
    const jitterMs = median(deviations);
    const uncertaintyMs = delayMs / 2 + jitterMs;

    return {
      offsetMs,
      delayMs,
      jitterMs,
      uncertaintyMs,
      sampleCount: this.samples.length,
      quality: qualityForUncertainty(uncertaintyMs)
    };
  }

  serverNowMs(localNowMs = monotonicNowMs()): number {
    return localNowMs + this.getStats().offsetMs;
  }
}

export function qualityForUncertainty(uncertaintyMs: number): ClockStats["quality"] {
  if (!Number.isFinite(uncertaintyMs)) {
    return "unsynced";
  }

  if (uncertaintyMs <= 20) {
    return "tight";
  }

  if (uncertaintyMs <= 60) {
    return "usable";
  }

  return "loose";
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const middle = Math.floor(values.length / 2);

  if (values.length % 2 === 1) {
    return values[middle] ?? 0;
  }

  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}
