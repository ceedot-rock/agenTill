> **This repo has moved into the verse.** Development continues at
> [ceedot-rock/WalletVerse](https://github.com/ceedot-rock/WalletVerse), in folder agenTill/.
> This copy is archived and read-only - history preserved, nothing lost.

# agenTill

[![Audited checks](https://github.com/ceedot-rock/agenTill/actions/workflows/audited-checks.yml/badge.svg)](https://github.com/ceedot-rock/agenTill/actions/workflows/audited-checks.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/agentill.svg)](https://www.npmjs.com/package/agentill)

Turn any online product into a storefront AI agents can buy from — with payment built in.

A merchant drops agenTill onto their existing checkout. Agents get four tools: browse the catalog, read the checkout, update the checkout, and seal the order. The merchant's own checkout flow stays exactly as it is — the box never replaces it. Every order still goes through the merchant's own payment, and nothing submits without the buyer's explicit approval. There is no way for an agent to buy anything on its own.

## What it does

- **Four agent tools over HTTP**, bound to the merchant's live checkout:
  - `browse_catalog` — search the product catalog. Read-only.
  - `read_checkout` — read the shared checkout (agent and buyer see the same cart). Read-only.
  - `amend_checkout` — change items, address, shipping, or discounts. The buyer approves anything that moves money.
  - `seal_order` — submit the order. The buyer always approves first. No exceptions.
- **Pre-flight gate.** The box checks the merchant's settings, then dry-runs against the existing checkout before activating. If anything looks off, it refuses to activate rather than half-working.
- **Buyer confirmation.** Money-moving actions pause for the buyer's explicit approval. Denying is always safe.
- **Agent identity, your choice.** Out of the box any agent can call (open mode). Merchants who want stronger identity can require signed credentials instead.
- **Exact decision paths.** The allow-list, confirmation rules, checkout state machine, and totals math are pure, deterministic functions — same inputs always give the same outputs, and refusals are returned as answers, never crashes.
- **Signed snapshots.** Every executed action seals the resulting state so it can't be tampered with or replayed.

## Drop it in (5 minutes)

**1. Add the script tag** to your checkout page — your form, your submit button, and your flow all stay:

```html
<script src="https://your-cdn/agentill.js"></script>
<script>
  AgenTill.init({ baseUrl: 'https://shop.example.com' });
  AgenTill.setCredential({ agentId: 'agent-1', scopes: ['read:catalog'] });
</script>
```

**2. Write the adapter** — four functions over the checkout you already have:

```js
const adapter = {
  getState:     () => myCheckoutStore.state,
  applyPatch:   (patch) => myCheckoutStore.patch(patch),
  getConfig:    () => ({ currency: 'USD' }),
  describeSubmit: () => ({ bindings: 1 }),
  getCatalog:   () => myCatalog,
  submitOrder:  (state) => myCheckoutStore.submit(state), // your EXISTING submit + payment
};
```

**3. Declare settings** (catalog, currency, payment rails, confirmation policy, spend caps) and **run pre-flight**:

```js
import { createBox } from 'agentill/server/middleware.js';
const box = createBox({ settings, adapter, secrets: { serverSecret } });
const report = await box.preflight();
if (!report.ok) throw new Error('box refused: ' + JSON.stringify(report.errors));
```

Pre-flight validates the settings and dry-runs against your live flow (no-op patch roundtrip, currency agreement, single submit binding, catalog reachability). Anything off → refusal, never a partial activation.

**4. Mount the middleware** next to your app (it only serves its own routes; everything else passes through):

```js
app.use(box.middleware()); // Express
```

**5. Done.** Agents discover the box at `/.well-known/agentill`. The buyer sees an approval prompt before anything submits. Your existing "Place order" button keeps working exactly as before.

## The agent flow

```
agent -> POST /agentill/tools/invoke { tool, args, credential }
  1. box activated?                        503 otherwise
  2. agent identity checks out?            401 / 403
  3. grant scopes (if the merchant uses them)  403
  4. merchant allow-list                   403
  5. per-call fee (only if the merchant set one) -> 402 when unpaid
  6. buyer confirmation                    -> "confirmation_required" (no challenge in-band;
                                              the buyer's browser fetches it from
                                              POST /agentill/confirm/challenge with its
                                              HttpOnly session cookie — an agent cannot)
  7. checkout rules                        -> 409 on illegal or incomplete checkouts
  8. your adapter applies the change / submits (YOUR flow, YOUR payment)
  9. signed snapshot of the new state
```

`seal_order` always requires buyer confirmation. There is no autonomous purchasing path: the approval challenge is issued only to the buyer's browser (HttpOnly session cookie), so an agent's plain HTTP client can never obtain one to self-approve with.

## Identity options

- **Open** (default): any agent can call; the agent asserts its own id. Buyer confirmation still guards every purchase.
- **Signed JWT**: require ES256-signed agent credentials. You supply the verification key and map your own claim names. A preset is included for Rider-style credentials (`agent_id` / `clearance` L0–L4) — one optional configuration, never required.

Raise per-tool trust levels with `settings.toolTrust` (e.g. `{ seal_order: 'verified' }`).

## Per-call fees (optional)

Off by default. Set `settings.tolls` to meter agent tool calls (e.g. 2¢ per catalog browse after a free quota). Charged calls return `402` with payment requirements on the `x402` rail; the agent pays, then retries. Receipts are deterministic.

## Pricing

**agenTill is free to use** (Apache-2.0). One visible platform fee applies:

- **0.081%** of each sealed order's merchandise value (subtotal minus discount), accruing to `0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c`.
- Locked on: 0.081% of every sealed order accrues to `0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c`. Visible in `/.well-known/agentill` discovery and inside every sealed order's signed snapshot — never a hidden skim — but not a merchant setting: there is no off switch and the recipient can't be redirected.
- **Fractional cents are never charged.** Fees accrue in integer microcents (BigInt rational math, no floats), rounded half-up at the sub-microcent level — at most 0.5 microcent per order over the exact 0.081% — in a per-merchant ledger and settle **monthly in whole cents** via a Stripe invoice from the lab. A $9.00 order accrues $0.00729 — it sits in the ledger until whole cents exist.
- Details: [docs/platform-fee-settlement.md](docs/platform-fee-settlement.md).

## Try it

```
npm test              # unit tests
node sandbox/e2e.js   # scripted buyer agent: full purchase + refusal paths
export AGENTILL_SERVER_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm run demo          # http://localhost:8471 — demo store + agent console
                      # (the demo refuses to boot without AGENTILL_SERVER_SECRET)
```

## What's not here (yet)

- On-chain payment verification for the x402 rail — the structure is checked; plug `hooks.verifySignature` for chain state.
- Persistent usage/snapshot stores — in-memory; merchants persist them in production.

## License

Apache-2.0

## From the same lab

- **AwLPay** — multi-rail agent payments (USDC x402 on Base and Solana, PayPal sandbox bridge): https://github.com/ceedot-rock/awlpay
- **ExactOdds** — provably-fair game math, byte-identical rules across five languages: https://github.com/ceedot-rock/exactodds
- **TNSSRC** — local lossless compression engine (Silesia 43,724,575 bytes, 12/12 decode+SHA verified): https://github.com/ceedot-rock/neural-pcc
- **pulsar** — free local best-path compressor (GPLv3 demo, not PCC): https://github.com/ceedot-rock/pulsar-best
- **TRUSTREAM** — lossless compression for live data streams in 4 KiB tiles: https://github.com/ceedot-rock/trustream
- **Chamber** — two-key JSON sealing for secrets: https://github.com/ceedot-rock/json-chamber-sdk
- Lab site: https://www.slidphilabs.com
