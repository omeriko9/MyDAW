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
 * ---------------------------------------------------------------- 1. THE CLI
 *
 *   node scripts/ui-drive.mjs up    --slot 1 [--fixture] [--headful]
 *   node scripts/ui-drive.mjs eval  --slot 1 --code "document.title"
 *   node scripts/ui-drive.mjs eval  --slot 1 --file snippet.js
 *   node scripts/ui-drive.mjs key   --slot 1 --key "Control+Alt+Shift+1"
 *   node scripts/ui-drive.mjs click --slot 1 --x 640 --y 285 [--button right] [--clicks 2]
 *   node scripts/ui-drive.mjs drag  --slot 1 --from 100,200 --to 300,200 [--steps 12]
 *   node scripts/ui-drive.mjs shot  --slot 1 --out shot.png
 *   node scripts/ui-drive.mjs down  --slot 1 [--purge]
 *
 * Every command prints one JSON object on stdout. Each invocation is its own
 * process and opens its own throwaway CDP socket.
 *
 * ---------------------------------------------------------------- 2. THE API
 *
 * A suite cannot pay node startup + browser connect (10-30 s under load) per
 * step, so the same internals are exported for a long-running process that holds
 * ONE CDP socket open for the whole session:
 *
 *   import { openSlot } from "./ui-drive.mjs";
 *   const s = await openSlot({ slot: 8, fixture: true });
 *   await s.key("Control+Alt+1");
 *   const title = await s.eval(() => document.title);
 *   const reply = await s.probe("transport/play");
 *   await s.reload();
 *   await s.close();
 *
 * See openSlot() for the full Slot surface. The CLI commands are thin wrappers
 * over the same functions — there is one implementation of each behaviour.
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
import { pathToFileURL } from "node:url";

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

/** Anything painted by the app proper — proves React mounted, not just that HTML loaded. */
const MOUNTED_JS = "!!document.querySelector('.tl-clipcanvas, .mixer-root, [class*=\"tlh\"]')";
/** Mounted AND talking to the engine AND not mid-reload (see Slot.reload). */
const READY_JS = `(() => {
  if (window.__uiDriveReloading) return false;
  if (!(${MOUNTED_JS})) return false;
  return document.querySelector('.sb-dot')?.dataset.ok === 'true';
})()`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ports and scratch dir for a slot. The only place the numbering lives. */
export function slotPorts(slot) {
  return {
    slot,
    enginePort: 8620 + slot,
    debugPort: 9230 + slot,
    slotDir: path.join(ROOT, `slot${slot}`),
    url: `http://127.0.0.1:${8620 + slot}/`,
  };
}

/** Poll until `fn()` is truthy. Errors count as "not ready yet". Returns its value. */
export async function waitFor(label, fn, timeoutMs = 45000, intervalMs = 300) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/* ---------------------------------------------------------------- CDP glue */

async function pageTarget(debugPort, enginePort) {
  // Prefer the MyDAW tab; a fresh Chrome may still be on about:blank.
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page");
  return pages.find((t) => t.url.includes(`:${enginePort}`)) ?? pages[0] ?? null;
}

/**
 * One CDP socket onto the slot's page.
 *
 * The connection is to the TARGET, not to a document, so it survives reloads and
 * navigations — which is what lets a suite keep one socket for hundreds of steps.
 * `onEvent(method, params)` (optional) receives every CDP event on the socket.
 */
