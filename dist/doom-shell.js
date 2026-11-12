// doom-shell.js -- browser side of the Doom port: video, keyboard/mouse, gamepad,
// sound effects and MUS music. Talks to i_web.c through Module.doom* functions.
'use strict';

// ---------------------------------------------------------------------------
// Doom key codes (doomdef.h)
// ---------------------------------------------------------------------------
const K = {
  RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf,
  ESC: 27, ENTER: 13, TAB: 9, BACKSPACE: 127, PAUSE: 0xff,
  RSHIFT: 0x80 + 0x36, RCTRL: 0x80 + 0x1d, RALT: 0x80 + 0x38,
  EQUALS: 0x3d, MINUS: 0x2d,
};
const EV_KEYDOWN = 0, EV_KEYUP = 1, EV_MOUSE = 2, EV_WEAPONCYCLE = 100;

const CODE_MAP = {
  ArrowRight: K.RIGHT, ArrowLeft: K.LEFT, ArrowUp: K.UP, ArrowDown: K.DOWN,
  Escape: K.ESC, Enter: K.ENTER, NumpadEnter: K.ENTER, Tab: K.TAB,
  Backspace: K.BACKSPACE, Delete: K.BACKSPACE, Pause: K.PAUSE,
  ShiftLeft: K.RSHIFT, ShiftRight: K.RSHIFT,
  ControlLeft: K.RCTRL, ControlRight: K.RCTRL,
  AltLeft: K.RALT, AltRight: K.RALT,
  Space: 32, Minus: K.MINUS, Equal: K.EQUALS, NumpadSubtract: K.MINUS, NumpadAdd: K.EQUALS,
  Comma: 44, Period: 46, Slash: 47, Semicolon: 59, Quote: 39,
  BracketLeft: 91, BracketRight: 93, Backslash: 92,
  Backquote: K.ESC, IntlBackslash: K.ESC,   // iPad keyboards often have no Esc key
};
for (let i = 1; i <= 12; i++) {
  CODE_MAP['F' + i] = i <= 10 ? 0x80 + 0x3a + i : 0x80 + 0x57 + (i - 11);
}
function doomKeyFromEvent(e) {
  if (CODE_MAP[e.code] !== undefined) return CODE_MAP[e.code];
  if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3) + 32;      // a-z
  if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);         // 0-9
  if (/^Numpad[0-9]$/.test(e.code)) return e.code.charCodeAt(6);
  if (e.key && e.key.length === 1) return e.key.toLowerCase().charCodeAt(0) & 0x7f;
  return 0;
}

// ---------------------------------------------------------------------------
// Shell state
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx2d = canvas.getContext('2d', { alpha: false });
let M = null;                 // emscripten module instance
const queue = [];             // pending [type, d1, d2, d3]
let mouseDX = 0, mouseButtons = 0, mouseDirty = false;
let lastWheel = 0;
const settings = loadSettings();

function loadSettings() {
  const def = { sens: 1.0, invertWheel: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem('doom-web-settings') || '{}')); }
  catch (e) { return def; }
}
function saveSettings() {
  try { localStorage.setItem('doom-web-settings', JSON.stringify(settings)); } catch (e) {}
}

function post(type, d1, d2 = 0, d3 = 0) { queue.push([type, d1, d2, d3]); }

// ---------------------------------------------------------------------------
// Keyboard & mouse
// ---------------------------------------------------------------------------
const keysDown = new Set();
window.addEventListener('keydown', (e) => {
  if (!M || !running) return;
  if (e.code === 'F11' || e.metaKey) return;  // browser fullscreen / iPad Cmd shortcuts
  resumeAudio();
  const k = doomKeyFromEvent(e);
  e.preventDefault();
  if (!k) return;
  if (!keysDown.has(e.code) || e.repeat) post(EV_KEYDOWN, k);
  keysDown.add(e.code);
});
window.addEventListener('keyup', (e) => {
  if (!M || !running) return;
  const k = doomKeyFromEvent(e);
  e.preventDefault();
  keysDown.delete(e.code);
  if (k) post(EV_KEYUP, k);
});
window.addEventListener('blur', () => {
  // release everything so keys don't get stuck
  for (const code of keysDown) {
    const k = doomKeyFromEvent({ code, key: '' });
    if (k) post(EV_KEYUP, k);
  }
  keysDown.clear();
  if (mouseButtons) { mouseButtons = 0; mouseDirty = true; }
  releasePadKeys();
});

