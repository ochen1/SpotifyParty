export function monotonicNowMs(): number {
  const perf = globalThis.performance;

  if (perf && typeof perf.now === "function") {
    const origin = typeof perf.timeOrigin === "number" ? perf.timeOrigin : Date.now() - perf.now();
    return origin + perf.now();
  }

  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function randomId(prefix = ""): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-6);
  return `${prefix}${time}${random}`;
}