async function openCdp(debugPort, enginePort, onEvent) {
  const target = await pageTarget(debugPort, enginePort);
  if (!target) throw new Error("no page target — is the slot up?");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error("cdp connect timeout")), 10000);
    ws.onopen = () => { clearTimeout(timer); ok(); };
    ws.onerror = () => { clearTimeout(timer); no(new Error("cdp socket failed")); };
  });
  let id = 0;
  let dead = null;
  const pending = new Map();
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pending.has(j.id)) {
      const settle = pending.get(j.id);
      pending.delete(j.id);
      settle(j);
      return;
    }
    if (j.method && onEvent) onEvent(j.method, j.params ?? {});
  };
  ws.onclose = () => {
    dead = new Error("cdp socket closed");
    for (const settle of pending.values()) settle({ error: { message: dead.message } });
    pending.clear();
  };
  // Timers are always cleared: a suite process would otherwise be held alive for
  // 30 s past its last command by a pile of orphaned timeouts.
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((ok, no) => {
      if (dead) return no(dead);
      const mid = ++id;
      const timer = setTimeout(() => {
        pending.delete(mid);
        no(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      pending.set(mid, (j) => {
        clearTimeout(timer);
        if (j.error) no(new Error(j.error.message));
        else ok(j.result);
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, target, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

/** Stateless one-shot: connect, run, disconnect. The CLI's whole lifecycle. */
async function cdpOnce(debugPort, enginePort, fn) {
  const sess = await openCdp(debugPort, enginePort);
  try {
    return await fn(sess.send);
  } finally {
    sess.close();
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
// Punctuation: [windows virtual key, code]. Letters and digits are the only characters
// whose ASCII value doubles as their VK — for everything else the two spaces collide
// badly, and Chrome dispatches the VK, not the character. "." is ASCII 46, which is
// VK_DELETE: typing "3.1.000" pressed Delete twice and arrived as "31000", and the
// locate field dutifully jumped to bar 31000. "'" is 39 (End), "-" is 45 (Insert),
// "[" is 91 (LWin). None of these are typos you can see — the character just vanishes
// and something else happens instead.
const OEM = {
  ";": [186, "Semicolon"], "=": [187, "Equal"], ",": [188, "Comma"], "-": [189, "Minus"],
  ".": [190, "Period"], "/": [191, "Slash"], "`": [192, "Backquote"], "[": [219, "BracketLeft"],
  "\\": [220, "Backslash"], "]": [221, "BracketRight"], "'": [222, "Quote"],
  // Shift+Equal on a US board. Reachable as a base key only via key("+"); type("+")
  // resolves through SHIFTED and arrives here as "=" with the shift modifier set.
  "+": [187, "Equal"],
};

export function keyEvents(combo) {
  const parts = combo.split("+");
  // "+" is both the separator and a key. A literal one lands as a trailing empty
  // segment ("+" -> ["",""], "Shift++" -> ["Shift","",""]); fold it back into a base.
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
    parts[parts.length - 1] = "+";
  }
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
  const isDigit = /^[0-9]$/.test(lower);
  const ch = shift ? (isAlpha ? lower.toUpperCase() : SHIFTED[lower] ?? lower) : lower;
  // The vk and code describe the PHYSICAL key, so they do not change under Shift —
  // only `key`/`text` do. Shift+Period is still vk 190 / code "Period", reporting ">".
  const [oemVk, oemCode] = OEM[lower] ?? [];
  const vk = isAlpha || isDigit ? lower.toUpperCase().charCodeAt(0) : oemVk ?? lower.charCodeAt(0);
  const code = isAlpha ? `Key${lower.toUpperCase()}` : isDigit ? `Digit${lower}` : oemCode ?? "";
  const common = { modifiers: m, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: ch, code };
  // With Ctrl/Meta held the browser emits no character, matching real behaviour.
  const text = m & (2 | 4) ? undefined : ch;
  return [{ ...common, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) }, { ...common, type: "keyUp" }];
}

/* --------------------------------------------------------- input + evaluate */

async function dispatchKey(send, combo) {
  for (const e of keyEvents(combo)) await send("Input.dispatchKeyEvent", e);
}

async function dispatchClick(send, x, y, { button = "left", clicks = 1 } = {}) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  for (let i = 1; i <= clicks; i++) {
    const buttons = button === "right" ? 2 : 1;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: i });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
  }
}

async function dispatchDrag(send, [fx, fy], [tx, ty], steps = 12) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy, button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = fx + ((tx - fx) * i) / steps;
    const y = fy + ((ty - fy) * i) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1 });
}

/** A page function has no closure — it is stringified and evaluated over there. */
function toExpression(code) {
  return typeof code === "function" ? `(${code.toString()})()` : String(code);
}

/** Evaluate and REPORT failure rather than throw, so the CLI can print it and the
 *  API can throw it. `{ value }` or `{ error }`, never both. */
async function evaluateRaw(send, expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return { error: d.exception?.description ?? d.text ?? "eval error" };
  }
  return { value: r.result?.value };
}

