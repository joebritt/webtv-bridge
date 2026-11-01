// Jitter-buffered player for interleaved stereo Float32 chunks from the emulator worker.
//
// The emulator produces audio in bursts (one batch per ~12ms run slice) at a rate that tracks
// its speed, which wanders a little around real time. To play that smoothly:
//   - playback starts (and restarts after an underrun) only once `target` ms are buffered;
//     each underrun raises the target by 50ms, up to MAX_TARGET_MS, and it relaxes by 1ms/s;
//   - the read rate is nudged by up to +-RATE_RANGE to hold the buffer near the target, so small
//     speed differences are absorbed by imperceptible resampling instead of gaps or overflow;
//   - starting and stopping fade over a few ms, so gaps don't click.
// Samples arrive on a MessagePort straight from the worker (see main.js), not via the page.

const MIN_TARGET_MS = 60;
const MAX_TARGET_MS = 400;
const RATE_RANGE = 0.02;
const FADE = 128; // frames

class WebTVAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const srcRate = (options.processorOptions && options.processorOptions.sourceRate) || 44100;
    this.step0 = srcRate / sampleRate; // source frames per output frame at nominal speed
    this.msFrames = srcRate / 1000;
    this.size = Math.ceil(srcRate * 2); // 2s of stereo frames
    this.buf = new Float32Array(this.size * 2);
    this.w = 0;          // write position (frames)
    this.pos = 0;        // fractional read position (frames)
    this.fill = 0;       // buffered frames
    this.target = 100 * this.msFrames;
    this.playing = false;
    this.gain = 0;       // fade envelope 0..1
    this.rate = 1;
    this.underruns = 0;
    this.lastReport = currentTime;
    const onData = (e) => { if (e.data instanceof Float32Array) this.push(e.data); };
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) e.data.port.onmessage = onData; // direct channel from the worker
      else onData(e);
    };
  }

  push(d) {
    const frames = d.length >> 1;
    // well over the target (a burst after a stall, or turbo): drop the backlog down to the
    // target rather than letting sound lag the picture
    if (this.fill + frames > this.target + 150 * this.msFrames) {
      const drop = Math.floor(this.fill - this.target);
      if (drop > 0) { this.pos = (this.pos + drop) % this.size; this.fill -= drop; }
    }
    for (let i = 0; i < frames; i++) {
      if (this.fill >= this.size - 1) break;
      this.buf[this.w * 2] = d[i * 2];
      this.buf[this.w * 2 + 1] = d[i * 2 + 1];
      this.w = (this.w + 1) % this.size;
      this.fill++;
    }
  }

  process(inputs, outputs) {
    const [L, R] = outputs[0];
    const n = L.length;
    if (!this.playing && this.fill >= this.target) this.playing = true;
    // hold the buffer near the target with a small rate change (proportional, smoothed)
    const err = (this.fill - this.target) / this.target;
    const want = 1 + Math.max(-RATE_RANGE, Math.min(RATE_RANGE, err * 0.02));
    this.rate += (want - this.rate) * 0.05;
    const step = this.step0 * this.rate;
    const buf = this.buf, size = this.size;
    for (let i = 0; i < n; i++) {
      const fading = !this.playing || this.fill < FADE + 2;
      if (fading) {
        if (this.gain <= 0) { L[i] = 0; R[i] = 0; continue; }
        this.gain = Math.max(0, this.gain - 1 / FADE);
      } else if (this.gain < 1) {
        this.gain = Math.min(1, this.gain + 1 / FADE);
      }
      if (this.fill < 2) { L[i] = 0; R[i] = 0; continue; }
      const i0 = Math.floor(this.pos), f = this.pos - i0, i1 = (i0 + 1) % size;
      L[i] = (buf[i0 * 2] + (buf[i1 * 2] - buf[i0 * 2]) * f) * this.gain;
      R[i] = (buf[i0 * 2 + 1] + (buf[i1 * 2 + 1] - buf[i0 * 2 + 1]) * f) * this.gain;
      const np = this.pos + step;
      const adv = Math.floor(np) - i0;
      this.pos = np >= size ? np - size : np;
      this.fill -= adv;
    }
    if (this.playing && this.fill < FADE + 2) {
      // ran dry: wait for a fuller buffer next time
      this.playing = false;
      this.underruns++;
      this.port.postMessage({ gap: true }); // marked on the page's speed graph
      this.target = Math.min(MAX_TARGET_MS * this.msFrames, this.target + 50 * this.msFrames);
    }
    if (currentTime - this.lastReport >= 1) {
      this.lastReport = currentTime;
      this.port.postMessage({ underruns: this.underruns, bufferMs: Math.round(this.fill / this.msFrames), targetMs: Math.round(this.target / this.msFrames) });
      // slowly relax the target again while playback is healthy
      if (this.playing) this.target = Math.max(MIN_TARGET_MS * this.msFrames, this.target - 1 * this.msFrames);
    }
    return true;
  }
}
registerProcessor('webtv-audio', WebTVAudio);
