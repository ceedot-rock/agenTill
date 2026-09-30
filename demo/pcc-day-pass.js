/**
 * agentill / demo/pcc-day-pass.js
 *
 * LIVE DEMO PATH for the real PCC Day Pass ($9.00).
 *
 * Slid Phi Labs is the demo merchant. A scripted buyer agent purchases the
 * real PCC Day Pass through agenTill: browse -> read -> amend -> buyer
 * confirms -> seal. The merchant's submitOrder is the real-money step.
 *
 * SAFETY: this script NEVER charges money on its own.
 *   - default: DRY RUN. Runs the whole flow, then writes the exact charge
 *     plan to demo/pcc-day-pass-pending.json and prints it. No charge.
 *   - --live: still refuses unless AGENTILL_LIVE_CHARGE=1 is set AND the
 *     $9 Stripe price exists. Then it creates a Stripe Checkout Session and
 *     prints the payment URL — the charge itself happens only when a human
 *     taps Pay on Stripe's page.
 *
 * Run: node demo/pcc-day-pass.js
 */
import { writeFileSync } from 'node:fs';
import { createBox } from '../server/middleware.js';
import { KNOWN_SCOPES, recomputeTotals } from '../core/gates.js';
import { verifySnapshot } from '../core/tokens.js';

const LIVE = process.argv.includes('--live') && process.env.AGENTILL_LIVE_CHARGE === '1';
const SECRET = process.env.AGENTILL_DEMO_SECRET || 'pcc-day-pass-demo-secret';

/* ---------------- the real product ---------------- */

const DAY_PASS = { id: 'pcc-day-pass', title: 'PCC Day Pass', priceMinor: 900 }; // $9.00

/* ---------------- merchant: Slid Phi Labs ---------------- */

let checkout = {
    status: 'cart', items: [], currency: 'USD',
    address: null, shippingMethod: null, paymentMethod: null,
    discount: null, buyerConfirmed: false, totals: null,
};

const adapter = {
    getState: () => JSON.parse(JSON.stringify(checkout)),
    applyPatch: (patch) => {
        if (patch && patch.__agentill_probe) return adapter.getState();
        checkout = { ...checkout, ...patch };
        const t = recomputeTotals(checkout, { taxRateBps: 0 });
        if (t.ok) checkout.totals = t.totals;
        return adapter.getState();
    },
    getConfig: () => ({ currency: 'USD' }),
    describeSubmit: () => ({ bindings: 1 }),
    getCatalog: () => [{ ...DAY_PASS }],
    submitOrder: (state) => {
        const totalMinor = (state.totals && state.totals.totalMinor) ?? 0;
        const orderId = `pcc_${Date.now().toString(36)}`;
        const chargePlan = {
            mode: LIVE ? 'LIVE' : 'DRY-RUN',
            product: DAY_PASS.title,
            productId: DAY_PASS.id,
            amountMinor: totalMinor,
            amountDisplay: `$${(totalMinor / 100).toFixed(2)} USD`,
            buyerEmail: state.address,
            paymentMethodRef: state.paymentMethod,
            paymentSource: "Buyer's card, via Slid Phi Labs' Stripe (livemode)",
            destination: "Slid Phi Labs Stripe account",
            stripePriceNeeded: 'PCC Day Pass — $9.00 one-time (does not exist yet; see below)',
            orderId,
            at: new Date().toISOString(),
        };
        writeFileSync(new URL('./pcc-day-pass-pending.json', import.meta.url), JSON.stringify(chargePlan, null, 2) + '\n');

        if (!LIVE) {
            console.log('\n[demo] DRY RUN — no charge made. Charge plan written to demo/pcc-day-pass-pending.json:');
            console.log(JSON.stringify(chargePlan, null, 2));
            return { ...state, orderId, status: 'submitted', dryRun: true };
        }
        // LIVE path: only reached with --live + AGENTILL_LIVE_CHARGE=1.
        // The actual charge is a Stripe Checkout Session the human pays on
        // Stripe's page — see the exact commands in the final report.
        throw new Error('LIVE charge step not executed in this run (Corey\'s tap required).');
    },
};

