// Three.js avatar: one character, many animation clips.
//
//   const avatar = new Avatar(AVATAR, SIGNS);
//   await avatar.init();               // probes files, loads the character
//   avatar.mount(someElement);         // the single canvas moves between screens
//   await avatar.play(['summer']);     // plays clips in order
//
// Clips are .glb files exported from the same rig as the character, so their
// animation tracks target the same bone names and can be applied to it.

import * as THREE from '../vendor/three.bundle.js';
import { clipUrl } from './clips.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// A file "exists" if it's in the service-worker cache or the server returns a
// non-HTML 2xx (static hosts that rewrite unknown paths to index.html return HTML).
async function probe(url) {
  try {
    if ('caches' in window && await caches.match(url, { ignoreMethod: true })) return true;
    const res = await fetch(url, { method: 'HEAD' });
    const type = res.headers.get('content-type') || '';
    return res.ok && !type.includes('text/html');
  } catch { return false; }
}

// A small procedural "studio room" used purely to bake an environment map from
// (via PMREMGenerator), so materials get realistic reflections/ambient occlusion
// without needing to ship an external HDRI file. Never rendered directly.
function buildStudioRoom() {
  const room = new THREE.Scene();
  const geo = new THREE.BoxGeometry();
  geo.deleteAttribute('uv');
  const mat = new THREE.MeshStandardMaterial({ side: THREE.BackSide });
  const box = new THREE.Mesh(geo, mat);
  box.scale.setScalar(20);
  room.add(box);

  const addPanel = (color, intensity, w, h, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const light = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    );
    light.position.set(x, y, z);
    light.rotation.set(rx, ry, rz);
    light.material.color.multiplyScalar(intensity);
    room.add(light);
  };
  // Soft key panel (front-upper), a cooler fill panel (side), and a warm
  // bounce panel (floor-ish) -- gives the environment map some directional
  // character instead of a flat grey ambient.
  addPanel(0xfff4e6, 4.5, 6, 6, 2, 6, 4, 0, -0.4, 0);
  addPanel(0xdfe6ff, 2.5, 5, 8, -6, 3, -2, 0, 0.6, 0);
  addPanel(0xffffff, 1.2, 8, 8, 0, -4, 0, Math.PI / 2, 0, 0);
  return room;
}

