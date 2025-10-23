/**
 * SUBSECOND // Voice Activity Detector (VAD) & Adaptive Energy Processor
 * Ultra-low latency voice onset detection with circular pre-roll buffer.
 */

class VADProcessor {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.frameSize = options.frameSize || 256; // ~16ms per frame at 16kHz
    this.sensitivity = options.sensitivity || 2.4; // Multiplier above noise floor
    this.minEnergyThreshold = options.minEnergyThreshold || 0.012;
    this.speechEndSilenceFrames = options.speechEndSilenceFrames || 18; // ~300ms pause triggers turn completion
    this.bargeInThresholdFrames = options.bargeInThresholdFrames || 2; // Fast ~30ms trigger for interrupt

    // Adaptive noise floor tracking
    this.noiseFloor = 0.005;
    this.noiseFloorAlpha = 0.05; // Learning rate during silence

    // State machine: 'SILENCE' | 'SPEECH_ONSET' | 'SPEAKING' | 'PAUSE'
    this.state = 'SILENCE';
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;

    // Circular pre-roll buffer (stores last 5 frames / ~80ms)
    this.preRollCapacity = 5;
    this.preRollBuffer = [];

    // Callbacks
    this.onSpeechStart = options.onSpeechStart || null;
    this.onSpeechEnd = options.onSpeechEnd || null;
    this.onBargeInTrigger = options.onBargeInTrigger || null;
    this.onEnergyUpdate = options.onEnergyUpdate || null;
  }

  /**
   * Computes Root-Mean-Square (RMS) amplitude of audio frame
   */
  computeRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Zero Crossing Rate (ZCR) helps distinguish unvoiced fricatives from low-frequency hum
   */
  computeZCR(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / samples.length;
  }

  /**
   * Ingests a raw PCM audio chunk (Float32Array) and evaluates state transitions
   */
  processFrame(samples) {
    const rms = this.computeRMS(samples);
    const zcr = this.computeZCR(samples);

    // Update circular pre-roll buffer
    this.preRollBuffer.push(new Float32Array(samples));
    if (this.preRollBuffer.length > this.preRollCapacity) {
      this.preRollBuffer.shift();
    }

    const dynamicThreshold = Math.max(
      this.minEnergyThreshold,
      this.noiseFloor * this.sensitivity
    );

    const isSpeechSample = rms > dynamicThreshold;

    if (this.onEnergyUpdate) {
      this.onEnergyUpdate({ rms, noiseFloor: this.noiseFloor, dynamicThreshold, zcr });
    }

    // State Machine Transitions
    switch (this.state) {
      case 'SILENCE':
        if (isSpeechSample) {
          this.consecutiveSpeechFrames = 1;
          this.state = 'SPEECH_ONSET';
          this.consecutiveSilenceFrames = 0;
        } else {
          this.consecutiveSpeechFrames = 0;
          // Smoothly adapt noise floor during confirmed ambient silence
          this.noiseFloor = (1 - this.noiseFloorAlpha) * this.noiseFloor + this.noiseFloorAlpha * rms;
        }
        break;

      case 'SPEECH_ONSET':
        if (isSpeechSample) {
          this.consecutiveSpeechFrames++;
          this.state = 'SPEAKING';
          if (this.onSpeechStart) {
            this.onSpeechStart({
              timestamp: Date.now(),
              rms,
              preRollFrames: this.preRollBuffer.length
            });
          }
          // If AI was actively talking, fire barge-in immediately
          if (this.onBargeInTrigger) {
            this.onBargeInTrigger({ timestamp: Date.now(), rms });
          }
        } else {
          // Transient mic click/glitch: return to silence
          this.state = 'SILENCE';
          this.consecutiveSpeechFrames = 0;
        }
        break;

      case 'SPEAKING':
        if (isSpeechSample) {
          this.consecutiveSilenceFrames = 0;
          this.consecutiveSpeechFrames++;
        } else {
          this.consecutiveSilenceFrames++;
          if (this.consecutiveSilenceFrames >= this.speechEndSilenceFrames) {
            this.state = 'SILENCE';
            this.consecutiveSpeechFrames = 0;
            if (this.onSpeechEnd) {
              this.onSpeechEnd({
                timestamp: Date.now(),
                durationMs: this.consecutiveSpeechFrames * 16
              });
            }
          }
        }
        break;
    }

    return {
      state: this.state,
      isSpeech: isSpeechSample,
      rms,
      noiseFloor: this.noiseFloor,
      dynamicThreshold
    };
  }

  reset() {
    this.state = 'SILENCE';
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.preRollBuffer = [];
  }
}

if (typeof window !== 'undefined') {
  window.VADProcessor = VADProcessor;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VADProcessor };
}
