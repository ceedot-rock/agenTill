/**
 * agentill / core/tolls.js
 *
 * Optional per-call metering for agent tool invocations.
 *
 * Design notes:
 *  - Prices are integer minor units (cents USD). No floats anywhere.
 *  - Receipt IDs are DETERMINISTIC (hash of canonical inputs) — no randomness,
 *    so receipts are reproducible and exactness-friendly.
 *  - Free quotas are evaluated by the pure function applyQuota(); the
 *    merchant supplies the usage store (usage = { "<agent>:<tool>:<period>": n }).
 *  - When a call costs > 0, the middleware converts the quote into x402
 *    PaymentRequirements via quoteToX402() (see tokens.js).
 */
import { createHash } from 'node:crypto';
import { canon } from './gates.js';
import { buildPaymentRequirements } from './tokens.js';

/** Default per-tool price table. Merchants override via settings.tolls. */
export const DEFAULT_TOLL_TABLE = {
    browse_catalog: { priceMinor: 2, freePerPeriod: 100, currency: 'USD' }, // $0.02
    read_checkout: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
    amend_checkout: { priceMinor: 1, freePerPeriod: 100, currency: 'USD' }, // $0.01
    seal_order: { priceMinor: 10, freePerPeriod: 0, currency: 'USD' }, // $0.10
};

const keyFor = (agentId, tool, periodId) => `${agentId}:${tool}:${periodId}`;

/**
 * Pure quota evaluation.
 * Returns { charged: bool, amountMinor, usedAfter } — charged=false means
 * the call falls inside the free quota.
 */
/* EXACT-GATE: toll.quota */
export function applyQuota({ tool, agentId, periodId, usage, tollTable = DEFAULT_TOLL_TABLE }) {
    const row = tollTable[tool];
    if (!row) return { charged: false, amountMinor: 0, usedAfter: 0, reason: `no toll row for ${tool}; treated as free` };
    const used = Math.trunc(Number((usage && usage[keyFor(agentId, tool, periodId)]) || 0));
    const usedAfter = used + 1;
    if (used < row.freePerPeriod) {
        return { charged: false, amountMinor: 0, usedAfter, reason: `within free quota (${used + 1}/${row.freePerPeriod})` };
    }
    return { charged: true, amountMinor: Math.trunc(row.priceMinor), usedAfter, reason: 'quota exhausted' };
}

/**
 * Issue a deterministic toll receipt. The receipt id is
 * sha256(canon({agent_id, tool, periodId, seq, amountMinor}))[:16] —
 * identical inputs always yield the identical receipt.
 */
export function issueReceipt({ agentId, tool, amountMinor, seq, periodId, currency = 'USD', nowSec = Math.floor(Date.now() / 1000) }) {
    const body = {
        agent_id: agentId,
        tool,
        amountMinor: Math.trunc(amountMinor),
        currency,
        seq: Math.trunc(seq),
        periodId,
        iat: nowSec,
    };
    const receipt_id = createHash('sha256').update(canon(body)).digest('hex').slice(0, 16);
    return { receipt_id, ...body };
}

/**
 * Convert a charged quote into x402 PaymentRequirements so the agent pays
 * over the x402 rail. amountAtomic is expressed in the rail asset's atomic
 * units; assetDecimals maps e.g. USDC -> 6.
 */
export function quoteToX402(quote, { network, payTo, asset, assetDecimals = 6, resource, description }) {
    if (!quote.charged || quote.amountMinor <= 0) return null;
    // minor USD cents -> atomic units of the asset (assumes 1:1 USD peg for USDC-style assets)
    const amountAtomic = (BigInt(quote.amountMinor) * 10n ** BigInt(assetDecimals)) / 100n;
    return buildPaymentRequirements({
        network,
        payTo,
        amountAtomic: amountAtomic.toString(),
        asset,
        resource,
        description: description || `toll for ${quote.tool || 'tool call'}`,
    });
}