const canLock = 'requestPointerLock' in Element.prototype || 'webkitRequestPointerLock' in Element.prototype;
function locked() { return (document.pointerLockElement || document.webkitPointerLockElement) === canvas; }
function lockPointer() {
  if (!running || locked() || !canLock) return;
  try {
    const r = (canvas.requestPointerLock || canvas.webkitRequestPointerLock).call(canvas);
    if (r && r.catch) r.catch(() => {});
  } catch (e) {}
}
// Mouse look also works without pointer lock while a mouse button is held
// (fallback for browsers that refuse pointer lock).
let dragLook = false;
canvas.addEventListener('pointerdown', (e) => {
  resumeAudio();
  if (e.pointerType === 'mouse') { lockPointer(); if (!locked()) dragLook = true; }
});
window.addEventListener('pointerup', () => { dragLook = false; });
document.addEventListener('pointerlockchange', () => {
  $('lockhint').hidden = locked() || !running;
});
document.addEventListener('webkitpointerlockchange', () => {
  $('lockhint').hidden = locked() || !running;
});
$('menubtn').addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  resumeAudio();
  post(EV_KEYDOWN, K.ESC);
  setTimeout(() => post(EV_KEYUP, K.ESC), 60);
});
document.addEventListener('mousemove', (e) => {
  if (!locked() && !dragLook) return;
  mouseDX += e.movementX;
  mouseDirty = true;
});
canvas.addEventListener('mousedown', (e) => {
  if (!locked() && !dragLook) return;
  e.preventDefault();
  if (e.button === 0) { mouseButtons |= 1; mouseDirty = true; }
  else if (e.button === 2) post(EV_KEYDOWN, 32);       // right click = use
  else if (e.button === 1) post(EV_WEAPONCYCLE, 1);
});
window.addEventListener('mouseup', (e) => {
  if (!running) return;
  if (e.button === 0 && (mouseButtons & 1)) { mouseButtons &= ~1; mouseDirty = true; }
  else if (e.button === 2) post(EV_KEYUP, 32);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!running) return;
  const now = performance.now();
  if (now - lastWheel < 120 || e.deltaY === 0) return;
  lastWheel = now;
  let dir = e.deltaY > 0 ? 1 : -1;
  if (settings.invertWheel) dir = -dir;
  post(EV_WEAPONCYCLE, dir);
}, { passive: false });

// ---------------------------------------------------------------------------
// Gamepad (standard mapping: Xbox / PlayStation / Switch Pro controllers)
// ---------------------------------------------------------------------------
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
              L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
let padKeys = new Set();       // doom keys currently held because of the pad
let padPrevButtons = [];
const repeatState = new Map(); // menu navigation auto-repeat
const DEAD = 0.25;

function releasePadKeys() {
  for (const k of padKeys) post(EV_KEYUP, k);
  padKeys = new Set();
  repeatState.clear();
}

function getPad() {
  if (!navigator.getGamepads) return null;
  for (const p of navigator.getGamepads()) if (p && p.connected) return p;
  return null;
}

