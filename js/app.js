import { Avatar } from './avatar.js';
import { AVATAR, SIGNS } from './clips.js';
import { store } from './store.js';
import { buildLexicon, toGloss } from './gloss.js';
import { createRecognizer } from './recognizer.js';

const VERSION = '0.1.0';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TITLES = { translate: 'Translate', scan: 'Scan sign', dictionary: 'Dictionary', profile: 'Profile' };
const signById = new Map(SIGNS.map((s) => [s.id, s]));
const lexicon = buildLexicon(SIGNS);
const avatar = new Avatar(AVATAR, SIGNS);
const recognizer = createRecognizer();

const state = {
  tab: 'translate',
  direction: store.get('direction') || 'en-isl',
  dictQuery: '',
  openId: null,       // expanded dictionary entry
  dictPlaying: false,
  listening: false,
  stream: null,
};

// ── small helpers ──────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 3200);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function icon(name) { const i = el('i', `ph ph-${name}`); i.setAttribute('aria-hidden', 'true'); return i; }

// The avatar stage: overlay for empty/loading, caption, stand-in flag, replay.
function makeStage(small = false) {
  const stage = el('div', `ss-stage${small ? ' ss-stage--sm' : ''}`);
  const empty = el('div', 'ss-stage-empty');
  const badge = el('div', 'ss-badge'); badge.append(icon('user'));
  empty.append(badge, el('div', 'card-title', 'Avatar preview'), el('div', 'card-body text-muted', 'Signing will appear here'));
  const standin = el('span', 'ss-standin tag tag-neutral', 'Stand-in avatar');
  const caption = el('span', 'ss-caption tag tag-accent');
  stage.append(empty, standin, caption);
  return stage;
}
const stageCaption = () => avatar.host?.querySelector('.ss-caption');

avatar.onStep = (id) => {
  const c = stageCaption();
  if (c) c.textContent = signById.get(id)?.en || '';
  store.markSeen(id);
  renderStats();
};
avatar.onMode = () => { renderDictionary(); };

// ── navigation ─────────────────────────────────────────────────────────────
function showTab(tab, { focus = false } = {}) {
  if (tab !== state.tab) { avatar.stop(); state.dictPlaying = false; }
  if (tab !== 'scan') stopScan();
  state.tab = tab;
  $$('[data-screen]').forEach((s) => { s.hidden = s.dataset.screen !== tab; });
  $$('.ss-tab').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const title = $('#screen-title');
  title.textContent = TITLES[tab];
  if (focus) title.focus({ preventScroll: true });
  $('#main').scrollTop = 0;
  if (tab === 'profile') renderProfile();
  if (tab === 'dictionary') renderDictionary();
  syncAvatarMount();
}

function syncAvatarMount() {
  if (state.tab === 'translate' && state.direction === 'en-isl') {
    avatar.mount($('#stage-slot .ss-stage'));
  } else if (state.tab === 'dictionary' && state.openId) {
    const host = $('#dict-list .ss-stage');
    if (host) avatar.mount(host); else avatar.unmount();
  } else {
    avatar.unmount();
  }
}

function setDirection(dir) {
  if (dir !== state.direction) { avatar.stop(); }
  state.direction = dir;
  $$('input[name="direction"]').forEach((r) => { r.checked = r.value === dir; });
  $('#panel-en-isl').hidden = dir !== 'en-isl';
  $('#panel-isl-en').hidden = dir !== 'isl-en';
  syncAvatarMount();
}

// ── translate (English → ISL) ──────────────────────────────────────────────
function renderGloss(ids, missing) {
  const box = $('#gloss');
  box.replaceChildren();
  if (ids.length) {
    box.append(el('span', 'text-muted', 'Signing:'));
    ids.forEach((id) => box.append(el('span', 'tag tag-accent', signById.get(id).en)));
  }
  if (missing.length) {
    const line = el('span', 'ss-gloss-miss text-muted',
      ids.length ? `No clip yet for: ${missing.join(', ')}` : `No clips yet for: ${missing.join(', ')}. Try a word from the Dictionary.`);
    box.append(line);
  }
}

async function translate() {
  const input = $('#input-text');
  const text = input.value.trim();
  if (!text) { toast('Type a sentence first.'); input.focus(); return; }
  const { ids, missing } = toGloss(text, lexicon, (id) => avatar.has(id));
  renderGloss(ids, missing);
  if (!ids.length) return;
  if (avatar.mode === 'unsupported') { toast("The 3D avatar isn't available on this device."); return; }
  lastIds = ids;
  $('#btn-replay')?.removeAttribute('hidden');
  await playIds(ids);
}

