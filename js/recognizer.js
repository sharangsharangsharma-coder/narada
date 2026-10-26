// ISL → English recognition hook.
//
// STATUS: hand-landmark TRACKING is connected (MediaPipe HandLandmarker,
// runs fully in-browser). Sign CLASSIFICATION is not — there is no trained
// model behind this yet, because no sign-level ISL dataset exists at the
// scale needed (the only usable one, INCLUDE, has 263 words from 7
// signers). This file draws the live hand skeleton as groundwork toward
// recognition and is honest about that gap in its own output text —
// it never fabricates a translated sign.
//
// Contract (unchanged):
//   ready                  → true once this recognizer can do something
//                            useful with a video feed (tracking, here)
//   start(video, onResult) → begin reading frames from the <video> element
//                            and call onResult({ text, confidence, alternatives })
//   stop()                 → stop reading frames and release resources

const TASKS_VISION_VERSION = '0.10.14';
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`;
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 21-point hand skeleton topology (MediaPipe Hands landmark indices)
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                  // palm base
];

let landmarker = null;
let loadPromise = null;

async function loadLandmarker() {
  if (landmarker) return landmarker;
  if (!loadPromise) {
    loadPromise = (async () => {
      const { HandLandmarker, FilesetResolver } = await import(VISION_BUNDLE_URL);
      const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);
      const baseOptions = { modelAssetPath: MODEL_URL };
      try {
        landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { ...baseOptions, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        });
      } catch (err) {
        console.warn('[recognizer] GPU delegate failed, falling back to CPU', err);
        landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { ...baseOptions, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        });
      }
      return landmarker;
    })();
  }
  return loadPromise;
}

export function createRecognizer() {
  let canvas = null;
  let ctx = null;
  let rafId = 0;
  let running = false;
  let hadHand = false;
  let onResultCb = null;

  function ensureCanvas(video) {
    const frame = video.closest('.ss-camera') || video.parentElement;
    canvas = frame?.querySelector('#cam-overlay') || null;
    ctx = canvas?.getContext('2d') || null;
  }

  function draw(result, video) {
    if (!canvas || !ctx) return;
    const w = video.clientWidth || video.videoWidth || 0;
    const h = video.clientHeight || video.videoHeight || 0;
    if (!w || !h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hands = result.landmarks || [];
    for (const lm of hands) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(122, 162, 255, 0.9)';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a], pb = lm[b];
        if (!pa || !pb) continue;
        ctx.moveTo(pa.x * canvas.width, pa.y * canvas.height);
        ctx.lineTo(pb.x * canvas.width, pb.y * canvas.height);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(122, 162, 255, 0.95)';
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (hands.length && !hadHand) {
      hadHand = true;
      onResultCb?.({
        text: 'Hand tracking active — recognition model coming soon',
        confidence: 0,
        alternatives: [],
      });
    } else if (!hands.length && hadHand) {
      hadHand = false;
    }
  }

  function loop(video) {
    if (!running) return;
    try {
      const result = landmarker.detectForVideo(video, performance.now());
      draw(result, video);
    } catch (err) {
      console.warn('[recognizer] detect failed', err);
    }
    rafId = requestAnimationFrame(() => loop(video));
  }

  return {
    ready: true, // tracking is connected; classification is not (see header note)

    async start(video, onResult) {
      onResultCb = onResult;
      hadHand = false;
      ensureCanvas(video);
      try {
        await loadLandmarker();
      } catch (err) {
        console.error('[recognizer] failed to load hand landmarker', err);
        onResult?.({
          text: "Couldn't load hand tracking. Check your connection and try again.",
          confidence: 0,
          alternatives: [],
        });
        return;
      }
      running = true;
      loop(video);
    },

    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
