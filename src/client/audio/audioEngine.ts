// src/client/audio/audioEngine.ts
// Singleton Web Audio API engine for Quest — no external dependencies.
// Lazy-initialises on first user interaction; fails silently if unavailable.

// ─── Types ────────────────────────────────────────────────────────────────────

export type SoundName =
  | 'dice_roll'
  | 'action_submit'
  | 'action_success'
  | 'action_failure'
  | 'door_open'
  | 'scene_enter'
  | 'search_find'
  | 'trap_trigger'
  | 'torch_light'
  | 'attack_hit'
  | 'attack_miss'
  | 'combat_start'
  | 'enemy_defeated'
  | 'level_up'
  | 'coin_clink'
  | 'purchase'
  | 'heal';

export type AmbienceScene =
  | 'dungeon_quiet'
  | 'dungeon_tense'
  | 'dungeon_combat'
  | 'town_day'
  | 'silence';

// ─── Internal state ───────────────────────────────────────────────────────────

let _ctx: AudioContext | null = null;
let _masterGain: GainNode | null = null;
let _volume = 0.4;
let _muted = false;
let _desiredScene: AmbienceScene | null = null;
let _currentScene: AmbienceScene | null = null;
let _noiseBuffer: AudioBuffer | null = null;

interface AmbienceNodes {
  noiseSource: AudioBufferSourceNode | null;
  noiseFilter: BiquadFilterNode | null;
  noiseGain: GainNode | null;
  pulseTimerId: ReturnType<typeof setTimeout> | null;
  dripTimerId: ReturnType<typeof setTimeout> | null;
}

const _amb: AmbienceNodes = {
  noiseSource: null,
  noiseFilter: null,
  noiseGain: null,
  pulseTimerId: null,
  dripTimerId: null,
};

const STORAGE_KEY = 'quest_audio';
const SCHEDULE_AHEAD = 0.05; // seconds — how far ahead to schedule sounds

// ─── AudioContext management ──────────────────────────────────────────────────

function getCtx(): AudioContext | null {
  if (_ctx) {
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }
  try {
    const c = new AudioContext();
    const g = c.createGain();
    g.gain.value = _muted ? 0 : _volume;
    g.connect(c.destination);
    _ctx = c;
    _masterGain = g;

    // Apply any ambience that was requested before context existed
    if (_desiredScene && _desiredScene !== 'silence') {
      setTimeout(() => {
        if (_desiredScene) _applyAmbienceInternal(_desiredScene);
      }, 100);
    }
    return c;
  } catch {
    return null;
  }
}

function master(): GainNode | null {
  return _masterGain;
}

// ─── Noise buffers ────────────────────────────────────────────────────────────

/** 3-second loopable buffer for ambient layers */
function getLoopNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (_noiseBuffer) return _noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 3);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  _noiseBuffer = buf;
  return buf;
}

/** Short one-shot noise buffer */
function makeNoiseBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * (duration + 0.1));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

interface OscOpts {
  endFreq?: number;
  type?: OscillatorType;
  startAt?: number;
  attackT?: number;
  decayTo?: number;
}

/** Play a short oscillator burst through the master chain */
function playOsc(freq: number, peakGain: number, duration: number, opts: OscOpts = {}): void {
  const c = getCtx();
  const m = master();
  if (!c || !m) return;

  const { endFreq, type = 'sine', startAt = SCHEDULE_AHEAD, attackT = 0.01, decayTo = 0 } = opts;
  const t = c.currentTime + startAt;

  const osc = c.createOscillator();
  const gain = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq !== undefined) osc.frequency.linearRampToValueAtTime(endFreq, t + duration);

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peakGain, t + attackT);
  gain.gain.linearRampToValueAtTime(decayTo, t + duration);

  osc.connect(gain);
  gain.connect(m);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

interface NoiseOpts {
  filterQ?: number;
  filterType?: BiquadFilterType;
  endFilterFreq?: number;
  startAt?: number;
  attackT?: number;
}

