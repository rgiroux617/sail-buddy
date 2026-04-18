// sound.js
// Web Audio API sound engine for Minesweeper: Hormuz Edition.
// All sounds are synthesized — no audio files required.
//
// ACTIVE engine: Discrete pulse / "thup thup thup" style
//   Based on redblobgames.com/x/2147-webaudio-motor/
//   Rapid short noise bursts scheduled at RPM rate using the Web Audio clock.
//   At low RPM the individual pulses are audible; at high RPM they merge
//   into a continuous tone — exactly like a real piston/propeller engine.
//
// ALTERNATE engine (commented out below): Band-pass filtered noise
//   Good for jet boats, turbines, hull rumble. Swap startEngine calls to use.
//
// IMPORTANT: Call sound.init() from a user gesture (the Cast Off button).

// ── Pulse engine constants ────────────────────────────────────────────────────
const PULSE_Q            = 20;    // resonance — higher = more tonal "thup"
const PULSE_DURATION     = 0.03; // seconds per burst — shorter = sharper click
const PULSE_VOLUME       = 0.68;  // volume per pulse
const PULSE_GLIDE_TIME   = 0.6;   // seconds to ramp between normal/boost RPM
const PULSE_LOOKAHEAD    = 0.1;   // seconds of pulses scheduled ahead

// ── Master volume controls ────────────────────────────────────────────────────
// Tweak any of these to balance the mix without touching the synthesis code.
// All values are 0.0 (silent) → 1.0 (full), though you can go above 1.0 to
// boost quiet samples (may clip if pushed too far).
const VOL_COLLISION       = 1.0;   // land_collision.wav
const VOL_DEPTH_CHARGE    = 1.0;   // depth_charge.wav (detonation)
const VOL_FUSE_TICK       = 0.8;   // synthesized ticking during fuse countdown
const VOL_FUSE_HUM        = 0.18;  // synthesized sub-bass hum during fuse
const VOL_HOURGLASS       = 0.28;  // synthesized two-tone chime
const VOL_PING            = 0.35;  // radar ping

// ── Radar ping constants ───────────────────────────────────────────────────────
const PING_START_HZ  = 880;
const PING_END_HZ    = 220;
const PING_DURATION  = 1.6;

