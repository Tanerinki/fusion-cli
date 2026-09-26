# O5.5C2.1 — Delivery store outside the target repository

Labels: **IMPLEMENTED + TESTED OFFLINE**. Only the store location changed. Inspect, approve and apply behave exactly as in O5.5C2, and the artifact, approval, event and apply-claim semantics are unchanged.

## The corrected trust boundary

O5.5C2 kept deliveries in `<target repository>/.fusion/deliveries`. That directory was ignored by Git and excluded from provider views, but it was still inside the tree a delivery writes to. Anything that operates on that tree could reach it:
- `git clean -x` deleted it;
- a copy of the directory carried it along;
- a process with access to the checkout could reach it.

From O5.5C2.1 on, **delivery state is Fusion's application state, outside every target repository**:

| Platform | Default base (production) | Fallback |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Fusion\deliveries` | `<home>\AppData\Local\Fusion\deliveries` |
| other | `$XDG_STATE_HOME/fusion/deliveries` | `<home>/.local/state/fusion/deliveries` |

The fallback is used when the variable is absent, empty or relative. On Windows it is also used when the value is not a drive path, for example a network share: delivery state never lives on a remote share. `LOCALAPPDATA` and `XDG_STATE_HOME` are the operating system's own conventions, not Fusion switches. No Fusion variable or configuration key names the store.

## Layout and namespace

```
<base>/<repository identity>/<delivery id>/{manifest.json, bundle.json, record.json, approval.json, events.jsonl, apply.claim}
```

- **Repository identity** is the SHA-256 of the repository's sorted root commits, the same identity the manifest binds. The namespace is never derived from a path, a directory name or a remote name. Delivery ids are validated as before, so there is no traversal.
- **Checkout binding.** The store record (version 2) binds the checkout the delivery was prepared in: the SHA-256 of that checkout's resolved, comparable root path, a digest never used as a path. Another checkout of the same repository (a clone has the same identity) finds the namespace but is refused ("prepared in another checkout", exit 2). This keeps the O5.5C2 behaviour, where a delivery was only visible from its own checkout. A moved checkout loses access to its deliveries (fail closed).
- **Misfiled deliveries.** A delivery copied into another repository's namespace is refused as corrupt ("filed under another repository", exit 4).
- **Manifest binding unchanged.** Every manifest still binds its repository identity, base commit and tree, and the precheck still checks them against the actual target.

## No redirection into the target

`openDeliveryNamespace` refuses any base that **overlaps the target repository** (SecurityViolation, exit 4). Overlap means the base is inside the repository, is the repository, or contains it.

The overlap check:
- resolves the base through links, following its longest existing prefix, so a junction outside the repository that points into it is caught;
- runs before any directory is created, and again after creation.

The refusal applies equally to the production default (a `LOCALAPPDATA` pointing into the repository), to the test seam, and to a link. The tests assert that nothing was created inside the repository.

**Test seam.** `ControlPlaneDeps.deliveryStoreRoot` injects a temporary base for tests. The CLI entry point never sets it, and the same overlap refusal applies to it.

## Guarantees kept from O5.5C2

- Write-once artifacts, the same id with other bytes refused, full revalidation on every read.
- Link and reparse refusal for the namespace and each delivery directory.
- Strict event order, the exclusive `apply.claim`, and the approval binding (id, manifest and bundle digests, repository identity, base commit).

The base directory itself is resolved once, so a profile folder that is itself redirected by the OS still works. Everything below it must be real directories.

## Tests (`test/o5-5c21-global-delivery-store.test.ts`; the O5.5C2 suite now runs against an injected root outside each primary)

| # | Covered |
|---|---|
| 1 | Default resolution per platform: `LOCALAPPDATA`, `XDG_STATE_HOME`, and fallbacks for absent, empty, relative, UNC and non-drive values. Without a seam, the CLI resolves the default from the environment (redirected into a temporary directory) and finds deliveries by id there. |
| 2 | Preparing creates no `.fusion` and no file in the repository: `git status --ignored` is unchanged. |
| 3 | Working-tree and baseline provider views of the repository contain no delivery artifact, and neither overlaps the store. |
| 4 | The store survives `git clean -fdx`, a checkout and the repository's deletion (byte-identical). A clone is refused. Another repository neither finds the delivery nor accepts a copied one. |
| 5 | An injected root is used, and deliveries are not visible from the default. A base inside, equal to or containing the repository is refused, as is a production variable or a junction pointing into it, with nothing created. |
| 6 | Invalid ids are refused. Namespace and delivery-directory junctions are refused (O5.5C2 store test 6). |
| 7 | The whole O5.5C2 suite (corruption, approval, concurrency, apply, gate) passes against the new location. |
