"use client";

// Walking the gallery in a VR session (session.ts moves the visitor; the headset's own pose comes on top).
//
// - left stick: walk, the way the head faces or (Settings: Walking in VR) the left controller points (kept in the
//   hall and off the furniture: layout.confine; the open elevator car too);
// - right stick left / right: snap turn; forward: aim a teleport arc at the floor, let go to go there; back: a
//   step back;
// - A / X: the next / previous room;
// - trigger (or a pinch) at a badge (the end doors, the elevator: Badge.tsx) uses it; at a painting, stands in
//   front of it, facing it; B / Y: back to where one stood.
//
// No camera flights, jumps or crouching: in a headset those are the visitor's own body, and a moving view the
// body does not feel is what makes people unwell. Moves that jump (teleports, rooms, paintings) blink: a short
// fade to black and back.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  confine,
  EYE_HEIGHT,
  firstWallHit,
  inspectMaxDist,
  inspectPose,
  spawnZ,
  type GalleryLayout,
} from "../layout";
import { pickPainting } from "../Controls";
import { liftCar } from "../Elevator";
import { setImmersive } from "../quality";
import { getSettings } from "../settings";
import { pickBadge, setHovered } from "./Badge";
import {
  adoptXR,
  blink,
  fade,
  fadeIn,
  placeViewer,
  readHead,
  releaseXR,
  setXRRenderer,
  shiftViewer,
  turnViewer,
  viewer,
} from "./session";

const MAX_DT = 1 / 30;
const WALK_SPEED = 1.4; // m/s at full tilt: a walk (running is for screens)
const STICK_DEAD = 0.15;
const SNAP_TURN = Math.PI / 6;
const SNAP_ON = 0.7;
const SNAP_OFF = 0.3;
/** The right stick pulled back: a step this long, straight back. */
const STEP_BACK = 0.5;
const PICK_RANGE = 16; // m
/** The teleport arc: launch speed (m/s), gravity, time step and longest flight (s). */
const ARC_SPEED = 7;
const ARC_G = 9.8;
const ARC_STEP = 0.03;
const ARC_MAX_T = 1.6;
const ARC_POINTS = Math.ceil(ARC_MAX_T / ARC_STEP) + 1;
/** The arc keeps this far under the lowest doorway's head, so an aim through a doorway clears its lintel. */
const ARC_HEADROOM = 0.25;
/** A landing may be moved this far to clear a wall or a bench; further, it is refused. */
const LAND_SLOP = 0.6;
/** Standing distance in front of a work: as if a 70° view had to take it in. */
const LOOK_FOV = 70;
/** The fade: seconds to black, and back. */
const FADE_OUT_S = 0.12;
const FADE_IN_S = 0.16;
/** In the elevator car: the body this far off its walls. */
const CAR_MARGIN = 0.25;

const _view = { x: 0, y: 0, z: 0, yaw: 0 };
const _p = { x: 0, z: 0 };
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Hands the canvas's renderer to the session and keeps the gallery fit for one: the floor's reflection off while
 *  in VR, the 2D view upright again after it. A session carried from the last page (another floor, another
 *  gallery: session.ts carryXR) is taken up here, the visitor standing where they arrive. Always mounted. */
export function XRBridge({ layout }: { layout: GalleryLayout }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    setXRRenderer(gl);
    const onStart = () => setImmersive(true);
    const onEnd = () => {
      setImmersive(false);
      // back on the screen where the headset left off: upright, at standing eye height
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      camera.rotation.set(0, e.y, 0, "YXZ");
      camera.position.y = EYE_HEIGHT;
      camera.scale.set(1, 1, 1);
      camera.updateProjectionMatrix();
      invalidate();
    };
    gl.xr.addEventListener("sessionstart", onStart);
    gl.xr.addEventListener("sessionend", onEnd);
    let alive = true;
    void adoptXR(gl).then((arrival) => {
      if (!alive || !arrival) return;
      const l = layoutRef.current;
      // facing into the hall (toward -z): out of the elevator car, or in from the entrance
      if (arrival === "lift" && l.elevator) placeViewer(l.elevator.x, l.hallLength / 2 + 0.7, 0);
      else placeViewer(0, spawnZ(l), 0);
      fadeIn();
    });
    return () => {
      alive = false;
      gl.xr.removeEventListener("sessionstart", onStart);
      gl.xr.removeEventListener("sessionend", onEnd);
      // leaving the gallery: a session carried to the next page goes on there, any other ends (without its
      // canvas it would freeze)
      releaseXR(gl);
      setImmersive(false);
      setXRRenderer(null);
    };
  }, [gl, camera, invalidate]);
  return null;
}

