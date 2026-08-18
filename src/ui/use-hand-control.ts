'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Smoother } from '@/dsp/smoothing';

export interface HandReading {
  x: number;
  y: number;
  pinch: number;
  spread: number;
}

export interface HandControlState {
  supported: boolean;
  active: boolean;
  error: string | null;
  /**
   * Roles are assigned by SCREEN POSITION, not MediaPipe's handedness label.
   * Handedness is computed on the un-mirrored image, so in a selfie view its
   * "Left" is the user's right hand — a reliable source of inverted-control
   * bugs. Leftmost hand on the mirrored preview is `left`, full stop: what you
   * see is what you get.
   */
  left: HandReading | null;
  right: HandReading | null;
}

export interface HandControlOptions {
  enabled: boolean;
  onHands: (left: HandReading | null, right: HandReading | null) => void;
}

/**
 * Landmark buffer, overwritten in place each frame so the detect loop allocates
 * nothing: 21 (x, y) pairs, un-mirrored, 0..1. Drawing code mirrors x itself.
 */
export interface HandFrame {
  readonly points: Float32Array;
  present: boolean;
}

/** Both hands' landmark frames, so the overlay can draw each one. */
export interface HandFrames {
  readonly left: HandFrame;
  readonly right: HandFrame;
}

/**
 * Structural view of @mediapipe/tasks-vision, declared locally (as use-midi.ts
 * does for Web MIDI) so this file compiles with or without the optional package.
 */
interface Landmark { readonly x: number; readonly y: number; readonly z: number }
interface DetectionResult { readonly landmarks: readonly (readonly Landmark[])[] }
interface HandLandmarkerLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): DetectionResult;
  close(): void;
}
interface LandmarkerOptions {
  baseOptions: { modelAssetPath: string; delegate: 'GPU' | 'CPU' };
  runningMode: 'VIDEO';
  numHands: number;
}
interface VisionModule {
  FilesetResolver: { forVisionTasks(wasmRoot: string): Promise<unknown> };
  HandLandmarker: {
    createFromOptions(f: unknown, o: LandmarkerOptions): Promise<HandLandmarkerLike>;
  };
}
interface FrameCallbackHost {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}
interface Smoothers { x: Smoother; y: Smoother; pinch: Smoother; spread: Smoother }

/**
 * MUST match the installed @mediapipe/tasks-vision version. A mismatch 404s the
 * whole fileset and hand tracking fails with a misleading "check your
 * connection" — which is exactly what happened when this was pinned to 0.10.22
 * while 1.0.1 was installed. tests/ui/hand-control-version.test.ts fails the
 * build if these ever drift apart again.
 */
const MEDIAPIPE_VERSION = '1.0.1';
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9, LANDMARK_COUNT = 21;
const PALM_POINTS = [0, 5, 9, 13, 17];
const FINGER_TIPS = [4, 8, 12, 16, 20];

/** Detection runs at video rate, so that is the smoother's "sample rate". */
const FRAME_RATE = 30, POSITION_MS = 60, SHAPE_MS = 90;
/** Thumb-to-index distance in hand-lengths: touching .. fully open. */
const PINCH_MIN = 0.15, PINCH_MAX = 1.1;
/** Mean fingertip-to-palm distance in hand-lengths: fist .. splayed. */
const SPREAD_MIN = 0.5, SPREAD_MAX = 1.05;
/** ~15 Hz is ample for the on-screen readout; modulation uses the callback. */
const PUBLISH_MS = 66;
const DENIED = 'Camera permission was denied. Allow camera access for this site, then try again.';
const MISSING = 'No camera was found on this device.';
const BUSY = 'The camera is already in use by another application.';
const NO_API = 'This browser has no camera API.';
const INSECURE = 'The camera needs a secure connection. Open SIGIL over HTTPS or on localhost.';
const NO_MODEL = 'Hand tracking could not be loaded. Check your connection and try again.';
const NO_PLAY = 'The camera preview could not start playing.';
const CAMERA_ERRORS: Readonly<Record<string, string>> = {
  NotAllowedError: DENIED, SecurityError: DENIED, PermissionDeniedError: DENIED,
  NotFoundError: MISSING, DevicesNotFoundError: MISSING, OverconstrainedError: MISSING,
  NotReadableError: BUSY, TrackStartError: BUSY,
};

