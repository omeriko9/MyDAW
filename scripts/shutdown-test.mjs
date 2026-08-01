#!/usr/bin/env node
/**
 * engine/shutdown test (SPEC §5.4) — File ▸ Exit's engine half.
 *
 *   node scripts/shutdown-test.mjs [--port 8576]
 *
 * Shipping v1.0.0 revealed the gap: a browser-UI DAW with no quit path — closing the
 * tab left the engine running forever, and the only "exit" was a process kill (which
 * leaves session.lock and triggers a bogus crash-recovery offer next launch).
 *
 * The contract, each leg able to fail independently:
 *   1. engine/shutdown replies ok BEFORE the process dies (the UI needs the ack).
 *   2. event/shutdown is broadcast (tabs flip to the goodbye screen on it).
 *   3. The process actually EXITS — within a few seconds, of its own accord.
 *   4. session.lock is GONE afterwards: a clean exit must never offer crash recovery.
 *      (Discriminates from a kill: a killed engine always leaves the lock behind.)
 */
import { spawnEngine, sleep } from "./lib/harness.mjs";
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8576"));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const e = await spawnEngine({ port: PORT });

try {
  await e.req("session/hello", { clientName: "shutdown" });
  // Make the session non-trivial so the teardown path has something to tear down.
  await e.req("cmd/track.add", { kind: "audio", name: "T" });
  await e.req("project/saveAs", { path: path.join(e.appdata, "S.mydaw") });

  const lock = path.join(e.appdata, "MyDAW", "session.lock");
  report("session.lock exists while running", existsSync(lock), lock);

  const exited = new Promise((res) => e.proc.on("exit", (code) => res(code)));

  const r = await e.req("engine/shutdown", {});
  report("engine/shutdown replies ok before dying", r.ok, JSON.stringify(r.error ?? ""));

  await sleep(150); // the broadcast races the reply by design; give it a beat
  report("event/shutdown was broadcast",
    e.events.some((ev) => ev.type === "event/shutdown"),
    `${e.events.length} events seen`);

  const code = await Promise.race([exited, sleep(6000).then(() => "TIMEOUT")]);
  report("the process exits on its own within 6 s", code !== "TIMEOUT", `exit code ${code}`);

  report("a CLEAN exit clears session.lock (no bogus recovery offer next launch)",
    !existsSync(lock));
} catch (err) {
  report("harness completed", false, err?.stack ?? String(err));
}

console.log(`\n${passed} passed, ${failed} failed`);
e.close(); // no-op kill on an already-exited process; removes the temp profile
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
