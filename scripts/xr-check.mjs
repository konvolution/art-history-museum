// VR checks for a gallery, in headless Chrome with an emulated Meta Quest 3 (IWER, Meta's WebXR emulation
// runtime, standing in for navigator.xr):
//
//  1. "Enter VR" shows and starts a session, the visitor where the 2D view stood;
//  2. both eyes see the props' layer (three uses layers 1 and 2 for the eyes; layers.ts);
//  3. the left stick walks forward, the right stick snap-turns, walls stop a walk;
//  4. the right stick's teleport arc lands on the floor;
//  5. the trigger at a painting stands the visitor in front of it, facing it; B goes back;
//  6. A / X jump to the next / previous room; an arc aimed up through a doorway lands in the next room; the right
//     stick pulled back steps back;
//  7. with floors (e.g. claude-monet): the elevator's badge opens its doors, the visitor walks into the car, a floor
//     badge rides to that floor and VR goes on there, the visitor in its car;
//     with end doors (e.g. caravaggio): a door's exit badge leads to the next gallery, still in VR;
//  8. leaving VR puts the 2D view back upright.
//
//   node scripts/xr-check.mjs <slug> [baseUrl] [doors]   # slug: an artist, or "<artist>/floor/<n>"; "doors": the
//                                                       # end doors' check where there is an elevator too
//
// Uses the page's test hook (window.__MUSEUM_DEBUG__). Writes screenshots to verify-artifacts/; exits 1 on a
// failure.
import { chromium } from "playwright";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const IWER_JS = fs.readFileSync(require.resolve("iwer").replace(/lib[\\/]index\.js$/, "build/iwer.min.js"), "utf8");

const slug = process.argv[2] ?? "caravaggio";
const base = process.argv[3] ?? "http://localhost:3000";
const preferDoors = process.argv[4] === "doors";
const OUT = "verify-artifacts";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"],
});
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${Object.keys(detail).length ? "  " + JSON.stringify(detail) : ""}`);
};
const errors = [];

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 240)));
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 240)}`));
await page.addInitScript({ content: IWER_JS });
await page.addInitScript(() => {
  window.__MUSEUM_DEBUG__ = true;
  const device = new window.IWER.XRDevice(window.IWER.metaQuest3);
  device.installRuntime({ forceInstall: true });
  // IWER (2.2-2.7) takes getOffsetReferenceSpace's XRRigidTransform for a matrix, so every offset is lost; a
  // headset's own WebXR does not. Hand it the transform's matrix.
  const RS = window.IWER.XRReferenceSpace.prototype;
  const offset = RS.getOffsetReferenceSpace;
  RS.getOffsetReferenceSpace = function (t) {
    return offset.call(this, t.matrix ?? t);
  };
  window.__xrDevice = device;
});

const sleep = (ms) => page.waitForTimeout(ms);
/** The eye in the gallery: place, heading, and whether a session is presenting. */
const eye = () =>
  page.evaluate(() => {
    const m = window.__museum;
    const c = m.camera;
    const q = c.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    return { x: c.position.x, y: c.position.y, z: c.position.z, yaw, presenting: m.gl.xr.isPresenting, room: m.runtime.currentRoom() };
  });
const stick = (hand, x, y) =>
  page.evaluate(([h, x, y]) => window.__xrDevice.controllers[h].updateAxes("thumbstick", x, y), [hand, x, y]);
