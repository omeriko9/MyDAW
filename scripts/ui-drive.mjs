#!/usr/bin/env node
/**
 * ui-drive — drive MyDAW in a real Chrome over CDP, N instances at a time.
 *
 * The Chrome DevTools MCP hands out ONE browser with one "selected page", which
 * makes concurrent agents clobber each other mid-action, so browser test passes
 * had to run strictly sequentially (~9 min per area). This gives every worker its
 * own Chrome AND its own engine, so they run in parallel.
 *
 * Everything here is Node built-ins only (Node 22: global fetch + WebSocket) —
 * the repo deliberately keeps puppeteer/playwright out of its dependencies.
 *
 * A "slot" is one isolated world:
 *   engine port  8620+slot   own APPDATA (throwaway) + --driver null
 *   debug port   9230+slot   own Chrome --user-data-dir (throwaway)
 *
 *   node scripts/ui-drive.mjs up    --slot 1 [--fixture] [--headful]
 *   node scripts/ui-drive.mjs eval  --slot 1 --code "document.title"
 *   node scripts/ui-drive.mjs eval  --slot 1 --file snippet.js
 *   node scripts/ui-drive.mjs key   --slot 1 --key "Control+Alt+Shift+1"
 *   node scripts/ui-drive.mjs click --slot 1 --x 640 --y 285 [--button right] [--clicks 2]
 *   node scripts/ui-drive.mjs drag  --slot 1 --from 100,200 --to 300,200 [--steps 12]
 *   node scripts/ui-drive.mjs shot  --slot 1 --out shot.png
 *   node scripts/ui-drive.mjs down  --slot 1
 *
 * Every command prints one JSON object on stdout.
 *
 * Why the real Input domain and not synthetic events: CDP's Input.dispatchKeyEvent
 * produces TRUSTED events with the character a real layout would send, so
 * Ctrl+Alt+Shift+1 arrives as "!" like it does on a physical keyboard. Synthetic
 * KeyboardEvents (and the MCP's press_key) deliver "1" and silently pass shortcuts
 * that are dead in real use — that exact difference hid a broken shortcut here.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const ENGINE = path.join(REPO, "build", "bin", "Release", "mydaw-engine.exe");
const UI_ROOT = path.join(REPO, "ui", "dist");
const ROOT = path.join(tmpdir(), "mydaw-ui-drive");

const CHROMES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, dflt = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const slot = Number(arg("slot", "1"));
const enginePort = 8620 + slot;
const debugPort = 9230 + slot;
const slotDir = path.join(ROOT, `slot${slot}`);
const out = (o) => console.log(JSON.stringify(o));
const die = (msg) => { out({ ok: false, error: msg }); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP glue */

async function pageTarget() {
  // Prefer the MyDAW tab; a fresh Chrome may still be on about:blank.
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page");
  return pages.find((t) => t.url.includes(`:${enginePort}`)) ?? pages[0] ?? null;
}

/** One request/response over a fresh CDP socket. Stateless by design: each CLI
 *  invocation is its own process, so there is no session to keep alive. */
async function cdp(fn) {
  const target = await pageTarget();
  if (!target) throw new Error("no page target — is the slot up?");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error("cdp socket failed"));
    setTimeout(() => no(new Error("cdp connect timeout")), 10000);
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
  };
  const send = (method, params = {}) =>
    new Promise((ok, no) => {
      const mid = ++id;
      pending.set(mid, (j) => (j.error ? no(new Error(j.error.message)) : ok(j.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => no(new Error(`cdp timeout: ${method}`)), 30000);
    });
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

/* ------------------------------------------------------------------- keys */

// Non-printable keys need a virtual key code; printable ones ride on `text`.
const VK = {
  Enter: [13, "Enter"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"],
  Delete: [46, "Delete"], ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"], Home: [36, "Home"],
  End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
  // [vk, key, code] — key and code differ for space: a real keyboard reports key " "
  // (a literal space) with code "Space". Sending key "Space" matches no handler and
  // makes every Space-driven check a silent no-op.
  Space: [32, " ", "Space"],
};
// US layout: what Shift actually produces. This is the whole point of using the
// Input domain — get the character a real keyboard would send, not the base key.
const SHIFTED = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*",
  "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":",
  "'": '"', ",": "<", ".": ">", "/": "?", "`": "~",
};

function keyEvents(combo) {
  const parts = combo.split("+");
  const base = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  let m = 0;
  if (mods.includes("alt")) m |= 1;
  if (mods.includes("control") || mods.includes("ctrl")) m |= 2;
  if (mods.includes("meta")) m |= 4;
  if (mods.includes("shift")) m |= 8;
  const shift = (m & 8) !== 0;

  if (VK[base]) {
    const [vk, key, codeName] = VK[base];
    const common = {
      modifiers: m, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      key, code: codeName ?? key,
    };
    // Space is a printable character, so it needs `text` (and a real keyDown) for the
    // page to see it; the rest are non-printable and use rawKeyDown.
    if (base === "Space") return [{ ...common, type: "keyDown", text: " " }, { ...common, type: "keyUp" }];
    return [{ ...common, type: "rawKeyDown" }, { ...common, type: "keyUp" }];
  }
  const lower = base.toLowerCase();
  const isAlpha = /^[a-z]$/.test(lower);
  const ch = shift ? (isAlpha ? lower.toUpperCase() : SHIFTED[lower] ?? lower) : lower;
  const vk = isAlpha ? lower.toUpperCase().charCodeAt(0) : lower.charCodeAt(0);
  const code = isAlpha ? `Key${lower.toUpperCase()}` : /^[0-9]$/.test(lower) ? `Digit${lower}` : "";
  const common = { modifiers: m, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: ch, code };
  // With Ctrl/Meta held the browser emits no character, matching real behaviour.
  const text = m & (2 | 4) ? undefined : ch;
  return [{ ...common, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) }, { ...common, type: "keyUp" }];
}

/* --------------------------------------------------------------- commands */

async function waitFor(label, fn, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* not ready */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(300);
  }
}

