#!/usr/bin/env node
// v0.2 live validation helper (run by the maintainer; the offline tests only pin create-git/verify-git verdicts):
//   node scripts/v02-live-fixture.mjs create <empty-dir>       the synthetic Home Assistant folder (no Git); records its digest
//   node scripts/v02-live-fixture.mjs verify <dir>             recomputes the digest: UNCHANGED (exit 0) or CHANGED (exit 1)
//   node scripts/v02-live-fixture.mjs create-git <empty-dir>   v0.2.1: the same configuration as a Git repository with a
//                                                              confined check (everything tracked, secrets included)
//   node scripts/v02-live-fixture.mjs verify-git <dir>         after a live "fix it": the inline secret kept exactly, the
//                                                              protected files untouched, no redaction marker written
// It needs `npm run build` first (it reuses the offline test fixture from dist/). It starts no provider and no Fusion command,
// and it never prints a secret value.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [command, target] = process.argv.slice(2);
if (!["create", "verify", "create-git", "verify-git"].includes(command) || target === undefined) {
  process.stderr.write("Usage: node scripts/v02-live-fixture.mjs create|verify|create-git|verify-git <dir>\n");
  process.exit(2);
}
const dir = resolve(target);
const root = join(dir, "homeassistant");
const gitRoot = join(dir, "homeassistant-git");
const record = join(dir, "homeassistant.sha256");
const load = async path => import(pathToFileURL(resolve("dist", ...path.split("/"))).href);

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
async function empty(path) {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length > 0) { process.stderr.write(`Refusing: ${path} is not empty.\n`); process.exit(2); }
}
const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=Fusion live check", "-c", "user.email=fusion-live@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) { process.stderr.write(`git ${args[0]} failed: ${result.stderr}\n`); process.exit(1); }
  return result.stdout;
};
// The confined check of the live build: configuration.yaml has trusted_proxies and no Fusion redaction marker. It names no
// secret (fusion.config.json is ordinary source every provider may read).
const CHECK = "const t=require('fs').readFileSync('configuration.yaml','utf8');" +
  "if(!t.includes('trusted_proxies')){console.error('trusted_proxies missing');process.exit(1)}" +
  "if(t.includes('<redacted')){console.error('a redaction marker was written');process.exit(1)}console.log('configuration check passed')";

if (command === "create") {
  await empty(dir);
  const { createHomeAssistantFixture } = await load("test/fixtures/home-assistant.js");
  await createHomeAssistantFixture(dir);
  const value = await digest(root);
  await writeFile(record, `${value}\n`);
  process.stdout.write(`Created ${root} (no Git)\nDigest: ${value}\n`);
} else if (command === "verify") {
  const expected = (await readFile(record, "utf8")).trim();
  const actual = await digest(root);
  process.stdout.write(`${actual === expected ? "UNCHANGED" : "CHANGED"} ${root}\nexpected ${expected}\nactual   ${actual}\n`);
  process.exit(actual === expected ? 0 : 1);
} else if (command === "create-git") {
  await empty(dir);
  const { createHomeAssistantFixture } = await load("test/fixtures/home-assistant.js");
  const { defaultRegistry } = await load("src/providers/registry.js");
  const { parseConfig } = await load("src/app/config.js");
  await createHomeAssistantFixture(dir, "homeassistant-git");
  const config = parseConfig({ schemaVersion: 1, bindings: defaultRegistry().defaults.bindings,
    verification: { commands: [], platformRequirement: "linux-compatible", dependencies: "none",
      confinedCommands: [{ id: "configuration", executable: "/usr/local/bin/node", args: ["-e", CHECK], cwd: ".", timeoutMs: 120_000, mutationPolicy: "readOnly" }] },
    limits: { runTimeoutMs: 30 * 60_000 } });
  await writeFile(join(gitRoot, "fusion.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(gitRoot, ".gitignore"), "home-assistant_v2.db\n");
  git(gitRoot, "init", "-q");
  git(gitRoot, "add", "--all");
  git(gitRoot, "commit", "-q", "-m", "Home Assistant baseline (synthetic, secrets tracked on purpose)");
  process.stdout.write(`Created ${gitRoot} (Git baseline ${git(gitRoot, "rev-parse", "--short", "HEAD").trim()}; secrets.yaml and .storage/ are tracked on purpose)\n`);
} else {
  const { HA_FILES, HA_SENTINELS } = await load("test/fixtures/home-assistant.js");
  const checks = [];
  const check = (name, ok) => { checks.push(ok); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`); };
  const config = await readFile(join(gitRoot, "configuration.yaml"), "utf8");
  check("configuration.yaml keeps the real inline MQTT password, exactly once", config.split(HA_SENTINELS.inlinePassword).length === 2);
  check("configuration.yaml has trusted_proxies (the applied fix)", config.includes("trusted_proxies"));
  for (const path of ["secrets.yaml", ".storage/auth", ".storage/core.config_entries", "home-assistant.log"])
    check(`${path} is byte-identical to the fixture`, (await readFile(join(gitRoot, ...path.split("/")), "utf8")) === HA_FILES[path]);
  // A Fusion redaction marker as Fusion writes one: <redacted> or <redacted:kind:N>. (Not the bare text "<redacted": the
  // fixture's own fusion.config.json carries it in the confined check that looks for markers.)
  const MARKER = /<redacted(?::[A-Za-z0-9_-]+:\d+)?>/u;
  let marker = false;
  for (const entry of await readdir(gitRoot, { recursive: true, withFileTypes: true })) {
    const rel = relative(gitRoot, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (!entry.isFile() || rel.startsWith(".git/") || rel.startsWith(".fusion/") || rel.endsWith(".db")) continue;
    if (MARKER.test(await readFile(join(entry.parentPath, entry.name), "utf8"))) marker = true;
  }
  check("no file contains a Fusion redaction marker", !marker);
  const status = git(gitRoot, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).filter(line => !line.endsWith(".fusion/"));
  check("only configuration.yaml changed, uncommitted", status.length === 1 && status[0].endsWith("configuration.yaml"));
  check("no new commit", git(gitRoot, "rev-list", "--count", "HEAD").trim() === "1");
  process.stdout.write(`${checks.every(Boolean) ? "V0_2_1_LIVE_BUILD_PATH: PASS" : "V0_2_1_LIVE_BUILD_PATH: FAIL"}\n`);
  process.exit(checks.every(Boolean) ? 0 : 1);
}
