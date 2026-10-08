/**
 * agentill / server/demo-server.js
 *
 * Demo merchant + box wiring. This file is DEMO ONLY — the box itself is
 * server/middleware.js. Run:  npm run demo   (then open http://localhost:8471)
 *
 * Boot sequence mirrors a real merchant integration:
 *   1. merchant defines settings + adapter (their EXISTING checkout flow)
 *   2. box.preflight() runs validate + semantic + dry-run
 *   3. if anything is off, the process EXITS instead of activating
 *      (the box refuses to sit on a flow it cannot prove safe)
 *   4. only then does the HTTP server start serving the demo store
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBox } from './middleware.js';
import { KNOWN_SCOPES } from '../core/gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8471;

/* ---------------- merchant's EXISTING checkout flow ---------------- */

const CATALOG = [
    { id: 'p1', title: 'Canvas Backpack', priceMinor: 8900 },
    { id: 'p2', title: 'Trail Running Shoes', priceMinor: 12900 },
    { id: 'p3', title: 'Wool Beanie', priceMinor: 2400 },
];

const freshCart = () => ({
    status: 'cart',
    items: [{ id: 'p1', title: 'Canvas Backpack', qty: 1, priceMinor: 8900 }],
    currency: 'USD',
    address: null,
    shippingMethod: null,
    paymentMethod: null,
    discount: null,
    buyerConfirmed: false,
    totals: null,
    note: null,
});

let checkout = freshCart();
let orderSeq = 1000;

const adapter = {
    getState: () => JSON.parse(JSON.stringify(checkout)),
    applyPatch: (patch) => {
        if (patch && patch.__agentill_probe) return adapter.getState(); // pre-flight no-op probe
        checkout = { ...checkout, ...patch };
        return adapter.getState();
    },
    getConfig: () => ({ currency: 'USD' }),
    describeSubmit: () => ({ bindings: 1 }),
    getCatalog: () => CATALOG.map((c) => ({ ...c })),
    submitOrder: (state) => {
        const missing = [];
        if (!state.items || state.items.length === 0) missing.push('items');
        if (!state.address) missing.push('address');
        if (!state.shippingMethod) missing.push('shippingMethod');
        if (!state.paymentMethod) missing.push('paymentMethod');
        if (missing.length) throw new Error(`cannot submit: missing ${missing.join(', ')}`);
        const order = { ...state, orderId: `ord_${++orderSeq}`, status: 'submitted' };
        checkout = freshCart(); // the merchant's own post-purchase reset
        return order;
    },
};

/* ---------------- merchant's box settings (pre-flight input) ---------------- */

const settings = {
    merchantId: 'demo-store',
    identity: { adapter: 'open' }, // demo: any agent; production merchants can require signed JWTs
    catalog: { type: 'inline', items: CATALOG },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'demo://tax/8.75pct' },
    shipping: { provider: 'manual', configPointer: 'demo://shipping/flat-499' },
    paymentRails: [{ rail: 'manual' }], // demo: the merchant's own payment flow
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 50000, perDayMinor: 200000, perAgentMinor: 50000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 875,
    // demo: no per-call tolls (tolls are opt-in via settings.tolls)
    // platform fee: default 0.081% to Slid Phi Labs, durable JSON ledger
    platformFee: { ledgerFile: join(ROOT, 'ledger', 'data', 'platform-fees.json') },
};

/* ---------------- boot ---------------- */

// The box's signing secret. ENV-ONLY: the demo refuses to boot without one.
// Set it before every run/deploy:
//   export AGENTILL_SERVER_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
const serverSecret = process.env.AGENTILL_SERVER_SECRET;
if (!serverSecret) {
    console.error('[box] REFUSING TO BOOT: AGENTILL_SERVER_SECRET is not set.');
    console.error('[box] Generate a value and export it, e.g.:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('  export AGENTILL_SERVER_SECRET=<the value>');
    process.exit(1);
}

const box = createBox({
    settings,
    adapter,
    secrets: { serverSecret },
    hooks: {
        onSnapshot: (s) => console.log('[box] snapshot seq=%d tool=%s', s.snapshot.seq, s.snapshot.tool),
        onReceipt: (r) => console.log('[box] receipt %s %s %d', r.receipt_id, r.tool, r.amountMinor),
    },
});

const report = await box.preflight();
if (!report.ok) {
    console.error('\n[box] PRE-FLIGHT REFUSED ACTIVATION (stage: %s)', report.stage);
    for (const e of report.errors || []) console.error('  - [%s] %s', e.code, e.message);
    console.error('[box] Fix the settings/adapter and restart. The box will not sit on an unsafe flow.\n');
    process.exit(1);
}
console.log('[box] pre-flight clean — %d checks passed', (report.checks || []).length);

// demo agent credential (DEMO ONLY — production merchants choose their identity adapter)
const credential = { agentId: 'demo-agent-1', scopes: KNOWN_SCOPES };

/* ---------------- http ---------------- */

const boxHandler = box.middleware();

const FILES = {
    '/': { path: join(ROOT, 'demo', 'index.html'), type: 'text/html' },
    '/sdk/agentill.js': { path: join(ROOT, 'sdk', 'agentill.js'), type: 'text/javascript' },
    '/core/gates.js': { path: join(ROOT, 'core', 'gates.js'), type: 'text/javascript' },
};

function demoBuyer(body, res) {
    try {
        if (body.action === 'update') {
            const s = adapter.applyPatch(body.patch || {});
            return json(res, 200, { ok: true, state: s });
        }
        if (body.action === 'submit') {
            const order = adapter.submitOrder(adapter.getState());
            return json(res, 200, { ok: true, order });
        }
        return json(res, 400, { ok: false, error: 'unknown buyer action' });
    } catch (e) {
        return json(res, 409, { ok: false, error: e.message });
    }
}

function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// Buyer session: when the buyer's browser loads the checkout page, open a
// buyer session and set its token as an HttpOnly cookie. The box issues
// confirmation challenges only to callers presenting this cookie, which an
// agent's plain HTTP client can never present or read.
function serveCheckoutPage(res) {
    const sess = box.issueBuyerSession();
    res.writeHead(200, {
        'content-type': 'text/html',
        'Set-Cookie': `agentill_buyer=${sess.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    });
    res.end(readFileSync(FILES['/'].path));
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
        if (url.pathname === '/' && req.method === 'GET') return serveCheckoutPage(res);
        if (url.pathname === '/demo/state' && req.method === 'GET') return json(res, 200, { ok: true, state: adapter.getState() });
        if (url.pathname === '/demo/buyer' && req.method === 'POST') {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => demoBuyer(JSON.parse(data || '{}'), res));
            return;
        }
        if (url.pathname === '/demo/credential' && req.method === 'GET') {
            // DEMO ONLY: hands the page a credential so the agent console works
            return json(res, 200, { credential });
        }
        if (url.pathname === '/demo/preflight' && req.method === 'GET') {
            return json(res, 200, { ok: true, checks: report.checks });
        }
        const f = FILES[url.pathname];
        if (f && req.method === 'GET') {
            res.writeHead(200, { 'content-type': f.type });
            res.end(readFileSync(f.path));
            return;
        }
        if (url.pathname === '/.well-known/agentill' || url.pathname.startsWith('/agentill/')) {
            return boxHandler(req, res, () => json(res, 404, { ok: false }));
        }
        return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
    }
});

server.listen(PORT, () => {
    console.log(`[demo] merchant store + box live at http://localhost:${PORT}`);
    console.log('[demo] the "Place order" button is the EXISTING flow (no box needed); the Agent console is the box.');
});