async function up() {
  const appdata = path.join(slotDir, "appdata");
  const profile = path.join(slotDir, "chrome");
  mkdirSync(path.join(appdata, "MyDAW"), { recursive: true });
  mkdirSync(profile, { recursive: true });

  // Carry settings + the plugin cache so the instance is useful, but never the
  // autosave/recent/session.lock — those must stay pristine and project-free.
  const real = path.join(process.env.APPDATA ?? "", "MyDAW");
  for (const f of ["settings.json", "plugin-cache.json", "blacklist.json"]) {
    const src = path.join(real, f);
    if (existsSync(src)) writeFileSync(path.join(appdata, "MyDAW", f), readFileSync(src));
  }

  if (!existsSync(ENGINE)) die(`engine not built: ${ENGINE}`);
  const eng = spawn(ENGINE, [
    "--port", String(enginePort), "--no-browser", "--driver", "null", "--ui-root", UI_ROOT,
  ], { env: { ...process.env, APPDATA: appdata }, detached: true, stdio: "ignore" });
  eng.unref();

  const chrome = CHROMES.find(existsSync);
  if (!chrome) die("no Chrome/Edge found");
  // --user-data-dir is NOT optional: without a distinct profile a second Chrome
  // hands off to the running instance and drops the debugging port silently.
  const br = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    ...(flag("headful") ? [] : ["--headless=new"]),
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    "--window-size=1600,1000",
    `http://127.0.0.1:${enginePort}/`,
  ], { detached: true, stdio: "ignore" });
  br.unref();

  await waitFor("engine", async () => (await fetch(`http://127.0.0.1:${enginePort}/`)).ok);
  await waitFor("chrome", async () => !!(await pageTarget()));
  await waitFor("app mount", async () =>
    cdp(async (send) => {
      const r = await send("Runtime.evaluate", {
        expression: "!!document.querySelector('.tl-clipcanvas, .mixer-root, [class*=\"tlh\"]')",
        returnByValue: true,
      });
      return r.result?.value === true;
    }),
  );

  if (flag("fixture")) await seedFixture();
  out({ ok: true, slot, enginePort, debugPort, url: `http://127.0.0.1:${enginePort}/`, enginePid: eng.pid, chromePid: br.pid });
}

/** 4 tracks + a MIDI clip with a melody + a 3s audio clip + a marker. Uses the
 *  page's own origin so the upload endpoint and the WS both come for free. */