function pollGamepad() {
  const pad = getPad();
  updatePadBadge(pad);
  if (!pad) { if (padKeys.size) releasePadKeys(); return; }

  const btn = (i) => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.4));
  const pressedNow = (i) => btn(i) && !padPrevButtons[i];
  const ax = (i) => { const v = pad.axes[i] || 0; return Math.abs(v) < DEAD ? 0 : v; };
  const lx = ax(0), ly = ax(1), rx = ax(2);

  const state = M._web_menu_state();   // 0 game, 1 menu, 2 y/n prompt, 3 title/intermission
  const want = new Set();
  const nav = new Set();               // keys that auto-repeat (menu navigation)

  if (state === 0) {
    if (ly < -0.3 || btn(PAD.UP)) want.add('w'.charCodeAt(0));
    if (ly > 0.3 || btn(PAD.DOWN)) want.add('s'.charCodeAt(0));
    if (lx < -0.3) want.add('a'.charCodeAt(0));
    if (lx > 0.3) want.add('d'.charCodeAt(0));
    if (btn(PAD.LEFT)) want.add(K.LEFT);
    if (btn(PAD.RIGHT)) want.add(K.RIGHT);
    if (Math.hypot(lx, ly) > 0.9 || btn(PAD.LT) || btn(PAD.L3)) want.add(K.RSHIFT);
    if (btn(PAD.RT) || btn(PAD.X)) want.add(K.RCTRL);
    if (btn(PAD.A) || btn(PAD.B)) want.add('e'.charCodeAt(0));
    if (btn(PAD.Y) || btn(PAD.BACK)) want.add(K.TAB);
    if (btn(PAD.START)) want.add(K.ESC);
    if (pressedNow(PAD.RB)) post(EV_WEAPONCYCLE, 1);
    if (pressedNow(PAD.LB)) post(EV_WEAPONCYCLE, -1);
    if (rx) {
      // curved response for fine aiming, full deflection ~ 1 turn per second
      mouseDX += Math.sign(rx) * Math.pow(Math.abs(rx), 1.8) * 220 / settings.sens;
      mouseDirty = true;
    }
  } else if (state === 2) {
    if (btn(PAD.A)) want.add('y'.charCodeAt(0));
    if (btn(PAD.B)) want.add('n'.charCodeAt(0));
    if (btn(PAD.START)) want.add(K.ESC);
  } else {
    if (ly < -0.5 || btn(PAD.UP)) nav.add(K.UP);
    if (ly > 0.5 || btn(PAD.DOWN)) nav.add(K.DOWN);
    if (lx < -0.5 || btn(PAD.LEFT)) nav.add(K.LEFT);
    if (lx > 0.5 || btn(PAD.RIGHT)) nav.add(K.RIGHT);
    if (btn(PAD.A)) { want.add(K.ENTER); if (state === 3) want.add('e'.charCodeAt(0)); }
    if (btn(PAD.RT) && state === 3) want.add(K.RCTRL);
    if (btn(PAD.B)) want.add(K.BACKSPACE);
    if (btn(PAD.START)) want.add(K.ESC);
  }

  // auto-repeat for menu navigation
  const now = performance.now();
  for (const k of nav) {
    want.add(k);
    const r = repeatState.get(k);
    if (!r) repeatState.set(k, now + 380);
    else if (now >= r) { post(EV_KEYDOWN, k); repeatState.set(k, now + 140); }
  }
  for (const k of [...repeatState.keys()]) if (!nav.has(k)) repeatState.delete(k);

  for (const k of padKeys) if (!want.has(k)) post(EV_KEYUP, k);
  for (const k of want) if (!padKeys.has(k)) post(EV_KEYDOWN, k);
  padKeys = want;
  padPrevButtons = pad.buttons.map((b) => b.pressed || b.value > 0.4);
}

