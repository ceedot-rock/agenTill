/**
 * agentill / sandbox/e2e.js
 *
 * SANDBOX END-TO-END (test plan stage 2).
 *
 * A tiny fake store (3 products) with the box dropped in. A scripted buyer
 * agent runs all four operations; the sandbox merchant "captures payment"
 * in its own submitOrder (the box never touches money itself). Then the two
 * refusal paths: broken settings -> preflight refuses; seal without buyer
 * confirmation -> refused.
 *
 * Run: node sandbox/e2e.js   (exit 0 = all green)
 */
import { createBox } from '../server/middleware.js';
import { KNOWN_SCOPES, recomputeTotals } from '../core/gates.js';

const SECRET = 'sandbox-secret';
let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};

/* ---------------- fake store: 3 products ---------------- */

const CATALOG = [
    { id: 'day-pass', title: 'PCC Day Pass', priceMinor: 900 },   // $9.00
    { id: 'pro-month', title: 'PCC Pro Month', priceMinor: 3900 }, // $39.00
    { id: 'year-pass', title: 'PCC Year Pass', priceMinor: 39000 }, // $390.00
];

const capturedPayments = []; // the merchant's own payment ledger

function freshCart() {
    return {
        status: 'cart',
        items: [],
        currency: 'USD',
        address: null,
        shippingMethod: null,
        paymentMethod: null,
        discount: null,
        buyerConfirmed: false,
        totals: null,
    };
}

let checkout = freshCart();
let orderSeq = 5000;

const adapter = {
    getState: () => JSON.parse(JSON.stringify(checkout)),
    applyPatch: (patch) => {
        if (patch && patch.__agentill_probe) return adapter.getState();
        checkout = { ...checkout, ...patch };
        // the merchant's OWN totals math (the box verifies, never replaces)
        const t = recomputeTotals(checkout, { taxRateBps: 0 });
        if (t.ok) checkout.totals = t.totals;
        return adapter.getState();
    },
    getConfig: () => ({ currency: 'USD' }),
    describeSubmit: () => ({ bindings: 1 }),
    getCatalog: () => CATALOG.map((c) => ({ ...c })),
    submitOrder: (state) => {
        // THE MERCHANT'S OWN payment capture: the box never charges cards.
        const total = (state.totals && state.totals.totalMinor) ?? 0;
        capturedPayments.push({
            orderId: `ord_${++orderSeq}`,
            amountMinor: total,
            currency: 'USD',
            paymentMethod: state.paymentMethod,
        });
        const order = { ...state, orderId: `ord_${orderSeq}`, status: 'submitted' };
        checkout = freshCart();
        return order;
    },
};

const settings = {
    merchantId: 'sandbox-store',
    identity: { adapter: 'open' },          // generalized default: any agent
    catalog: { type: 'inline', items: CATALOG },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'sandbox://tax/0pct' },
    shipping: { provider: 'manual', configPointer: 'sandbox://shipping/digital' },
    paymentRails: [{ rail: 'manual' }],    // merchant's own payment
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 100000, perDayMinor: 500000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 0,
    // no settings.tolls -> per-call tolls off
};

const credential = { agentId: 'sandbox-buyer-agent', scopes: KNOWN_SCOPES };

/* ---------------- the run ---------------- */

console.log('== agentill sandbox end-to-end ==\n');

// 1. pre-flight
const box = createBox({ settings, adapter, secrets: { serverSecret: SECRET } });
const pf = await box.preflight();
check('pre-flight activates clean', pf.ok === true, `${(pf.checks || []).length} dry-run checks passed`);
if (!pf.ok) { console.log(JSON.stringify(pf.errors, null, 2)); process.exit(1); }

// 2. browse_catalog
const browse = await box.invokeTool({ tool: 'browse_catalog', args: { query: 'day' }, credential });
check('browse_catalog finds the Day Pass', browse.status === 200 && browse.body.ok && browse.body.result.results.length === 1 && browse.body.result.results[0].id === 'day-pass',
    `${browse.body.result.results.length} result(s), priceMinor=${browse.body.result.results[0]?.priceMinor}`);

// 3. read_checkout
const read = await box.invokeTool({ tool: 'read_checkout', args: {}, credential });
check('read_checkout returns the shared cart', read.status === 200 && read.body.ok && read.body.result.checkout.status === 'cart');