async function captureScreenshot(send, dest) {
  const data = await send("Page.captureScreenshot", { format: "png" });
  const abs = path.resolve(dest);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.from(data.data, "base64"));
  return abs;
}

/* ------------------------------------------------------------- slot process */

/**
 * Spawn the engine + Chrome for a slot and wait until both answer. Does NOT wait
 * for the app to mount — callers do that over a CDP socket they own, so a suite
 * can attach its console collector before the first line of app code runs.
 */
export async function spawnSlot(slot, { headful = false } = {}) {
  const { enginePort, debugPort, slotDir, url } = slotPorts(slot);
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

  if (!existsSync(ENGINE)) throw new Error(`engine not built: ${ENGINE}`);
  const eng = spawn(ENGINE, [
    "--port", String(enginePort), "--no-browser", "--driver", "null", "--ui-root", UI_ROOT,
  ], { env: { ...process.env, APPDATA: appdata }, detached: true, stdio: "ignore" });
  eng.unref();

  const chrome = CHROMES.find(existsSync);
  if (!chrome) throw new Error("no Chrome/Edge found");
  // --user-data-dir is NOT optional: without a distinct profile a second Chrome
  // hands off to the running instance and drops the debugging port silently.
  const br = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    ...(headful ? [] : ["--headless=new"]),
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    "--window-size=1600,1000",
    url,
  ], { detached: true, stdio: "ignore" });
  br.unref();

  await waitFor("engine", async () => (await fetch(`http://127.0.0.1:${enginePort}/`)).ok);
  await waitFor("chrome", async () => !!(await pageTarget(debugPort, enginePort)));
  return { slot, enginePort, debugPort, url, enginePid: eng.pid, chromePid: br.pid };
}

/** Kill whatever is holding this slot's ports. Safe to call on a dead slot. */
export async function stopSlot(slot, { purge = false } = {}) {
  const { enginePort, debugPort, slotDir } = slotPorts(slot);
  // Ask Chrome to close, then drop the engine on this slot's port.
  try { await fetch(`http://127.0.0.1:${debugPort}/json/close`).catch(() => {}); } catch { /* ignore */ }
  await new Promise((r) => {
    const k = spawn("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${debugPort}*' -or $_.CommandLine -like '*--port ${enginePort}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: "ignore" });
    k.on("exit", r);
  });
  if (purge) {
    // The dying processes may still hold handles for a moment.
    try { rmSync(slotDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* leftovers are tolerable */ }
  }
  return { slot, stopped: true };
}

/* ---------------------------------------------------------------- fixture */

/** 4 tracks + a MIDI clip with a melody + a 3s audio clip + a marker. Uses the
 *  page's own origin so the upload endpoint and the WS both come for free. */
function fixtureSource(enginePort) {
  return `(async () => {
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
    // Peaks are computed on a worker AFTER the upload replies, and the timeline asks
    // for them the moment it draws the clip — so a check that starts too early sees a
    // 404 ("no peaks for asset N") land in the console as a network-level error and
    // has no way to tell it from a real one. Block here until the file exists: one
    // 200 means the whole multi-lod file is on disk, so no later render can race it.
    const assetId = p.tracks.flatMap(t => t.clips || []).map(c => c.assetId).find(a => a != null);
    let peaks = 'no audio clip';
    if (assetId != null) {
      peaks = 'timeout';
      for (let i = 0; i < 100; i++) {
        const r = await fetch('/api/peaks/' + assetId + '?lod=0');
        if (r.ok) { peaks = 'ready after ' + (i * 100) + 'ms'; break; }
        await new Promise(r2 => setTimeout(r2, 100));
      }
    }
    return { upload: up.status, tracks: p.tracks.length, assetId, peaks,
             clips: p.tracks.reduce((n,t) => n + (t.clips||[]).length, 0) };
  })()`;
}

async function seedFixtureWith(send, enginePort) {
  const r = await evaluateRaw(send, fixtureSource(enginePort), { timeoutMs: 60000 });
  if (r.error) throw new Error("fixture failed: " + String(r.error).slice(0, 300));
  // Loud, not silent: a fixture whose peaks never arrived leaves every downstream check
  // racing a 404, which is the failure mode this wait exists to remove.
  if (r.value?.peaks === "timeout")
    throw new Error(`fixture: peaks for asset ${r.value.assetId} never became available (10s)`);
  return r.value;
}

/* ----------------------------------------------------------- console buffer */

/** Normalise the three ways Chrome reports trouble into one row. */
function consoleEntry(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    const frame = params.stackTrace?.callFrames?.[0];
    const text = (params.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.unserializableValue ?? a.type)))
      .join(" ");
    return { source: "console", level: params.type === "warning" ? "warning" : params.type, text,
             url: frame?.url, line: frame?.lineNumber };
  }
  if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails ?? {};
    return { source: "exception", level: "error",
             text: d.exception?.description ?? d.text ?? "uncaught exception",
             url: d.url, line: d.lineNumber };
  }
  if (method === "Log.entryAdded") {
    const e = params.entry ?? {};
    return { source: e.source ?? "log", level: e.level ?? "info", text: e.text ?? "", url: e.url, line: e.lineNumber };
  }
  return null;
}

