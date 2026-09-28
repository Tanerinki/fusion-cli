# Security model (v0.3)

Fusion drives AI model CLIs against a user's repository. Its security model assumes the models are capable, fallible and
steerable by the content they read — so they are treated as **untrusted proposal engines**, and every step that changes
anything is owned by Fusion or by the human.

## Trust hierarchy

```text
Deterministic Fusion observation  >  validated structured model output  >  model prose
```

A model saying that tests passed, that a file is safe or that a change is complete is a claim, never evidence. Only what
Fusion itself observes decides an outcome.

## Trust boundaries at a glance

| Boundary | Guarantee | Mechanism |
| --- | --- | --- |
| Provider sessions | Models cannot write the repository or run arbitrary commands | Read-only launch posture (read-only file tools; no write, shell or web tools; no approval escalation, no personal context, extensions quarantined), established by launch controls on validated runtime versions and re-checked before each turn; each session bound to a Fusion-owned, `.git`-free view |
| Model output | Nothing unvalidated is acted on | Strict JSON contracts (plan, change set, review, adjudication); anything malformed fails closed; untrusted packets are detached by structured clone before validation |
| Mutation | Only Fusion changes files, only in private candidates, only within the confirmed scope | Canonical change-set validation and host application with SHA-256 preconditions |
| Verification | Results come from Fusion's own run of the configured commands | Docker container per run: zero host mounts, `--network none`, all capabilities dropped, `no-new-privileges`, read-only root filesystem, unprivileged user, pinned image by digest |
| Review | Independent of the author | Fresh reviewer session on a copy of the verified candidate; no author transcript or reasoning |
| Delivery | The human approves exact bytes, for one checkout, once | Immutable manifest and bundle outside the repository; typed digest approval; precheck; single-use claim; journaled rollback |
| Evidence | No secrets or model reasoning at rest | Bounded, redacted records; forbidden raw fields refused |

## Provider sessions

- Every provider process starts in a Fusion-owned view: a copy of the baseline, of the candidate, or of the working tree
  for conversations — without `.git` and without provider state paths. Adapters refuse the primary checkout as a working
  directory.
- The primary checkout's fingerprint (Git state, tracked and untracked files, and a bounded monitor of ignored and
  protected paths such as `.env`) is held to its first observation around every turn; each view must stay equal to its
  identity. A change fails the run.
- Launch posture is capability-checked per binding and per runtime version; unknown capability state is never treated as
  safe.

### Billing and authentication

Provider override variables can change the billing or authentication lane, so credential lanes are checked in two stages.
Before a process starts, Fusion classifies the environment by variable names only; it never inspects credential values:

- Claude has two recognized subscription lanes: the interactive login (`subscription`) and the `CLAUDE_CODE_OAUTH_TOKEN`
  produced by `claude setup-token` (`subscriptionToken`).
- Any API key, gateway token, base URL, Bedrock/Vertex/Foundry route, unrecognized provider variable, or settings API-key
  helper or env override refuses the whole environment. A token never coexists with such a source; Fusion refuses rather
  than choosing.

After spawn and before any turn is trusted, the adapter reads the lane back: the token lane must report an OAuth-token
first-party login, and the session must report no API-key credential source. Anything else fails closed. The token value is
forwarded only to the provider child and never appears in diagnostics, errors, events or artifacts. There is no API-key
fallback.

## Conversational turns and sensitive input (v0.2)

- **The host grants, not the model.** The shell classifies every line itself; its intent kind — never the text or a model
  reply — decides whether a turn may run providers (read-only only) and whether it may enter the confirmed Writer route.
  Requests to skip safety steps are refused. A model can only propose a task in words; the human starts it.
- **Sensitive input.** Every provider view passes the same policy: credentials, key material, authentication stores,
  databases, binaries and oversized files are withheld; `secrets.yaml` and `.env` keep key names only; secret values in
  other text files are masked with numbered markers. A build never writes a protected file; a masked value inside an
  editable file is restored by Fusion, exactly, before the change is applied, verified or delivered.