// 4. amend_checkout: add the Day Pass + buyer details (buyer confirms)
const amend1 = await box.invokeTool({
    tool: 'amend_checkout',
    args: { patch: { items: [{ id: 'day-pass', title: 'PCC Day Pass', qty: 1, priceMinor: 900 }] } },
    credential, buyerSessionId: 'buyer-sandbox-1',
});
check('amend_checkout (items) asks buyer first', amend1.body.status === 'confirmation_required');
{
    const c = amend1.body.confirmation;
    const amend1b = await box.invokeTool({
        tool: 'amend_checkout',
        args: { patch: { items: [{ id: 'day-pass', title: 'PCC Day Pass', qty: 1, priceMinor: 900 }] } },
        credential, buyerSessionId: 'buyer-sandbox-1',
        buyerConfirmation: { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'buyer-sandbox-1', approved: true },
    });
    check('amend_checkout (items) applies after buyer approval', amend1b.status === 200 && amend1b.body.ok === true);
}

const amend2 = await box.invokeTool({
    tool: 'amend_checkout',
    args: { patch: { address: 'buyer@example.com', shippingMethod: 'digital', paymentMethod: 'card_sandbox_visa' } },
    credential, buyerSessionId: 'buyer-sandbox-1',
});
check('amend_checkout (address+shipping+payment) asks buyer first', amend2.body.status === 'confirmation_required');
{
    const c = amend2.body.confirmation;
    const amend2b = await box.invokeTool({
        tool: 'amend_checkout',
        args: { patch: { address: 'buyer@example.com', shippingMethod: 'digital', paymentMethod: 'card_sandbox_visa' } },
        credential, buyerSessionId: 'buyer-sandbox-1',
        buyerConfirmation: { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'buyer-sandbox-1', approved: true },
    });
    check('amend_checkout (details) applies after buyer approval', amend2b.status === 200 && amend2b.body.ok === true,
        `totalMinor=${amend2b.body.result.totals?.totalMinor}`);
}

// 5. seal_order WITHOUT buyer confirmation -> refused
const sealNoConfirm = await box.invokeTool({ tool: 'seal_order', args: {}, credential, buyerSessionId: 'buyer-sandbox-1' });
check('REFUSAL: seal_order without buyer confirmation is refused', sealNoConfirm.body.status === 'confirmation_required',
    `got status=${sealNoConfirm.body.status}`);

// 6. seal_order WITH buyer confirmation -> submits through the merchant flow
const c = sealNoConfirm.body.confirmation;
const seal = await box.invokeTool({
    tool: 'seal_order', args: {}, credential, buyerSessionId: 'buyer-sandbox-1',
    buyerConfirmation: { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'buyer-sandbox-1', approved: true },
});
check('seal_order submits after buyer approval', seal.status === 200 && seal.body.ok === true && seal.body.result.orderId === 'ord_5001',
    `orderId=${seal.body.result.orderId}`);

// 7. payment landed in the merchant's own ledger
check('payment landed: $9.00 captured by the merchant', capturedPayments.length === 1 && capturedPayments[0].amountMinor === 900 && capturedPayments[0].currency === 'USD',
    `captured=${capturedPayments.length} payment(s), amountMinor=${capturedPayments[0]?.amountMinor}`);

// 8. tolls off by default
check('per-call tolls off (no settings.tolls)', seal.body.toll.charged === false);

// 9. signed snapshot verifies
const { verifySnapshot } = await import('../core/tokens.js');
let snapOk = false;
try {
    const snap = verifySnapshot(seal.body.snapshot, SECRET, { maxAgeSec: 3600 });
    snapOk = snap.tool === 'seal_order' && snap.agent_id === 'sandbox-buyer-agent' && snap.state.status === 'submitted';
} catch { snapOk = false; }
check('signed snapshot verifies and binds agent+tool+state', snapOk);

console.log('\n== refusal path: broken settings ==');
const badBox = createBox({
    settings: { ...settings, merchantId: 'broken-store', currency: 'US' }, // bad ISO code
    adapter, secrets: { serverSecret: SECRET },
});
const badPf = await badBox.preflight();
check('REFUSAL: pre-flight refuses broken settings', badPf.ok === false && badPf.stage === 'validate',
    `stage=${badPf.stage}, errors=${(badPf.errors || []).length}`);
const badInvoke = await badBox.invokeTool({ tool: 'browse_catalog', args: {}, credential });
check('REFUSAL: unactivated box serves nothing (503)', badInvoke.status === 503 && badInvoke.body.error.code === 'not_activated');

console.log(`\n== ${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'} ==`);
process.exit(failures === 0 ? 0 : 1);
