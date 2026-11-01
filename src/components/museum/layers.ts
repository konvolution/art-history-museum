// Render layers. Layer 0 is everything the floor reflection sees (drei's reflector camera sees layer 0 only);
// PROP_LAYER is seen by the main camera alone: small props, wall labels, the works' shadows, the FX.
//
// Not 1 or 2: in a WebXR session three.js uses layer 1 for the left eye and layer 2 for the right
// (WebXRManager.updateCamera), so a prop on layer 1 would show in the left eye only.
export const PROP_LAYER = 3;