const button = (hand, id, v) =>
  page.evaluate(([h, id, v]) => window.__xrDevice.controllers[h].updateButtonValue(id, v), [hand, id, v]);
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Point a controller from the eye at a place in the gallery (the headset space is the rig's: session.ts). */
const aimAt = (hand, at, pitchOverride) =>
  page.evaluate(
    ([hand, at, pitchOverride]) => {
      const m = window.__museum;
      const v = m.xr.viewer();
      const d = window.__xrDevice;
      const hq = d.quaternion;
      const headYaw = Math.atan2(2 * (hq.w * hq.y + hq.x * hq.z), 1 - 2 * (hq.y * hq.y + hq.x * hq.x));
      // rig: gallery = rotY(ry) · headset + (rx, rz)
      const ry = v.yaw - headYaw;
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      const rx = v.x - (c * d.position.x + s * d.position.z);
      const rz = v.z - (-s * d.position.x + c * d.position.z);
      const gx = at[0] - rx;
      const gz = at[2] - rz;
      const lx = c * gx - s * gz;
      const lz = s * gx + c * gz;
      const ctl = d.controllers[hand];
      ctl.position.set(d.position.x, d.position.y, d.position.z);
      const dx = lx - d.position.x;
      const dy = at[1] - d.position.y;
      const dz = lz - d.position.z;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = pitchOverride ?? Math.atan2(dy, Math.hypot(dx, dz));
      // YXZ: yaw about Y, then pitch about X
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      ctl.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    },
    [hand, at, pitchOverride ?? null]
  );
const press = async (hand, id) => {
  await button(hand, id, 1);
  await sleep(150);
  await button(hand, id, 0);
};
const place = (x, z, yaw) => page.evaluate(([x, z, yaw]) => window.__museum.xr.place(x, z, yaw), [x, z, yaw]);
const badges = () => page.evaluate(() => window.__museum.badges());

try {
  await page.goto(`${base}/museum/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mus-click-to-start", { timeout: 60000 });
  await page.waitForFunction(() => !!window.__museum);

  // 1. enter
  const enter = page.getByRole("button", { name: "Enter VR" });
  check("Enter VR button shows", await enter.isVisible().catch(() => false));
  const before = await eye();
  await enter.click();
  await page.waitForFunction(() => window.__museum?.gl.xr.isPresenting, null, { timeout: 10000 });
  await sleep(600);
  const start = await eye();
  check("session presenting", start.presenting);
  check("starts where the 2D view stood", Math.hypot(start.x - before.x, start.z - before.z) < 0.05 && Math.abs(angle(start.yaw - before.yaw)) < 0.05, {
    before: [before.x.toFixed(2), before.z.toFixed(2)],
    start: [start.x.toFixed(2), start.z.toFixed(2)],
  });
  await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-enter.png` });

  // 2. layers: every object on a non-zero layer is seen by both eyes
  const eyes = await page.evaluate(() => {
    const { gl, scene } = window.__museum;
    const cams = gl.xr.getCamera().cameras;
    let props = 0;
    let missing = 0;
    scene.traverse((o) => {
      if (!o.isMesh || o.layers.mask === 1) return;
      props++;
      if (!cams.every((c) => c.layers.test(o.layers))) missing++;
    });
    return { eyes: cams.length, props, missing };
  });
  check("both eyes see the props' layer", eyes.eyes === 2 && eyes.props > 0 && eyes.missing === 0, eyes);

  // 3. walk, turn, walls
  await stick("left", 0, -1);
  await sleep(1000);
  await stick("left", 0, 0);
  await sleep(100);
  const walked = await eye();
  const fwd = (walked.x - start.x) * -Math.sin(start.yaw) + (walked.z - start.z) * -Math.cos(start.yaw);
  check("left stick walks forward (~1.4 m/s)", fwd > 0.8 && fwd < 2.0, { metres: fwd.toFixed(2) });

  await stick("right", 1, 0);
  await sleep(150);
  await stick("right", 0, 0);
  await sleep(150);
  const turned = await eye();
  const dYaw = angle(turned.yaw - walked.yaw);
  check("right stick snap-turns 30° right", Math.abs(dYaw + Math.PI / 6) < 0.03, { degrees: ((dYaw * 180) / Math.PI).toFixed(1) });
  check("snap turn keeps the visitor in place", Math.hypot(turned.x - walked.x, turned.z - walked.z) < 0.02);

  // a long walk to the side runs into the wall and stays in the hall
  await stick("left", -1, 0);
  await sleep(6000);
  await stick("left", 0, 0);
  await sleep(100);
  const wall = await eye();
  const hall = await page.evaluate(([x, z]) => {
    const { layout } = window.__museum;
    const r = layout.rooms.find((r) => z >= Math.min(r.z0, r.z1) && z <= Math.max(r.z0, r.z1)) ?? layout.rooms[0];
    return { half: r.halfWidth ?? layout.hallWidth / 2, x };
  }, [wall.x, wall.z]);
  check("a walk into the wall stops inside the hall", Math.abs(wall.x) < hall.half - 0.3, { x: wall.x.toFixed(2), halfWidth: hall.half });

  // 4. teleport: aim down the hall, let go
  await page.evaluate(() => {
    const d = window.__xrDevice;
    const c = d.controllers.right;
    c.position.set(d.position.x + 0.2, d.position.y - 0.4, d.position.z - 0.3);
    c.quaternion.copy(d.quaternion);
  });
  await stick("right", 0, -1);
  await sleep(400);
  await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-teleport-aim.png` });
  await stick("right", 0, 0);
  await sleep(300);
  const tele = await eye();
  check("teleport moves the visitor", Math.hypot(tele.x - wall.x, tele.z - wall.z) > 1, {
    from: [wall.x.toFixed(2), wall.z.toFixed(2)],
    to: [tele.x.toFixed(2), tele.z.toFixed(2)],
  });

  // 5. the trigger at the nearest painting in this room
  const aimed = await page.evaluate(() => {
    const { layout, runtime, camera } = window.__museum;
    const room = runtime.currentRoom();
    const cx = camera.position.x;
    const cz = camera.position.z;
    const pl = layout.placements
      .filter((p) => p.room === room)
      .sort((a, b) => Math.hypot(a.position[0] - cx, a.position[2] - cz) - Math.hypot(b.position[0] - cx, b.position[2] - cz))[0];
    return pl ? { slug: pl.painting.slug, x: pl.position[0], y: pl.position[1], z: pl.position[2] } : null;
  });
  if (aimed) await aimAt("right", [aimed.x, aimed.y, aimed.z]);
  if (!aimed) check("a painting in the room to aim at", false);
  else {
    await sleep(200);
    const pre = await eye();
    await button("right", "trigger", 1);
    await sleep(150);
    await button("right", "trigger", 0);
    await sleep(400);
    const at = await eye();
    const dist = Math.hypot(at.x - aimed.x, at.z - aimed.z);
    const facing = Math.abs(angle(at.yaw - Math.atan2(-(aimed.x - at.x), -(aimed.z - at.z))));
    check("trigger at a painting stands in front of it, facing it", dist < 4 && dist > 0.5 && facing < 0.1, {
      painting: aimed.slug,
      metres: dist.toFixed(2),
      facingOffDeg: ((facing * 180) / Math.PI).toFixed(1),
    });
    await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-inspect.png` });
    await button("right", "b-button", 1);
    await sleep(150);
    await button("right", "b-button", 0);
    await sleep(300);
    const backAt = await eye();
    check("B goes back to where one stood", Math.hypot(backAt.x - pre.x, backAt.z - pre.z) < 0.05, {
      pre: [pre.x.toFixed(2), pre.z.toFixed(2)],
      back: [backAt.x.toFixed(2), backAt.z.toFixed(2)],
    });
  }

  // 6. rooms: A / X, an arc through a doorway, a step back
  const rooms = await page.evaluate(() => window.__museum.layout.rooms.length);
  if (rooms > 1) {
    await place(0, (await page.evaluate(() => window.__museum.layout.hallLength)) / 2 - 3, 0);
    await sleep(400);
    const r0 = (await eye()).room;
    await press("right", "a-button");
    await sleep(700);
    const r1 = (await eye()).room;
    check("A jumps to the next room", r1 === r0 + 1, { from: r0, to: r1 });
    await press("left", "x-button");
    await sleep(700);
    const r2 = (await eye()).room;
    check("X jumps back to the room before", r2 === r0, { room: r2 });

    // stand 3.5 m before the first doorway, facing it, and aim well up through it (45°)
    const door = await page.evaluate(() => {
      const d = window.__museum.layout.doorways[0];
      return { x: d.x, z: d.z, t: d.thickness, h: d.height };
    });
    await place(door.x, door.z + door.t / 2 + 3.5, 0);
    await sleep(400);
    await aimAt("right", [door.x, 1.6, door.z - 3], Math.PI / 4);
    await stick("right", 0, -1);
    await sleep(300);
    await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-doorway-arc.png` });
    await stick("right", 0, 0);
    await sleep(600);
    const through = await eye();
    check("an arc aimed up through a doorway lands in the next room", through.z < door.z - door.t / 2, {
      doorHeight: door.h,
      z: through.z.toFixed(2),
      doorway: door.z.toFixed(2),
      room: through.room,
    });

    const before = await eye();
    await stick("right", 0, 1);
    await sleep(150);
    await stick("right", 0, 0);
    await sleep(150);
    const stepped = await eye();
    const backDist = (stepped.x - before.x) * Math.sin(before.yaw) + (stepped.z - before.z) * Math.cos(before.yaw);
    check("right stick back steps back ~0.5 m", backDist > 0.4 && backDist < 0.6, { metres: backDist.toFixed(2) });
  }

  // 7. the elevator (a gallery with floors), or the end doors
  const spots = await page.evaluate(() => {
    const l = window.__museum.layout;
    return { lift: l.elevator, exits: l.exits, hall: l.hallLength };
  });
  if (spots.lift && !(preferDoors && spots.exits)) {
    const zw = spots.hall / 2;
    await place(spots.lift.x, zw - 1.6, Math.PI);
    await sleep(500);
    const call = (await badges()).find((b) => b.icon === "lift");
    check("the elevator has a call badge", !!call?.shown, { badges: (await badges()).length });
    if (call) {
      await aimAt("right", call.at);
      await sleep(150);
      await press("right", "trigger");
      await sleep(2600);
      await stick("left", 0, -1);
      await sleep(2000);
      await stick("left", 0, 0);
      await sleep(200);
      const inCar = await eye();
      check("the doors open and the visitor walks into the car", inCar.z > zw + 0.2, { z: inCar.z.toFixed(2), wall: zw });
      await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-in-car.png` });
      const floorBadge = (await badges()).find((b) => b.icon === "floor" && b.shown);
      check("the car has floor badges", !!floorBadge, { floor: floorBadge?.text });
      if (floorBadge) {
        const url = page.url();
        await page.evaluate(() => (window.__museum.old = true));
        await aimAt("right", floorBadge.at);
        await sleep(150);
        await press("right", "trigger");
        await page.waitForURL((u) => u.toString() !== url, { timeout: 20000 });
        await page.waitForFunction(() => window.__museum && !window.__museum.old && window.__museum.gl.xr.isPresenting, null, { timeout: 20000 });
        await sleep(1500);
        const there = await eye();
        const hall2 = await page.evaluate(() => window.__museum.layout.hallLength);
        check("riding to another floor stays in VR, the visitor in its car", there.presenting && there.z > hall2 / 2 - 0.2, {
          url: page.url().replace(base, ""),
          z: there.z.toFixed(2),
          wall: (hall2 / 2).toFixed(2),
        });
        await sleep(1500);
        check("its doors open on arrival", await page.evaluate(() => window.__museum.liftCar.open === true));
        await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-arrived-by-lift.png` });
        await stick("left", 0, -1);
        await sleep(2000);
        await stick("left", 0, 0);
        await sleep(200);
        const out = await eye();
        check("and walks out of the car into the hall", out.z < hall2 / 2 - 0.5, { z: out.z.toFixed(2) });
      }
    }
  } else if (spots.exits) {
    const zw = -spots.hall / 2;
    await place(0, zw + 4, 0);
    await sleep(1500);
    const exit = (await badges()).find((b) => b.icon === "exit" && b.shown);
    check("the end doors have exit badges", !!exit, { badges: (await badges()).filter((b) => b.icon === "exit").length });
    if (exit) {
      const url = page.url();
      await page.evaluate(() => (window.__museum.old = true));
      await aimAt("right", exit.at);
      await sleep(300);
      await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-exit-badges.png` });
      await press("right", "trigger");
      await page.waitForURL((u) => u.toString() !== url, { timeout: 20000 });
      await page.waitForFunction(() => window.__museum && !window.__museum.old && window.__museum.gl.xr.isPresenting, null, { timeout: 20000 });
      await sleep(1500);
      const there = await eye();
      check("an exit badge leads to the next gallery, still in VR", there.presenting, { url: page.url().replace(base, "") });
      await page.screenshot({ path: `${OUT}/xr-${slug.replaceAll("/", "-")}-next-gallery.png` });
    }
  }

  // 8. leave
  await page.evaluate(() => window.__museum.gl.xr.getSession().end());
  await sleep(500);
  const after = await eye();
  const up = await page.evaluate(() => {
    const r = window.__museum.camera.rotation;
    return { x: r.x, z: r.z };
  });
  check("leaving VR: no session, the 2D view upright at eye height", !after.presenting && Math.abs(up.x) < 1e-3 && Math.abs(up.z) < 1e-3 && Math.abs(after.y - 1.65) < 1e-3, {
    y: after.y.toFixed(3),
  });
} catch (e) {
  check("ran to the end", false, { error: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
}

const own = errors.filter((e) => !/wikimedia|wikiart|Failed to load resource/i.test(e));
check("no page errors", own.length === 0, own.length ? { errors: own.slice(0, 5) } : {});
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
