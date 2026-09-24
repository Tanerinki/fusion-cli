import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { ownershipLabels } from "../src/platform/verification/docker/config.js";
import { ACTIVE_DOCKER_RUNS, LONGEST_RUN_MS, selectStaleOwnedContainers, sweepStaleContainers,
  type SweepCandidate } from "../src/platform/verification/docker/sweeper.js";
import { FakeDocker, type ExtraContainer } from "./fixtures/fake-docker.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const OLD = new Date(NOW - 3 * 3_600_000).toISOString(), YOUNG = new Date(NOW - 60_000).toISOString();
const MIN_AGE = 2 * 3_600_000;
const id = (char: string): string => char.repeat(64);
const run = (char: string): string => char.repeat(32);
const owned = (runChar: string, created = OLD): Record<string, string> => ({ ...ownershipLabels(run(runChar), created, "verify") });

test("O5.5B6 sweep selection: only complete Fusion ownership + staleness selects; everything else survives", () => {
  const candidates: SweepCandidate[] = [
    { id: id("1"), labels: { "com.docker.compose.project": "immich" }, running: false, created: OLD },           // unrelated
    { id: id("2"), labels: {}, running: false, created: OLD },                                                     // named fusion-*, no labels
    { id: id("3"), labels: { "fusion.owner": "true", "fusion.backend": "docker-linux" }, running: false, created: OLD }, // partial
    { id: id("4"), labels: { ...owned("a"), "fusion.backend": "other" }, running: false, created: OLD },           // wrong backend
    { id: id("5"), labels: { ...owned("a"), "fusion.run": "not-hex" }, running: false, created: OLD },             // malformed run
    { id: id("6"), labels: { ...owned("a"), "fusion.protocol": "9" }, running: false, created: OLD },              // unknown protocol
    { id: id("7"), labels: { ...owned("a"), "fusion.created": "yesterday" }, running: false, created: OLD },       // malformed time
    { id: id("8"), labels: owned("b"), running: false, created: OLD },                                              // stale, owned
    { id: id("9"), labels: owned("c", YOUNG), running: false, created: OLD },                                       // young label
    { id: id("a"), labels: owned("d"), running: true, created: YOUNG },                                             // young daemon time
    { id: id("b"), labels: owned("e"), running: true, created: OLD },                                               // live in this process
    { id: id("c"), labels: owned("f", new Date(NOW + 3_600_000).toISOString()), running: false, created: OLD },    // future label
    { id: "xyz", labels: owned("1"), running: false, created: OLD },                                                // short id
  ];
  const decisions = Object.fromEntries(selectStaleOwnedContainers(candidates, NOW, MIN_AGE, new Set([run("e")]))
    .map(entry => [entry.id.slice(0, 1), entry.decision]));
  assert.deepEqual(decisions, { 1: "foreign", 2: "foreign", 3: "foreign", 4: "foreign", 5: "foreign", 6: "foreign", 7: "foreign",
    8: "remove", 9: "young", a: "young", b: "live", c: "invalidTime", x: "foreign" });
  assert.equal(selectStaleOwnedContainers([candidates[12]!], NOW, MIN_AGE)[0]!.decision, "foreign");
  assert.throws(() => selectStaleOwnedContainers([], NOW, LONGEST_RUN_MS - 1), kind("InvalidInput"),
    "a threshold shorter than the longest run could sweep another live process's container");
  // The O5.5B5 prototype's protocol-1 containers are still recognised for crash recovery.
  assert.equal(selectStaleOwnedContainers([{ id: id("d"), labels: { ...owned("0"), "fusion.protocol": "1" }, running: false,
    created: OLD }], NOW, MIN_AGE)[0]!.decision, "remove");
});

const extras = (): ExtraContainer[] => [
  { id: id("1"), labels: { "com.docker.compose.project": "immich" }, created: OLD, alwaysListed: true },
  { id: id("2"), labels: {}, created: OLD, alwaysListed: true },
  { id: id("3"), labels: { "fusion.owner": "true", "fusion.backend": "docker-linux" }, created: OLD },
  { id: id("8"), labels: owned("b"), created: OLD },
  { id: id("9"), labels: owned("c", YOUNG), created: YOUNG },
  { id: id("b"), labels: owned("e"), created: OLD, running: true },
];