async function seedFixture() {
  const js = `(async () => {
    const probe = async (type, payload = {}) => {
      const ws = new WebSocket('ws://127.0.0.1:${enginePort}/ws');
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(Error('ws')); setTimeout(() => no(Error('t/o')), 8000); });
      const id = Math.floor(Math.random() * 1e6);
      const out = new Promise((ok, no) => { ws.onmessage = m => { const j = JSON.parse(m.data); if (j.replyTo === id) ok(j); }; setTimeout(() => no(Error('reply t/o')), 8000); });
      ws.send(JSON.stringify({ id, type, payload }));
      const r = await out; ws.close(); return r;
    };
    const midi = (await probe('cmd/track.add', { kind: 'midi', name: 'MIDI 1' })).payload.track;
    await probe('cmd/track.add', { kind: 'instrument', name: 'Instrument 1' });
    const audio = (await probe('cmd/track.add', { kind: 'audio', name: 'Audio 1' })).payload.track;
    await probe('cmd/track.add', { kind: 'bus', name: 'Bus A' });
    const clip = (await probe('cmd/clip.addMidi', { trackId: midi.id, startBeat: 0, lengthBeats: 8 })).payload.clip;
    const P = [60,62,64,65,67,65,64,62,60,64,67,72];
    await probe('cmd/notes.edit', { clipId: clip.id, add: P.map((p,i) => ({ pitch:p, startBeat:i*0.5, lengthBeats:0.45, velocity:70+(i%5)*12 })) });
    const sr = 48000, secs = 3, frames = sr*secs, db = frames*4;
    const b = new ArrayBuffer(44+db), dv = new DataView(b);
    const a = (o,s) => { for (let i=0;i<s.length;i++) dv.setUint8(o+i, s.charCodeAt(i)); };
    a(0,'RIFF'); dv.setUint32(4,36+db,true); a(8,'WAVE'); a(12,'fmt ');
    dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,2,true);
    dv.setUint32(24,sr,true); dv.setUint32(28,sr*4,true); dv.setUint16(32,4,true); dv.setUint16(34,16,true);
    a(36,'data'); dv.setUint32(40,db,true);
    for (let i=0;i<frames;i++) { const t=i/sr; const v=Math.round(Math.sin(2*Math.PI*(220+60*Math.sin(2*Math.PI*0.5*t))*t)*11000*(0.4+0.6*Math.abs(Math.sin(Math.PI*t)))); dv.setInt16(44+i*4,v,true); dv.setInt16(46+i*4,v,true); }
    const fd = new FormData();
    fd.append('files', new Blob([b], { type: 'audio/wav' }), 'fixture-sweep.wav');
    const up = await fetch('/api/upload?trackId=' + audio.id + '&atBeat=0&file0=fixture-sweep.wav', { method: 'POST', body: fd });
    await probe('cmd/marker.add', { beat: 4, name: 'Verse' });
    const p = (await probe('session/hello', { clientName: 'fixture' })).payload.project;
    return { upload: up.status, tracks: p.tracks.length, clips: p.tracks.reduce((n,t) => n + (t.clips||[]).length, 0) };
  })()`;
  return cdp(async (send) => {
    const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("fixture failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  });
}

async function main() {
  switch (cmd) {
    case "up":
      return up();

    case "eval": {
      const file = arg("file");
      const code = file ? readFileSync(file, "utf8") : arg("code");
      if (!code) die("need --code or --file");
      const v = await cdp(async (send) => {
        const r = await send("Runtime.evaluate", {
          expression: code, awaitPromise: true, returnByValue: true, userGesture: true,
        });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __throw: d.exception?.description ?? d.text ?? "eval error" };
        }
        return r.result?.value;
      });
      if (v && v.__throw) die(v.__throw);
      return out({ ok: true, value: v });
    }

    case "key": {
      const combo = arg("key");
      if (!combo) die("need --key");
      await cdp(async (send) => {
        for (const e of keyEvents(combo)) await send("Input.dispatchKeyEvent", e);
      });
      return out({ ok: true, key: combo });
    }

    case "click": {
      const x = Number(arg("x")), y = Number(arg("y"));
      const button = arg("button", "left");
      const clicks = Number(arg("clicks", "1"));
      await cdp(async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
        for (let i = 1; i <= clicks; i++) {
          const buttons = button === "right" ? 2 : 1;
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: i });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
        }
      });
      return out({ ok: true, x, y, button, clicks });
    }

    case "drag": {
      const [fx, fy] = String(arg("from", "0,0")).split(",").map(Number);
      const [tx, ty] = String(arg("to", "0,0")).split(",").map(Number);
      const steps = Number(arg("steps", "12"));
      await cdp(async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy, button: "none", buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          const x = fx + ((tx - fx) * i) / steps;
          const y = fy + ((ty - fy) * i) / steps;
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        }
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1 });
      });
      return out({ ok: true, from: [fx, fy], to: [tx, ty], steps });
    }

    case "shot": {
      const dest = arg("out", `slot${slot}.png`);
      const data = await cdp(async (send) => (await send("Page.captureScreenshot", { format: "png" })).data);
      writeFileSync(dest, Buffer.from(data, "base64"));
      return out({ ok: true, file: path.resolve(dest) });
    }

    case "fixture":
      return out({ ok: true, fixture: await seedFixture() });

    case "down": {
      // Ask Chrome to close, then drop the engine on this slot's port.
      try { await fetch(`http://127.0.0.1:${debugPort}/json/close`).catch(() => {}); } catch { /* ignore */ }
      await new Promise((r) => {
        const k = spawn("powershell", ["-NoProfile", "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${debugPort}*' -or $_.CommandLine -like '*--port ${enginePort}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: "ignore" });
        k.on("exit", r);
      });
      if (flag("purge")) rmSync(slotDir, { recursive: true, force: true });
      return out({ ok: true, slot, stopped: true });
    }

    default:
      return die(`unknown command "${cmd}" — up|eval|key|click|drag|shot|fixture|down`);
  }
}

main().catch((e) => die(e.message ?? String(e)));
