## Summary

What changed and why?

## Scope

- [ ] Core workflow/policy
- [ ] Process/runtime
- [ ] Workspace/verification
- [ ] Provider adapter
- [ ] Review/adjudication
- [ ] CLI/control plane
- [ ] Documentation only

## Invariants affected

List any security, workflow, provider-neutrality, or Writer-mode invariants touched by this change.

## Verification

```text
npm run typecheck:
npm run build:
npm test:
git diff --check:
```

## Tests

What regression/adversarial tests were added or changed?

## Provider / network activity

- Live provider calls:
- Network/account actions:
- Global configuration changes:

## Risks / follow-ups

List unresolved LOW/MEDIUM/HIGH risks.

## Writer-mode impact

- [ ] Does not change Writer readiness
- [ ] Changes Writer readiness

If changed, explain why the existing real-Writer gates remain safe.
