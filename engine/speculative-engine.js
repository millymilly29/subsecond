/**
 * SUBSECOND // Speculative Conversational Branching Engine
 * Generates and prefetches candidate LLM responses before user speech concludes.
 */

const DEFAULT_INTENT_TREES = [
  {
    prefix: /^(where is my order|order status|track my package|track order|delivery status)/i,
    intent: 'ORDER_TRACKING',
    confidence: 0.92,
    leadText: 'Checking your tracking status in the logistics system right now.',
    audioPreset: 'status_check'
  },
  {
    prefix: /^(can i return|how do i return|return policy|refund request|exchange item)/i,
    intent: 'RETURNS_REFUND',
    confidence: 0.88,
    leadText: 'You can return any item within 30 days of delivery using our prepaid portal.',
    audioPreset: 'refund_info'
  },
  {
    prefix: /^(we have a critical outage|database down|server 500 error|incident priority 1|prod is down)/i,
    intent: 'CRITICAL_INCIDENT',
    confidence: 0.96,
    leadText: 'Alerting on-call engineering leads and opening an emergency incident bridge.',
    audioPreset: 'incident_dispatch'
  },
  {
    prefix: /^(patient has severe chest pain|difficulty breathing|calling an ambulance|emergency triage)/i,
    intent: 'MEDICAL_EMERGENCY',
    confidence: 0.98,
    leadText: 'Dispatching paramedic unit to your GPS location immediately. Please stay on the line.',
    audioPreset: 'emergency_dispatch'
  },
  {
    prefix: /^(what is your tech stack|how does subsecond work|how do you reduce latency)/i,
    intent: 'TECH_ARCHITECTURE',
    confidence: 0.94,
    leadText: 'SubSecond combines zero-buffer VAD ring buffers with speculative branch prefetching to drop TTFT below 120 milliseconds.',
    audioPreset: 'tech_explain'
  }
];

class SpeculativeEngine {
  constructor(customTree = null) {
    this.intentTrees = customTree || DEFAULT_INTENT_TREES;
    this.activeSpeculations = [];
    this.history = [];
    this.currentSpeculation = null;
  }

  /**
   * Evaluates partial stream of words arriving from streaming STT
   */
  ingestPartialTranscript(partialText) {
    if (!partialText || typeof partialText !== 'string') {
      this.currentSpeculation = null;
      return { candidates: [], activeBranch: null };
    }

    const cleaned = partialText.trim().toLowerCase();
    const candidates = [];

    for (const item of this.intentTrees) {
      if (item.prefix.test(cleaned)) {
        candidates.push({
          intent: item.intent,
          confidence: item.confidence,
          leadText: item.leadText,
          audioPreset: item.audioPreset,
          prefetchReady: true,
          estimatedTTFTMs: 85 // Instant branch playback
        });
      }
    }

    // Sort by confidence
    candidates.sort((a, b) => b.confidence - a.confidence);

    if (candidates.length > 0) {
      this.currentSpeculation = {
        triggeredBy: cleaned,
        timestamp: Date.now(),
        bestCandidate: candidates[0],
        allCandidates: candidates
      };
    } else {
      this.currentSpeculation = null;
    }

    return {
      candidates,
      activeBranch: this.currentSpeculation ? this.currentSpeculation.bestCandidate : null
    };
  }

  /**
   * Finalizes user turn. Evaluates if the speculation matched reality
   */
  commitFinalTranscript(finalText) {
    const tFinal = Date.now();
    const cleaned = (finalText || '').trim().toLowerCase();

    let result = {
      status: 'MISS',
      finalText,
      intent: 'GENERIC_FALLBACK',
      leadText: 'Processing your request now...',
      perceivedTTFTMs: 580, // Standard cloud LLM latency
      savingsMs: 0,
      confidence: 0
    };

    if (this.currentSpeculation && this.currentSpeculation.bestCandidate) {
      const best = this.currentSpeculation.bestCandidate;
      // Check if the final text still matches the predicted intent pattern
      const matchedRule = this.intentTrees.find(r => r.intent === best.intent);
      if (matchedRule && matchedRule.prefix.test(cleaned)) {
        result = {
          status: 'HIT',
          finalText,
          intent: best.intent,
          leadText: best.leadText,
          audioPreset: best.audioPreset,
          perceivedTTFTMs: 85, // Pre-buffered response!
          savingsMs: 580 - 85, // 495ms saved
          confidence: best.confidence
        };
      }
    }

    this.history.unshift(result);
    this.currentSpeculation = null;
    return result;
  }

  getStats() {
    if (this.history.length === 0) return { total: 0, hits: 0, hitRate: 0, avgSavingsMs: 0 };
    const hits = this.history.filter(h => h.status === 'HIT').length;
    const totalSavings = this.history.reduce((acc, h) => acc + h.savingsMs, 0);
    return {
      total: this.history.length,
      hits,
      hitRate: Number(((hits / this.history.length) * 100).toFixed(1)),
      avgSavingsMs: Math.round(totalSavings / this.history.length)
    };
  }

  reset() {
    this.activeSpeculations = [];
    this.currentSpeculation = null;
    this.history = [];
  }
}

if (typeof window !== 'undefined') {
  window.SpeculativeEngine = SpeculativeEngine;
  window.DEFAULT_INTENT_TREES = DEFAULT_INTENT_TREES;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SpeculativeEngine, DEFAULT_INTENT_TREES };
}