let lastIds = [];
async function playIds(ids) {
  try {
    const result = await avatar.play(ids);
    if (result === 'no-model') toast(avatar.mode === 'loading' ? 'The avatar is still loading. Try again in a moment.' : 'No signing avatar is loaded yet.');
  } catch (err) {
    console.error(err);
    toast("Couldn't load that sign. Check your connection and try again.");
  } finally {
    const c = stageCaption(); if (c) c.textContent = '';
  }
}

// Speech input (Web Speech API; Chrome/Edge/Safari — not Firefox)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
function setListening(on) {
  state.listening = on;
  const btn = $('#btn-speak');
  btn.classList.toggle('is-listening', on);
  btn.setAttribute('aria-label', on ? 'Listening' : 'Speak');
  btn.replaceChildren(icon(on ? 'stop' : 'microphone'));
}
function toggleSpeak() {
  if (!SR) { toast("Voice input isn't supported in this browser. Type your message instead."); return; }
  if (state.listening) { recognition?.stop(); return; }
  recognition = new SR();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    $('#input-text').value = e.results[0][0].transcript;
    translate();
  };
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone blocked. Allow microphone access in your browser settings.');
    else if (e.error === 'no-speech') toast("Didn't catch that. Try again.");
    else if (e.error !== 'aborted') toast("Couldn't hear that. Try again.");
  };
  recognition.onend = () => setListening(false);
  try { recognition.start(); setListening(true); } catch { setListening(false); }
}

// ── scan (ISL → English) ───────────────────────────────────────────────────
function setOutText(text) {
  ['#out-a', '#out-b'].forEach((sel) => {
    const o = $(sel); o.textContent = text; o.classList.add('has-text'); o.classList.remove('text-muted');
  });
}

async function startScan() {
  const status = $('#scan-status');
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera needs a secure connection (HTTPS). Open the deployed site or localhost.');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (err) {
    state.stream = null;
    toast(err.name === 'NotFoundError' ? 'No camera found on this device.'
      : 'Camera blocked. Allow camera access in your browser settings, then try again.');
    return;
  }
  const video = $('#cam');
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  $('#camera-frame').classList.add('is-live');
  $('#btn-scan').textContent = 'Stop scanning';
  if (recognizer.ready) {
    status.textContent = 'Scanning…';
    recognizer.start(video, (r) => setOutText(r.text));
  } else {
    status.textContent = "Camera is on. Sign recognition isn't connected yet, so nothing is translated.";
  }
}

function stopScan() {
  if (!state.stream) return;
  recognizer.stop();
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  const video = $('#cam');
  video.srcObject = null;
  $('#camera-frame').classList.remove('is-live');
  $('#btn-scan').textContent = 'Start scanning';
  $('#scan-status').textContent = '';
}

// ── dictionary ─────────────────────────────────────────────────────────────
function renderDictionary() {
  const list = $('#dict-list');
  if (!list) return;
  const q = state.dictQuery.trim().toLowerCase();
  const rows = SIGNS.filter((s) => s.en.toLowerCase().includes(q));
  const wasMounted = avatar.host && list.contains(avatar.host);
  if (wasMounted) avatar.unmount();
  list.replaceChildren();
  $('#dict-empty').hidden = rows.length > 0;

  rows.forEach((s) => {
    const ready = avatar.has(s.id);
    const open = state.openId === s.id;
    const row = el('div', `ss-row ss-entry${open ? ' is-open' : ''}`);

    const btn = el('button', 'ss-entry-btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(open));
    const main = el('span', 'ss-entry-main');
    main.append(el('span', 'ss-entry-word', s.en), el('span', 'tag tag-neutral', s.tag));
    main.lastChild.style.alignSelf = 'flex-start';
    const side = el('span', 'ss-entry-side');
    if (!ready) side.append(el('span', 'ss-soon', 'Coming soon'));
    side.append(icon('caret-right'));
    btn.append(main, side);
    btn.addEventListener('click', () => toggleEntry(s.id));
    row.append(btn);

    if (open) {
      const demo = el('div', 'ss-demo');
      if (ready) {
        demo.append(makeStage(true));
        const bar = el('div', 'ss-demo-bar');
        bar.append(el('div', 'text-muted', `Avatar demonstration for “${s.en}”`));
        const play = el('button', 'btn btn-icon btn-ghost');
        play.type = 'button';
        play.id = 'dict-play';
        play.setAttribute('aria-label', state.dictPlaying ? 'Pause' : 'Play');
        play.append(icon(state.dictPlaying ? 'pause' : 'play'));
        play.addEventListener('click', () => dictTogglePlay(s.id));
        bar.append(play);
        demo.append(bar);
      } else {
        demo.append(el('div', 'text-muted ss-small', 'No demonstration for this sign yet.'));
      }
      row.append(demo);
    }
    list.append(row);
  });
  if (state.tab === 'dictionary') syncAvatarMount();
}

function toggleEntry(id) {
  avatar.stop();
  state.dictPlaying = false;
  state.openId = state.openId === id ? null : id;
  renderDictionary();
  if (state.openId && avatar.has(state.openId)) dictTogglePlay(state.openId);
}

async function dictTogglePlay(id) {
  if (state.dictPlaying) {
    avatar.pause(); state.dictPlaying = false; renderDictionary(); return;
  }
  if (avatar.paused && avatar.currentId === id) {
    avatar.resume(); state.dictPlaying = true; renderDictionary(); return;
  }
  state.dictPlaying = true;
  renderDictionary();
  try {
    await avatar.play(id, { loop: true });
  } catch (err) {
    console.error(err);
    toast("Couldn't load that sign. Check your connection and try again.");
    state.dictPlaying = false; renderDictionary();
  } finally {
    const c = stageCaption(); if (c) c.textContent = '';
  }
}

// ── profile ────────────────────────────────────────────────────────────────
function renderStats() {
  $('#stat-seen').textContent = String(store.get('seen').length);
  $('#stat-streak').textContent = String(store.streak());
}
function renderProfile() {
  renderStats();
  $$('input[name="pref-dir"]').forEach((r) => { r.checked = r.value === store.get('direction'); });
  $$('input[name="pref-speed"]').forEach((r) => { r.checked = Number(r.value) === store.get('speed'); });
  $('#app-version').textContent = VERSION;
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#row-install').hidden = false;
});
window.addEventListener('appinstalled', () => { $('#row-install').hidden = true; installEvent = null; });

