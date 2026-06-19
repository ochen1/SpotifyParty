import { describe, expect, it } from "vitest";
import { ClockEstimator, createClockSample, qualityForUncertainty } from "../src/clock";

describe("clock sync", () => {
  it("computes offset and delay with symmetric latency", () => {
    const sample = createClockSample({
      seq: 1,
      clientSendMs: 1000,
      serverReceiveMs: 1050,
      serverSendMs: 1050,
      clientReceiveMs: 1100
    });

    expect(sample.offsetMs).toBe(0);
    expect(sample.delayMs).toBe(100);
  });

  it("computes positive server offset", () => {
    const sample = createClockSample({
      seq: 1,
      clientSendMs: 1000,
      serverReceiveMs: 1250,
      serverSendMs: 1250,
      clientReceiveMs: 1100
    });

    expect(sample.offsetMs).toBe(200);
    expect(sample.delayMs).toBe(100);
  });

  it("prefers low-delay samples in the estimator", () => {
    const estimator = new ClockEstimator();

    estimator.add(
      createClockSample({
        seq: 1,
        clientSendMs: 1000,
        serverReceiveMs: 1600,
        serverSendMs: 1600,
        clientReceiveMs: 2200
      })
    );

    for (let seq = 2; seq <= 8; seq += 1) {
      estimator.add(
        createClockSample({
          seq,
          clientSendMs: 1000,
          serverReceiveMs: 1210,
          serverSendMs: 1210,
          clientReceiveMs: 1020
        })
      );
    }

    const stats = estimator.getStats();
    expect(stats.offsetMs).toBeCloseTo(200, 3);
    expect(stats.uncertaintyMs).toBeLessThanOrEqual(20);
  });

  it("maps uncertainty to quality bands", () => {
    expect(qualityForUncertainty(10)).toBe("tight");
    expect(qualityForUncertainty(40)).toBe("usable");
    expect(qualityForUncertainty(100)).toBe("loose");
    expect(qualityForUncertainty(Number.POSITIVE_INFINITY)).toBe("unsynced");
  });
});
