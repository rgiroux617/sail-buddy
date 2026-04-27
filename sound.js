// sound.js
// Web Audio API sound engine for SailBuddy.
//
// ENGINE: WAV-sample based motor sounds, one file per boat.
//   Each boat has a looping WAV recorded at its natural cruising RPM.
//   Boost shifts playbackRate upward for a higher-pitched "pushed" sound.
//   ENGINE_GLIDE_TIME controls how smoothly pitch ramps between normal/boost.
//
// IMPORTANT: Call sound.init() from a user gesture (the Cast Off button).

// ── Engine playback constants ─────────────────────────────────────────────────
const ENGINE_GLIDE_TIME  = 0.6;   // seconds to ramp between normal and boost pitch

// ── Master volume controls ────────────────────────────────────────────────────
// Tweak any of these to balance the mix without touching playback code.
// All values are 0.0 (silent) → 1.0 (full).
const VOL_ENGINE_MOTORBOAT = 0.3;   // motor_motorboat.wav
const VOL_ENGINE_MOTORBOAT_2 = 0.3;   // motor_motorboat_2.wav
const VOL_ENGINE_JETBOAT = 0.3;   // motor_jetboat.wav
const VOL_ENGINE_DESTROYER = 1.0;   // motor_destroyer.wav
const VOL_COLLISION       = 1.0;   // land_collision.wav
const VOL_DEPTH_CHARGE    = 1.0;   // depth_charge.wav (detonation)
const VOL_FUSE_TICK       = 0.8;   // synthesized ticking during fuse countdown
const VOL_FUSE_HUM        = 0.18;  // synthesized sub-bass hum during fuse
const VOL_HOURGLASS       = 0.28;  // synthesized two-tone chime
const VOL_PING            = 0.35;  // radar ping
const VOL_MUSIC           = 0.48;  // background music — sits under SFX

// ── Radar ping constants ──────────────────────────────────────────────────────
const PING_START_HZ  = 880;
const PING_END_HZ    = 220;
const PING_DURATION  = 1.6;