/** Play a filtered noise burst through the master chain */
function playNoise(filterFreq: number, peakGain: number, duration: number, opts: NoiseOpts = {}): void {
  const c = getCtx();
  const m = master();
  if (!c || !m) return;

  const { filterQ = 1, filterType = 'bandpass', endFilterFreq, startAt = SCHEDULE_AHEAD, attackT = 0.01 } = opts;
  const t = c.currentTime + startAt;

  const buf = makeNoiseBuffer(c, duration);
  const src = c.createBufferSource();
  src.buffer = buf;

  const filter = c.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(filterFreq, t);
  if (endFilterFreq !== undefined) filter.frequency.linearRampToValueAtTime(endFilterFreq, t + duration);
  filter.Q.value = filterQ;

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peakGain, t + attackT);
  gain.gain.linearRampToValueAtTime(0, t + duration);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(m);
  src.start(t);
  src.stop(t + duration + 0.15);
}

// ─── Procedural sound effects ─────────────────────────────────────────────────

const SOUNDS: Record<SoundName, () => void> = {

  // ── UI / Actions ──────────────────────────────────────────────────────────

  dice_roll() {
    // Short filtered noise burst + descending pitch, ~180ms
    playNoise(800, 0.4, 0.18, { filterQ: 2, filterType: 'bandpass' });
    playOsc(350, 0.2, 0.18, { endFreq: 80, type: 'triangle' });
  },

  action_submit() {
    // Soft click — low sine thud
    playOsc(100, 0.15, 0.08, { type: 'sine', attackT: 0.005 });
    playNoise(200, 0.08, 0.06, { filterQ: 0.5, filterType: 'lowpass' });
  },

  action_success() {
    // Warm two-tone chime: C5 then G5
    playOsc(523, 0.3, 0.5, { type: 'sine' });
    playOsc(784, 0.25, 0.5, { type: 'sine', startAt: 0.22 });
  },

  action_failure() {
    // Low single tone, slightly dissonant (two close frequencies beating)
    playOsc(150, 0.25, 0.45, { type: 'sine' });
    playOsc(157, 0.12, 0.45, { type: 'sine' });
  },

  // ── Dungeon ───────────────────────────────────────────────────────────────

  door_open() {
    // Low creak: slow sine sweep + noise layer, 400ms
    playOsc(80, 0.2, 0.4, { endFreq: 120, type: 'sawtooth', attackT: 0.05 });
    playNoise(300, 0.12, 0.4, { filterQ: 0.5, filterType: 'lowpass' });
  },

  scene_enter() {
    // Subtle stone echo: low thud with 3 reverb-like echoes
    const offsets = [0, 0.15, 0.32, 0.52];
    const gains =   [0.28, 0.14, 0.07, 0.03];
    offsets.forEach((gap, i) => {
      playOsc(58, gains[i], 0.1, { startAt: SCHEDULE_AHEAD + gap, type: 'sine' });
      playNoise(120, gains[i] * 0.5, 0.09, { filterType: 'lowpass', startAt: SCHEDULE_AHEAD + gap });
    });
  },

  search_find() {
    // Bright short ding — C6
    playOsc(1047, 0.22, 0.6, { type: 'sine', attackT: 0.008 });
  },

  trap_trigger() {
    // Sharp noise burst + pitch drop
    playNoise(2200, 0.5, 0.1, { filterQ: 3, filterType: 'bandpass' });
    playOsc(650, 0.3, 0.25, { endFreq: 70, type: 'sawtooth', attackT: 0.005 });
  },

  torch_light() {
    // Soft ignition flicker — noise burst 200ms
    playNoise(350, 0.2, 0.2, { filterQ: 1.5, filterType: 'bandpass', attackT: 0.03 });
    playOsc(120, 0.08, 0.2, { type: 'sine' });
  },

  // ── Combat ────────────────────────────────────────────────────────────────

  attack_hit() {
    // Percussive thud + short noise burst
    playOsc(100, 0.4, 0.1, { type: 'sine', endFreq: 40, attackT: 0.005 });
    playNoise(400, 0.28, 0.08, { filterQ: 1 });
  },

  attack_miss() {
    // Whoosh — sweeping bandpass noise, softer
    playNoise(900, 0.14, 0.26, { filterQ: 2, endFilterFreq: 350 });
  },

  combat_start() {
    // Low tension swell, ~2.5s rising drone
    playOsc(55, 0.28, 2.5, { endFreq: 82, type: 'sawtooth', attackT: 0.5, decayTo: 0.03 });
    playOsc(110, 0.14, 2.5, { endFreq: 165, type: 'sine', attackT: 0.8 });
    playNoise(200, 0.1, 2.5, { filterType: 'lowpass', attackT: 0.3 });
  },

  enemy_defeated() {
    // Descending resolution tone
    playOsc(440, 0.28, 1.0, { endFreq: 220, type: 'sine', attackT: 0.05 });
    playOsc(880, 0.1, 0.8, { endFreq: 440, type: 'sine', startAt: 0.1, attackT: 0.05 });
  },

  level_up() {
    // Ascending arpeggio: C4 E4 G4 C5 E5
    const notes = [262, 330, 392, 523, 659];
    notes.forEach((freq, i) => {
      playOsc(freq, 0.28, 0.28, { type: 'triangle', startAt: SCHEDULE_AHEAD + i * 0.13, attackT: 0.01 });
    });
  },

  // ── Town ──────────────────────────────────────────────────────────────────

  coin_clink() {
    // Two high metallic pings in quick succession
    playOsc(2093, 0.18, 0.15, { type: 'sine', attackT: 0.004 });
    playOsc(2350, 0.13, 0.14, { type: 'sine', startAt: 0.09, attackT: 0.004 });
  },

  purchase() {
    // Coin clink + soft low confirmation tone
    SOUNDS.coin_clink();
    playOsc(220, 0.14, 0.45, { type: 'sine', startAt: 0.16, attackT: 0.06 });
  },

  heal() {
    // Warm ascending tone, slow
    playOsc(220, 0.24, 1.2, { endFreq: 440, type: 'sine', attackT: 0.2 });
    playOsc(330, 0.1, 1.0, { endFreq: 523, type: 'sine', startAt: 0.2, attackT: 0.15 });
  },
};

