# Contributing to agenTill

Thanks for helping make online checkouts agent-buyable.

## Ground rules

- All money math is in integer minor units (cents). No floats, ever.
- The allow-list, confirmation rules, checkout state machine, and totals
  math are pure, deterministic functions — same inputs give the same
  outputs, and refusals are returned as answers, never crashes.
- The platform fee (currently 0.081% per order) is locked ON. Merchants
  cannot shut it off or redirect it — do not touch `core/platformFee.js`
  math without an explicit maintainer decision.
- No Slid Phi branding in the core. `core/`, `server/middleware.js`, and
  `sdk/agentill.js` stay brand-neutral.

## Quick checks

```sh
npm test   # node --test "tests/*.test.js" — 137 tests, must all pass
```

CI runs the full test suite on every pull request.

## Making a change

1. Change the smallest surface that fixes or adds the thing.
2. Add or update tests in `tests/` for any behavior change.
3. Run `npm test` — all tests must pass.
4. Run the demo once (`npm run demo`) if you touched the server or box,
   to make sure the store still boots and pre-flight is clean.
5. Open a pull request using the template.

## Reporting bugs

Use the bug report issue template. For anything money-moving, include
exact inputs (amounts, settings, adapter state) so the failure can be
reproduced byte-for-byte.

## Security

See SECURITY.md. Do not open a public issue for a security problem —
use GitHub's private vulnerability reporting instead.

## Licensing

agenTill is licensed under the Apache License 2.0 (see LICENSE).
By contributing you agree your contribution may be distributed under
that license.
