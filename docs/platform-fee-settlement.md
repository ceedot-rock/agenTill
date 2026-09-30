# agenTill platform-fee settlement design (0.3.0)

## What the fee is

Every sealed order accrues a platform fee of **0.081%** of the order's
merchandise value (subtotal minus discount, integer minor units) to
the fee wallet `0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c`. The fee is locked — `settings.platformFee` rate/recipient overrides are ignored (only `ledgerFile`, the durable ledger path, is honored).
The fee is a visible setting, never a hidden skim: it appears in
`/.well-known/agentill` discovery, in every sealed order's signed snapshot,
and in the README pricing section.

## The one hard rule

**Fractional cents are NEVER charged.** The fee is computed exactly
(BigInt rational math, no floats) and tracked in integer microcents
(1e-6 of a currency unit) in a per-merchant ledger. A $9.00 order accrues
exactly 7290 microcents ($0.00729) — it sits in the ledger; nothing is
charged.

## Settlement: monthly Stripe invoice (recommended path)

Why a monthly invoice instead of per-order collection:

1. **The math demands it.** Most single orders accrue a fraction of a cent.
   There is nothing to charge until whole cents exist.
2. **One invoice per merchant per month** is the cheapest rail: a single
   Stripe invoice (or invoice item batch) instead of hundreds of
   sub-cent-intent payment attempts that Stripe would refuse anyway.
3. **The merchant already pays the lab this way** for other products, so
   no new money-movement plumbing is introduced in 0.3.0.

### Exact monthly flow

1. **Preview.** Run the settle CLI in preview mode (reads the ledger,
   computes floor-to-whole-cents per merchant, shows remainders):
   ```
   node ledger/settle.js --ledger ledger/data/platform-fees.json --preview
   ```
   Example output for a merchant with 200 × $9.00 orders:
   `{ "wholeCents": 145, "remainderMicrocents": 8000 }` → $1.45 due,
   $0.008 carries forward.

2. **Invoice.** In the lab's Stripe dashboard (or via the lab's `stripe.py`
   skill CLI — operator step, never automated in 0.3.0), create a **draft
   invoice** for the merchant for exactly the previewed whole cents, with
   a line item like `agenTill platform fee — September 2026 (0.081%)`.
   Finalize and collect it through the merchant's normal billing
   relationship with the lab.

3. **Mark settled.** Only after the invoice is PAID, mark it in the ledger:
   ```
   node ledger/settle.js --ledger ledger/data/platform-fees.json \
        --settle --merchant <merchantId> --cents 145 --invoice in_1ABCxyz
   ```
   The CLI refuses to settle more than the releasable whole cents and
   records the invoice id, so the ledger always reconciles to paid
   invoices. The sub-cent remainder stays accrued for next month.

### Worked example

- September: merchant seals 200 orders × $9.00 merchandise.
- Fee per order: 900 × 0.00081 = $0.00729 → 7290 microcents.
- Accrued: 200 × 7290 = 1,458,000 microcents = $1.458.
- Preview: wholeCents 145 ($1.45), remainder 8000 microcents ($0.008).
- Invoice the merchant $1.45; on payment, settle `--cents 145`.
- October starts with $0.008 already accrued.

## What settlement is NOT (0.3.0)

- Not automatic: no cron charges merchants; the lab operator runs the
  monthly flow. (A scheduled job can be added once Corey approves it.)
- Not per-order: Stripe has no sub-cent charges; the ledger exists
  precisely so we never attempt one.
- Not on-chain: USDC settlement rails remain for tolls; the platform fee
  settles in fiat via invoice, matching how merchants already pay the lab.

## Ledger durability

`ledger/data/platform-fees.json`, written atomically (tmp + rename).
Back it up with the merchant's other data — it is the money record.
Corrupt files fail LOUD at load (never silently reset), so a bad disk
blocks rather than loses accruals.

## Future options (not built)

- Auto-invoicing via Stripe's invoice API on the 1st of each month
  (needs Corey's approval for automated money movement).
- Merchant self-serve settlement portal.
- Per-order USDC settlement once per-order values routinely exceed
  whole cents (e.g. high-ticket merchants).