// ── wiring ─────────────────────────────────────────────────────────────────
function wire() {
  $$('.ss-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab, { focus: true })));
  $('#btn-settings').addEventListener('click', () => showTab('profile', { focus: true }));
  $('#btn-open-scan').addEventListener('click', () => showTab('scan', { focus: true }));

  $$('input[name="direction"]').forEach((r) => r.addEventListener('change', () => setDirection(r.value)));
  $('#btn-translate').addEventListener('click', translate);
  const box = $('#input-text');                                  // the text box grows a little as you type
  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 96) + 'px'; });
  $('#btn-speak').addEventListener('click', toggleSpeak);
  $('#input-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); translate(); }
  });

  $('#btn-scan').addEventListener('click', () => (state.stream ? stopScan() : startScan()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

  $('#dict-query').addEventListener('input', (e) => { state.dictQuery = e.target.value; renderDictionary(); });

  $$('input[name="pref-dir"]').forEach((r) => r.addEventListener('change', () => {
    store.set('direction', r.value);
  }));
  $$('input[name="pref-speed"]').forEach((r) => r.addEventListener('change', () => {
    store.set('speed', Number(r.value)); avatar.setSpeed(Number(r.value)); refreshSpeedLabel();
  }));
  $('#btn-install').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null; $('#row-install').hidden = true;
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Reset the signs you have viewed and your day streak on this device?')) return;
    store.reset(); renderProfile(); toast('Local data reset.');
  });
}

// Replay button lives on the translate stage
const SPEEDS = [1, 0.75, 0.5];
function refreshSpeedLabel() {
  const b = $('#btn-speed');
  if (b) b.textContent = `${avatar.speed}×`;
}
function addTools() {
  const box = el('div', 'ss-tools');
  const speed = el('button', 'btn btn-secondary ss-speed');
  speed.type = 'button'; speed.id = 'btn-speed';
  speed.setAttribute('aria-label', 'Signing speed');
  speed.addEventListener('click', () => {
    const next = SPEEDS[(SPEEDS.indexOf(avatar.speed) + 1) % SPEEDS.length];
    avatar.setSpeed(next);
    store.set('speed', next);
    refreshSpeedLabel();
  });
  const btn = el('button', 'btn btn-icon btn-secondary');
  btn.type = 'button'; btn.id = 'btn-replay'; btn.hidden = true;
  btn.setAttribute('aria-label', 'Replay signing');
  btn.append(icon('arrow-counter-clockwise'));
  btn.addEventListener('click', () => lastIds.length && playIds(lastIds));
  box.append(speed, btn);
  $('#stage-slot .ss-stage').append(box);
  refreshSpeedLabel();
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  $('#stage-slot').append(makeStage());
  avatar.setSpeed(store.get('speed') || 1);
  addTools();
  wire();
  store.touchToday();

  const params = new URLSearchParams(location.search);
  const startTab = TITLES[params.get('tab')] ? params.get('tab') : 'translate';
  setDirection(state.direction);
  showTab(startTab);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw] registration failed', err));
  }

  await avatar.init();
  renderDictionary();
  syncAvatarMount();
}
boot();
