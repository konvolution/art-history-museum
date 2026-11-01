"use client";

import { useState, type RefObject } from "react";
import * as THREE from "three";
import { enterXR, useXRSupported } from "./session";

const _e = new THREE.Euler(0, 0, 0, "YXZ");

/** "Enter VR", where the browser has a headset to offer (the Quest Browser, a desktop with a headset linked):
 *  the visitor goes on from where the 2D view stands, facing the same way. */
export function EnterVR({ cameraRef, className }: { cameraRef: RefObject<THREE.Camera | null>; className?: string }) {
  const supported = useXRSupported();
  const [failed, setFailed] = useState(false);
  if (!supported) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        // not the overlay's click (that would take the pointer)
        e.stopPropagation();
        const cam = cameraRef.current;
        if (!cam) return;
        if (document.pointerLockElement) document.exitPointerLock();
        _e.setFromQuaternion(cam.quaternion);
        enterXR({ x: cam.position.x, z: cam.position.z, yaw: _e.y }).catch((err) => {
          console.warn("Could not start VR", err);
          setFailed(true);
        });
      }}
    >
      {failed ? "VR could not start: try again" : "Enter VR"}
    </button>
  );
}
