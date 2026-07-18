#!/usr/bin/env node
// generate-cpr-donor-header.mjs — regenerate engine/src/export/CprDonor.gen.h from the
// checked-in donor asset engine/assets/cpr-donor-c5.cpr (the Cubase 5.1.1 splice donor
// the .cpr writer pipeline is built on — the exact file scripts/cpr-write.mjs uses,
// docs/CPR_WRITER_M2_NOTES.md / M3 §"C++ port"). Embedding the donor as a byte array
// keeps the engine free of runtime asset resolution (and packaging) concerns.
//
// usage: node scripts/generate-cpr-donor-header.mjs [--check]

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = path.join(ROOT, "engine", "assets", "cpr-donor-c5.cpr");
const OUT = path.join(ROOT, "engine", "src", "export", "CprDonor.gen.h");
const CHECK = process.argv.includes("--check");

const bytes = fs.readFileSync(ASSET);
const sha = createHash("sha256").update(bytes).digest("hex");

const lines = [];
lines.push("// GENERATED FILE — do not edit. Regenerate with:");
lines.push("//   node scripts/generate-cpr-donor-header.mjs");
lines.push("// Source: engine/assets/cpr-donor-c5.cpr (Cubase 5.1.1 donor for the .cpr writer,");
lines.push("// docs/CPR_WRITER_M2_NOTES.md / CPR_WRITER_M3_NOTES.md §\"C++ port\").");
lines.push(`// sha256: ${sha}  (${bytes.length} bytes)`);
lines.push("");
lines.push("#pragma once");
lines.push("");
lines.push("#include <cstddef>");
lines.push("");
lines.push("namespace mydaw::cprdonor {");
lines.push("");
lines.push(`inline constexpr std::size_t kDonorC5Size = ${bytes.length};`);
lines.push("");
lines.push("inline constexpr unsigned char kDonorC5[kDonorC5Size] = {");
for (let i = 0; i < bytes.length; i += 16) {
  const row = [];
  for (let j = i; j < Math.min(i + 16, bytes.length); j++)
    row.push("0x" + bytes[j].toString(16).padStart(2, "0"));
  lines.push("    " + row.join(",") + ",");
}
lines.push("};");
lines.push("");
lines.push("} // namespace mydaw::cprdonor");
lines.push("");
const text = lines.join("\n");

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error("CprDonor.gen.h is stale — run: node scripts/generate-cpr-donor-header.mjs");
    process.exit(1);
  }
  console.log("CprDonor.gen.h up to date");
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${bytes.length} donor bytes, sha256 ${sha}`);
}