/* -------------------------------------------------------------- engine link */

/** Persistent WS to the engine's protocol port, used by Slot.probe.
 *  Replies correlate on `replyTo` (there is no `id` on a reply) and the socket is
 *  flooded with event/meters at ~30 Hz, so everything without a replyTo is dropped. */
function engineLink(enginePort) {
  let ws = null;
  let opening = null;
  let seq = 1000;
  const pending = new Map();

  const connect = () => {
    if (ws && ws.readyState === 1) return Promise.resolve();
    if (opening) return opening;
    const sock = new WebSocket(`ws://127.0.0.1:${enginePort}/ws`);
    sock.onmessage = (m) => {
      let j;
      try { j = JSON.parse(m.data); } catch { return; }
      if (j.replyTo === undefined || !pending.has(j.replyTo)) return;
      const settle = pending.get(j.replyTo);
      pending.delete(j.replyTo);
      settle(j);
    };
    sock.onclose = () => {
      ws = null; opening = null;
      for (const settle of pending.values()) settle({ ok: false, error: { code: "ws_closed", message: "engine socket closed" } });
      pending.clear();
    };
    opening = new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Error("engine ws connect timeout")), 10000);
      sock.onopen = () => { clearTimeout(timer); ws = sock; ok(); };
      sock.onerror = () => { clearTimeout(timer); opening = null; no(new Error("engine ws failed")); };
    });
    return opening;
  };

  return {
    /** Send one protocol message and resolve with the whole reply envelope.
     *  Throws on `ok:false` unless `allowError` — a typo'd op should be loud. */
    async probe(type, payload = {}, { timeoutMs = 20000, allowError = false } = {}) {
      await connect();
      const id = ++seq;
      const reply = await new Promise((ok, no) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          no(new Error(`probe timeout: ${type}`));
        }, timeoutMs);
        pending.set(id, (j) => { clearTimeout(timer); ok(j); });
        ws.send(JSON.stringify({ id, type, payload }));
      });
      if (reply.ok === false && !allowError) {
        const e = reply.error ?? {};
        throw new Error(`probe ${type} failed: ${e.code ?? "error"} — ${e.message ?? ""}`);
      }
      return reply;
    },
    close() {
      try { ws?.close(); } catch { /* already gone */ }
      ws = null; opening = null;
    },
  };
}

/* ------------------------------------------------------------------ openSlot */