export function createSoundEngine() {
  let ctx          = null;
  let engineActive = false;
  let boosting     = false;

  // ── WAV-based engine state ────────────────────────────────────────────────
  let engineSource    = null;   // looping BufferSource for the active motor WAV
  let engineGain      = null;   // gain node — fade in/out and mute control
  let engineBoostRate = 1.35;   // playbackRate at boost (set per boat by startEngine)

  // ── Motor sample buffers (one per boat, loaded via loadSamples) ───────────
  let motorBuffers = {};   // keyed by boat name: motorboat, motorboat_2, etc.

  // ── Decoded audio sample buffers ──────────────────────────────────────────
  let sampleCollision   = null;   // land_collision.wav
  let sampleDepthCharge = null;   // depth_charge.wav

  // ── Mute state ────────────────────────────────────────────────────────────
  let muted = false;

  function setMuted(val) {
    muted = val;
    if (engineGain && ctx) {
      engineGain.gain.setTargetAtTime(val ? 0 : VOL_ENGINE, ctx.currentTime, 0.15);
    }
    if (musicGain && ctx) {
      musicGain.gain.setTargetAtTime(val ? 0 : VOL_MUSIC, ctx.currentTime, 0.15);
    }
  }

  function getMuted() { return muted; }

  // ── Init ──────────────────────────────────────────────────────────────────
  // Must be called from a user-gesture handler (e.g. button click).
  // On iOS, AudioContext inside ES modules is not treated as a user gesture.
  // The fix: index.html's inline script creates and unlocks the context on
  // the very first touch (stored as window._sbAudioCtx). We reuse it here.
  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    if (window._sbAudioCtx) {
      ctx = window._sbAudioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    // Fallback for desktop
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const silentBuf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const silentSrc = ctx.createBufferSource();
    silentSrc.buffer = silentBuf;
    silentSrc.connect(ctx.destination);
    silentSrc.start(0);
    ctx.resume();
  }

  // ── Sample loader ─────────────────────────────────────────────────────────
  // Fetches all audio files and decodes them into AudioBuffers.
  // Must be called after init() so the AudioContext exists.
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
    [
      sampleCollision,
      sampleDepthCharge,
      musicBuffer,
      motorBuffers.motorboat,
      motorBuffers.motorboat_2,
      motorBuffers.jetboat,
      motorBuffers.destroyer,
    ] = await Promise.all([
      _load(`${baseUrl}/land_collision.wav`),
      _load(`${baseUrl}/depth_charge.wav`),
      _load(`${baseUrl}/bkdMusic.ogg`).then(buf => buf || _load(`${baseUrl}/bkdMusic.mp3`)),
      _load(`${baseUrl}/motor_motorboat.wav`),
      _load(`${baseUrl}/motor_motorboat_2.wav`),
      _load(`${baseUrl}/motor_jetboat.wav`),
      _load(`${baseUrl}/motor_destroyer.wav`),
    ]);
    console.log('[sound] samples loaded');
  }

  // ── Helper: play a decoded AudioBuffer once at a given volume ─────────────
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

  // ── WAV-based engine ──────────────────────────────────────────────────────
  // Loops the boat's WAV file at playbackRate 1.0 (normal) or boostRate (boost).
  // Called from main.js with { sampleKey: 'motorboat', boostRate: 1.35 }.
  // boostRate: how much faster (and higher-pitched) boost sounds vs normal.
  //   1.0 = same pitch, 1.5 = noticeably higher. Start around 1.25–1.4.

  function startEngine({ sampleKey, boostRate } = {}) {
    console.log('[sound] startEngine called, ctx:', !!ctx, 'engineActive:', engineActive);
    if (!ctx || engineActive) return;
    const buffer = motorBuffers[sampleKey];
    if (!buffer) {
      console.warn(`[sound] No motor buffer found for: ${sampleKey}`);
      return;
    }
    console.log('[sound] engine starting —', sampleKey);
    engineBoostRate = boostRate || 1.35;
    engineActive    = true;

    engineGain = ctx.createGain();
    engineGain.gain.setValueAtTime(0, ctx.currentTime);
    if (!muted) {
      const VOL_ENGINE_MAP = {
        motorboat: VOL_ENGINE_MOTORBOAT,
        motorboat_2: VOL_ENGINE_MOTORBOAT_2,
        jetboat: VOL_ENGINE_JETBOAT,
        destroyer: VOL_ENGINE_DESTROYER,
      };
      engineGain.gain.linearRampToValueAtTime(VOL_ENGINE_MAP[sampleKey] ?? 1.0, ctx.currentTime + 0.5);
    }
    engineGain.connect(ctx.destination);

    engineSource = ctx.createBufferSource();
    engineSource.buffer       = buffer;
    engineSource.loop         = true;
    engineSource.playbackRate.setValueAtTime(1.0, ctx.currentTime);
    engineSource.connect(engineGain);
    engineSource.start(ctx.currentTime);
  }

  function stopEngine() {
    if (!engineActive || !ctx) return;
    engineActive = false;
    if (engineGain) {
      engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    }
    const src = engineSource;
    engineSource = null;
    engineGain   = null;
    setTimeout(() => { try { src.stop(); } catch (_) {} }, 1500);
  }

  function setBoost(active) {
    if (!ctx || active === boosting || !engineSource) return;
    boosting   = active;
    const rate = active ? engineBoostRate : 1.0;
    engineSource.playbackRate.linearRampToValueAtTime(rate, ctx.currentTime + ENGINE_GLIDE_TIME);
  }

  // ── Background music ──────────────────────────────────────────────────────
  // Fades in over 2 seconds when the game starts, loops until stopMusic().
  // OGG is loaded first; MP3 is the fallback (needed for iOS).
  let musicSource = null;
  let musicGain   = null;
  let musicBuffer = null;

  function startMusic() {
    if (!ctx || !musicBuffer || musicSource) return;
    musicGain = ctx.createGain();
    musicGain.gain.setValueAtTime(0, ctx.currentTime);
    if (!muted) {
      musicGain.gain.linearRampToValueAtTime(VOL_MUSIC, ctx.currentTime + 2.0);
    }
    musicGain.connect(ctx.destination);

    musicSource = ctx.createBufferSource();
    musicSource.buffer = musicBuffer;
    musicSource.loop   = true;
    musicSource.connect(musicGain);
    musicSource.start(ctx.currentTime);
  }

  function stopMusic(fadeSecs = 2.5) {
    if (!ctx || !musicSource) return;
    const src  = musicSource;
    const gain = musicGain;
    musicSource = null;
    musicGain   = null;
    gain.gain.setTargetAtTime(0, ctx.currentTime, fadeSecs / 4);
    setTimeout(() => { try { src.stop(); } catch (_) {} }, fadeSecs * 1000 + 500);
  }

  // ── Land collision — land_collision.wav ───────────────────────────────────
  function playCollision() {
    if (!ctx || muted) return;
    _playSample(sampleCollision, VOL_COLLISION);
  }

  // ── Mine / depth charge explosion — depth_charge.wav ─────────────────────
  function playMineHit() {
    if (!ctx || muted) return;
    _playSample(sampleDepthCharge, VOL_DEPTH_CHARGE);
  }

  // ── Hourglass collect — ascending two-tone chime ──────────────────────────
  // Two sine tones a perfect fifth apart (C5 → G5), second one delayed slightly.
  function playHourglassCollect() {
    if (!ctx || muted) return;

    function _chime(hz, delaySeconds, volume) {
      const t   = ctx.currentTime + delaySeconds;
      const osc = ctx.createOscillator();
      osc.type  = 'sine';
      osc.frequency.setValueAtTime(hz, t);

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
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      lfo.start(t); lfo.stop(t + 0.56);
      osc.start(t); osc.stop(t + 0.56);
    }

    _chime(523, 0.0,  VOL_HOURGLASS);
    _chime(784, 0.11, VOL_HOURGLASS * 1.15);
  }

  // ── Depth charge fuse — ticking + building hum ────────────────────────────
  // Starts when the charge is dropped, stops (and is replaced by the boom) on
  // detonation. Ticks accelerate from ~2/s to ~8/s; hum builds from silence.

  let fuseGain      = null;
  let fuseHum       = null;
  let fuseTickId    = null;
  let fuseNextTick  = 0;
  let fuseStartTime = 0;
  let fuseDuration  = 2.5;

  function playDepthChargeFuse(duration = 2.5) {
    if (!ctx || muted) return;
    stopDepthChargeFuse();

    fuseDuration  = duration;
    fuseStartTime = ctx.currentTime;

    fuseGain = ctx.createGain();
    fuseGain.gain.setValueAtTime(0.001, fuseStartTime);
    fuseGain.gain.linearRampToValueAtTime(1.0, fuseStartTime + 0.1);
    fuseGain.connect(ctx.destination);

    fuseHum = ctx.createOscillator();
    fuseHum.type = 'sine';
    fuseHum.frequency.value = 55;
    const humGain = ctx.createGain();
    humGain.gain.setValueAtTime(0.0, fuseStartTime);
    humGain.gain.linearRampToValueAtTime(VOL_FUSE_HUM, fuseStartTime + fuseDuration);
    fuseHum.connect(humGain);
    humGain.connect(fuseGain);
    fuseHum.start(fuseStartTime);

    fuseNextTick = fuseStartTime + 0.05;

    fuseTickId = setInterval(() => {
      if (!ctx || !fuseGain) return;
      const now      = ctx.currentTime;
      const elapsed  = now - fuseStartTime;
      const progress = Math.min(elapsed / fuseDuration, 1);
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
    if (!ctx || muted) return;
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
    setMuted,
    getMuted,
    playCollision,
    playMineHit,
    playHourglassCollect,
    playDepthChargeFuse,
    stopDepthChargeFuse,
    playRadarPing,
    startMusic,
    stopMusic,
  };
}
