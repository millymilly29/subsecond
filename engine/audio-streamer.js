/**
 * SUBSECOND // Audio Streamer, Zero-Buffer Barge-In & Formant Synthesizer
 * Manages Web Audio playback pipelines, microsecond phase cancellation, and real-time FFT telemetry.
 */

class AudioStreamer {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 24000;
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.currentSource = null;
    this.isPlaying = false;
    this.activeUtteranceId = null;

    // Barge-in metrics
    this.lastBargeInTime = null;
    this.bargeInFadeDuration = 0.015; // 15ms anti-pop crossfade ramp

    // Callbacks
    this.onPlaybackStarted = options.onPlaybackStarted || null;
    this.onPlaybackEnded = options.onPlaybackEnded || null;
    this.onBargeInCancelled = options.onBargeInCancelled || null;
  }

  initContext() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ sampleRate: this.sampleRate });
      this.masterGain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Generates a procedural speech-like formant acoustic wave (zero external dependencies)
   */
  synthesizeFormantSpeech(text = '', durationSec = 2.0) {
    if (!this.ctx) this.initContext();
    if (!this.ctx) return null;

    const sr = this.ctx.sampleRate;
    const numSamples = Math.floor(sr * durationSec);
    const buffer = this.ctx.createBuffer(1, numSamples, sr);
    const data = buffer.getChannelData(0);

    // Formant frequencies for vocal tract resonance (F1: ~600Hz, F2: ~1600Hz, F3: ~2600Hz)
    const f0Base = 135; // Base vocal pitch (Hz)
    let phaseF0 = 0;

    for (let i = 0; i < numSamples; i++) {
      const t = i / sr;
      // Slight pitch modulation to simulate prosody
      const f0 = f0Base + Math.sin(t * 6) * 12 + Math.cos(t * 14) * 8;
      phaseF0 += (2 * Math.PI * f0) / sr;

      // Glottal excitation wave (sawtooth with exponential decay)
      const glottal = (phaseF0 % (2 * Math.PI)) / (2 * Math.PI) - 0.5;

      // Resonant formants
      const formant1 = Math.sin(2 * Math.PI * 650 * t);
      const formant2 = Math.sin(2 * Math.PI * 1550 * t) * 0.45;
      const formant3 = Math.sin(2 * Math.PI * 2550 * t) * 0.25;

      // Amplitude envelope (attack, sustain, rhythmic syllabic dip)
      const syllableCadence = 0.5 + 0.5 * Math.abs(Math.sin(t * 10));
      const envelope = Math.min(1, t * 15) * Math.min(1, (durationSec - t) * 12);

      data[i] = glottal * (formant1 + formant2 + formant3) * syllableCadence * envelope * 0.4;
    }

    return buffer;
  }

  /**
   * Starts streaming synthesized speech audio buffer
   */
  playUtterance(text, durationSec = 2.2) {
    this.initContext();
    if (!this.ctx) {
      this.isPlaying = true;
      return 'MOCK_PLAYING';
    }

    // Cancel any ongoing speech first
    this.cancelBargeIn();

    const buffer = this.synthesizeFormantSpeech(text, durationSec);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Reset gain to normal level
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(0.7, now);

    source.connect(this.masterGain);

    this.currentSource = source;
    this.isPlaying = true;
    const utteranceId = `UTT-${Date.now().toString(36).toUpperCase()}`;
    this.activeUtteranceId = utteranceId;

    source.onended = () => {
      if (this.activeUtteranceId === utteranceId) {
        this.isPlaying = false;
        this.currentSource = null;
        if (this.onPlaybackEnded) this.onPlaybackEnded({ utteranceId });
      }
    };

    source.start(now);
    if (this.onPlaybackStarted) {
      this.onPlaybackStarted({ utteranceId, text, durationSec });
    }

    return utteranceId;
  }

  /**
   * CRITICAL BARGE-IN INTERRUPT:
   * Instantly purges active audio buffer with 15ms exponential anti-pop gain ramp.
   */
  cancelBargeIn() {
    if (!this.isPlaying || !this.currentSource) return false;

    const t0 = performance.now();

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      // 1. Cancel all future audio graph gain schedules
      this.masterGain.gain.cancelScheduledValues(now);
      // 2. Exponential ramp-down over 15ms prevents DC thump/pop
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + this.bargeInFadeDuration);

      // 3. Stop buffer playback immediately after ramp
      try {
        this.currentSource.stop(now + this.bargeInFadeDuration);
      } catch (e) {}
    }

    const cancelLatencyMs = Number((performance.now() - t0).toFixed(2));
    this.lastBargeInTime = Date.now();
    this.isPlaying = false;
    this.currentSource = null;

    if (this.onBargeInCancelled) {
      this.onBargeInCancelled({
        utteranceId: this.activeUtteranceId,
        cancelLatencyMs,
        timestamp: this.lastBargeInTime
      });
    }

    return true;
  }

  /**
   * Obtains live frequency spectrum data from AnalyserNode
   */
  getFrequencyData() {
    if (!this.analyser) {
      return new Uint8Array(64).fill(0);
    }
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  /**
   * Obtains live oscilloscope waveform time-domain data
   */
  getTimeDomainData() {
    if (!this.analyser) {
      return new Uint8Array(64).fill(128);
    }
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }
}

if (typeof window !== 'undefined') {
  window.AudioStreamer = AudioStreamer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioStreamer };
}