function cameraError(e: unknown): string {
  const name =
    typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  return CAMERA_ERRORS[name] ?? 'The camera could not be started.';
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function scale01(v: number, lo: number, hi: number): number { return clamp01((v - lo) / (hi - lo)); }

function lx(pts: Float32Array, i: number): number { return pts[i * 2] ?? 0; }
function ly(pts: Float32Array, i: number): number { return pts[i * 2 + 1] ?? 0; }

/** x is normalised by frame width and y by height, so x needs its aspect back. */
function dist(ax: number, ay: number, bx: number, by: number, aspect: number): number {
  const dx = (ax - bx) * aspect, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function span(pts: Float32Array, a: number, b: number, aspect: number): number {
  return dist(lx(pts, a), ly(pts, a), lx(pts, b), ly(pts, b), aspect);
}

/**
 * Writes the four raw 0..1 signals into `out`. Distances are divided by
 * wrist-to-middle-knuckle, so camera distance does not change them.
 */
function measure(pts: Float32Array, aspect: number, out: Float32Array): boolean {
  const size = span(pts, WRIST, MIDDLE_MCP, aspect);
  if (size < 1e-4) return false;
  let cx = 0, cy = 0, splay = 0;
  for (let i = 0; i < PALM_POINTS.length; i += 1) {
    const j = PALM_POINTS[i] ?? 0; cx += lx(pts, j); cy += ly(pts, j);
  }
  cx /= PALM_POINTS.length;
  cy /= PALM_POINTS.length;
  for (let i = 0; i < FINGER_TIPS.length; i += 1) {
    const j = FINGER_TIPS[i] ?? 0; splay += dist(lx(pts, j), ly(pts, j), cx, cy, aspect);
  }
  // Mirrored x: the webcam image is flipped, and a hand moving right should
  // move the parameter right. y is flipped too, so raising the hand raises it.
  out[0] = clamp01(1 - cx);
  out[1] = clamp01(1 - cy);
  out[2] = 1 - scale01(span(pts, THUMB_TIP, INDEX_TIP, aspect) / size, PINCH_MIN, PINCH_MAX);
  out[3] = scale01(splay / FINGER_TIPS.length / size, SPREAD_MIN, SPREAD_MAX);
  return true;
}

/** Snapping on reacquisition stops a hand re-entering elsewhere from sweeping. */
function smooth(s: Smoother, target: number, snap: boolean): number {
  if (snap) s.snap(target); else s.setTarget(target);
  return s.next();
}

async function loadLandmarker(): Promise<HandLandmarkerLike> {
  const loaded: unknown =
    // @ts-ignore optional dependency: absence is handled as an error state below.
    await import('@mediapipe/tasks-vision');
  const vision = loaded as VisionModule;
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
  const options: LandmarkerOptions = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2,
  };
  try {
    return await vision.HandLandmarker.createFromOptions(fileset, options);
  } catch {
    options.baseOptions.delegate = 'CPU';
    return vision.HandLandmarker.createFromOptions(fileset, options);
  }
}

/**
 * Hand position and shape as four smoothed 0..1 signals, from the local camera
 * via MediaPipe's hand landmarker. Round-trip latency is 50-100 ms, so this is
 * a modulation source only, never a way to trigger notes.
 *
 * The camera starts only when `enabled` flips true, and every track is stopped
 * when it flips back or the component unmounts. Frames never leave the device.
 */
export function useHandControl(opts: HandControlOptions): HandControlState & {
  videoRef: RefObject<HTMLVideoElement | null>;
  frameRef: RefObject<HandFrame>;
  framesRef: RefObject<HandFrames>;
} {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<HandReading | null>(null);
  const [right, setRight] = useState<HandReading | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HandFrame>({ points: new Float32Array(LANDMARK_COUNT * 2), present: false });
  const framesRef = useRef<HandFrames>({
    left: { points: new Float32Array(LANDMARK_COUNT * 2), present: false },
    right: { points: new Float32Array(LANDMARK_COUNT * 2), present: false },
  });
  const rawRef = useRef<Float32Array>(new Float32Array(4));
  const onHandsRef = useRef(opts.onHands);
  onHandsRef.current = opts.onHands;

  const makeSmoothers = (): Smoothers => ({
    x: new Smoother(FRAME_RATE, POSITION_MS), y: new Smoother(FRAME_RATE, POSITION_MS),
    pinch: new Smoother(FRAME_RATE, SHAPE_MS), spread: new Smoother(FRAME_RATE, SHAPE_MS),
  });
  // One set per role. Sharing smoothers between hands would make each hand drag
  // the other's values toward it whenever they crossed.
  const smoothersRef = useRef<{ left: Smoothers; right: Smoothers } | null>(null);
  smoothersRef.current ??= { left: makeSmoothers(), right: makeSmoothers() };
  const enabled = opts.enabled;

  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return;
    setSupported(window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function');
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    const frame = frameRef.current;
    const raw = rawRef.current;
    const smoothers = smoothersRef.current;
    if (video === null || smoothers === null) return;
    const media = navigator.mediaDevices;
    if (!window.isSecureContext) { setError(INSECURE); return; }
    if (typeof media?.getUserMedia !== 'function') { setError(NO_API); return; }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let landmarker: HandLandmarkerLike | null = null;
    let rafHandle = 0, vfcHandle = 0, lastTs = 0, lastPublish = 0;
    const hadHand: { left: boolean; right: boolean } = { left: false, right: false };
    const host = video as HTMLVideoElement & FrameCallbackHost;
    const requestFrame = host.requestVideoFrameCallback;
    const schedule = (): void => {
      if (cancelled) return;
      if (typeof requestFrame === 'function') vfcHandle = requestFrame.call(video, step);
      else rafHandle = window.requestAnimationFrame(step);
    };

    const step = (): void => {
      if (cancelled) return;
      schedule();
      if (landmarker === null || video.readyState < 2 || video.videoHeight === 0) return;

      // detectForVideo demands strictly increasing timestamps.
      const now = performance.now();
      const ts = now > lastTs ? now : lastTs + 1;
      lastTs = ts;
      let result: DetectionResult;
      try {
        result = landmarker.detectForVideo(video, ts);
      } catch {
        return;
      }

      /*
       * Assign roles by horizontal position on the MIRRORED preview: the hand
       * the user sees on the left is the left role. Deliberately not using
       * MediaPipe handedness, which is computed on the un-mirrored image and
       * therefore reports the opposite of what a selfie view shows.
       */
      const detected: Array<{ points: readonly Landmark[]; cx: number }> = [];
      for (const hand of result.landmarks) {
        if (hand.length < LANDMARK_COUNT) continue;
        let sum = 0;
        for (const idx of PALM_POINTS) sum += hand[idx]?.x ?? 0;
        detected.push({ points: hand, cx: sum / PALM_POINTS.length });
      }
      // Mirrored, so a larger raw x sits further LEFT on screen.
      detected.sort((a, b) => b.cx - a.cx);

      const roles = ['left', 'right'] as const;
      const next: { left: HandReading | null; right: HandReading | null } = {
        left: null, right: null,
      };

      for (let r = 0; r < roles.length; r++) {
        const role = roles[r] as 'left' | 'right';
        const frameForRole = framesRef.current[role];
        const found = detected[r];
        if (found === undefined) {
          frameForRole.present = false;
          hadHand[role] = false;
          continue;
        }
        for (let i = 0; i < LANDMARK_COUNT; i += 1) {
          const pt = found.points[i];
          if (pt === undefined) break;
          frameForRole.points[i * 2] = pt.x;
          frameForRole.points[i * 2 + 1] = pt.y;
        }
        frameForRole.present = true;
        if (!measure(frameForRole.points, video.videoWidth / video.videoHeight, raw)) continue;

        const fresh = !hadHand[role];
        hadHand[role] = true;
        const sm = smoothers[role];
        next[role] = {
          x: smooth(sm.x, raw[0] ?? 0, fresh),
          y: smooth(sm.y, raw[1] ?? 0, fresh),
          pinch: smooth(sm.pinch, raw[2] ?? 0, fresh),
          spread: smooth(sm.spread, raw[3] ?? 0, fresh),
        };
      }

      // The single-hand frame stays in step for any overlay still reading it.
      frame.present = framesRef.current.left.present;
      if (frame.present) frame.points.set(framesRef.current.left.points);

      onHandsRef.current(next.left, next.right);
      if (ts - lastPublish >= PUBLISH_MS) {
        lastPublish = ts;
        setLeft(next.left);
        setRight(next.right);
      }
    };

    const start = async (): Promise<void> => {
      let stage = NO_MODEL;
      try {
        const model = await loadLandmarker();
        if (cancelled) { model.close(); return; }
        landmarker = model;
        stage = '';
        const granted = await media.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
        });
        if (cancelled) { for (const track of granted.getTracks()) track.stop(); return; }
        stream = granted;
        video.srcObject = granted;
        stage = NO_PLAY;
        await video.play();
      } catch (e) {
        if (!cancelled) setError(stage === '' ? cameraError(e) : stage);
        return;
      }
      if (cancelled) return;
      setError(null);
      setActive(true);
      schedule();
    };

    void start();

    return (): void => {
      cancelled = true;
      const cancelFrame = host.cancelVideoFrameCallback;
      if (vfcHandle !== 0 && typeof cancelFrame === 'function') cancelFrame.call(video, vfcHandle);
      if (rafHandle !== 0) window.cancelAnimationFrame(rafHandle);
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      if (landmarker !== null) landmarker.close();
      landmarker = null;
      frame.present = false;
      setActive(false);
      setLeft(null);
      setRight(null);
    };
  }, [enabled]);

  return { supported, active, error, left, right, videoRef, frameRef, framesRef };
}