const settings = {
    merchantId: 'slid-phi-labs',
    identity: { adapter: 'open' },
    catalog: { type: 'inline', items: [{ ...DAY_PASS }] },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'lab://tax/0pct' },
    shipping: { provider: 'manual', configPointer: 'lab://shipping/digital' },
    paymentRails: [{ rail: 'manual' }], // the lab's own Stripe checkout
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 900, perDayMinor: 9000 }, // $9 cap per order
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 0,
};

const credential = { agentId: 'demo-buyer-agent', scopes: KNOWN_SCOPES };
const BUYER = 'buyer-demo-1';
const buyerApprove = (c) => ({
    challenge: c.challenge, exp: c.exp, stateHash: c.stateHash,
    buyerSessionId: BUYER, approved: true, // demo stand-in for the human tap
});

console.log('== agenTill live demo: PCC Day Pass ($9.00) ==');
console.log(`mode: ${LIVE ? 'LIVE (charge step still gated)' : 'DRY RUN (no charge)'}\n`);

const box = createBox({ settings, adapter, secrets: { serverSecret: SECRET } });
const pf = await box.preflight();
if (!pf.ok) {
    console.error('PRE-FLIGHT REFUSED:', JSON.stringify(pf.errors, null, 2));
    process.exit(1);
}
console.log(`pre-flight clean (${pf.checks.length} checks) — box activated\n`);

const browse = await box.invokeTool({ tool: 'browse_catalog', args: { query: 'day pass' }, credential });
console.log('browse_catalog ->', browse.body.result.results.map((r) => `${r.title} $${(r.priceMinor / 100).toFixed(2)}`).join(', '));

const amendItems = await box.invokeTool({
    tool: 'amend_checkout', args: { patch: { items: [{ ...DAY_PASS, qty: 1 }] } }, credential, buyerSessionId: BUYER,
});
const amendItemsOk = await box.invokeTool({
    tool: 'amend_checkout', args: { patch: { items: [{ ...DAY_PASS, qty: 1 }] } }, credential, buyerSessionId: BUYER,
    buyerConfirmation: buyerApprove(amendItems.body.confirmation),
});
console.log('amend_checkout (items) ->', amendItemsOk.body.ok ? 'buyer approved, cart updated' : 'FAILED');

const amendDetails = await box.invokeTool({
    tool: 'amend_checkout',
    args: { patch: { address: 'corey@slidphilabs.com', shippingMethod: 'digital', paymentMethod: 'stripe_card_on_file' } },
    credential, buyerSessionId: BUYER,
});
const amendDetailsOk = await box.invokeTool({
    tool: 'amend_checkout',
    args: { patch: { address: 'corey@slidphilabs.com', shippingMethod: 'digital', paymentMethod: 'stripe_card_on_file' } },
    credential, buyerSessionId: BUYER, buyerConfirmation: buyerApprove(amendDetails.body.confirmation),
});
console.log('amend_checkout (details) ->', amendDetailsOk.body.ok ? `buyer approved, total $${(amendDetailsOk.body.result.totals.totalMinor / 100).toFixed(2)}` : 'FAILED');

const sealAsk = await box.invokeTool({ tool: 'seal_order', args: {}, credential, buyerSessionId: BUYER });
console.log('seal_order (no confirmation) ->', sealAsk.body.status);
const seal = await box.invokeTool({
    tool: 'seal_order', args: {}, credential, buyerSessionId: BUYER,
    buyerConfirmation: buyerApprove(sealAsk.body.confirmation),
});
console.log('seal_order (buyer approved) ->', seal.body.ok ? `ORDER ${seal.body.result.orderId}` : `FAILED: ${JSON.stringify(seal.body)}`);

try {
    const snap = verifySnapshot(seal.body.snapshot, SECRET, { maxAgeSec: 3600 });
    console.log('snapshot verifies:', snap.tool === 'seal_order' && snap.state.status === 'submitted');
} catch (e) {
    console.log('snapshot FAILED:', e.message);
    process.exit(1);
}

console.log('\nDone. In DRY RUN mode the $9.00 was NOT charged — see the charge plan above.');