let padShown = null;
function updatePadBadge(pad) {
  const id = pad ? pad.id : null;
  if (id === padShown) return;
  padShown = id;
  const el = $('padbadge');
  el.hidden = !pad;
  if (pad) el.textContent = '🎮 ' + pad.id.replace(/\s*\(.*$/, '').slice(0, 40) + (running ? '' : ' — A 또는 Start로 시작');
}
window.addEventListener('gamepadconnected', (e) => updatePadBadge(e.gamepad));
window.addEventListener('gamepaddisconnected', () => updatePadBadge(getPad()));

// Called by I_StartTic once per tic.
function pollEvents(bufPtr, max) {
  pollGamepad();
  if (mouseDirty) {
    const dx = Math.round(mouseDX * 4 * settings.sens);
    mouseDX = 0; mouseDirty = false;
    queue.push([EV_MOUSE, mouseButtons, dx, 0]);
  }
  const n = Math.min(max, queue.length);
  const h = M.HEAP32, base = bufPtr >> 2;
  for (let i = 0; i < n; i++) {
    const e = queue[i];
    h[base + i * 4] = e[0]; h[base + i * 4 + 1] = e[1];
    h[base + i * 4 + 2] = e[2]; h[base + i * 4 + 3] = e[3];
  }
  queue.splice(0, n);
  return n;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------
let imageData = null;
function blit(ptr, w, h) {
  if (!imageData || imageData.width !== w) {
    canvas.width = w; canvas.height = h;
    imageData = ctx2d.createImageData(w, h);
  }
  imageData.data.set(M.HEAPU8.subarray(ptr, ptr + w * h * 4));
  ctx2d.putImageData(imageData, 0, 0);
}

// ---------------------------------------------------------------------------
// Audio: sound effects
// ---------------------------------------------------------------------------
let audio = null, sfxBus = null, musicBus = null;
function ensureAudio() {
  if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio = new AC();
  sfxBus = audio.createGain(); sfxBus.gain.value = 0.7; sfxBus.connect(audio.destination);
  musicBus = audio.createGain(); musicBus.gain.value = 0.3; musicBus.connect(audio.destination);
}

function resumeAudio() {
  if (audio && audio.state !== 'running') audio.resume().catch(() => {});
}
document.addEventListener('touchend', resumeAudio, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAudio(); });

const sfxCache = new Map();
const voices = new Map();
let nextHandle = 1;

function sfxBuffer(id, ptr, len) {
  let buf = sfxCache.get(id);
  if (buf) return buf;
  const d = M.HEAPU8.subarray(ptr, ptr + len);
  if (len < 8 || (d[0] | (d[1] << 8)) !== 3) return null;
  const rate = d[2] | (d[3] << 8);
  let count = (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0;
  count = Math.min(count, len - 8);
  let start = 8, n = count;
  if (n > 32) { start += 16; n -= 32; }        // DMX padding bytes
  buf = audio.createBuffer(1, Math.max(1, n), rate);
  const out = buf.getChannelData(0);
  for (let i = 0; i < n; i++) out[i] = (d[start + i] - 128) / 128;
  sfxCache.set(id, buf);
  return buf;
}

function sfxStart(id, ptr, len, vol, sep, pitch) {
  if (!audio) return -1;
  const buf = sfxBuffer(id, ptr, len);
  if (!buf) return -1;
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (pitch - 128) / 64);
  const gain = audio.createGain();
  gain.gain.value = Math.min(1, vol / 15);
  let pan = null;
  if (audio.createStereoPanner) {
    pan = audio.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
    src.connect(gain).connect(pan).connect(sfxBus);
  } else src.connect(gain).connect(sfxBus);
  const handle = nextHandle++;
  const v = { src, gain, pan, done: false };
  src.onended = () => { v.done = true; voices.delete(handle); };
  voices.set(handle, v);
  src.start();
  return handle;
}
function sfxStop(h) { const v = voices.get(h); if (v) { try { v.src.stop(); } catch (e) {} voices.delete(h); } }
function sfxPlaying(h) { const v = voices.get(h); return v && !v.done ? 1 : 0; }
function sfxUpdate(h, vol, sep, pitch) {
  const v = voices.get(h);
  if (!v) return;
  v.gain.gain.value = Math.min(1, vol / 15);
  if (v.pan) v.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
  v.src.playbackRate.value = Math.pow(2, (pitch - 128) / 64);
}

// ---------------------------------------------------------------------------
// Audio: MUS music (small built-in synthesizer, no external soundfont)
// ---------------------------------------------------------------------------
const songs = new Map();
let nextSong = 1;
let music = null;             // currently playing song state
let musicPaused = false;
let musicVol = 8;
let noiseBuf = null;

function parseMus(bytes) {
  const scoreLen = bytes[4] | (bytes[5] << 8);
  const scoreStart = bytes[6] | (bytes[7] << 8);
  const ev = [];
  let p = scoreStart, tick = 0;
  const end = Math.min(bytes.length, scoreStart + scoreLen);
  while (p < end) {
    const desc = bytes[p++];
    const type = (desc >> 4) & 7, ch = desc & 15;
    let a = 0, b = -1;
    switch (type) {
      case 0: a = bytes[p++] & 127; break;                         // release
      case 1: a = bytes[p++]; if (a & 128) { a &= 127; b = bytes[p++] & 127; } break; // play
      case 2: a = bytes[p++]; break;                                // pitch bend
      case 3: a = bytes[p++]; break;                                // system
      case 4: a = bytes[p++]; b = bytes[p++]; break;                // controller
      case 5: break;                                                // measure end
      case 6: ev.push({ t: tick, type: 6, ch: 0 }); p = end; continue;
      default: break;
    }
    ev.push({ t: tick, type, ch, a, b });
    if (desc & 128) {
      let d = 0, c;
      do { c = bytes[p++]; d = d * 128 + (c & 127); } while (c & 128 && p < end);
      tick += d;
    }
  }
  if (!ev.length || ev[ev.length - 1].type !== 6) ev.push({ t: tick, type: 6, ch: 0 });
  return { events: ev, length: ev[ev.length - 1].t };
}

function musicRegister(ptr, len) {
  try {
    const song = parseMus(M.HEAPU8.slice(ptr, ptr + len));
    const h = nextSong++;
    songs.set(h, song);
    return h;
  } catch (e) { console.warn('MUS parse failed', e); return 0; }
}

function newChannels() {
  const chs = [];
  for (let i = 0; i < 16; i++) chs.push({ prog: 0, vol: 100, pan: 64, bend: 0, lastVel: 100, notes: new Map() });
  return chs;
}

function musicPlay(h, looping) {
  musicStop();
  const song = songs.get(h);
  if (!song || !audio) return;
  music = { song, looping, idx: 0, t0: audio.currentTime + 0.1, chs: newChannels() };
  musicPaused = false;
}

function musicStop() {
  if (!music) return;
  for (const ch of music.chs) for (const n of ch.notes.values()) killVoice(n, audio.currentTime);
  music = null;
}

function musicPause(p) {
  if (!music || musicPaused === !!p) { musicPaused = !!p; return; }
  musicPaused = !!p;
  if (musicPaused) {
    music.pausedAt = audio.currentTime;
    for (const ch of music.chs) { for (const n of ch.notes.values()) killVoice(n, audio.currentTime); ch.notes.clear(); }
  } else {
    music.t0 += audio.currentTime - music.pausedAt;
  }
}

function musicVolume(v) {
  musicVol = Math.max(0, Math.min(15, v));
  if (musicBus) musicBus.gain.setTargetAtTime(0.3 * musicVol / 15, audio.currentTime, 0.05);
}

const TICK = 1 / 140;
function timbre(prog) {
  if (prog < 8) return { wave: 'triangle', cut: 3000, a: 0.005, d: 1.2, s: 0.25, r: 0.25, det: 0 };
  if (prog < 16) return { wave: 'sine', cut: 5000, a: 0.002, d: 0.6, s: 0.0, r: 0.3, det: 0 };
  if (prog < 24) return { wave: 'square', cut: 1800, a: 0.01, d: 0.1, s: 0.8, r: 0.1, det: 0, g: 0.6 };
  if (prog === 29 || prog === 30) return { wave: 'sawtooth', cut: 2600, a: 0.004, d: 0.5, s: 0.65, r: 0.12, det: 9, q: 4 };
  if (prog < 32) return { wave: 'triangle', cut: 2500, a: 0.003, d: 0.8, s: 0.2, r: 0.2, det: 4 };
  if (prog < 40) return { wave: 'square', cut: 700, a: 0.004, d: 0.4, s: 0.6, r: 0.08, det: 0, g: 1.2 };
  if (prog < 56) return { wave: 'sawtooth', cut: 1600, a: 0.06, d: 0.3, s: 0.8, r: 0.3, det: 7, g: 0.6 };
  if (prog < 64) return { wave: 'sawtooth', cut: 2200, a: 0.02, d: 0.2, s: 0.75, r: 0.12, det: 3, g: 0.7 };
  if (prog < 80) return { wave: 'square', cut: 2400, a: 0.02, d: 0.2, s: 0.7, r: 0.12, det: 0, g: 0.5 };
  if (prog < 88) return { wave: 'square', cut: 3200, a: 0.005, d: 0.2, s: 0.7, r: 0.1, det: 5, g: 0.5 };
  if (prog < 104) return { wave: 'sawtooth', cut: 1200, a: 0.2, d: 0.5, s: 0.7, r: 0.6, det: 8, g: 0.5 };
  return { wave: 'triangle', cut: 3000, a: 0.005, d: 0.5, s: 0.4, r: 0.2, det: 0 };
}

function noteOn(ch, chn, note, vel, when) {
  const level = (vel / 127) * (chn.vol / 127);
  if (level <= 0) return;
  if (ch === 15) { drum(note, level, chn, when); return; }
  const old = chn.notes.get(note);
  if (old) killVoice(old, when);
  const tb = timbre(chn.prog);
  const out = audio.createGain();
  const filt = audio.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = tb.cut;
  filt.Q.value = tb.q || 0.7;
  const pan = audio.createStereoPanner ? audio.createStereoPanner() : null;
  if (pan) pan.pan.value = (chn.pan - 64) / 64;
  const freq = 440 * Math.pow(2, (note - 69) / 12);
  const oscs = [];
  const n = tb.det ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const o = audio.createOscillator();
    o.type = tb.wave;
    o.frequency.value = freq;
    o.detune.value = chn.bend + (i ? tb.det : 0);
    o.connect(filt);
    oscs.push(o);
  }
  filt.connect(out);
  if (pan) out.connect(pan).connect(musicBus); else out.connect(musicBus);
  const peak = level * 0.16 * (tb.g || 1) / n;
  const g = out.gain;
  g.setValueAtTime(0, when);
  g.linearRampToValueAtTime(peak, when + tb.a);
  g.setTargetAtTime(peak * tb.s, when + tb.a, tb.d / 3);
  for (const o of oscs) o.start(when);
  chn.notes.set(note, { oscs, out, r: tb.r });
}