export function createSoundEngine() {
  let ctx           = null;
  let engineActive  = false;
  let boosting      = false;
  let scheduleId    = null;   // setInterval handle for pulse scheduler
  let nextPulseAt   = 0;      // Web Audio clock time of next scheduled pulse
  let currentRPM    = 0;
  let targetRPM     = 0;
  let rpmGlideStart = 0;
  let rpmGlideFrom  = 0;
  let masterGain    = null;
  // Per-engine configurable values (set by startEngine)
  let engineNormalRpm = 0;
  let engineBoostRpm  = 0;
  let pulseFilterHz   = 300;

  // ── Decoded audio sample buffers (loaded via loadSamples) ─────────────────
  let sampleCollision   = null;   // land_collision.wav
  let sampleDepthCharge = null;   // depth_charge.wav

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // ── Sample loader ─────────────────────────────────────────────────────────
  // Fetches WAV/MP3 files and decodes them into AudioBuffers ready for instant
  // playback. Must be called after init() so the AudioContext exists.
  // Returns a promise — main.js can await it or just fire-and-forget; playback
  // functions fall back gracefully if buffers are still null.
  async function loadSamples(baseUrl = '.') {
    if (!ctx) return;
    async function _load(path) {
      try {
        const response = await fetch(path);
        const arrayBuf = await response.arrayBuffer();
        return await ctx.decodeAudioData(arrayBuf);
      } catch (e) {
        console.warn(`[sound] Failed to load sample: ${path}`, e);
        return null;
      }
    }
    [sampleCollision, sampleDepthCharge] = await Promise.all([
      _load(`${baseUrl}/land_collision.wav`),
      _load(`${baseUrl}/depth_charge.wav`),
    ]);
    console.log('[sound] samples loaded');
  }

  // ── Helper: play a decoded AudioBuffer at a given volume ──────────────────
  function _playSample(buffer, volume) {
    if (!ctx || !buffer) return;
    const src  = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(ctx.currentTime);
  }

  // ── Pulse engine ──────────────────────────────────────────────────────────
  // Each pulse: a tiny white noise buffer through a band-pass filter,
  // with a sharp attack and very fast decay. The interval between pulses
  // = 60 / RPM seconds. The Web Audio clock schedules them ahead of time
  // so there are no gaps or timing jitter from JavaScript.

  function _schedulePulse(time) {
    const bufLen = Math.ceil(ctx.sampleRate * PULSE_DURATION);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = pulseFilterHz;   // ← your main tone tweak
    filter.Q.value = PULSE_Q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(PULSE_VOLUME, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + PULSE_DURATION);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start(time);
  }

  function _updateRPM() {
    // Smoothly interpolate currentRPM toward targetRPM
    if (currentRPM === targetRPM) return;
    const elapsed = ctx.currentTime - rpmGlideStart;
    const t       = Math.min(elapsed / PULSE_GLIDE_TIME, 1);
    currentRPM    = rpmGlideFrom + (targetRPM - rpmGlideFrom) * t;
    if (t >= 1) currentRPM = targetRPM;
  }

  function startEngine({ normalRpm, boostRpm, filterHz } = {}) {
    console.log('[sound] startEngine called, ctx:', !!ctx, 'engineActive:', engineActive);
    if (!ctx || engineActive) return;
    console.log('[sound] engine starting');
    engineNormalRpm = normalRpm;
    engineBoostRpm  = boostRpm;
    pulseFilterHz   = filterHz;
    engineActive = true;
    currentRPM   = engineNormalRpm;
    targetRPM    = engineNormalRpm;
    nextPulseAt  = ctx.currentTime + 0.1;

    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, ctx.currentTime);
    masterGain.gain.linearRampToValueAtTime(8.0, ctx.currentTime + 0.4);
    masterGain.connect(ctx.destination);

    // Scheduler loop — runs every 50ms, schedules pulses up to LOOKAHEAD ahead
    scheduleId = setInterval(() => {
      if (!ctx || !engineActive) return;
      _updateRPM();
      const interval = 60 / currentRPM;
      while (nextPulseAt < ctx.currentTime + PULSE_LOOKAHEAD) {
        _schedulePulse(nextPulseAt);
        nextPulseAt += interval;
      }
    }, 50);
  }

  function stopEngine() {
    if (!engineActive || !ctx) return;
    engineActive = false;
    clearInterval(scheduleId);
    scheduleId = null;
    masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    setTimeout(() => { masterGain = null; }, 1500);
  }

  function setBoost(active) {
    if (!ctx || active === boosting) return;
    boosting       = active;
    rpmGlideFrom   = currentRPM;
    rpmGlideStart  = ctx.currentTime;
    targetRPM      = active ? engineBoostRpm : engineNormalRpm;
  }

  // ── ALTERNATE ENGINE: Band-pass filtered noise (hull rumble / jet boat) ───
  // Swap startEngine/stopEngine/setBoost calls in main.js to use this instead.
  // Good for turbines, jet boats, continuous hull rumble.
  //
  // const ALT_FUNDAMENTAL       = 65;
  // const ALT_FUNDAMENTAL_BOOST = 110;
  // const ALT_HARMONICS         = [1, 2, 3, 4, 5];
  // const ALT_HARMONIC_GAINS    = [0.7, 0.5, 0.3, 0.15, 0.08];
  // const ALT_Q                 = 3;
  // const ALT_NOISE_VOLUME      = 0.65;
  // const ALT_MASTER_VOLUME     = 0.4;
  // const ALT_GLIDE_TIME        = 0.4;
  // let altFilters = [];
  // let altNoise   = null;
  // let altMaster  = null;
  // let altBoosting = false;
  //
  // function startAltEngine() {
  //   if (!ctx || engineActive) return;
  //   engineActive = true;
  //   const bufferSize = ctx.sampleRate * 2;
  //   const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  //   const data = buffer.getChannelData(0);
  //   for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  //   altNoise = ctx.createBufferSource();
  //   altNoise.buffer = buffer;
  //   altNoise.loop = true;
  //   const noiseGain = ctx.createGain();
  //   noiseGain.gain.setValueAtTime(ALT_NOISE_VOLUME, ctx.currentTime);
  //   altNoise.connect(noiseGain);
  //   altMaster = ctx.createGain();
  //   altMaster.gain.setValueAtTime(0, ctx.currentTime);
  //   altMaster.gain.linearRampToValueAtTime(ALT_MASTER_VOLUME, ctx.currentTime + 0.3);
  //   altMaster.connect(ctx.destination);
  //   altFilters = ALT_HARMONICS.map((mult, idx) => {
  //     const f = ctx.createBiquadFilter();
  //     f.type = 'bandpass';
  //     f.frequency.setValueAtTime(ALT_FUNDAMENTAL * mult, ctx.currentTime);
  //     f.Q.value = ALT_Q;
  //     const g = ctx.createGain();
  //     g.gain.setValueAtTime(ALT_HARMONIC_GAINS[idx], ctx.currentTime);
  //     noiseGain.connect(f); f.connect(g); g.connect(altMaster);
  //     return f;
  //   });
  //   altNoise.start();
  // }
  //
  // function stopAltEngine() {
  //   if (!engineActive || !ctx) return;
  //   engineActive = false;
  //   altMaster.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
  //   setTimeout(() => { try { altNoise.stop(); } catch(_){} altNoise=null; altFilters=[]; altMaster=null; }, 2000);
  // }
  //
  // function setAltBoost(active) {
  //   if (!ctx || !altFilters.length || active === altBoosting) return;
  //   altBoosting = active;
  //   const hz = active ? ALT_FUNDAMENTAL_BOOST : ALT_FUNDAMENTAL;
  //   altFilters.forEach((f, i) => f.frequency.setTargetAtTime(hz * ALT_HARMONICS[i], ctx.currentTime, ALT_GLIDE_TIME / 3));
  // }
  // ── End alternate engine ──────────────────────────────────────────────────

  // ── Land collision — land_collision.wav ──────────────────────────────────
  function playCollision() {
    _playSample(sampleCollision, VOL_COLLISION);
  }

  // ── Mine / depth charge explosion — depth_charge.wav ─────────────────────
  function playMineHit() {
    _playSample(sampleDepthCharge, VOL_DEPTH_CHARGE);
  }

  // ── Hourglass collect — ascending two-tone chime ─────────────────────────
  // Two sine tones a perfect fifth apart (C5 → G5), second one delayed slightly.
  // Short attack, medium decay — feels like a classic "item get" reward sound.
  // A soft low-pass keeps it warm rather than harsh.
  function playHourglassCollect() {
    if (!ctx) return;

    function _chime(hz, delaySeconds, volume) {
      const t   = ctx.currentTime + delaySeconds;
      const osc = ctx.createOscillator();
      osc.type  = 'sine';
      osc.frequency.setValueAtTime(hz, t);

      // Slight vibrato for warmth
      const lfo = ctx.createOscillator();
      lfo.type  = 'sine';
      lfo.frequency.value = 5.5;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 3;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 3200;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);   // sharp attack
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55); // natural decay

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      lfo.start(t); lfo.stop(t + 0.56);
      osc.start(t); osc.stop(t + 0.56);
    }

    _chime(523, 0.0,  VOL_HOURGLASS);          // C5 — first note
    _chime(784, 0.11, VOL_HOURGLASS * 1.15);   // G5 — second note, slightly louder
  }

  // ── Depth charge fuse — ticking + building hum ───────────────────────────
  // Starts when the charge is dropped, stops (and is replaced by the boom) on
  // detonation. Two elements:
  //   1. Metronome ticks — short low-pass noise clicks scheduled via Web Audio
  //      clock, starting at ~2/s and accelerating to ~8/s over the fuse duration.
  //   2. Sub-bass hum — a very quiet sine at 55Hz that slowly gains volume,
  //      giving a submarine "pressure building" feel.
  // Both are routed through a shared fuseGain so stopDepthChargeFuse() can
  // fade everything out instantly.

  let fuseGain       = null;   // shared gain node for clean stop
  let fuseHum        = null;   // persistent oscillator for the hum
  let fuseTickId     = null;   // setInterval handle for the tick scheduler
  let fuseNextTick   = 0;      // Web Audio time of next tick
  let fuseStartTime  = 0;      // ctx.currentTime when fuse started
  let fuseDuration   = 2.5;    // mirrors DC_FUSE_DELAY in main.js

  function playDepthChargeFuse(duration = 2.5) {
    if (!ctx) return;
    stopDepthChargeFuse();   // safety: clear any leftover fuse

    fuseDuration  = duration;
    fuseStartTime = ctx.currentTime;

    fuseGain = ctx.createGain();
    fuseGain.gain.setValueAtTime(0.001, fuseStartTime);
    fuseGain.gain.linearRampToValueAtTime(1.0, fuseStartTime + 0.1);
    fuseGain.connect(ctx.destination);

    // ── Hum ──────────────────────────────────────────────────────────────
    fuseHum = ctx.createOscillator();
    fuseHum.type = 'sine';
    fuseHum.frequency.value = 55;
    const humGain = ctx.createGain();
    humGain.gain.setValueAtTime(0.0,  fuseStartTime);
    humGain.gain.linearRampToValueAtTime(VOL_FUSE_HUM, fuseStartTime + fuseDuration);
    fuseHum.connect(humGain);
    humGain.connect(fuseGain);
    fuseHum.start(fuseStartTime);

    // ── Ticks ─────────────────────────────────────────────────────────────
    fuseNextTick = fuseStartTime + 0.05;

    fuseTickId = setInterval(() => {
      if (!ctx || !fuseGain) return;
      const now      = ctx.currentTime;
      const elapsed  = now - fuseStartTime;
      const progress = Math.min(elapsed / fuseDuration, 1);
      // Tick rate: starts at 2/s, accelerates to 10/s
      const tickHz   = 2 + progress * 8;
      const interval = 1 / tickHz;

      while (fuseNextTick < now + 0.12) {
        const t       = fuseNextTick;
        const tickLen = Math.ceil(ctx.sampleRate * 0.022);
        const tickBuf = ctx.createBuffer(1, tickLen, ctx.sampleRate);
        const data    = tickBuf.getChannelData(0);
        for (let i = 0; i < tickLen; i++) data[i] = Math.random() * 2 - 1;

        const src = ctx.createBufferSource();
        src.buffer = tickBuf;

        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 900;
        f.Q.value = 4;

        const g = ctx.createGain();
        // Ticks get slightly louder as the fuse runs out
        const tickVol = VOL_FUSE_TICK * (0.6 + progress * 0.4);
        g.gain.setValueAtTime(tickVol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);

        src.connect(f); f.connect(g); g.connect(fuseGain);
        src.start(t);

        fuseNextTick += interval;
      }
    }, 40);
  }

  function stopDepthChargeFuse() {
    if (fuseTickId !== null) {
      clearInterval(fuseTickId);
      fuseTickId = null;
    }
    if (fuseHum) {
      try { fuseHum.stop(); } catch (_) {}
      fuseHum = null;
    }
    if (fuseGain) {
      fuseGain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
      fuseGain = null;
    }
    fuseNextTick = 0;
  }

  // ── Radar ping — classic sonar ────────────────────────────────────────────
  function playRadarPing() {
    if (!ctx) return;
    function _ping(delaySeconds, volumeScale) {
      const t   = ctx.currentTime + delaySeconds;
      const osc = ctx.createOscillator();
      osc.type  = 'sine';
      osc.frequency.setValueAtTime(PING_START_HZ, t);
      osc.frequency.exponentialRampToValueAtTime(PING_END_HZ, t + PING_DURATION);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(VOL_PING * volumeScale, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + PING_DURATION);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + PING_DURATION + 0.1);
    }
    _ping(0,   1.0);
    _ping(0.5, 0.35);
  }

  return {
    init,
    loadSamples,
    startEngine,
    stopEngine,
    setBoost,
    playCollision,
    playMineHit,
    playHourglassCollect,
    playDepthChargeFuse,
    stopDepthChargeFuse,
    playRadarPing,
  };
}
