"use client";

// Things to point at that take the visitor somewhere: a round badge with an icon on the end doors, the elevator's
// call plate and the floor buttons in its car. The controller ray (XRPlayer) or, on a computer, the crosshair
// highlights one, and the trigger or a click uses it. They are drawn in the scene, so one component serves both.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PROP_LAYER } from "../layers";

export type BadgeIcon = "exit" | "lift" | "up" | "down" | "floor";

interface Entry {
  icon: BadgeIcon;
  text?: string;
  hit: THREE.Mesh;
  press: () => void;
  hover: boolean;
}
/** The badges in the scene, for the ray (one gallery at a time). */
const badges = new Set<Entry>();
const _hits: THREE.Intersection[] = [];

/** The nearest badge under a ray, within `range`. */
export function pickBadge(ray: THREE.Raycaster, range = 12): { entry: Entry; distance: number } | null {
  let best: { entry: Entry; distance: number } | null = null;
  for (const e of badges) {
    if (!e.hit.visible || !e.hit.parent?.visible) continue;
    _hits.length = 0;
    e.hit.raycast(ray, _hits);
    const h = _hits[0];
    if (h && h.distance <= range && (!best || h.distance < best.distance)) best = { entry: e, distance: h.distance };
  }
  return best;
}

/** The badges in the scene with their place in the gallery (the test hook: window.__museum.badges). */
export function badgeList(): { icon: string; text?: string; at: [number, number, number]; shown: boolean }[] {
  const out: { icon: string; text?: string; at: [number, number, number]; shown: boolean }[] = [];
  for (const e of badges) {
    const p = e.hit.getWorldPosition(new THREE.Vector3());
    out.push({ icon: e.icon, text: e.text, at: [p.x, p.y, p.z], shown: !!e.hit.parent?.visible });
  }
  return out;
}

/** Which badge the pointers are on this frame (XRPlayer sets it; the badges grow and brighten). */
export function setHovered(entry: Entry | null) {
  for (const e of badges) e.hover = e === entry;
}

const SIZE = 256;
function drawIcon(icon: BadgeIcon, text?: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d")!;
  const m = SIZE / 2;
  g.fillStyle = "rgba(14, 12, 10, 0.78)";
  g.beginPath();
  g.arc(m, m, m - 6, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#f2d9a6";
  g.lineWidth = 10;
  g.beginPath();
  g.arc(m, m, m - 12, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = g.fillStyle = "#f6ead2";
  g.lineWidth = 12;
  g.lineCap = g.lineJoin = "round";
  const arrow = (x0: number, y0: number, x1: number, y1: number) => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x1 - 26 * Math.cos(a - 0.6), y1 - 26 * Math.sin(a - 0.6));
    g.moveTo(x1, y1);
    g.lineTo(x1 - 26 * Math.cos(a + 0.6), y1 - 26 * Math.sin(a + 0.6));
    g.stroke();
  };
  if (icon === "exit") {
    // a door frame, an arrow leaving it
    g.strokeRect(70, 66, 70, 124);
    arrow(112, 128, 192, 128);
  } else if (icon === "lift") {
    // two doors, up and down arrows over them
    g.strokeRect(78, 104, 100, 92);
    g.beginPath();
    g.moveTo(128, 104);
    g.lineTo(128, 196);
    g.stroke();
    arrow(104, 86, 104, 54);
    arrow(152, 54, 152, 86);
  } else if (icon === "up" || icon === "down") {
    if (icon === "up") arrow(128, 190, 128, 66);
    else arrow(128, 66, 128, 190);
  } else {
    g.font = `600 ${text && text.length > 2 ? 84 : 112}px Georgia, serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text ?? "", m, m + 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const _ndcCentre = new THREE.Vector2(0, 0);

/** A badge at `position` (facing whoever looks at it), `size` metres across. `enabled` false hides it. */
export function Badge({
  position,
  icon,
  text,
  size = 0.22,
  enabled = true,
  range = 8,
  onPress,
}: {
  position: [number, number, number];
  icon: BadgeIcon;
  text?: string;
  size?: number;
  enabled?: boolean;
  /** Shown only within this distance (m). */
  range?: number;
  onPress: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const group = useRef<THREE.Group>(null);
  const hit = useRef<THREE.Mesh>(null);
  const pressRef = useRef(onPress);
  useEffect(() => {
    pressRef.current = onPress;
  }, [onPress]);
  const tex = useMemo(() => drawIcon(icon, text), [icon, text]);
  useEffect(() => () => tex.dispose(), [tex]);
  const entry = useRef<Entry | null>(null);

  useEffect(() => {
    if (!hit.current) return;
    const e: Entry = { icon, text, hit: hit.current, press: () => pressRef.current(), hover: false };
    entry.current = e;
    badges.add(e);
    return () => {
      badges.delete(e);
    };
  }, [icon, text]);

  // on a computer: a click with the crosshair on it (the pointer locked)
  useEffect(() => {
    if (!enabled) return;
    const ray = new THREE.Raycaster();
    const onClick = (ev: MouseEvent) => {
      if (ev.button !== 0 || !document.pointerLockElement || !entry.current) return;
      camera.updateMatrixWorld();
      ray.setFromCamera(_ndcCentre, camera);
      const best = pickBadge(ray, range);
      if (best?.entry === entry.current) best.entry.press();
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [enabled, camera, range]);

  const scale = useRef(1);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const near = enabled && camera.position.distanceTo(g.position) < range;
    if (g.visible !== near) {
      g.visible = near;
      invalidate();
    }
    if (!near) return;
    // face the eye, upright
    g.rotation.set(0, Math.atan2(camera.position.x - g.position.x, camera.position.z - g.position.z), 0);
    const want = entry.current?.hover ? 1.18 : 1;
    if (Math.abs(scale.current - want) > 1e-3) {
      scale.current += (want - scale.current) * Math.min(1, dt * 14);
      g.scale.setScalar(scale.current);
      invalidate();
    }
  });

  return (
    <group ref={group} position={position} visible={false}>
      <mesh layers={PROP_LAYER} renderOrder={3}>
        <circleGeometry args={[size / 2, 48]} />
        <meshBasicMaterial map={tex} transparent toneMapped={false} depthWrite={false} />
      </mesh>
      {/* the hit disc: larger than the drawing, so a shaky ray still finds it; never drawn */}
      <mesh ref={hit} visible={true}>
        <circleGeometry args={[size * 0.75, 24]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