/**
 * Bring up a slot and return a Slot handle that drives it over ONE CDP socket.
 *
 * `fresh` (default) tears down anything already on the slot AND purges its
 * scratch dir first, so every run starts from a pristine Chrome profile and a
 * project-free APPDATA. Reusing them is a determinism trap: localStorage keeps
 * prefs/themes/layout presets and the engine can recover a previous run's
 * autosave — a slot that had been reused came up with someone else's project.
 *
 * Slot:
 *   s.eval(fnOrString, opts?)      -> JSON value; a page function is stringified,
 *                                     so it has NO closure over the check's scope.
 *   s.key("Control+Alt+1")         -> void  (trusted CDP Input)
 *   s.click(x, y, opts?)           -> void  ({ button:"left"|"right", clicks:n })
 *   s.drag([x,y], [x,y], steps?)   -> void
 *   s.shot(path)                   -> absolute path written
 *   s.probe(type, payload?, opts?) -> engine reply envelope { replyTo, ok, payload }
 *   s.reload()                     -> void, resolves once the app has remounted
 *                                     and reconnected; clears the console buffer
 *   s.until(label, asyncFn, opts?) -> poll a NODE-side predicate until truthy
 *   s.untilEval(label, fn, opts?)  -> poll a PAGE-side predicate until it is true
 *   s.console / s.consoleErrors() / s.clearConsole()
 *   s.close()                      -> disconnect AND kill the slot's processes
 *   s.detach()                     -> disconnect only, leave the slot running
 *   s.send(method, params)         -> raw CDP escape hatch
 *   s.slot / s.enginePort / s.debugPort / s.url
 */
export async function openSlot({ slot = 1, fixture = false, headful = false, fresh = true } = {}) {
  const ports = slotPorts(slot);
  if (fresh) await stopSlot(slot, { purge: true });
  const proc = await spawnSlot(slot, { headful });

  const consoleLog = [];
  const cdp = await openCdp(ports.debugPort, ports.enginePort, (method, params) => {
    // Fires the moment a navigation commits — the exact boundary between documents,
    // so a check never sees the previous page's noise.
    if (method === "Runtime.executionContextsCleared") { consoleLog.length = 0; return; }
    const e = consoleEntry(method, params);
    if (!e) return;
    consoleLog.push(e);
    if (consoleLog.length > 1000) consoleLog.shift();
  });
  // Enabled BEFORE the app mounts, so "no console errors on mount" can be honest.
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  const evalPage = async (code, opts) => {
    const r = await evaluateRaw(cdp.send, toExpression(code), opts);
    if (r.error) throw new Error(String(r.error));
    return r.value;
  };
  const until = (label, fn, { timeout = 15000, interval = 100 } = {}) => waitFor(label, fn, timeout, interval);
  const untilEval = (label, code, opts) => until(label, async () => (await evalPage(code)) === true, opts);

  await until("app mount", async () => (await evalPage(READY_JS)) === true, { timeout: 60000, interval: 300 });

  const link = engineLink(ports.enginePort);
  const fixtureResult = fixture ? await seedFixtureWith(cdp.send, ports.enginePort) : null;
  // Seeding is not evidence. The live page reacts to the fixture as it is built — the
  // timeline asks for waveform peaks the moment the upload lands, before the engine's
  // worker has written them, and that 404 is logged at error level. Hand the slot over
  // with an empty buffer so a check's console only ever holds what the check caused.
  consoleLog.length = 0;

  return {
    slot,
    enginePort: ports.enginePort,
    debugPort: ports.debugPort,
    url: ports.url,
    enginePid: proc.enginePid,
    chromePid: proc.chromePid,
    fixture: fixtureResult,

    console: consoleLog,
    consoleErrors: () => consoleLog.filter((e) => e.level === "error"),
    clearConsole: () => { consoleLog.length = 0; },

    send: cdp.send,
    eval: evalPage,
    key: (combo) => dispatchKey(cdp.send, combo),
    /** Type a literal string one trusted keystroke at a time. Shifted characters are
     *  sent as the real Shift+key a US layout would produce, not as bare text. */
    type: async (text) => {
      for (const ch of String(text)) {
        if (ch === " ") { await dispatchKey(cdp.send, "Space"); continue; }
        if (/[A-Z]/.test(ch)) { await dispatchKey(cdp.send, `Shift+${ch.toLowerCase()}`); continue; }
        const unshifted = Object.entries(SHIFTED).find(([, v]) => v === ch)?.[0];
        await dispatchKey(cdp.send, unshifted ? `Shift+${unshifted}` : ch);
      }
    },
    click: (x, y, opts) => dispatchClick(cdp.send, x, y, opts),
    drag: (from, to, steps) => dispatchDrag(cdp.send, from, to, steps),
    shot: (dest) => captureScreenshot(cdp.send, dest),
    probe: (type, payload, opts) => link.probe(type, payload, opts),
    until,
    untilEval,
    seedFixture: () => seedFixtureWith(cdp.send, ports.enginePort),

    async reload() {
      // A sentinel on the doomed document is the only reliable barrier: polling for
      // app-mounted right after Page.reload would match the OLD DOM and return early.
      await evalPage("window.__uiDriveReloading = 1; true");
      consoleLog.length = 0;
      await cdp.send("Page.reload", {});
      await until("app remount", async () => (await evalPage(READY_JS)) === true, { timeout: 60000, interval: 150 });
    },

    detach() { link.close(); cdp.close(); },
    async close() { link.close(); cdp.close(); await stopSlot(slot); },
  };
}

