/**
 * SUBSECOND // Acoustic Latency Budget & Telemetry Engine
 * Tracks millisecond waterfalls and computes P50, P95, and P99 conversational turn latencies.
 */

class LatencyBudget {
  constructor() {
    this.records = [];
  }

  /**
   * Records a complete end-to-end conversational turn
   */
  recordTurn(metrics = {}) {
    const isHit = metrics.isSpeculativeHit ?? true;

    // Millisecond stage waterfall
    const vadDelay = metrics.vadDelay ?? (isHit ? 35 : 45);
    const sttEmit = metrics.sttEmit ?? (isHit ? 55 : 120);
    const ttft = metrics.ttft ?? (isHit ? 85 : 580);
    const ttsChunk = metrics.ttsChunk ?? (isHit ? 45 : 280);
    const outputBuffer = metrics.outputBuffer ?? 15;

    const totalLatency = vadDelay + sttEmit + ttft + ttsChunk + outputBuffer;

    const record = {
      id: `TRN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      isSpeculativeHit: isHit,
      waterfall: {
        vadDelay,
        sttEmit,
        ttft,
        ttsChunk,
        outputBuffer
      },
      totalLatency,
      targetMet: totalLatency < 300 // Sub-second SLA
    };

    this.records.unshift(record);
    return record;
  }

  getPercentiles() {
    if (this.records.length === 0) {
      return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0, sub300Rate: 0 };
    }

    const sorted = [...this.records].map(r => r.totalLatency).sort((a, b) => a - b);
    const count = sorted.length;

    const p50 = sorted[Math.floor(count * 0.5)];
    const p95 = sorted[Math.floor(count * 0.95)] || sorted[count - 1];
    const p99 = sorted[Math.floor(count * 0.99)] || sorted[count - 1];
    const min = sorted[0];
    const max = sorted[count - 1];

    const sub300Count = sorted.filter(l => l < 300).length;
    const sub300Rate = Number(((sub300Count / count) * 100).toFixed(1));

    return {
      p50,
      p95,
      p99,
      min,
      max,
      count,
      sub300Rate
    };
  }

  getWaterfallAverages() {
    if (this.records.length === 0) {
      return { vadDelay: 35, sttEmit: 55, ttft: 85, ttsChunk: 45, outputBuffer: 15, total: 235 };
    }

    const n = this.records.length;
    const totals = this.records.reduce(
      (acc, r) => {
        acc.vadDelay += r.waterfall.vadDelay;
        acc.sttEmit += r.waterfall.sttEmit;
        acc.ttft += r.waterfall.ttft;
        acc.ttsChunk += r.waterfall.ttsChunk;
        acc.outputBuffer += r.waterfall.outputBuffer;
        acc.total += r.totalLatency;
        return acc;
      },
      { vadDelay: 0, sttEmit: 0, ttft: 0, ttsChunk: 0, outputBuffer: 0, total: 0 }
    );

    return {
      vadDelay: Math.round(totals.vadDelay / n),
      sttEmit: Math.round(totals.sttEmit / n),
      ttft: Math.round(totals.ttft / n),
      ttsChunk: Math.round(totals.ttsChunk / n),
      outputBuffer: Math.round(totals.outputBuffer / n),
      total: Math.round(totals.total / n)
    };
  }

  getHistory(limit = 20) {
    return this.records.slice(0, limit);
  }

  exportJSON() {
    return JSON.stringify(this.records, null, 2);
  }

  reset() {
    this.records = [];
  }
}

if (typeof window !== 'undefined') {
  window.LatencyBudget = LatencyBudget;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LatencyBudget };
}