test("O5.5B6 sweep: removes only stale owned containers, is idempotent, and never runs prune or touches images/volumes", async () => {
  const fake = new FakeDocker({ extraListed: extras() });
  ACTIVE_DOCKER_RUNS.add(run("e"));
  try {
    const dry = await sweepStaleContainers(fake, { nowMs: NOW, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.removed, []);
    assert.equal(fake.commands("rm").length, 0, "a dry run removes nothing");
    const first = await sweepStaleContainers(fake, { nowMs: NOW });
    assert.equal(first.complete, true);
    assert.deepEqual(first.removed, [id("8")]);
    assert.deepEqual(fake.commands("rm").map(args => args.at(-1)), [id("8")]);
    const decisions = Object.fromEntries(first.selections.map(entry => [entry.id.slice(0, 1), entry.decision]));
    assert.deepEqual(decisions, { 1: "foreign", 2: "foreign", 3: "foreign", 8: "remove", 9: "young", b: "live" });
    const second = await sweepStaleContainers(fake, { nowMs: NOW });
    assert.deepEqual([second.complete, second.removed], [true, []], "idempotent");
    assert.equal(fake.calls.some(args => ["system", "volume", "network", "image", "rmi", "pull"].includes(args[0]!) &&
      !(args[0] === "image" && args[1] === "inspect")), false);
  } finally { ACTIVE_DOCKER_RUNS.delete(run("e")); }
});

test("O5.5B6 sweep: a removal that cannot be proven is reported as a failure, never as success", async () => {
  const fake = new FakeDocker({ extraListed: extras(), rmFails: true });
  const report = await sweepStaleContainers(fake, { nowMs: NOW, active: new Set([run("e")]) });
  assert.equal(report.complete, false);
  assert.deepEqual(report.failed, [id("8")]);
  assert.match(report.reasons.join(" "), /could not be proven removed/u);
  const down = new FakeDocker({ version: "noServer" });
  down.run = async () => ({ status: "exited", exitCode: 1, stdout: "", stderr: "daemon down", durationMs: 1 });
  assert.equal((await sweepStaleContainers(down, { nowMs: NOW })).complete, false, "an unreadable listing is not a clean sweep");
});

test("O5.5B6 sweep: re-checks ownership right before removal (labels changed after listing) and ignores malformed listings", async () => {
  const fake = new FakeDocker({ extraListed: [{ id: id("8"), labels: owned("b"), created: OLD }] });
  const original = fake.run.bind(fake);
  let inspections = 0;
  fake.run = async invocation => {
    if (invocation.args[0] === "ps") return { status: "exited", exitCode: 0, stdout: `${id("8")}\nnot-an-id\n`, stderr: "", durationMs: 1 };
    const outcome = await original(invocation);
    if (invocation.args.includes("{{json .Config.Labels}}") && ++inspections === 1)
      return { ...outcome, stdout: JSON.stringify({ "com.docker.compose.project": "relabelled" }) };
    return outcome;
  };
  const report = await sweepStaleContainers(fake, { nowMs: NOW });
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.failed, [id("8")]);
  assert.match(report.reasons.join(" "), /malformed ids/u);
});

test("O5.5B6 recovery is wired: the verification service sweeps each backend once before first use and reports it", async () => {
  const { mkdtemp, mkdir, rm, writeFile, utimes } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DockerLinuxVerificationBackend } = await import("../src/platform/verification/docker/backend.js");
  const { VerificationService } = await import("../src/platform/verification/selection.js");
  const { FAKE_DOCKER_EXE, FAKE_IMAGE } = await import("./fixtures/fake-docker.js");
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-recover-"));
  try {
    const candidate = join(root, "candidate");
    await mkdir(candidate);
    await writeFile(join(candidate, "package.json"), "{}");
    const store = join(root, "store");
    await mkdir(store);
    await writeFile(join(store, ".fusion-dependency-store"), "marker");
    const abandoned = join(store, `.staging-${"a".repeat(32)}`), fresh = join(store, `.staging-${"b".repeat(32)}`);
    await mkdir(abandoned); await mkdir(fresh);
    const past = new Date(Date.now() - 3 * 3_600_000);
    await utimes(abandoned, past, past);
    const fake = new FakeDocker({ extraListed: [{ id: id("8"), labels: owned("b", new Date(Date.now() - 3 * 3_600_000).toISOString()),
      created: new Date(Date.now() - 3 * 3_600_000).toISOString() }, { id: id("1"), labels: { "com.docker.compose.project": "x" } }] });
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: store });
    const service = new VerificationService([backend]);
    const request = { purpose: "autonomousWriter" as const, plan: { commands: [{ id: "t", executable: "/usr/local/bin/node", args: [],
      cwd: ".", timeoutMs: 1_000, mutationPolicy: "readOnly" as const }] }, workspaceRoot: candidate, git: {} as never, env: {},
      platformRequirement: "linux-compatible" };
    const first = await service.verify(request);
    assert.deepEqual(first.recovery, { complete: true, removed: 2, reasons: [] });
    assert.equal(existsSync(abandoned), false, "abandoned staging removed");
    assert.equal(existsSync(fresh), true, "a staging directory that may belong to a live preparation survives");
    assert.equal(fake.commands("rm").some(args => args.includes(id("1"))), false, "a foreign container survives");
    const second = await service.verify(request);
    assert.equal(second.recovery, undefined, "once per backend per service");
  } finally { await rm(root, { recursive: true, force: true }); }
});
