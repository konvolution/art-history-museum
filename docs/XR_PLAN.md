# Plan: WebXR (Meta Quest) support and Cloudflare hosting

Status: 2026-11-01. Fork of `justdataplease/art-history-museum` at `33afff2`.

**Progress:** phases 0, 2 and 3 and the inspect part of 4 are done; see "VR (WebXR)" in `docs/DEVELOPMENT.md`.
`scripts/xr-check.mjs` passes 13/13 in an emulated Quest 3. Not yet done: Cloudflare (phase 1), in-world
panels and a wrist menu, on-device performance measurement, and audio in VR.

One change from §3: the build does not use `@react-three/xr`. three already copies the headset pose into the
parentless R3F camera, so the visitor is moved by offsetting the session's reference space (`xr/session.ts`).
Every existing `camera.position` reader keeps working, and the 39-site sweep and the `XROrigin` are not needed.

Goal: walk the existing artist galleries and custom rooms in VR on a Meta Quest from the Quest Browser, with
an **Enter VR** button next to the current desktop and touch modes, and host the fork on Cloudflare.

Non-goals for v1: the timeline (`/`) and the room builder (`/rooms`) in VR. They stay 2D pages, which the Quest
Browser shows fine. Also out of scope: multiplayer, AR/passthrough, and the Vandalism FX easter egg in VR.