function rayFrom(pose: XRPose | undefined | null, ray: THREE.Raycaster): boolean {
  if (!pose) return false;
  const t = pose.transform;
  _o.set(t.position.x, t.position.y, t.position.z);
  _q.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
  _d.set(0, 0, -1).applyQuaternion(_q);
  ray.set(_o, _d);
  return true;
}

/** In the elevator's car, or its doorway coming or going while the doors are open: the place kept inside it
 *  (true); false elsewhere. With the doors shut, whoever is in the car stays in it. */
function inLift(p: { x: number; z: number }, from: { x: number; z: number }): boolean {
  const c = liftCar.box;
  if (!c) return false;
  const inCar = (q: { x: number; z: number }) => q.z >= c.zw - 0.05 && Math.abs(q.x - c.x) <= c.carHalf - CAR_MARGIN + 0.05;
  const inDoor = (q: { x: number; z: number }) => q.z >= c.zw - 0.7 && Math.abs(q.x - c.x) <= c.halfWidth - CAR_MARGIN;
  if (!liftCar.open) {
    if (!inCar(from)) return false;
    p.z = Math.max(c.zw + CAR_MARGIN, p.z);
  } else if (!(inCar(p) || (inDoor(p) && (inCar(from) || inDoor(from) || p.z > from.z)))) return false;
  // the car's walls, and the doorway's sides while in it
  const half = p.z >= c.zw + 0.1 ? c.carHalf - CAR_MARGIN : c.halfWidth - CAR_MARGIN;
  p.x = Math.min(c.x + half, Math.max(c.x - half, p.x));
  p.z = Math.min(c.zw + c.depth - CAR_MARGIN, p.z);
  return true;
}

/** Keep a place in the hall (or in the open elevator car). */
function keepIn(p: { x: number; z: number }, from: { x: number; z: number }, layout: GalleryLayout) {
  if (!inLift(p, from)) confine(p, layout);
}