// ─── Ambient atmosphere ───────────────────────────────────────────────────────

function _stopNoiseSource(): void {
  try {
    _amb.noiseSource?.stop();
  } catch { /* already stopped */ }
  try { _amb.noiseSource?.disconnect(); } catch {}
  try { _amb.noiseFilter?.disconnect(); } catch {}
  try { _amb.noiseGain?.disconnect(); } catch {}
  _amb.noiseSource = null;
  _amb.noiseFilter = null;
  _amb.noiseGain = null;
}

function _stopPulse(): void {
  if (_amb.pulseTimerId !== null) { clearTimeout(_amb.pulseTimerId); _amb.pulseTimerId = null; }
}

function _stopDrip(): void {
  if (_amb.dripTimerId !== null) { clearTimeout(_amb.dripTimerId); _amb.dripTimerId = null; }
}

function _startNoise(filterFreq: number, gainLevel: number): void {
  const c = getCtx();
  const m = master();
  if (!c || !m) return;

  const buf = getLoopNoiseBuffer(c);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = 0.5;

  const g = c.createGain();
  g.gain.setValueAtTime(0, c.currentTime);
  g.gain.linearRampToValueAtTime(gainLevel, c.currentTime + 1.0); // 1s fade in

  src.connect(filter);
  filter.connect(g);
  g.connect(m);
  src.start();

  _amb.noiseSource = src;
  _amb.noiseFilter = filter;
  _amb.noiseGain = g;
}

/** Schedule a repeating heartbeat pulse (lub-dub) at the given period (ms) */
function _schedulePulse(periodMs: number): void {
  const tick = () => {
    if (!_ctx || !_masterGain) return;
    // Lub
    playOsc(58, 0.14, 0.09, { type: 'sine', attackT: 0.005, startAt: 0.01 });
    // Dub (slightly quieter, 100ms later)
    playOsc(48, 0.09, 0.08, { type: 'sine', attackT: 0.005, startAt: 0.11 });
    _amb.pulseTimerId = setTimeout(tick, periodMs);
  };
  _amb.pulseTimerId = setTimeout(tick, periodMs);
}