Upstream already lists this as item 17 in `PLAN_V2.md` ("`@react-three/xr` ... teleport plus smooth walking, snap
turning ... steady 72–90 fps on Quest ... labels and the inspect panel move into the 3D scene"). This plan
follows that direction and adds what the code review turned up.

---

## 1. What the project is (the parts XR touches)

| Area | Where | Notes for XR |
|---|---|---|
| App | Next.js 16 App Router, React 19, `output: "standalone"` | Galleries are prerendered (ISR, `revalidate = 3600`); `/room` and `/api/*` render on request. |
| 3D | three r184, @react-three/fiber 9, drei 10 | One `<Canvas>` in `src/components/museum/MuseumApp.tsx:710`, `frameloop="demand"`. |
| Scene root | `src/components/museum/Gallery.tsx` | Mounts `Player` / `TouchPlayer` / `InspectCamera`, `SuiteDirector` (streams rooms by `camera.position`), the teleport API, and shader warm-up. |
| Movement | `src/components/museum/Controls.tsx` (1,134 lines) | Writes to `camera.position` and `camera.quaternion` directly. Desktop uses drei `PointerLockControls` + WASD; touch uses sticks, drag and double-tap. Includes jumping, crouching, sitting and the inspect fly-to (GSAP). |
| Level logic | `src/components/museum/layout.ts` | Pure functions that can be reused as they are: `confine`, `supportAt`, `seatNear`, `planRoute`, `firstWallHit`, `inspectPose`, `roomAt`, `EYE_HEIGHT = 1.65`. |
| Look | `Room.tsx`, `room-floor.tsx`, `room-shading.ts`, `exhibit-*.ts` | Neutral tone mapping, a pool of 16 spotlights, 2–4 `RectAreaLight`s, a forked `MeshReflectorMaterial` floor (a second full scene pass), a shader patch in `renderer-shader-patches.ts`. |
| Quality | `quality.ts`, `Gallery.tsx:510+` | Tiers `full` and `fast`, plus adaptive DPR that steps down while walking. |
| 2D UI | `InspectPanel`, `RoomNavigator`, `AudioGuide`, `SettingsPanel`, `Elevator` floor picker, crosshair, `TouchStick` | All of it is DOM, so none of it is visible in an immersive session. |
| Already in 3D | `ExitDoors.tsx`, `Elevator.tsx`, `room-signs.tsx`, placards (`exhibit-placard.ts`) | Proximity is driven by `useFrame` + `camera.position`. These work in VR once world positions are fixed. |
| Films | `src/components/cinema/*` | Open streams play as a `VideoTexture` (fine in VR). YouTube, Vimeo and Dailymotion play as an `<iframe>` through drei `Html` behind a hole in the canvas, which **cannot render in XR**. |
| Audio | `MuseumAudio.tsx`, `AudioGuide.tsx`, `voice.ts` | Music, plus a guide spoken by an in-browser WASM TTS model (Pocket, ~120 MB) or by `speechSynthesis`. |
| Data | `src/lib/data.ts`, `rooms.ts`, `phases.ts` | Read with `fs` from `data/…json` at build and at run time. **`/data` is gitignored and private upstream** (see §6). |
| Hosting today | Vercel (`Server: Vercel` on the live site) and a Dockerfile | |

---

## 2. Findings that shape the design

1. **Layer 1 is the left eye in WebXR.** three's `WebXRManager` sets `cameraL.layers` to the scene camera's mask
   minus layer 2 and `cameraR.layers` to that mask minus layer 1 (it uses layers 1 and 2 as eye layers). This
   app puts paintings, placards, signs, small props and FX on **layer 1** (`PROP_LAYER = 1` in
   `PaintingExhibit.tsx:79`, `room-signs.tsx:21`, `fx/engine.ts:54`, `fx/rig.ts:17`; `Gallery.tsx:427` enables
   it). In a headset, **those objects would appear in the left eye only**. Fix: move the prop layer to 3 (one
   shared constant), and keep the reflector camera on layer 0. This is the first change to make.
2. **Camera ownership changes.** In XR the headset pose overwrites the camera's local transform every frame.
   Locomotion has to move a rig (`<XROrigin>` from `@react-three/xr`), not the camera. There are 39
   `camera.position` reads and writes in `src/`, plus the teleport API in `Gallery.tsx:229–253`. Readers
   (`SuiteDirector`, `FilmNook`, `ExitDoors`, `Elevator`, `AudioGuide` proximity, `room-shading` cross-window,
   the aim raycast) need the camera's **world** position. Writers need to go through a single
   `setViewerPose()` that moves the origin so the *head* lands at the target.
3. **The render loop runs every frame in XR.** R3F drives XR frames through `gl.xr.setAnimationLoop`, so the
   `frameloop="demand"` and `invalidate()` savings no longer apply. The scene must hold 72 fps (Quest 2) or
   72–90 fps (Quest 3/3S) **continuously, at stereo resolution**. Check that `frameloop="never"` (used during
   transitions, `MuseumApp.tsx:712`) does not stall a running session.
4. **The floor reflection must be off in XR.** The reflector renders a mono virtual camera, which looks wrong in
   stereo and doubles the cost. Quality tiers already let the reflection be turned off (`setReflection`).
5. **Most interaction is DOM-based.** Clicks to inspect go through a `window` click listener + pointer lock
   (`Controls.tsx`). The inspect panel, room navigator, audio guide, settings and the elevator's floor
   `<select>` are DOM. All of these need an XR path: controller rays plus in-world panels.
6. **The inspect fly-to is a comfort hazard.** A GSAP camera flight along a CatmullRom curve
   (`Controls.tsx:970–1090`) is fine on a screen and makes people sick in a headset. In VR, use fade, teleport
   to `inspectPose`, and fade in.
7. **The movement code is well factored.** Collision (`confine` with `BODY_RADIUS`), benches (`supportAt`),
   seats (`seatNear`) and line of sight (`firstWallHit`) are pure functions over `GalleryLayout`. A VR
   locomotion component can reuse all of them.

---

## 3. Architecture

```
MuseumApp
 └─ <Canvas gl={...xr-friendly}>
     └─ <XR store={xrStore}>                     ← @react-three/xr v6 (6.6.x supports fiber 9)
         ├─ <XROrigin ref={rig}>                 ← moved by locomotion and teleports
         ├─ Gallery (unchanged scene)
         │   ├─ Player | TouchPlayer | XRPlayer  ← new XRPlayer while session active
         │   ├─ InspectCamera (desktop) | XRInspect (fade-teleport + panel)
         │   └─ SuiteDirector(worldEye)          ← reads viewer world position
         └─ <XRHud/>                             ← in-world panels: inspect, navigator, guide, settings
```

New modules (all in `src/components/museum/xr/`):

- `xr-store.ts`: `createXRStore({ foveation: 1, frameRate: "high", hand: { teleportPointer: true },
  controller: { teleportPointer: true }, emulate: "metaQuest3" in dev })`, plus a `useInXR()` hook.
- `viewer.ts`: `viewerWorldPosition(out)`, `viewerYaw()`, `setViewerPose(x, z, yaw)`. In XR these compute the
  origin offset from the current head pose; outside XR they write to the camera as today. The 39 call sites go
  through these functions.
- `XRPlayer.tsx`: smooth thumbstick locomotion, snap turn, teleport, and room-scale collision (see §4).
- `XRInspect.tsx` and `panels/*.tsx`: in-world UI (see §5).
- `EnterVRButton.tsx`: shown only when `navigator.xr.isSessionSupported("immersive-vr")`. It sits in the top bar
  and on the entry doors' "click to start" overlay.

A session starts from the existing gallery page, with no new route. Leaving VR returns to the 2D view at the
same spot.

---

## 4. Locomotion and comfort

- **Reference space:** `local-floor`, so the eye height is the visitor's real height. A "seated" toggle adds
  `EYE_HEIGHT − headY` to the origin's Y.
- **Smooth move** (left stick): head-relative direction, speed from `PACE_SPEED[settings.pace]` capped at a
  walk (~1.4 m/s; running in VR is uncomfortable). Each frame the target goes through
  `confine(target, layout, feet)`.
- **Turning** (right stick): snap 30° by default, with smooth turn as an option.
- **Teleport** (right stick forward, or the hand-tracking pinch pointer): a parabolic arc onto the floor. The
  target is valid when `confine` leaves it within a few cm and `firstWallHit(head, target)` is null (no
  teleporting through cross walls). Show a 150 ms fade.
- **Room-scale walking:** when the physical head moves, run `confine` on the head's world XZ and push the
  *origin* back by the correction, so people cannot walk through walls. Fade to black past ~0.3 m of
  penetration.
- **Benches and seats:** `supportAt` raises the origin when the visitor stands on a bench (keep it optional, and
  off by default). "Sit" (button B near `seatNear`) is replaced by a seated-mode height preset.
- **Comfort vignette** while the stick is moving: optional and on by default.
- **Disabled in XR:** jump, crouch (the visitor crouches physically), and the inspect camera flight.

---

## 5. Interaction and in-world UI

- **Pointing:** controller rays and hand pinch through `@react-three/xr` pointer events. Paintings are already
  registered meshes (`registry: Map<string, THREE.Mesh>` with `userData.placement`). Hook `onClick` /
  `onPointerOver` into the same `pickPainting` rules (range, `firstWallHit`). The hover highlight replaces the
  crosshair.
- **Inspect:** trigger on a painting → fade → teleport to `inspectPose(placement)` → a floating panel beside the
  work (title, artist, year, medium, dimensions, credits: the data `InspectPanel.tsx` already shows; fetched
  from `/api/work/...`). A "zoom" grip moves a high-resolution copy of the texture toward the viewer instead of
  moving the viewer. "Back" fades back.
- **Panel tech:** `@react-three/uikit` (flex layout and text in WebGL, works with XR pointers). Fallback: drei
  `<Text>` (troika) plus plain planes. The panels should not reuse `Html` (DOM), which does not render in XR.
- **Wrist menu** (left hand or controller, palm up / Y button): room navigator (jump to room *n* through the
  existing `teleportApi.go`), floor list (the elevator's floors), audio guide play/pause/next, music
  mute, seated toggle, snap-turn angle, exit VR.
- **Elevator and exit doors:** both are already 3D with proximity triggers. Add pointer `onClick` on their
  buttons. `E`/`Q` key handling stays for desktop.
- **Films:** in XR, embedded providers (YouTube, Vimeo, Dailymotion) show a poster card ("Plays outside VR").
  Open streams (HLS, Commons, Archive) keep the video texture. Check that `hls.js` plays in the Quest Browser.

---

## 6. Performance budget (Quest)

Target: **72 fps sustained on Quest 2, 90 fps on Quest 3/3S**, in the longest suites (Monet: 130 rooms).

Add an `xr` quality tier in `quality.ts`, selected automatically on session start:

| Knob | Desktop `full` | `xr` (start) | Notes |
|---|---|---|---|
| Floor reflection | on | **off** | Also wrong in stereo. |
| Area lights | 4 | **0–1** | LTC area lights are costly per pixel; bake the laylight look into emissive or env. |
| Spotlight pool | 16 | **6–8** | One per nearby work. Check that the `lights_fragment_begin` patch still helps. |
| MSAA | on | via XR layer | `antialias: true` on the context. Quest does MSAA on tile. |
| Framebuffer scale | DPR 1.5 | `xr.setFramebufferScaleFactor(1.0)`; 1.2 on Quest 3 if headroom | |
| Foveation | n/a | `1` (high) | `store` option. Set the edges to blur rather than shimmer. |
| Close-up textures | 3840 px | **1280–1920 px**, nearest 2–4 works | GPU memory and upload stalls (each 10–20 ms upload = a dropped frame). |
| Texture uploads | as loaded | **≤1 per frame**, `createImageBitmap` off-thread, held while turning | Ties into upstream item 15. |
| Rooms streamed | `VISTA_ROOMS = 3` | 2 | Fewer draws. |
| Multiview | n/a | Evaluate three's multiview path (OVR_multiview2) | Roughly halves CPU draw cost. Check how r184 enables it with R3F. |

Measuring: Meta's OVR Metrics Tool overlay on the headset, plus an XR mode for `scripts/perf-probe.mjs` using the
IWER emulator for draw-call counts on desktop.

---

## 7. Hosting on Cloudflare

### Option A (recommended): OpenNext on Cloudflare Workers
`@opennextjs/cloudflare` runs Next (App Router, ISR, route handlers) on Workers, with ISR caching in R2.

Required changes:
1. **Data access without `fs` at run time.** `data.ts`, `rooms.ts` and `phases.ts` read JSON with `fs` from
   `data/`, and `/room`, `/api/room*`, `/api/work/*` and `/api/guide/*` do this on every request. Introduce a
   small `DataSource` interface. Its Node implementation keeps `fs` (build time, dev, Docker). Its Cloudflare
   implementation reads the same files from an **R2 bucket** (or Workers static assets) and memoises them per
   isolate. Do not `import` `museum.json` into the bundle: ~100k works would blow the Worker size limit
   (3 MB free / 10 MB paid, compressed).
2. **Split the big snapshot** if per-request reads are slow: `museum.json` → `artists/<slug>.json` plus a small
   index. Routes then load only what they need.
3. **Config:** drop `output: "standalone"` for the Cloudflare build (env-gated), add `wrangler.jsonc`
   (`nodejs_compat`, R2 bindings for data + ISR cache), add `open-next.config.ts`, and add
   `npm run cf:build` / `cf:deploy` / `cf:preview` scripts.
4. **Headers:** the CSP and security headers in `next.config.ts` carry over. Add
   `xr-spatial-tracking=(self)` to `Permissions-Policy` (it is the default, but say it explicitly).
   `frame-ancestors 'none'` is fine.
5. **Postgres** (`pg`) is optional. Leave `DATABASE_URL` unset and use JSON. If it is wanted later, use
   Hyperdrive.
6. **Domain:** a custom domain on the Cloudflare zone. HTTPS comes with it, and WebXR requires it.
7. **CI:** GitHub Actions → `wrangler deploy` on push to `main`. The data lives in R2 and is uploaded by a
   separate `npm run cf:upload-data`, not in git.

### Option B (fallback, no code changes): Cloudflare Containers
Run the existing `Dockerfile` behind a Worker. This is the fastest path to a live URL, but it costs more at idle
and depends on Containers being available on the account. It is useful as a stopgap while Option A is built.

### Not viable: static export to Pages
`/room` (which encodes the selection in the URL), the API routes and ISR all need a server.

---

## 8. Data (blocker to resolve first)

Upstream does not publish `data/` (gitignored as "private, local only"), nor `public/audio/` or the Python
`archive/` pipeline. A fresh clone has **no collection**. What the fork can regenerate:

- `npm run ingest` (with `WIKI_USER_AGENT` set) writes `data/wikipedia/museum.json` from Wikipedia, Wikidata and
  Commons. The README describes a full run as hours. Development can start on a cut-down seed (a handful of
  artists in `scripts/seed.ts`, or `--new`).
- Without the pipeline, the following are missing: `data/site/rooms.json` (custom rooms and recreated museums),
  `phases.json` (life phases; galleries fall back to years), `guide/*.json` (audio guide scripts), films, and
  WikiArt-only works. The code tolerates their absence (`existsSync` checks), so the features degrade
  gracefully.
- Music: `MuseumAudio` falls back to Commons when `public/audio` is missing. Confirm the Commons URLs still
  resolve.

Optionally, ask the upstream author whether a data snapshot can be shared (MIT code; the data is Wikimedia
content with its own licences, see `NOTICE.md`).

---

## 9. Phased work

| # | Phase | Main files | Done when | Rough size |
|---|---|---|---|---|
| 0 | **Fork and baseline**: GitHub fork, set `upstream` remote, `npm i`, ingest a ~20-artist seed, `npm run dev`. Reach it from the Quest via `adb reverse tcp:3000 tcp:3000` (so `localhost` is a secure context) or `next dev --experimental-https`. Install the Immersive Web Emulator for desktop work. | `scripts/seed.ts`, `.env.local` | A gallery walks on desktop, and the page opens in the Quest Browser | 0.5–1 d (+ ingest time) |
| 1 | **Cloudflare deploy** (Option A, or B as a stopgap) | `src/lib/data.ts`, `rooms.ts`, `phases.ts`, `next.config.ts`, new `wrangler.jsonc`, `open-next.config.ts` | The fork is live on a custom HTTPS domain, and the headset can test without a cable | 2–4 d |
| 2 | **XR foundation**: add `@react-three/xr`, wrap the Canvas, Enter VR button, `XROrigin`, **move the prop layer off 1**, `viewer.ts`, and sweep the 39 `camera.position` sites, reflection off in XR, `xr` quality tier, clean session start and end | `MuseumApp.tsx`, `Gallery.tsx`, `Controls.tsx`, `PaintingExhibit.tsx`, `room-signs.tsx`, `fx/*`, `quality.ts` | Standing in a gallery in VR, both eyes see everything, and leaving VR restores the 2D view | 3–5 d |
| 3 | **Locomotion**: `XRPlayer` with smooth move, snap turn, teleport, room-scale collision, seated mode, vignette | `xr/XRPlayer.tsx`, `layout.ts` (reuse) | Can walk the whole Caravaggio suite and cannot pass through walls or cross walls | 3–4 d |
| 4 | **Interaction and UI**: pointer inspect, `XRInspect` panel, wrist menu (navigator, floors, guide, music, settings), clickable elevator and exit doors, films fallback | `xr/XRInspect.tsx`, `xr/panels/*`, `Elevator.tsx`, `ExitDoors.tsx`, `FilmNook.tsx` | Every desktop feature in a gallery has a VR equivalent or a deliberate "not in VR" | 5–8 d |
| 5 | **Performance pass**: hold 72/90 fps on the longest suite; texture upload throttling; spot pool; multiview evaluation | `quality.ts`, `exhibit-texture.ts`, `suite-runtime.ts`, `Room.tsx` | OVR Metrics shows no sustained drops while walking Monet | 3–6 d |
| 6 | **Audio**: music and guide in VR; default the guide to `speechSynthesis` on Quest if Pocket's WASM model is too heavy; optional positional audio for the film nook | `AudioGuide.tsx`, `voice.ts`, `MuseumAudio.tsx` | Guide is playable from the wrist menu without frame drops | 1–2 d |
| 7 | **Tests and docs**: `scripts/verify-xr.mjs` (Playwright + `iwer` emulated Quest: enter session, both-eye layer check, teleport, inspect, exit), a manual device checklist, README/DEVELOPMENT updates | `scripts/`, `docs/` | CI runs the XR smoke test | 1–2 d |

Phases 1 and 2–3 are independent and can run in parallel. Phase 2 is the critical path for a first "I'm
standing in a gallery" moment, which is roughly a week in.

---

## 10. Risks and open questions

- **Which headset?** Quest 2 vs 3/3S changes the budget a lot (Adreno 650 vs 740). Phase 5's targets assume
  Quest 3 for "good" and Quest 2 for "acceptable".
- **Standing, seated, or both?** This affects the defaults for height and the bench-climbing feature.
- **Hand tracking** is supported through `@react-three/xr` pointers at little extra cost, but the wrist menu's
  palm-up gesture needs tuning. Ship controllers first?
- **Texture memory:** close-up 3840 px textures across a room can exceed Quest's comfortable GPU memory. Mipmapped
  1920 px is the likely ceiling until IIIF tiling (upstream item 13) exists.
- **Shader warm-up:** `precompile()` compiles mono programs. Stereo or multiview variants may compile on first
  XR frame and hitch. Warm up again on `sessionstart` behind a black fade.
- **Cloudflare limits:** Worker CPU time per request for `/room` (it builds a layout over large JSON) may need
  the paid plan ($5/mo) and the data split in §7.2.
- **Upstream sync:** keep XR code mostly in `xr/` plus small hooks in existing files, so that
  `git merge upstream/main` stays manageable. Upstream changes very often (several commits a day).
- **Licences:** code is MIT, so it can be forked. Images are hot-linked from Wikimedia/WikiArt under their own
  licences and credits (`NOTICE.md`). Keep the credits visible in the VR inspect panel.