/* --------------------------------------------------------------------- CLI */

async function cli(argv) {
  const cmd = argv[0];
  const arg = (name, dflt = undefined) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const flag = (name) => argv.includes(`--${name}`);
  const slot = Number(arg("slot", "1"));
  const { enginePort, debugPort, url } = slotPorts(slot);
  const out = (o) => console.log(JSON.stringify(o));
  const die = (msg) => { out({ ok: false, error: msg }); process.exit(1); };
  const cdp = (fn) => cdpOnce(debugPort, enginePort, fn);

  switch (cmd) {
    case "up": {
      const proc = await spawnSlot(slot, { headful: flag("headful") });
      await cdp(async (send) =>
        waitFor("app mount", async () => (await evaluateRaw(send, MOUNTED_JS)).value === true),
      );
      if (flag("fixture")) await cdp((send) => seedFixtureWith(send, enginePort));
      return out({ ok: true, slot, enginePort, debugPort, url, enginePid: proc.enginePid, chromePid: proc.chromePid });
    }

    case "eval": {
      const file = arg("file");
      const code = file ? readFileSync(file, "utf8") : arg("code");
      if (!code) die("need --code or --file");
      const r = await cdp((send) => evaluateRaw(send, code));
      if (r.error) die(r.error);
      return out({ ok: true, value: r.value });
    }

    case "key": {
      const combo = arg("key");
      if (!combo) die("need --key");
      await cdp((send) => dispatchKey(send, combo));
      return out({ ok: true, key: combo });
    }

    case "click": {
      const x = Number(arg("x")), y = Number(arg("y"));
      const button = arg("button", "left");
      const clicks = Number(arg("clicks", "1"));
      await cdp((send) => dispatchClick(send, x, y, { button, clicks }));
      return out({ ok: true, x, y, button, clicks });
    }

    case "drag": {
      const [fx, fy] = String(arg("from", "0,0")).split(",").map(Number);
      const [tx, ty] = String(arg("to", "0,0")).split(",").map(Number);
      const steps = Number(arg("steps", "12"));
      await cdp((send) => dispatchDrag(send, [fx, fy], [tx, ty], steps));
      return out({ ok: true, from: [fx, fy], to: [tx, ty], steps });
    }

    case "shot": {
      const dest = arg("out", `slot${slot}.png`);
      const file = await cdp((send) => captureScreenshot(send, dest));
      return out({ ok: true, file });
    }

    case "fixture":
      return out({ ok: true, fixture: await cdp((send) => seedFixtureWith(send, enginePort)) });

    case "down": {
      await stopSlot(slot, { purge: flag("purge") });
      return out({ ok: true, slot, stopped: true });
    }

    default:
      return die(`unknown command "${cmd}" — up|eval|key|click|drag|shot|fixture|down`);
  }
}

// Only act as a CLI when run as one; importing this file must have no side effects.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cli(process.argv.slice(2)).catch((e) => {
    console.log(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
    process.exit(1);
  });
}