- **Not an OS sandbox.** Provider processes run under the host user's account. Views remove the primary as a working
  directory and detect changes; they do not make other paths unreachable to a process.

## Adaptive orchestration (v0.3)

- **A routing decision is a proposal.** The lead's choice of the next step (answer, delegate investigations,
  synthesize, stop) is one closed JSON object, read strictly against what the host allows at that moment: the actions of
  that state, the closed list of inventory areas, and the investigation count the budget leaves.
  - There is no field for a path, a partner, a tool, a permission, a budget or a write.
  - A decision with any other field, an unknown action, an unknown or **withheld** area, or too many investigations is
    refused. Fusion's own bounded choice replaces it.
- **Budgets are the host's.** Concurrency, batches, investigations, repeats, lead, reviewer and total model turns, and
  time have conservative defaults under hard caps. Every turn is reserved before it starts, and the route stops honestly
  when a budget runs out. No model reply can change a budget.
- **Parallel turns are isolated.** Each investigation has its own view copy and its own fresh session, and receives only
  its packet: no lead reasoning, no other explorer's report, no transcript.
  - Each copy is the already filtered view: nothing the input policy withheld or masked can reappear.
  - A write into any copy, or a change of the primary, stops the whole route: siblings are aborted, every copy is
    removed, and the conversation is closed.
- **Reports are data.** An explorer's report is a bounded, closed structure. Its cited paths count only when the host
  finds them in the shared copy, and its text reaches the lead marked as untrusted.
- **Security gates are never downgraded.** An explorer binding whose read-only posture is not proven is never used. A
  failed posture or authentication check fails that turn and is never repeated. Adaptive routing reaches the Writer route
  only through the same human-confirmed change request as before.

## Host-controlled changes

The Change Author's reply is a proposal: a canonical change set of 1–32 `writeText`/`delete` operations on explicit
repository-relative paths within the confirmed scope, each with the SHA-256 of the file it expects (or `null` for a new
file), at most 1 MiB per file and 4 MiB in total. Validation refuses extra properties, duplicate or case-colliding targets,
traversal, drive/UNC/device/alternate-stream forms, `.git`, reserved Windows names, symlinks and junctions. Fusion applies a
valid change set to a fresh private candidate and re-checks every precondition immediately before each write. There are no
shell, Git or rename operations. Details: [host-controlled changes](host-controlled-changes.md).

The scope itself is fixed before any role runs: the human gives it with `--path`, or the Lead proposes it in one read-only
turn and Fusion checks it (canonical files only; never `.git`, `.fusion`, lock files or `.env`) before showing it for
confirmation.

## Confined verification

A Writer build is verified only by the confined Docker backend, under an acceptance Fusion grants itself after checking the
daemon, the pinned image and the container's observed properties. Without that acceptance — no Docker, a missing image,
an unsupported platform (`windows-required`, `unknown`) or no confined plan — the build is refused **before any model
turn**. The verification container receives the candidate's files over standard input (no host mounts), runs only the
configured read-only commands with an absolute executable inside the image, and returns results on standard output.

The `npm-lockfile` dependency lane installs the locked packages in a separate preparation container (registry-only packages
with integrity digests, no lifecycle scripts) that has network access for that purpose; its output is an immutable
artifact handed to the verification container. A change that touches a dependency manifest stops for a human decision.

## Review and adjudication

The Reviewer is a fresh session over a copy of the verified candidate; it receives bounded review evidence, never the
Change Author's transcript or reasoning. Its findings are strictly structured and bounded. The Lead adjudicates each
finding (confirmed, partial, rejected, unverifiable); Fusion's own evidence outranks a model assertion. Retries and
corrections are bounded (one verification retry, one review-driven correction); beyond that the run stops for a decision.

## Delivery, approval and apply

- **Immutable delivery.** A delivery is a canonical manifest (identities, exact paths, before/after digests, evidence
  digests, safety policy; no provider text) and a bundle of the exact validated bytes. Both are written once (temporary
  file, `fsync`, exclusive link) and revalidated on every read; a corrupt or tampered delivery is never used.