/** Schedule random water drips (8–20s intervals) */
function _scheduleDrip(): void {
  const drip = () => {
    if (!_ctx) return;
    playNoise(3200, 0.06, 0.05, { filterQ: 10, startAt: 0.01 });
    playOsc(1300, 0.05, 0.09, { type: 'sine', startAt: 0.01, attackT: 0.003 });
    const next = 8000 + Math.random() * 12000;
    _amb.dripTimerId = setTimeout(drip, next);
  };
  _amb.dripTimerId = setTimeout(drip, 5000 + Math.random() * 8000);
}

function _applyAmbienceInternal(scene: AmbienceScene): void {
  const c = _ctx;
  const m = _masterGain;

  _stopPulse();
  _stopDrip();

  if (scene === 'silence' || !c || !m) {
    if (_amb.noiseGain) {
      const oldGain = _amb.noiseGain;
      const oldSrc = _amb.noiseSource;
      oldGain.gain.linearRampToValueAtTime(0, c ? c.currentTime + 0.8 : 0);
      setTimeout(() => {
        try { oldSrc?.stop(); } catch {}
        try { oldGain.disconnect(); } catch {}
      }, 900);
      _amb.noiseSource = null;
      _amb.noiseGain = null;
      _amb.noiseFilter = null;
    }
    _currentScene = scene;
    return;
  }

  // Crossfade: fade out existing noise
  if (_amb.noiseGain && _amb.noiseSource) {
    const oldGain = _amb.noiseGain;
    const oldSrc = _amb.noiseSource;
    oldGain.gain.linearRampToValueAtTime(0, c.currentTime + 0.6);
    setTimeout(() => {
      try { oldSrc.stop(); } catch {}
      try { oldGain.disconnect(); } catch {}
    }, 700);
    _amb.noiseSource = null;
    _amb.noiseGain = null;
    _amb.noiseFilter = null;
  }

  // Slight delay before starting new layer (lets crossfade settle)
  setTimeout(() => {
    switch (scene) {
      case 'dungeon_quiet':
        _startNoise(220, 0.028);
        _scheduleDrip();
        break;
      case 'dungeon_tense':
        _startNoise(280, 0.045);
        _schedulePulse(1250); // 0.8 Hz
        break;
      case 'dungeon_combat':
        _startNoise(450, 0.07);
        _schedulePulse(720);  // ~1.4 Hz — urgent
        break;
      case 'town_day':
        _startNoise(650, 0.035);
        break;
    }
  }, 200);

  _currentScene = scene;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Load volume/mute settings from localStorage without creating AudioContext */
export function initFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { volume, muted } = JSON.parse(raw) as { volume?: number; muted?: boolean };
    if (typeof volume === 'number') _volume = Math.max(0, Math.min(1, volume));
    if (typeof muted === 'boolean') _muted = muted;
  } catch {}
}

/** Play a one-shot sound effect (creates AudioContext on first call) */
export function playSound(name: SoundName): void {
  try {
    SOUNDS[name]?.();
  } catch { /* fail silently */ }
}

/** Set or change the looping ambient scene */
export function setAmbience(scene: AmbienceScene): void {
  if (scene === _currentScene && scene === _desiredScene) return;
  _desiredScene = scene;
  if (_ctx) {
    _applyAmbienceInternal(scene);
  }
  // else: deferred — will be applied when AudioContext is first created (getCtx)
}

/** Stop all ambient audio */
export function stopAmbience(): void {
  setAmbience('silence');
}

/** Set master volume (0–1) */
export function setVolume(v: number): void {
  _volume = Math.max(0, Math.min(1, v));
  if (_masterGain && _ctx) {
    _masterGain.gain.setValueAtTime(_muted ? 0 : _volume, _ctx.currentTime);
  }
  _savePrefs();
}

export function mute(): void {
  _muted = true;
  if (_masterGain && _ctx) _masterGain.gain.setValueAtTime(0, _ctx.currentTime);
  _savePrefs();
}

export function unmute(): void {
  _muted = false;
  if (_masterGain && _ctx) _masterGain.gain.setValueAtTime(_volume, _ctx.currentTime);
  _savePrefs();
}

export function getVolume(): number { return _volume; }
export function isMuted(): boolean  { return _muted; }

function _savePrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: _volume, muted: _muted }));
  } catch {}
}
