## Summary

What changed and why?

## Area

- [ ] Chat / Analyze
- [ ] Build / Create
- [ ] Delivery / Apply
- [ ] Verification / Docker
- [ ] Provider adapter
- [ ] Review / adjudication
- [ ] History / evidence
- [ ] CLI / config
- [ ] Documentation only

## Safety invariants touched

Which of these does the change touch, and how do they stay intact? (See CONTRIBUTING.md.)

- [ ] Provider neutrality
- [ ] Host-owned mutation (change sets, private candidates, confirmed scope)
- [ ] Read-only provider sessions and views
- [ ] Confined verification
- [ ] Human confirmation / delivery approval / precheck / single-use claim
- [ ] Evidence and redaction
- [ ] Git safety
- [ ] None

## Delivery / apply impact

Does this change what a delivery contains, how it is approved, or what `fusion apply` does? If yes, describe it.

## Evidence / redaction impact

Does anything new get recorded, printed or logged? Confirm that no provider transcripts, hidden reasoning or credentials
can reach evidence or output.

## Provider / network activity

- Live provider calls used while developing (never in `npm test`):
- Network or account actions:
- Global configuration changes:

## Verification

```text
npm run typecheck:
npm test:
git diff --check:
npm run smoke:pack (packaging changes):
```

What adversarial or regression tests were added or changed?

## Docs / CLI impact

- [ ] README, help text or docs updated for user-visible changes
- [ ] No user-visible change

## Risks / follow-ups
