"use client";

// Walking the gallery in a VR session (session.ts moves the visitor; the headset's own pose comes on top).
//
// - left stick: walk, the way the head faces (kept in the hall and off the furniture: layout.confine);
// - right stick left / right: snap turn; pushed forward: aim a teleport arc at the floor, let go to go there;
// - trigger (or a pinch) at a painting: stand in front of it, facing it; B / Y: back to where one stood.
//
// No camera flights, jumps or crouching: in a headset those are the visitor's own body, and a moving view the
// body does not feel is what makes people unwell.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { confine, EYE_HEIGHT, firstWallHit, inspectMaxDist, inspectPose, type GalleryLayout } from "../layout";
import { pickPainting } from "../Controls";
import { setImmersive } from "../quality";
import { exitXR, placeViewer, readHead, setXRRenderer, shiftViewer, turnViewer, viewer } from "./session";

const MAX_DT = 1 / 30;
const WALK_SPEED = 1.4; // m/s at full tilt: a walk (running is for screens)
const STICK_DEAD = 0.15;
const SNAP_TURN = Math.PI / 6;
const SNAP_ON = 0.7;
const SNAP_OFF = 0.3;
const PICK_RANGE = 16; // m
/** The teleport arc: launch speed (m/s), gravity, time step and longest flight (s). */
const ARC_SPEED = 7;
const ARC_G = 9.8;
const ARC_STEP = 0.03;
const ARC_MAX_T = 1.6;
const ARC_POINTS = Math.ceil(ARC_MAX_T / ARC_STEP) + 1;
/** A landing may be moved this far to clear a wall or a bench; further, it is refused. */
const LAND_SLOP = 0.6;
/** Standing distance in front of a work: as if a 70° view had to take it in. */
const LOOK_FOV = 70;

const _view = { x: 0, y: 0, z: 0, yaw: 0 };
const _p = { x: 0, z: 0 };
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Hands the canvas's renderer to the session and keeps the gallery fit for one: the floor's reflection off while
 *  in VR, the 2D view upright again after it. Always mounted. */
export function XRBridge() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);
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
    return () => {
      gl.xr.removeEventListener("sessionstart", onStart);
      gl.xr.removeEventListener("sessionend", onEnd);
      // leaving the gallery (another artist's doors, another floor): a session without its canvas would freeze
      exitXR();
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

export function XRPlayer({ layout, registry }: { layout: GalleryLayout; registry: Map<string, THREE.Mesh> }) {
  const gl = useThree((s) => s.gl);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  const turn = useRef({ armed: true });
  const aim = useRef({ on: false, ok: false, x: 0, z: 0 });
  /** Where the visitor stood before stepping up to a painting (B / Y goes back). */
  const back = useRef<{ x: number; z: number; yaw: number } | null>(null);
  const backDown = useRef(false);

  // what the visitor sees of their controllers: a pointer per hand, the teleport arc and its landing ring
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
    group.add(arc, ring);
    return { group, pointers, arc, arcMat, ring };
  }, []);
  useEffect(
    () => () => {
      gfx.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    },
    [gfx]
  );

  // a select (trigger, or a pinch with tracked hands) at a painting: stand in front of it
  useEffect(() => {
    const session = gl.xr.getSession();
    if (!session) return;
    const onSelect = (e: XRInputSourceEvent) => {
      const space = gl.xr.getReferenceSpace();
      if (!space || !rayFrom(e.frame.getPose(e.inputSource.targetRaySpace, space), ray)) return;
      const hit = pickPainting(ray, registry, PICK_RANGE, layout);
      if (!hit) return;
      const pose = inspectPose(hit.placement, LOOK_FOV, 1, { maxDist: inspectMaxDist(hit.placement, layout) });
      const [px, , pz] = pose.position;
      const [lx, , lz] = pose.lookAt;
      _p.x = px;
      _p.z = pz;
      confine(_p, layout);
      const v = viewer(_view);
      back.current = { x: v.x, z: v.z, yaw: v.yaw };
      placeViewer(_p.x, _p.z, Math.atan2(-(lx - _p.x), -(lz - _p.z)));
    };
    session.addEventListener("select", onSelect);
    return () => session.removeEventListener("select", onSelect);
  }, [gl, ray, registry, layout]);

  useFrame((_, rawDt, frame?: XRFrame) => {
    readHead(frame);
    const space = gl.xr.getReferenceSpace();
    if (!frame || !space) return;
    const dt = Math.min(rawDt, MAX_DT);

    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    let backPressed = false;
    let right: XRInputSource | null = null;
    let i = 0;
    for (const src of frame.session.inputSources) {
      const pointer = gfx.pointers[i++];
      if (pointer) {
        const ok = rayFrom(frame.getPose(src.targetRaySpace, space), ray);
        pointer.visible = ok && src.targetRayMode === "tracked-pointer";
        if (ok) {
          const hit = pickPainting(ray, registry, PICK_RANGE, layout);
          const len = hit ? hit.distance : 3;
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
        mx = ax;
        my = ay;
      } else {
        tx = ax;
        ty = ay;
        right = src;
      }
      // B (right) / Y (left)
      if (gp.buttons[5]?.pressed) backPressed = true;
    }
    for (; i < gfx.pointers.length; i++) gfx.pointers[i].visible = false;

    // back to where one stood before stepping up to a painting
    if (backPressed && !backDown.current && back.current) {
      const b = back.current;
      back.current = null;
      placeViewer(b.x, b.z, b.yaw);
    }
    backDown.current = backPressed;

    // snap turn
    const t = turn.current;
    if (!t.armed && Math.abs(tx) < SNAP_OFF) t.armed = true;
    if (t.armed && Math.abs(tx) > SNAP_ON && !aim.current.on) {
      t.armed = false;
      turnViewer(-Math.sign(tx) * SNAP_TURN);
    }

    // walk, the way the head faces; never through a wall, never more than the step (a head leant over a bench
    // or toward a wall is eased out, not thrown)
    const v = viewer(_view);
    const mag = Math.hypot(mx, my);
    if (mag > STICK_DEAD) {
      const k = (Math.min(1, mag) - STICK_DEAD) / (1 - STICK_DEAD) / mag;
      // right (cos yaw, -sin yaw) times the stick's x, forward (-sin yaw, -cos yaw) times its push (-y)
      const c = Math.cos(v.yaw);
      const s = Math.sin(v.yaw);
      const step = WALK_SPEED * dt;
      _p.x = v.x + (c * mx + s * my) * k * step;
      _p.z = v.z + (-s * mx + c * my) * k * step;
      confine(_p, layout);
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
    const aiming = ty < -SNAP_ON || (a.on && ty < -SNAP_OFF);
    if (aiming && right && rayFrom(frame.getPose(right.targetRaySpace, space), ray)) {
      a.on = true;
      a.ok = false;
      const pos = gfx.arc.geometry.getAttribute("position") as THREE.BufferAttribute;
      _a.copy(ray.ray.origin);
      const vel = _d.copy(ray.ray.direction).multiplyScalar(ARC_SPEED);
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
          confine(_p, layout);
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
      if (a.on && a.ok) placeViewer(a.x, a.z);
      a.on = false;
      a.ok = false;
      gfx.arc.visible = false;
      gfx.ring.visible = false;
    }
  });

  return <primitive object={gfx.group} />;
}
