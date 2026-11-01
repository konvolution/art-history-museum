// VR checks for a gallery, in headless Chrome with an emulated Meta Quest 3 (IWER, Meta's WebXR emulation
// runtime, standing in for navigator.xr):
//
//  1. "Enter VR" shows and starts a session, the visitor where the 2D view stood;
//  2. both eyes see the props' layer (three uses layers 1 and 2 for the eyes; layers.ts);
//  3. the left stick walks forward, the right stick snap-turns, walls stop a walk;
//  4. the right stick's teleport arc lands on the floor;
//  5. the trigger at a painting stands the visitor in front of it, facing it; B goes back;
//  6. leaving VR puts the 2D view back upright.
//
//   node scripts/xr-check.mjs <slug> [baseUrl]
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
  await page.screenshot({ path: `${OUT}/xr-${slug}-enter.png` });

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
  await page.screenshot({ path: `${OUT}/xr-${slug}-teleport-aim.png` });
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
    if (!pl) return null;
    // gallery -> headset space: the rig is the camera's world pose times the headset pose's inverse (yaw only)
    const d = window.__xrDevice;
    const hq = d.quaternion;
    const headYaw = Math.atan2(2 * (hq.w * hq.y + hq.x * hq.z), 1 - 2 * (hq.y * hq.y + hq.x * hq.x));
    const q = camera.quaternion;
    const camYaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    const ry = camYaw - headYaw;
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const rx = cx - (c * d.position.x + s * d.position.z);
    const rz = cz - (-s * d.position.x + c * d.position.z);
    const gx = pl.position[0] - rx;
    const gz = pl.position[2] - rz;
    const lx = c * gx - s * gz;
    const lz = s * gx + c * gz;
    const ly = pl.position[1];
    // the controller at the eye, pointing at the work
    const ctl = d.controllers.right;
    ctl.position.set(d.position.x, d.position.y, d.position.z);
    const dx = lx - d.position.x;
    const dy = ly - d.position.y;
    const dz = lz - d.position.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    // YXZ: yaw about Y, then pitch about X
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    ctl.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    return { slug: pl.painting.slug, x: pl.position[0], z: pl.position[2], rotationY: pl.rotationY };
  });
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
    await page.screenshot({ path: `${OUT}/xr-${slug}-inspect.png` });
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

  // 6. leave
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