- **Outside the repository.** The store lives in Fusion's application state (`%LOCALAPPDATA%\Fusion\deliveries` or
  `$XDG_STATE_HOME/fusion/deliveries`), namespaced by repository identity (a digest of the root commits). A store location
  that overlaps the repository — resolved through links — is refused.
- **Bound approval.** Approval requires a human at an interactive terminal typing the full manifest SHA-256. It binds the
  delivery id, the manifest and bundle digests, the repository identity, the base commit and the checkout. Another
  checkout or a same-content clone cannot use it.
- **Precheck before any write.** `fusion apply` re-derives the approval, then prechecks without writing: repository
  identity, HEAD and tree; a clean working tree (no staged, unstaged or untracked change); no Git filter drivers; every
  touched path contained, reached through real directories, not ignored, and exactly its expected preimage (never a link
  or reparse point). A failed precheck writes nothing and keeps the approval.
- **Single-use claim.** Only after a passing precheck does Fusion take the mutation claim (an exclusive, bound marker),
  immediately before the first write. From then on the approval is spent, whatever follows: no replay, not even after a
  rollback.
- **Apply and rollback.** Post-images are staged in Fusion-owned space inside the repository's Git directory and verified;
  each operation re-checks its precondition right before it runs (create by exclusive link, update by backup then
  rename, delete by moving to backup); a postcheck confirms every touched path and an unchanged HEAD. A failure after the
  first write restores every file from its backup in reverse order and verifies it. This is a journaled, verified
  rollback — not a multi-file transaction: if the whole process dies between two operations, the journal and backups remain
  for manual recovery; there is no automatic crash recovery yet.
- **No bypass.** There is no `--force`, `--yes`, environment variable or configuration key that skips the confirmation,
  the approval, the checkout binding, the precheck or the claim. Tests pin this.

## Evidence and redaction

- Run evidence records bounded metadata: outcomes, transitions, risk, review and adjudication labels and counts,
  model-turn provenance (requested and observed provider and model), the human's task (bounded, redacted) and — when a
  role asked for a decision — a bounded, structured decision request (at most five questions, one line each, redacted).
- It never records provider transcripts, hidden reasoning, plan summaries, environment dumps, auth responses or
  credentials; the artifact store refuses raw fields such as `transcript`, `messages`, `env` or `headers`, and every stored
  value passes a credential-shape redactor.
- Conversations (`chat`, `analyze`) are not recorded at all.
- Redaction is defense in depth, not permission to store sensitive material.

## Git safety

On your repositories Fusion performs no destructive or outward Git operation: no commit (except the baseline commit
`fusion create` writes in the new project it creates), no push or force-push, reset, clean, stash, merge, rebase, tag or
worktree pruning. The applier runs only read-only Git commands, with hooks and fsmonitor disabled. (Fusion's own private
candidates are clones in Fusion-owned temporary space, removed after each run.)

## What remains out of scope

The Writer route is **human-confirmed and host-controlled**, and it is live-validated for the supported scope. That is
not unrestricted autonomous Writer mode:

- **Unattended Writer mode is not enabled.** No configuration, flag or model output can start a Writer build without the
  human's confirmation or apply a delivery without the human's typed approval. `REAL_WRITER_LIVE_GATE_AUTHORIZED` is a
  constant `false`.
- **Its readiness stays NO.** Several prerequisites for running without a human boundary are only partially met by design
  — for example primary-checkout protection and ignored-path monitoring are bounded (content hashes for sensitive and
  protected paths, metadata for other ignored files), and the dependency lane is restricted. Fusion relies on the human
  approval boundary instead of claiming those are complete.
- **The verifier is Linux-only.** Projects that must be verified on Windows are refused.
- **Provider vendors are trusted for their own infrastructure.** Fusion constrains what a provider process can do locally;
  it cannot audit what a vendor does with the context a session reads.

Reporting: [SECURITY.md](../SECURITY.md).
