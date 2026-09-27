#!/usr/bin/env node
// v0.2 live validation helper (run by the maintainer, never by tests or CI):
//   node scripts/v02-live-fixture.mjs create <empty-dir>   writes the synthetic Home Assistant folder (no Git) and records its digest
//   node scripts/v02-live-fixture.mjs verify <dir>         recomputes the digest: UNCHANGED (exit 0) or CHANGED (exit 1)
// It needs `npm run build` first (it reuses the offline test fixture from dist/). It starts no provider and no Fusion command.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [command, target] = process.argv.slice(2);
if ((command !== "create" && command !== "verify") || target === undefined) {
  process.stderr.write("Usage: node scripts/v02-live-fixture.mjs create|verify <dir>\n");
  process.exit(2);
}
const dir = resolve(target);
const root = join(dir, "homeassistant");
const record = join(dir, "homeassistant.sha256");

async function digest(folder) {
  const hash = createHash("sha256");
  const entries = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .map(entry => ({ entry, rel: relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/") }))
    .sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  for (const { entry, rel } of entries) {
    if (entry.isFile()) hash.update(`F ${rel} ${createHash("sha256").update(await readFile(join(entry.parentPath, entry.name))).digest("hex")}\n`);
    else hash.update(`${entry.isDirectory() ? "D" : "X"} ${rel}\n`);
  }
  return hash.digest("hex");
}

if (command === "create") {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) { process.stderr.write(`Refusing: ${dir} is not empty.\n`); process.exit(2); }
  const fixture = pathToFileURL(resolve("dist", "test", "fixtures", "home-assistant.js")).href;
  const { createHomeAssistantFixture } = await import(fixture);
  await createHomeAssistantFixture(dir);
  const value = await digest(root);
  await writeFile(record, `${value}\n`);
  process.stdout.write(`Created ${root} (no Git)\nDigest: ${value}\n`);
} else {
  const expected = (await readFile(record, "utf8")).trim();
  const actual = await digest(root);
  process.stdout.write(`${actual === expected ? "UNCHANGED" : "CHANGED"} ${root}\nexpected ${expected}\nactual   ${actual}\n`);
  process.exit(actual === expected ? 0 : 1);
}
