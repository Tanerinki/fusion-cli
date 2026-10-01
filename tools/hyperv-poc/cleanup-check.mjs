// Fusion v0.6 Hyper-V PoC — post-cleanup comparison (pure, unit-tested). Mechanically verifies that the host returned to
// its pre-state for the objects THIS PoC owns/affects, and that the non-PoC objects it never modified are unchanged. It
// deliberately does NOT assert global equality for state the PoC never touched (only the non-PoC Docker-network set).
//
// Input (gathered by cleanup.ps1 / inspect.ps1):
//   { prefix, endpointId, listenerPids:[int],
//     prestate:  { dockerNetworks:[name] },
//     poststate: { dockerNetworks:[name], containers:[name], images:[repo:tag], hnsEndpointIds:[id], alivePids:[int], pocAddresses:[ip] } }
// A name/id is "ours" iff it starts with `prefix` (networks/containers), equals the run image tag (images), equals the
// exact recorded endpoint id, or is a recorded listener pid / PoC address.

const isMine = (name, prefix) => typeof name === "string" && (name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}`));

export function compareCleanup(input) {
  const { prefix, runId, endpointId, listenerPids = [], prestate = {}, poststate = {} } = input ?? {};
  if (typeof prefix !== "string" || prefix.length === 0) return { ok: false, checks: {}, reasons: ["missing prefix"] };
  const post = {
    dockerNetworks: poststate.dockerNetworks ?? [], containers: poststate.containers ?? [], images: poststate.images ?? [],
    hnsEndpointIds: (poststate.hnsEndpointIds ?? []).map(x => String(x).replace(/[{}]/gu, "").toLowerCase()),
    alivePids: poststate.alivePids ?? [], pocAddresses: poststate.pocAddresses ?? [],
  };
  const preNonPoc = (prestate.dockerNetworks ?? []).filter(n => !isMine(n, prefix)).sort();
  const postNonPoc = post.dockerNetworks.filter(n => !isMine(n, prefix)).sort();
  const wantEp = endpointId ? String(endpointId).replace(/[{}]/gu, "").toLowerCase() : null;

  const checks = {
    noPocNetwork:            post.dockerNetworks.every(n => !isMine(n, prefix)),
    noPocContainer:          post.containers.every(n => !isMine(n, prefix)),
    noPocImage:              post.images.every(t => !isRunImage(t, runId)),
    listenersGone:           listenerPids.every(pid => !post.alivePids.includes(pid)),
    workerEndpointGone:      wantEp ? !post.hnsEndpointIds.includes(wantEp) : true,
    pocAddressGone:          post.pocAddresses.length === 0,
    nonPocNetworksUnchanged: preNonPoc.length === postNonPoc.length && preNonPoc.every((n, i) => n === postNonPoc[i]),
  };
  const reasons = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return { ok: reasons.length === 0, checks, reasons };
}

/** Whether a worker image tag belongs to this run (exact tag match), for the images check. */
export function isRunImage(tag, runId) {
  return typeof tag === "string" && tag === `fusion-hv-poc-img:${runId}`;
}

// CLI: node cleanup-check.mjs <inputJson>  → prints CLEANUP_OK=<bool> and any failing checks; exit 0 if ok else 2.
if (process.argv[2] && !process.argv[2].startsWith("--")) {
  const { readJsonFile } = await import("./json-io.mjs");
  let input;
  try { input = readJsonFile(process.argv[2]); }
  catch (e) { console.log("CLEANUP_OK=false"); console.error(String(e)); process.exit(2); }
  const r = compareCleanup(input);
  console.log(`CLEANUP_OK=${r.ok}`);
  for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v === true ? "ok " : "FAIL"} ${k}`);
  process.exit(r.ok ? 0 : 2);
}
