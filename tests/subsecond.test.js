/**
 * SUBSECOND // Automated Verification Test Suite
 * Validates VAD state machine, Speculative Intent Trees, Latency Waterfall Percentiles & Barge-in logic.
 */

const assert = require('assert');
const { VADProcessor } = require('../engine/vad-processor');
const { SpeculativeEngine } = require('../engine/speculative-engine');
const { LatencyBudget } = require('../engine/latency-budget');
const { AudioStreamer } = require('../engine/audio-streamer');

console.log('\n\x1b[36m\x1b[1m=== RUNNING SUBSECOND VERIFICATION TEST SUITE ===\x1b[0m\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    \x1b[31m${err.message}\x1b[0m`);
    failed++;
  }
}

// 1. VAD: RMS calculation
test('VAD: Computes accurate RMS on synthetic silence and sine waves', () => {
  const vad = new VADProcessor();
  const silence = new Float32Array(256).fill(0);
  assert.strictEqual(vad.computeRMS(silence), 0);

  const active = new Float32Array(256).fill(0.2);
  const rms = vad.computeRMS(active);
  assert(Math.abs(rms - 0.2) < 0.001);
});

// 2. VAD: Noise floor adaptation during silence
test('VAD: Dynamically adapts noise floor during confirmed ambient silence', () => {
  const vad = new VADProcessor({ noiseFloorAlpha: 0.2 });
  const initialFloor = vad.noiseFloor;
  // Feed slight ambient room hiss (0.01)
  for (let i = 0; i < 10; i++) {
    vad.processFrame(new Float32Array(256).fill(0.008));
  }
  assert(vad.noiseFloor > 0.005);
  assert.strictEqual(vad.state, 'SILENCE');
});

// 3. VAD: Speech onset state transition
test('VAD: Transitions to SPEECH_ONSET and SPEAKING when energy bursts', () => {
  let onsetFired = false;
  const vad = new VADProcessor({
    onSpeechStart: () => { onsetFired = true; }
  });

  // 1 silence frame
  vad.processFrame(new Float32Array(256).fill(0.002));
  // 2 loud voice frames
  vad.processFrame(new Float32Array(256).fill(0.25));
  const res2 = vad.processFrame(new Float32Array(256).fill(0.3));

  assert.strictEqual(res2.state, 'SPEAKING');
  assert.strictEqual(onsetFired, true);
});

// 4. VAD: Circular pre-roll buffer retention
test('VAD: Stores plosive consonant pre-roll buffer frames', () => {
  const vad = new VADProcessor();
  for (let i = 0; i < 8; i++) {
    vad.processFrame(new Float32Array(256).fill(0.01 * (i + 1)));
  }
  assert.strictEqual(vad.preRollBuffer.length, 5); // Capped at capacity
});

// 5. VAD: Turn completion after silence timeout
test('VAD: Detects end of speech turn after silence timeout', () => {
  let endFired = false;
  const vad = new VADProcessor({
    speechEndSilenceFrames: 4,
    onSpeechEnd: () => { endFired = true; }
  });

  // Speak
  vad.processFrame(new Float32Array(256).fill(0.25));
  vad.processFrame(new Float32Array(256).fill(0.25));
  vad.processFrame(new Float32Array(256).fill(0.25));
  assert.strictEqual(vad.state, 'SPEAKING');

  // Silence for 4 frames
  for (let i = 0; i < 5; i++) {
    vad.processFrame(new Float32Array(256).fill(0.001));
  }
  assert.strictEqual(vad.state, 'SILENCE');
  assert.strictEqual(endFired, true);
});

// 6. SPECULATIVE: Ingestion and candidate prediction
test('SPECULATIVE: Predicts intent from partial prefix stream', () => {
  const spec = new SpeculativeEngine();
  const partial = spec.ingestPartialTranscript('where is my order');
  assert(partial.candidates.length > 0);
  assert.strictEqual(partial.activeBranch.intent, 'ORDER_TRACKING');
  assert(partial.activeBranch.confidence >= 0.9);
});

// 7. SPECULATIVE: Commit HIT reduces TTFT to sub-100ms
test('SPECULATIVE: Final commit matches prediction and saves ~495ms TTFT', () => {
  const spec = new SpeculativeEngine();
  spec.ingestPartialTranscript('where is my order');
  const commit = spec.commitFinalTranscript('where is my order #4819 from yesterday?');

  assert.strictEqual(commit.status, 'HIT');
  assert.strictEqual(commit.intent, 'ORDER_TRACKING');
  assert.strictEqual(commit.perceivedTTFTMs, 85);
  assert(commit.savingsMs >= 400);
});

// 8. SPECULATIVE: Commit MISS gracefully falls back to standard pipeline
test('SPECULATIVE: Unpredicted turn falls back gracefully to standard pipeline', () => {
  const spec = new SpeculativeEngine();
  spec.ingestPartialTranscript('can i order');
  const commit = spec.commitFinalTranscript('what is the capital of Iceland?');

  assert.strictEqual(commit.status, 'MISS');
  assert.strictEqual(commit.perceivedTTFTMs, 580);
  assert.strictEqual(commit.savingsMs, 0);
});