export function XRPlayer({
  layout,
  registry,
  jump,
}: {
  layout: GalleryLayout;
  registry: Map<string, THREE.Mesh>;
  /** The next (+1) or previous (-1) room. */
  jump?: (delta: number) => void;
}) {
  const gl = useThree((s) => s.gl);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  const stick = useRef({ turnArmed: true, backArmed: true });
  const aim = useRef({ on: false, ok: false, x: 0, z: 0 });
  /** Where the visitor stood before stepping up to a painting (B / Y goes back). */
  const back = useRef<{ x: number; z: number; yaw: number } | null>(null);
  const buttons = useRef({ back: false, next: false, prev: false });
  const hovered = useRef<ReturnType<typeof pickBadge>>(null);
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  /** The arc's ceiling: under the lowest doorway's head. */
  const arcTop = useMemo(
    () => Math.min(3.2, ...layout.doorways.map((d) => d.height)) - ARC_HEADROOM,
    [layout]
  );

  // what the visitor sees of their controllers: a pointer per hand, the teleport arc and its landing ring; and
  // the fade, a black sphere round the head
  const gfx = useMemo(() => {
    const group = new THREE.Group();
    const pointerMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 });
    const pointers = [0, 1].map(() => {
      const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(6, 3));
      const l = new THREE.Line(g, pointerMat);
      l.frustumCulled = false;
      l.visible = false;
      group.add(l);
      return l;
    });
    const arcGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(ARC_POINTS * 3, 3));
    const arcMat = new THREE.LineBasicMaterial({ color: 0x7fd4ff });
    const arc = new THREE.Line(arcGeo, arcMat);
    arc.frustumCulled = false;
    arc.visible = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.3, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.8, depthWrite: false })
    );
    ring.visible = false;
    const veilMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const veil = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), veilMat);
    veil.frustumCulled = false;
    veil.renderOrder = 10000;
    veil.visible = false;
    group.add(arc, ring, veil);
    return { group, pointers, arc, arcMat, ring, veil, veilMat };
  }, []);
  useEffect(
    () => () => {
      gfx.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      setHovered(null);
    },
    [gfx]
  );

  // a select (trigger, or a pinch with tracked hands): a badge is used; at a painting, stand in front of it
  useEffect(() => {
    const session = gl.xr.getSession();
    if (!session) return;
    const onSelect = (e: XRInputSourceEvent) => {
      const space = gl.xr.getReferenceSpace();
      if (fade.goal === 1 || !space || !rayFrom(e.frame.getPose(e.inputSource.targetRaySpace, space), ray)) return;
      const badge = pickBadge(ray);
      const hit = pickPainting(ray, registry, PICK_RANGE, layout);
      if (badge && (!hit || badge.distance <= hit.distance)) {
        badge.entry.press();
        return;
      }
      if (!hit) return;
      const pose = inspectPose(hit.placement, LOOK_FOV, 1, { maxDist: inspectMaxDist(hit.placement, layout) });
      const [px, , pz] = pose.position;
      const [lx, , lz] = pose.lookAt;
      const v = viewer(_view);
      const from = { x: v.x, z: v.z, yaw: v.yaw };
      void blink(() => {
        _p.x = px;
        _p.z = pz;
        confine(_p, layout);
        back.current = from;
        placeViewer(_p.x, _p.z, Math.atan2(-(lx - _p.x), -(lz - _p.z)));
      });
    };
    session.addEventListener("select", onSelect);
    return () => session.removeEventListener("select", onSelect);
  }, [gl, ray, registry, layout]);

  useFrame((_, rawDt, frame?: XRFrame) => {
    readHead(frame);
    const space = gl.xr.getReferenceSpace();
    if (!frame || !space) return;
    const dt = Math.min(rawDt, MAX_DT);

    // the fade, round the eye where it will be drawn (after any move this frame: viewer() is up to date)
    if (fade.level !== fade.goal) {
      fade.level = fade.goal > fade.level ? Math.min(1, fade.level + dt / FADE_OUT_S) : Math.max(0, fade.level - dt / FADE_IN_S);
      if (fade.level === 1 && fade.waiting.length) fade.waiting.splice(0).forEach((f) => f());
    }
    const blind = fade.goal === 1;

    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    const pressed = { back: false, next: false, prev: false };
    let right: XRInputSource | null = null;
    let left: XRInputSource | null = null;
    let nearest: ReturnType<typeof pickBadge> = null;
    let nearestSrc: XRInputSource | null = null;
    let i = 0;
    for (const src of frame.session.inputSources) {
      const pointer = gfx.pointers[i++];
      if (pointer) {
        const ok = rayFrom(frame.getPose(src.targetRaySpace, space), ray);
        pointer.visible = ok && src.targetRayMode === "tracked-pointer" && !blind;
        if (ok) {
          const hit = pickPainting(ray, registry, PICK_RANGE, layout);
          const badge = pickBadge(ray);
          let len = hit ? hit.distance : 3;
          if (badge && badge.distance <= len) {
            len = badge.distance;
            if (!nearest || badge.distance < nearest.distance) {
              nearest = badge;
              nearestSrc = src;
            }
          }
          const pos = pointer.geometry.getAttribute("position") as THREE.BufferAttribute;
          _a.copy(ray.ray.origin);
          _b.copy(ray.ray.direction).multiplyScalar(len).add(_a);
          pos.setXYZ(0, _a.x, _a.y, _a.z);
          pos.setXYZ(1, _b.x, _b.y, _b.z);
          pos.needsUpdate = true;
        }
      }
      const gp = src.gamepad;
      if (!gp) continue;
      // xr-standard: the thumbstick is axes 2 and 3 (0 and 1 are a touchpad's, absent on Quest)
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] ?? 0;
      const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] ?? 0;
      if (src.handedness === "left") {
        left = src;
        mx = ax;
        my = ay;
        if (gp.buttons[4]?.pressed) pressed.prev = true; // X
      } else {
        tx = ax;
        ty = ay;
        right = src;
        if (gp.buttons[4]?.pressed) pressed.next = true; // A
      }
      // B (right) / Y (left)
      if (gp.buttons[5]?.pressed) pressed.back = true;
    }
    for (; i < gfx.pointers.length; i++) gfx.pointers[i].visible = false;

    // a badge under a pointer: it grows, and the hand feels it once
    if (nearest?.entry !== hovered.current?.entry) {
      setHovered(nearest?.entry ?? null);
      if (nearest && nearestSrc) {
        const act = (nearestSrc.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)
          ?.hapticActuators?.[0];
        act?.pulse(0.25, 25);
      }
      hovered.current = nearest;
    }

    // buttons, on their press
    const was = buttons.current;
    if (!blind) {
      if (pressed.back && !was.back && back.current) {
        const b = back.current;
        back.current = null;
        void blink(() => placeViewer(b.x, b.z, b.yaw));
      }
      if (pressed.next && !was.next && jumpRef.current) void blink(() => jumpRef.current?.(1));
      if (pressed.prev && !was.prev && jumpRef.current) void blink(() => jumpRef.current?.(-1));
    }
    buttons.current = pressed;

    const v = viewer(_view);
    const st = stick.current;

    // snap turn
    if (!st.turnArmed && Math.abs(tx) < SNAP_OFF) st.turnArmed = true;
    if (st.turnArmed && Math.abs(tx) > SNAP_ON && !aim.current.on && !blind) {
      st.turnArmed = false;
      turnViewer(-Math.sign(tx) * SNAP_TURN);
    }

    // the right stick pulled back: a step straight back
    if (!st.backArmed && ty < SNAP_OFF) st.backArmed = true;
    if (st.backArmed && ty > SNAP_ON && Math.abs(tx) < SNAP_ON && !blind) {
      st.backArmed = false;
      _p.x = v.x + Math.sin(v.yaw) * STEP_BACK;
      _p.z = v.z + Math.cos(v.yaw) * STEP_BACK;
      keepIn(_p, v, layout);
      placeViewer(_p.x, _p.z);
    }

    // walk, the way the head faces; never through a wall, never more than the step (a head leant over a bench
    // or toward a wall is eased out, not thrown)
    const mag = Math.hypot(mx, my);
    if (mag > STICK_DEAD && !blind) {
      const k = (Math.min(1, mag) - STICK_DEAD) / (1 - STICK_DEAD) / mag;
      // which way is forward: the head's, or the left controller's (its ray, level)
      let yaw = v.yaw;
      if (getSettings().vrSteer === "hand" && left && rayFrom(frame.getPose(left.targetRaySpace, space), ray)) {
        const f = ray.ray.direction;
        if (f.x * f.x + f.z * f.z > 1e-4) yaw = Math.atan2(-f.x, -f.z);
      }
      // right (cos yaw, -sin yaw) times the stick's x, forward (-sin yaw, -cos yaw) times its push (-y)
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const step = WALK_SPEED * dt;
      _p.x = v.x + (c * mx + s * my) * k * step;
      _p.z = v.z + (-s * mx + c * my) * k * step;
      keepIn(_p, v, layout);
      let dx = _p.x - v.x;
      let dz = _p.z - v.z;
      const d = Math.hypot(dx, dz);
      const most = step * 1.05;
      if (d > most) {
        dx *= most / d;
        dz *= most / d;
      }
      if (d > 1e-5) shiftViewer(dx, dz);
    }

    // teleport: push the right stick forward to aim, let go to land
    const a = aim.current;
    const aiming = !blind && (ty < -SNAP_ON || (a.on && ty < -SNAP_OFF));
    if (aiming && right && rayFrom(frame.getPose(right.targetRaySpace, space), ray)) {
      a.on = true;
      a.ok = false;
      const pos = gfx.arc.geometry.getAttribute("position") as THREE.BufferAttribute;
      _a.copy(ray.ray.origin);
      const vel = _d.copy(ray.ray.direction).multiplyScalar(ARC_SPEED);
      // no higher than under the doorways' heads: an aim through a doorway clears its lintel
      const rise = Math.sqrt(2 * ARC_G * Math.max(0, arcTop - _a.y));
      if (vel.y > rise) vel.y = rise;
      let n = 0;
      pos.setXYZ(n++, _a.x, _a.y, _a.z);
      for (let s = 0; s < ARC_POINTS - 1; s++) {
        _b.copy(_a).addScaledVector(vel, ARC_STEP);
        vel.y -= ARC_G * ARC_STEP;
        // into a cross wall: the arc stops there, no landing
        const wall = firstWallHit(_a, _b, layout);
        if (wall) {
          pos.setXYZ(n++, wall.x, wall.y, wall.z);
          break;
        }
        if (_b.y <= 0) {
          const f = _a.y / (_a.y - _b.y);
          const hx = _a.x + (_b.x - _a.x) * f;
          const hz = _a.z + (_b.z - _a.z) * f;
          pos.setXYZ(n++, hx, 0, hz);
          _p.x = hx;
          _p.z = hz;
          keepIn(_p, v, layout);
          if (Math.hypot(_p.x - hx, _p.z - hz) < LAND_SLOP) {
            a.ok = true;
            a.x = _p.x;
            a.z = _p.z;
          }
          break;
        }
        pos.setXYZ(n++, _b.x, _b.y, _b.z);
        _a.copy(_b);
      }
      gfx.arc.geometry.setDrawRange(0, n);
      pos.needsUpdate = true;
      gfx.arc.visible = true;
      gfx.arcMat.color.set(a.ok ? 0x7fd4ff : 0xff6b5b);
      gfx.ring.visible = a.ok;
      if (a.ok) gfx.ring.position.set(a.x, 0.01, a.z);
    } else {
      if (a.on && a.ok) {
        const to = { x: a.x, z: a.z };
        void blink(() => placeViewer(to.x, to.z));
      }
      a.on = false;
      a.ok = false;
      gfx.arc.visible = false;
      gfx.ring.visible = false;
    }

    const eye = viewer(_view);
    gfx.veil.visible = fade.level > 0;
    gfx.veilMat.opacity = fade.level;
    gfx.veil.position.set(eye.x, eye.y, eye.z);
  });

  return <primitive object={gfx.group} />;
}
