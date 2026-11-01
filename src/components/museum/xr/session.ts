// The immersive (VR) session: whether this browser offers one, entering and leaving it, and where the visitor
// stands in the gallery while in it.
//
// Where: the headset's pose is its own (three.js copies it into the camera every frame: the R3F camera has no
// parent, so camera.position stays the eye's place in the gallery and everything that reads it keeps working).
// The visitor is moved by moving the floor under them instead: the session's reference space is offset by the
// rig (a place on the floor and a turn about it), gallery = rig * headset space. Walking, turning and teleports
// change the rig; the headset's own movement (stepping about the play area) comes on top.

import { useSyncExternalStore } from "react";
import * as THREE from "three";

// ------------------------------------------------------------------ the store

let presenting = false;
let supported: boolean | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};

/** True while an immersive session is running. */
export const isInXR = (): boolean => presenting;
export function useInXR(): boolean {
  return useSyncExternalStore(subscribe, isInXR, () => false);
}

/** Whether this browser can start an immersive VR session (null: not known yet). */
export function useXRSupported(): boolean | null {
  return useSyncExternalStore(subscribe, () => supported, () => null);
}

if (typeof navigator !== "undefined") {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (!xr) supported = false;
  else
    xr.isSessionSupported("immersive-vr").then(
      (ok) => {
        supported = ok;
        emit();
      },
      () => {
        supported = false;
        emit();
      }
    );
}

// ------------------------------------------------------------------ the rig

/** The floor's offset: the headset's space turned by `yaw` and moved to (x, z) in the gallery. */
const rig = { x: 0, z: 0, yaw: 0 };
/** Where the headset is in its own space (the reference space at its origin), read every frame. */
const head = { x: 0, y: 0, z: 0, yaw: 0, known: false };
/** Where the visitor should stand once the headset's pose is first known (the 2D view's spot). */
let pending: { x: number; z: number; yaw: number } | null = null;

let renderer: THREE.WebGLRenderer | null = null;
let base: XRReferenceSpace | null = null;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");

function applyRig() {
  if (!renderer || !base) return;
  _q.setFromAxisAngle(_UP, rig.yaw);
  const t = new XRRigidTransform({ x: rig.x, y: 0, z: rig.z }, { x: _q.x, y: _q.y, z: _q.z, w: _q.w });
  // a pose in the offset space is offset⁻¹ · pose in the base space: offset = rig⁻¹ gives gallery = rig · headset
  renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(t.inverse));
}
const _UP = new THREE.Vector3(0, 1, 0);

/** The eye's place and heading in the gallery (rig · head). */
export function viewer(out: { x: number; y: number; z: number; yaw: number }) {
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  out.x = rig.x + c * head.x + s * head.z;
  out.z = rig.z - s * head.x + c * head.z;
  out.y = head.y;
  out.yaw = rig.yaw + head.yaw;
  return out;
}

/** Put the eye at (x, z) in the gallery, facing `yaw` (default: the way it faces now). */
export function placeViewer(x: number, z: number, yaw?: number) {
  if (!head.known) {
    pending = { x, z, yaw: yaw ?? rig.yaw + head.yaw };
    return;
  }
  const want = yaw ?? rig.yaw + head.yaw;
  rig.yaw = want - head.yaw;
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  rig.x = x - (c * head.x + s * head.z);
  rig.z = z - (-s * head.x + c * head.z);
  applyRig();
}

/** Move the floor so the eye moves by (dx, dz) in the gallery. */
export function shiftViewer(dx: number, dz: number) {
  rig.x += dx;
  rig.z += dz;
  applyRig();
}

/** Turn the visitor about where they stand. */
export function turnViewer(dYaw: number) {
  const v = viewer(_v);
  placeViewer(v.x, v.z, v.yaw + dYaw);
}
const _v = { x: 0, y: 0, z: 0, yaw: 0 };

/** Read the headset's pose in its own space; call once per XR frame, before anything moves the visitor. */
export function readHead(frame: XRFrame | undefined) {
  if (!frame || !base) return;
  const pose = frame.getViewerPose(base);
  if (!pose) return;
  const p = pose.transform.position;
  const o = pose.transform.orientation;
  head.x = p.x;
  head.y = p.y;
  head.z = p.z;
  _e.setFromQuaternion(_q.set(o.x, o.y, o.z, o.w));
  head.yaw = _e.y;
  if (!head.known) {
    head.known = true;
    if (pending) {
      const to = pending;
      pending = null;
      placeViewer(to.x, to.z, to.yaw);
    }
  }
}

// ------------------------------------------------------------------ entering and leaving

/** Hand the canvas's renderer over (XRBridge, inside the Canvas). */
export function setXRRenderer(gl: THREE.WebGLRenderer | null) {
  renderer = gl;
}

/** Start a VR session with the visitor standing where the 2D view is, facing the same way. From a click. */
export async function enterXR(from: { x: number; z: number; yaw: number }): Promise<void> {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (!renderer || !xr || presenting) return;
  const session = await xr.requestSession("immersive-vr", {
    optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
  });
  const gl = renderer;
  gl.xr.setReferenceSpaceType("local-floor");
  head.known = false;
  pending = from;
  rig.x = from.x;
  rig.z = from.z;
  rig.yaw = from.yaw;
  session.addEventListener("end", () => {
    presenting = false;
    base = null;
    head.known = false;
    emit();
  });
  await gl.xr.setSession(session);
  // the space three made for the session: everything is offset from it
  base = gl.xr.getReferenceSpace();
  gl.xr.setFoveation(1);
  applyRig();
  presenting = true;
  emit();
}

export function exitXR() {
  void renderer?.xr.getSession()?.end();
}