export class Avatar {
  constructor(cfg, signs) {
    this.cfg = cfg;
    this.signs = signs;
    this.byId = new Map(signs.map((s) => [s.id, s]));
    this.available = new Set();
    this.clips = new Map();        // id → AnimationClip
    this.mode = 'loading';         // loading | model | standin | unsupported
    this.host = null;
    this.root = null;
    this.mixer = null;
    this.current = null;           // AnimationAction on screen
    this.currentId = null;
    this.speed = 1;
    this.paused = false;
    this.runId = 0;
    this._cancel = null;
    this._raf = 0;
    this.onStep = null;            // (id, index) => void
    this.onMode = null;            // (mode) => void

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ss-avatar-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Signing avatar');

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    } catch (err) {
      console.warn('[avatar] WebGL unavailable', err);
      this.renderer = null;
      this._setMode('unsupported');
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    // Filmic tone mapping + correct color space: the single biggest things that
    // make a real-time render stop looking like a flat "game asset" and start
    // reading as a graded, cinematic image.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    if ('outputColorSpace' in this.renderer) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if ('outputEncoding' in this.renderer) this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    // A narrower FOV (was 30) reads less "fisheye"/distorted, closer to how a
    // photographed subject looks; _frame() already moves the camera back to
    // compensate, so framing stays the same, just with less perspective skew.
    this.camera = new THREE.PerspectiveCamera(22, 1, 0.05, 100);
    this._last = 0;
    this._elapsed = 0;
    this.loader = new THREE.GLTFLoader();

    // Image-based lighting: bake a studio-room environment map so materials get
    // realistic ambient reflections/occlusion instead of flat directional-only
    // shading. This is what gives the "premium render" look rather than a matte
    // game-asset look -- it costs one offscreen render at startup, nothing per frame.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileCubemapShader();
    const studioRoom = buildStudioRoom();
    this.scene.environment = pmrem.fromScene(studioRoom, 0.04).texture;
    pmrem.dispose();

    // Lighting: a softer key + fill now that the environment map is carrying
    // most of the ambient/reflection work, plus the faint violet rim (the
    // Nocturne accent) kept subtle so it doesn't compete with the key.
    this.scene.add(new THREE.HemisphereLight(0xeef0ff, 0x2a2c3f, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.8, 1.9, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 8;
    key.shadow.camera.left = -1.1;
    key.shadow.camera.right = 1.1;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.1;
    key.shadow.bias = -0.0015;
    key.shadow.radius = 3;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7); fill.position.set(-1.6, 0.8, 2.5); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9184d9, 0.6); rim.position.set(-2, 1.5, -2.5); this.scene.add(rim);

    // A faint, mostly-invisible floor that only shows a soft contact shadow
    // under the character's feet -- grounds the render without drawing a
    // visible floor plane (the app's background stays transparent).
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.ShadowMaterial({ opacity: 0.32 })
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = 0;
    shadowCatcher.receiveShadow = true;
    this.scene.add(shadowCatcher);

    // Post-processing: a touch of bloom on bright highlights + a soft vignette
    // at the frame edges -- the "cinematic grade" finishing pass. OutputPass
    // at the end re-applies tone mapping/color space, which composer passes
    // otherwise bypass.
    this.composer = new THREE.EffectComposer(this.renderer);
    this.composer.addPass(new THREE.RenderPass(this.scene, this.camera));
    // Bloom runs on pre-tonemap linear light values, so a plain bright white
    // shirt can cross a low threshold and glow -- keep strength low and the
    // threshold high so only genuine specular highlights catch it, not flat
    // bright surfaces.
    this.bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), 0.15, 0.3, 1.15);
    this.composer.addPass(this.bloomPass);
    const vignetteShader = {
      uniforms: { tDiffuse: { value: null }, offset: { value: 0.85 }, darkness: { value: 0.45 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float offset; uniform float darkness; varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(tDiffuse, vUv);
          vec2 uv = (vUv - 0.5) * 2.0;
          float vig = 1.0 - smoothstep(offset, 1.4, length(uv));
          vig = mix(1.0, vig, darkness);
          gl_FragColor = vec4(texel.rgb * vig, texel.a);
        }`,
    };
    this.vignettePass = new THREE.ShaderPass(vignetteShader);
    this.composer.addPass(this.vignettePass);
    this.composer.addPass(new THREE.OutputPass());

    this._ro = new ResizeObserver(() => this._resize());
    document.addEventListener('visibilitychange', () => this._kick());
  }

  // ── setup ────────────────────────────────────────────────────────────────
  async init() {
    if (!this.renderer) return;
    // Only signs that declare a file are checked; a missing file means "coming soon".
    const declared = this.signs.filter((s) => clipUrl(s));
    const checks = await Promise.all(declared.map(async (s) => [s.id, await probe(clipUrl(s))]));
    this.available = new Set(checks.filter(([, ok]) => ok).map(([id]) => id));

    // 1. dedicated character file, 2. the first available clip's file, 3. stand-in
    const candidates = [];
    if (this.cfg.character && await probe(this.cfg.character)) candidates.push({ url: this.cfg.character });
    for (const s of this.signs) if (this.available.has(s.id)) candidates.push({ url: clipUrl(s), sign: s });

    for (const c of candidates) {
      try {
        const gltf = await this.loader.loadAsync(c.url);
        this._setCharacter(gltf.scene);
        if (c.sign) this._cacheClip(c.sign, gltf.animations);
        this._setMode('model');
        await this._showRest();
        return;
      } catch (err) {
        console.warn('[avatar] could not load', c.url, err);
      }
    }
    this._setCharacter(buildStandIn());
    this._setMode('standin');
  }

  has(id) { return this.available.has(id); }

  _setMode(mode) {
    this.mode = mode;
    if (this.host) this.host.dataset.avatar = mode;
    this.onMode?.(mode);
  }

  _setCharacter(obj) {
    if (this.root) this.scene.remove(this.root);
    this.root = obj;
    obj.traverse((n) => {
      if (!(n.isSkinnedMesh || n.isMesh)) return;
      n.frustumCulled = false;
      n.castShadow = true;
      n.receiveShadow = true;
      // Blender exports every material as see-through (alpha blend) with no depth writing, so the body can be
      // painted over the clothes. Draw everything as solid instead, with hard-edged cut-outs for hair and eyebrows.
      const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
      for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
        m.transparent = false;
        m.depthWrite = true;
        m.alphaTest = 0.1;
        // Sharper texture at glancing angles (the shirt logo/fabric weave) --
        // free quality, no visual trade-off at this budget.
        if (m.map) { m.map.anisotropy = maxAniso; m.map.needsUpdate = true; }
        m.needsUpdate = true;
      }
    });
    this.scene.add(obj);
    this.mixer = new THREE.AnimationMixer(obj);
    this.mixer.timeScale = this.paused ? 0 : this.speed;
    obj.updateMatrixWorld(true);
    this.bounds = new THREE.Box3().setFromObject(obj);
    this._resize();
  }

  _cacheClip(sign, animations) {
    const clip = (sign.clip && animations.find((a) => a.name === sign.clip)) || animations[0];
    if (clip) this.clips.set(sign.id, clip);
    return clip;
  }

  async _getClip(id) {
    if (this.clips.has(id)) return this.clips.get(id);
    const sign = this.byId.get(id);
    if (!sign || !this.available.has(id)) throw new Error(`No clip file for "${id}"`);
    const gltf = await this.loader.loadAsync(clipUrl(sign));
    const clip = this._cacheClip(sign, gltf.animations);
    if (!clip) throw new Error(`"${clipUrl(sign)}" contains no animation`);
    return clip;
  }

  // Hold frame 0 of the first available clip so the character isn't left in a T-pose.
  async _showRest() {
    const first = this.signs.find((s) => this.available.has(s.id));
    if (!first || !this.mixer) return;
    try {
      const clip = await this._getClip(first.id);
      const action = this.mixer.clipAction(clip);
      action.reset().play();
      action.paused = true;
      this.mixer.update(0);
      this.current = action;
    } catch (err) { console.warn('[avatar] rest pose failed', err); }
  }

  // ── mounting & rendering ────────────────────────────────────────────────
  mount(el) {
    if (!this.renderer) { el.dataset.avatar = 'unsupported'; return; }
    if (this.host === el && this.canvas.parentNode === el) return;
    this.unmount();
    this.host = el;
    el.prepend(this.canvas);
    el.dataset.avatar = this.mode;
    this._ro.observe(el);
    this._resize();
    this._kick();
  }

  unmount() {
    if (!this.renderer) return;
    if (this.host) this._ro.unobserve(this.host);
    this.canvas.remove();
    this.host = null;
    this._kick();
  }

  _resize() {
    if (!this.renderer || !this.host) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      const ratio = this.renderer.getPixelRatio();
      this.composer.setSize(w, h);
      this.composer.setPixelRatio(ratio);
      this.bloomPass?.setSize(w * ratio, h * ratio);
    }
    this._frame();
  }

  _frame() {
    if (!this.bounds) return;
    const size = this.bounds.getSize(new THREE.Vector3());
    const c = this.bounds.getCenter(new THREE.Vector3());
    const { focusY, height, width } = this.cfg.frame;
    const y = this.bounds.min.y + size.y * focusY;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const distV = (size.y * height) / 2 / t;
    const distH = (size.y * width) / 2 / (t * this.camera.aspect);
    const dist = Math.max(distV, distH);
    this.camera.position.set(c.x, y, this.bounds.max.z + dist);
    this.camera.lookAt(c.x, y, c.z);
  }

  _kick() {
    const shouldRun = !!(this.renderer && this.host && !document.hidden);
    if (shouldRun && !this._raf) {
      this._last = performance.now();
      const tick = (now) => {
        this._raf = requestAnimationFrame(tick);
        const dt = Math.min((now - this._last) / 1000, 0.1);
        this._last = now;
        this._elapsed += dt;
        this.mixer?.update(dt);
        if (this.mode === 'standin' && this.root && !reducedMotion.matches) {
          const t = this._elapsed;
          this.root.rotation.y = Math.sin(t * 0.6) * 0.18;
          this.root.position.y = Math.sin(t * 1.4) * 0.006;
        }
        if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(tick);
    } else if (!shouldRun && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  // ── playback ─────────────────────────────────────────────────────────────
  setSpeed(s) {
    this.speed = s;
    if (this.mixer && !this.paused) this.mixer.timeScale = s;
  }
  pause()  { this.paused = true;  if (this.mixer) this.mixer.timeScale = 0; }
  resume() { this.paused = false; if (this.mixer) this.mixer.timeScale = this.speed; }

  stop() {
    this.runId++;
    this._cancel?.();
    this._cancel = null;
    this.currentId = null;
    this.paused = false;
    if (this.mixer) this.mixer.timeScale = this.speed;
  }

  // Plays one id or an array of ids in order.
  // Resolves 'done' | 'cancelled' | 'no-model'. Rejects if a clip can't be loaded.
  async play(ids, { loop = false } = {}) {
    if (this.mode !== 'model') return 'no-model';
    const list = Array.isArray(ids) ? ids : [ids];
    this.stop();
    const run = this.runId;
    for (let i = 0; i < list.length; i++) {
      const clip = await this._getClip(list[i]);
      if (run !== this.runId) return 'cancelled';
      this.currentId = list[i];
      this.onStep?.(list[i], i);
      const result = await this._runClip(clip, loop && list.length === 1);
      if (result === 'cancelled' || run !== this.runId) return 'cancelled';
    }
    this.currentId = null;
    return 'done';
  }

  _runClip(clip, loop) {
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.paused = false;
    action.clampWhenFinished = true;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, 0.2, false);
    action.play();
    this.current = action;

    return new Promise((resolve) => {
      const onDone = (e) => {
        if (e.action !== action) return;
        this.mixer.removeEventListener('finished', onDone);
        this._cancel = null;
        resolve('done');
      };
      this._cancel = () => {
        this.mixer.removeEventListener('finished', onDone);
        resolve('cancelled');
      };
      if (!loop) this.mixer.addEventListener('finished', onDone);
    });
  }
}

// Shown when no character .glb is available yet, so the slot is visibly alive.
function buildStandIn() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x595d6c, roughness: 0.85, metalness: 0 });
  const add = (geo, x, y, z, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.z = rz; g.add(m); return m;
  };
  add(new THREE.CapsuleGeometry(0.19, 0.5, 6, 16), 0, 1.22, 0);          // torso
  add(new THREE.SphereGeometry(0.13, 24, 16), 0, 1.72, 0);               // head
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 12), 0, 1.6, 0);       // neck
  add(new THREE.CapsuleGeometry(0.05, 0.5, 4, 12), -0.29, 1.15, 0, 0.12); // arms
  add(new THREE.CapsuleGeometry(0.05, 0.5, 4, 12), 0.29, 1.15, 0, -0.12);
  add(new THREE.CapsuleGeometry(0.075, 0.6, 4, 12), -0.1, 0.55, 0);      // legs
  add(new THREE.CapsuleGeometry(0.075, 0.6, 4, 12), 0.1, 0.55, 0);
  return g;
}