function noteOff(chn, note, when) {
  const v = chn.notes.get(note);
  if (!v) return;
  chn.notes.delete(note);
  killVoice(v, when);
}

function killVoice(v, when) {
  const r = v.r || 0.05;
  try {
    v.out.gain.cancelScheduledValues(when);
    v.out.gain.setTargetAtTime(0, when, r / 3);
    for (const o of v.oscs) o.stop(when + r + 0.05);
  } catch (e) {}
}

function drum(note, level, chn, when) {
  if (!noiseBuf) {
    noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const out = audio.createGain();
  out.connect(musicBus);
  const amp = level * 0.35;
  const tone = (f0, f1, dur, wave = 'sine', a = amp) => {
    const o = audio.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const g = audio.createGain();
    g.gain.setValueAtTime(a, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    o.connect(g).connect(out);
    o.start(when); o.stop(when + dur + 0.02);
  };
  const noise = (type, freq, dur, a = amp) => {
    const s = audio.createBufferSource();
    s.buffer = noiseBuf;
    const f = audio.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = audio.createGain();
    g.gain.setValueAtTime(a, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    s.connect(f).connect(g).connect(out);
    s.start(when, Math.random() * 0.5); s.stop(when + dur + 0.02);
  };
  if (note === 35 || note === 36) tone(150, 45, 0.25, 'sine', amp * 1.4);
  else if (note === 38 || note === 40) { noise('highpass', 1200, 0.18, amp * 0.8); tone(220, 120, 0.08, 'triangle', amp * 0.6); }
  else if (note === 37 || note === 39) noise('bandpass', 2000, 0.06, amp * 0.8);
  else if (note === 42 || note === 44) noise('highpass', 7000, 0.05, amp * 0.5);
  else if (note === 46) noise('highpass', 7000, 0.25, amp * 0.5);
  else if (note === 49 || note === 52 || note === 55 || note === 57) noise('highpass', 5000, 1.0, amp * 0.5);
  else if (note === 51 || note === 53 || note === 59) noise('highpass', 9000, 0.3, amp * 0.35);
  else if (note >= 41 && note <= 50) { const f = 80 + (note - 41) * 18; tone(f * 1.6, f, 0.3, 'sine', amp); }
  else noise('bandpass', 400 + note * 30, 0.1, amp * 0.5);
}

function musicTick() {
  if (!music || musicPaused || !audio) return;
  const horizon = audio.currentTime + 0.2;
  const { song } = music;
  for (;;) {
    if (music.idx >= song.events.length) {
      if (!music.looping) { music = null; return; }
      music.t0 += (song.length + 1) * TICK;
      music.idx = 0;
      for (const c of music.chs) { c.bend = 0; }
    }
    const e = song.events[music.idx];
    const when = music.t0 + e.t * TICK;
    if (when > horizon) break;
    music.idx++;
    const t = Math.max(when, audio.currentTime);
    const chn = music.chs[e.ch];
    switch (e.type) {
      case 0: noteOff(chn, e.a, t); break;
      case 1: if (e.b >= 0) chn.lastVel = e.b; noteOn(e.ch, chn, e.a, chn.lastVel, t); break;
      case 2:
        chn.bend = (e.a - 128) / 128 * 200;
        for (const v of chn.notes.values()) for (const o of v.oscs) o.detune.setValueAtTime(chn.bend, t);
        break;
      case 3:
        if (e.a === 10 || e.a === 11) { for (const v of chn.notes.values()) killVoice(v, t); chn.notes.clear(); }
        break;
      case 4:
        if (e.a === 0) chn.prog = e.b;
        else if (e.a === 3) chn.vol = e.b;
        else if (e.a === 4) chn.pan = e.b;
        break;
      case 6:
        for (const c of music.chs) { for (const v of c.notes.values()) killVoice(v, t); c.notes.clear(); }
        music.idx = song.events.length;
        break;
    }
  }
}
setInterval(musicTick, 30);

// ---------------------------------------------------------------------------
// WAD handling
// ---------------------------------------------------------------------------
function wadInfo(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error('WAD 파일이 아닙니다.');
  const num = dv.getInt32(4, true), dir = dv.getInt32(8, true);
  const names = new Set();
  for (let i = 0; i < num; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) { const c = bytes[dir + i * 16 + 8 + j]; if (!c) break; s += String.fromCharCode(c); }
    names.add(s.toUpperCase());
  }
  // linuxdoom identifies the game by the IWAD file name
  if (names.has('MAP01')) return { file: 'doom2.wad', game: 'DOOM II' };
  if (names.has('E4M1')) return { file: 'doomu.wad', game: 'Ultimate DOOM' };
  if (names.has('E2M1')) return { file: 'doom.wad', game: 'DOOM (registered)' };
  if (names.has('E1M1')) return { file: 'doom1.wad', game: 'DOOM (shareware)' };
  throw new Error('맵이 들어있는 IWAD가 아닙니다.');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let running = false;
let wadBytes = null, wadMeta = null;

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

async function tryDefaultWads() {
  for (const name of ['doom2.wad', 'doomu.wad', 'doom.wad', 'doom1.wad', 'freedoom1.wad', 'freedoom2.wad']) {
    try {
      const r = await fetch('wads/' + name);
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      useWad(bytes, name);
      return true;
    } catch (e) { /* not found */ }
  }
  return false;
}

function useWad(bytes, label) {
  try {
    wadMeta = wadInfo(bytes);
    wadBytes = bytes;
    setStatus(`${label} — ${wadMeta.game} 준비 완료`);
    $('start').disabled = false;
  } catch (e) {
    setStatus(`${label}: ${e.message}`, true);
  }
}

$('wadfile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) useWad(new Uint8Array(await f.arrayBuffer()), f.name);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (running) return;
  const f = e.dataTransfer.files[0];
  if (f) useWad(new Uint8Array(await f.arrayBuffer()), f.name);
});

$('start').addEventListener('click', start);

let starting = false;
async function start() {
  if (running || starting || !wadBytes) return;
  starting = true;
  ensureAudio();
  $('start').disabled = true;
  setStatus('엔진 로딩 중…');
  try {
    M = await createDoom({
      arguments: [],
      print: (s) => console.log(s),
      printErr: (s) => console.warn(s),
      doomBlit: blit,
      doomPollEvents: pollEvents,
      doomFatal: (msg) => showFatal(msg),
      doomQuit: () => showEnd('게임을 종료했습니다.'),
      doomSfxStart: sfxStart, doomSfxStop: sfxStop,
      doomSfxPlaying: sfxPlaying, doomSfxUpdate: sfxUpdate,
      doomMusicRegister: musicRegister, doomMusicPlay: musicPlay,
      doomMusicStop: musicStop, doomMusicPause: musicPause, doomMusicVolume: musicVolume,
      preRun: [(mod) => {
        const FS = mod.FS;
        FS.mkdir('/wads');
        FS.writeFile('/wads/' + wadMeta.file, wadBytes);
        mod.ENV.DOOMWADDIR = '/wads';
        // persistent config + savegames
        FS.mount(mod.IDBFS || FS.filesystems.IDBFS, {}, '/home/web_user');
        mod.addRunDependency('idbfs');
        FS.syncfs(true, () => mod.removeRunDependency('idbfs'));
      }],
      onAbort: (what) => showFatal('엔진이 중단되었습니다: ' + what),
    });
    running = true;
    wadBytes = null;
    $('overlay').hidden = true;
    $('lockhint').hidden = false;
    canvas.focus();
    lockPointer();
    $('menubtn').hidden = false;
    startPersistence();
  } catch (e) {
    showFatal(String(e && e.message || e));
  }
}

let syncing = false;
function startPersistence() {
  const sync = () => {
    if (!M || syncing) return;
    syncing = true;
    M.FS.syncfs(false, () => { syncing = false; });
  };
  setInterval(sync, 5000);
  window.addEventListener('pagehide', sync);
}

function showFatal(msg) {
  showEnd('오류: ' + msg);
}
function showEnd(msg) {
  running = false;
  if (document.exitPointerLock) document.exitPointerLock();
  try { M && M.FS.syncfs(false, () => {}); } catch (e) {}
  musicStop();
  $('overlay').hidden = false;
  $('lockhint').hidden = true;
  $('menubtn').hidden = true;
  $('startbox').hidden = true;
  $('endbox').hidden = false;
  $('endmsg').textContent = msg;
}

// settings panel
const sensEl = $('sens');
sensEl.value = settings.sens;
$('sensval').textContent = settings.sens.toFixed(1);
sensEl.addEventListener('input', () => {
  settings.sens = parseFloat(sensEl.value);
  $('sensval').textContent = settings.sens.toFixed(1);
  saveSettings();
});
$('fullscreen').addEventListener('click', () => {
  const el = document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { setStatus('이 기기에서는 전체 화면을 지원하지 않아요. Safari 공유 → "홈 화면에 추가"로 실행하면 전체 화면이 돼요.'); return; }
    const r = req.call(el);
    if (r && r.catch) r.catch(() => {});
  }
});
$('reload').addEventListener('click', () => location.reload());

// Gamepad on the start screen: A / Start begins the game.
// (iOS only exposes a pad after one of its buttons has been pressed.)
function startScreenPad() {
  if (running) return;
  const pad = getPad();
  updatePadBadge(pad);
  if (pad && !$('start').disabled) {
    const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
    if (b(PAD.A) || b(PAD.START)) { start(); return; }
  }
  requestAnimationFrame(startScreenPad);
}
requestAnimationFrame(startScreenPad);

tryDefaultWads().then((found) => {
  if (!found) setStatus('WAD 파일을 선택하거나 이 창에 끌어다 놓으세요 (DOOM.WAD, DOOM1.WAD, DOOM2.WAD, freedoom1.wad …)');
});