// 9. SPECULATIVE: Accrues hit rate statistics
test('SPECULATIVE: Tracks cumulative hit rate % accurately', () => {
  const spec = new SpeculativeEngine();
  spec.ingestPartialTranscript('delivery status');
  spec.commitFinalTranscript('delivery status update please'); // HIT

  spec.ingestPartialTranscript('random phrase');
  spec.commitFinalTranscript('totally unrelated speech'); // MISS

  const stats = spec.getStats();
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.hits, 1);
  assert.strictEqual(stats.hitRate, 50);
});

// 10. LATENCY BUDGET: Records turn waterfall and validates sub-300ms SLA
test('LATENCY: Correctly computes total turn waterfall latency', () => {
  const budget = new LatencyBudget();
  const turn = budget.recordTurn({
    isSpeculativeHit: true,
    vadDelay: 35,
    sttEmit: 50,
    ttft: 85,
    ttsChunk: 40,
    outputBuffer: 15
  });

  assert.strictEqual(turn.totalLatency, 225);
  assert.strictEqual(turn.targetMet, true);
});

// 11. LATENCY BUDGET: Percentiles P50, P95, and P99 calculation
test('LATENCY: Computes statistical P50, P95, P99 percentiles', () => {
  const budget = new LatencyBudget();
  // Insert 20 simulated turns
  for (let i = 1; i <= 20; i++) {
    budget.recordTurn({
      isSpeculativeHit: true,
      vadDelay: 30 + i,
      sttEmit: 50,
      ttft: 80,
      ttsChunk: 40,
      outputBuffer: 15
    });
  }

  const p = budget.getPercentiles();
  assert(p.p50 > 0);
  assert(p.p95 >= p.p50);
  assert(p.p99 >= p.p95);
  assert.strictEqual(p.count, 20);
});

// 12. LATENCY BUDGET: Calculates average stage breakdown
test('LATENCY: Computes average waterfall times across multiple turns', () => {
  const budget = new LatencyBudget();
  budget.recordTurn({ isSpeculativeHit: true, vadDelay: 30, sttEmit: 50, ttft: 80, ttsChunk: 40, outputBuffer: 15 });
  budget.recordTurn({ isSpeculativeHit: true, vadDelay: 40, sttEmit: 60, ttft: 90, ttsChunk: 50, outputBuffer: 15 });

  const avg = budget.getWaterfallAverages();
  assert.strictEqual(avg.vadDelay, 35);
  assert.strictEqual(avg.sttEmit, 55);
  assert.strictEqual(avg.ttft, 85);
});

// 13. AUDIO STREAMER: Safe node instantiation and barge-in state management
test('AUDIO STREAMER: Initializes with expected sample rate and default state', () => {
  const streamer = new AudioStreamer({ sampleRate: 24000 });
  assert.strictEqual(streamer.sampleRate, 24000);
  assert.strictEqual(streamer.isPlaying, false);
});

// 14. AUDIO STREAMER: Cancel barge-in resets playing flag and triggers callback
test('AUDIO STREAMER: Cancel barge-in halts playback state cleanly', () => {
  let cancelled = false;
  const streamer = new AudioStreamer({
    onBargeInCancelled: () => { cancelled = true; }
  });
  streamer.isPlaying = true;
  streamer.currentSource = { stop: () => {} };

  const res = streamer.cancelBargeIn();
  assert.strictEqual(res, true);
  assert.strictEqual(streamer.isPlaying, false);
  assert.strictEqual(cancelled, true);
});

// 15. END-TO-END CONVERSATIONAL TURN SIMULATION
test('E2E: Full conversational pipeline: VAD speech -> Speculative Hit -> Sub-300ms playback', () => {
  const vad = new VADProcessor();
  const spec = new SpeculativeEngine();
  const budget = new LatencyBudget();

  // 1. User starts speaking
  vad.processFrame(new Float32Array(256).fill(0.3));
  vad.processFrame(new Float32Array(256).fill(0.3));
  assert.strictEqual(vad.state, 'SPEAKING');

  // 2. Streaming partial transcript arrives
  const partial = spec.ingestPartialTranscript('incident priority 1 prod is down');
  assert(partial.candidates.length > 0);

  // 3. User finishes speaking
  for (let i = 0; i < 20; i++) {
    vad.processFrame(new Float32Array(256).fill(0.001));
  }
  assert.strictEqual(vad.state, 'SILENCE');

  // 4. Final commit matches
  const commit = spec.commitFinalTranscript('incident priority 1 prod is down server unreachable');
  assert.strictEqual(commit.status, 'HIT');

  // 5. Latency recorded
  const turn = budget.recordTurn({ isSpeculativeHit: true });
  assert(turn.totalLatency < 300);
});

console.log('\n----------------------------------------');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: \x1b[32m${passed}\x1b[0m | FAILED: \x1b[31m${failed}\x1b[0m\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\x1b[32m\x1b[1mALL VERIFICATION CHECKS PASSED WITH 100% SUCCESS.\x1b[0m\n');
  process.exit(0);
}
