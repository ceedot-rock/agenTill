import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DEFAULT_PLATFORM_FEE,
    parseRate,
    resolvePlatformFee,
    computePlatformFeeMicrocents,
    wholeCentsDue,
    formatMicrocentsUSD,
    feeLineForSnapshot,
} from '../core/platformFee.js';
import { canon } from '../core/gates.js';
import { createPlatformFeeLedger, createMemoryPlatformFeeLedger } from '../ledger/platformFees.js';
import { createBox } from '../server/middleware.js';
import { verifySnapshot } from '../core/tokens.js';
import { KNOWN_SCOPES } from '../core/gates.js';

/* ---------- exact fee math ---------- */

describe('platform fee math (exact, no float drift)', () => {
    it('$9.00 order -> 7290 microcents ($0.00729)', () => {
        const r = computePlatformFeeMicrocents(900, '0.00081');
        assert.equal(r.ok, true);
        assert.equal(r.microcents, 7290);
    });

    it('$10,000 order -> 8,100,000 microcents ($8.10)', () => {
        const r = computePlatformFeeMicrocents(1_000_000, '0.00081');
        assert.equal(r.ok, true);
        assert.equal(r.microcents, 8_100_000);
    });

    it('rounds half-up at exact .5 microcent boundaries', () => {
        // 5 minor * 0.00007 = 3.5 microcents exactly -> rounds UP to 4
        const up = computePlatformFeeMicrocents(5, '0.00007');
        assert.equal(up.ok, true);
        assert.equal(up.microcents, 4);
        // $0.15 @ 0.081% = 121.5 microcents exactly -> 122
        const up2 = computePlatformFeeMicrocents(15, '0.00081');
        assert.equal(up2.ok, true);
        assert.equal(up2.microcents, 122);
    });

    it('rounds down just below .5', () => {
        // 5 minor * 0.000069 = 3.45 microcents -> 3
        const r = computePlatformFeeMicrocents(5, '0.000069');
        assert.equal(r.ok, true);
        assert.equal(r.microcents, 3);
    });

    it('no float drift across many small orders', () => {
        // 1000 x $0.01 orders: each is exactly 8.1 -> 8 microcents; float math
        // would smear 0.01*0.00081 across the accumulation
        let total = 0;
        for (let i = 0; i < 1000; i++) {
            const r = computePlatformFeeMicrocents(1, '0.00081');
            assert.equal(r.ok, true);
            total += r.microcents;
        }
        assert.equal(total, 8000);
    });

    it('deterministic: same inputs, byte-identical outputs', () => {
        const a = canon(computePlatformFeeMicrocents(900, '0.00081'));
        const b = canon(computePlatformFeeMicrocents(900, '0.00081'));
        assert.equal(a, b);
    });

    it('rejects bad totals and bad rates', () => {
        assert.equal(computePlatformFeeMicrocents(-5, '0.00081').ok, false);
        assert.equal(computePlatformFeeMicrocents(900, 'abc').ok, false);
        assert.equal(computePlatformFeeMicrocents(900, 1.5).ok, false);
        assert.equal(computePlatformFeeMicrocents(900, -0.1).ok, false);
        assert.equal(computePlatformFeeMicrocents(900, NaN).ok, false);
    });

    it('zero rate disables the fee exactly', () => {
        const r = computePlatformFeeMicrocents(900, 0);
        assert.equal(r.ok, true);
        assert.equal(r.microcents, 0);
    });

    it('accepts {num,den} rationals directly', () => {
        const r = computePlatformFeeMicrocents(900, { num: 81n, den: 100000n });
        assert.equal(r.ok, true);
        assert.equal(r.microcents, 7290);
    });
});

describe('parseRate', () => {
    it('parses decimals to exact rationals', () => {
        const p = parseRate('0.00081');
        assert.equal(p.ok, true);
        assert.equal(p.num, 81n);
        assert.equal(p.den, 100000n);
        assert.equal(p.rate, '0.00081');
    });
    it('accepts numbers, 0, and 1', () => {
        assert.equal(parseRate(0).ok, true);
        assert.equal(parseRate(1).ok, true);
        assert.equal(parseRate(0.01).num, 1n);
    });
    it('rejects out-of-range and malformed rates', () => {
        assert.equal(parseRate(-0.1).ok, false);
        assert.equal(parseRate(1.00001).ok, false);
        assert.equal(parseRate('abc').ok, false);
        assert.equal(parseRate('').ok, false);
        assert.equal(parseRate(null).ok, false);
        assert.equal(parseRate(NaN).ok, false);
    });
});

describe('resolvePlatformFee', () => {
    it('absent settings -> default 0.081% to fee wallet', () => {
        const r = resolvePlatformFee({});
        assert.equal(r.ok, true);
        assert.equal(r.fee.rate, DEFAULT_PLATFORM_FEE.rate);
        assert.equal(r.fee.recipient, '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c');
    });
    it('merchant override of rate/recipient is ignored (locked fee)', () => {
        const r = resolvePlatformFee({ platformFee: { rate: '0.01', recipient: 'Acme' } });
        assert.equal(r.ok, true);
        assert.equal(r.fee.rate, '0.00081');
        assert.equal(r.fee.recipient, '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c');
    });
    it('zero rate does not disable the fee', () => {
        const r = resolvePlatformFee({ platformFee: { rate: '0' } });
        assert.equal(r.ok, true);
        assert.equal(r.fee.rate, '0.00081');
    });
    it('garbage settings are ignored, fee still resolves', () => {
        const r = resolvePlatformFee({ platformFee: { rate: 'nope', recipient: '' } });
        assert.equal(r.ok, true);
        assert.equal(r.fee.rate, '0.00081');
    });
});

describe('wholeCentsDue + formatting', () => {
    it('floors to whole cents; remainder carries', () => {
        assert.deepEqual(wholeCentsDue(7290), { ok: true, wholeCents: 0, remainderMicrocents: 7290 });
        assert.deepEqual(wholeCentsDue(8_100_000), { ok: true, wholeCents: 810, remainderMicrocents: 0 });
        assert.deepEqual(wholeCentsDue(19999), { ok: true, wholeCents: 1, remainderMicrocents: 9999 });
    });
    it('formats fractional-cent displays deterministically', () => {
        assert.equal(formatMicrocentsUSD(7290), '$0.00729');
        assert.equal(formatMicrocentsUSD(8_100_000), '$8.10');
        assert.equal(formatMicrocentsUSD(0), '$0.00');
        assert.equal(formatMicrocentsUSD(5), '$0.000005');
    });
    it('feeLineForSnapshot is always present-shaped', () => {
        const line = feeLineForSnapshot({ merchandiseMinor: 900, microcents: 7290, rate: '0.00081', recipient: 'Slid Phi Labs' });
        assert.equal(line.rate, '0.00081');
        assert.equal(line.recipient, 'Slid Phi Labs');
        assert.equal(line.merchandiseMinor, 900);
        assert.equal(line.microcents, 7290);
        assert.equal(line.display, '$0.00729');
    });
});

/* ---------- ledger ---------- */

describe('platform fee ledger', () => {
    it('accumulates across orders (memory backend)', () => {
        const ledger = createMemoryPlatformFeeLedger();
        ledger.accrue({ merchantId: 'm1', orderId: 'o1', seq: 1, microcents: 7290, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1000 });
        ledger.accrue({ merchantId: 'm1', orderId: 'o2', seq: 2, microcents: 7290, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1001 });
        assert.equal(ledger.balanceMicrocents('m1'), 14580);
        assert.equal(ledger.balanceMicrocents('unknown'), 0);
    });

    it('preview settles whole cents only; settle carries the remainder', () => {
        const ledger = createMemoryPlatformFeeLedger();
        ledger.accrue({ merchantId: 'm1', orderId: 'o1', seq: 1, microcents: 8_107_290, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1000 });
        const prev = ledger.previewSettlement('m1');
        assert.equal(prev.wholeCents, 810); // $8.10; $0.00729 stays
        assert.equal(prev.remainderMicrocents, 7290);
        const s = ledger.settle({ merchantId: 'm1', wholeCents: 810, invoiceRef: 'in_test_1', at: 2000 });
        assert.equal(s.settledCents, 810);
        assert.equal(s.remainingMicrocents, 7290);
        assert.equal(ledger.balanceMicrocents('m1'), 7290);
    });

    it('refuses to settle more than the releasable whole cents', () => {
        const ledger = createMemoryPlatformFeeLedger();
        ledger.accrue({ merchantId: 'm1', orderId: 'o1', seq: 1, microcents: 7290, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1000 });
        assert.throws(() => ledger.settle({ merchantId: 'm1', wholeCents: 1, invoiceRef: 'in_x' }), /only 0c releasable/);
    });

    it('file backend persists across instances', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            const a = createPlatformFeeLedger({ filePath: path });
            a.accrue({ merchantId: 'm9', orderId: 'o1', seq: 1, microcents: 7290, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1000 });
            const b = createPlatformFeeLedger({ filePath: path });
            assert.equal(b.balanceMicrocents('m9'), 7290);
            assert.throws(
                () => b.settle({ merchantId: 'm9', wholeCents: 0, invoiceRef: 'in_zero' }),
                /positive integer/
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects corrupt ledger files loudly (never silently loses money)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            writeFileSync(path, '{not json', 'utf8');
            assert.throws(() => createPlatformFeeLedger({ filePath: path }), /corrupt ledger/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('accrue validates input', () => {
        const ledger = createMemoryPlatformFeeLedger();
        assert.throws(() => ledger.accrue({ merchantId: '', microcents: 5 }), /merchantId/);
        assert.throws(() => ledger.accrue({ merchantId: 'm', microcents: -5 }), /microcents/);
        assert.throws(() => ledger.settle({ merchantId: 'm', wholeCents: 1 }), /invoiceRef/);
    });
});

/* ---------- middleware integration ---------- */

const SECRET = 'fee-test-secret';

const settings = (over = {}) => ({
    merchantId: 'fee-store',
    identity: { adapter: 'open' },
    catalog: { type: 'inline', items: [{ id: 'p9', title: 'Day Pass', priceMinor: 900 }] },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'x' },
    shipping: { provider: 'manual', configPointer: 'x' },
    paymentRails: [{ rail: 'manual' }],
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 50000, perDayMinor: 200000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 0,
    ...over,
});

const adapter = (stateOver = {}) => {
    let s = {
        status: 'cart',
        items: [{ id: 'p9', title: 'Day Pass', qty: 1, priceMinor: 900 }],
        currency: 'USD',
        address: '1 Main St',
        shippingMethod: 'standard',
        paymentMethod: 'card_1',
        buyerConfirmed: false,
        totals: null,
        ...stateOver,
    };
    return {
        getState: () => JSON.parse(JSON.stringify(s)),
        applyPatch: (p) => {
            if (p && p.__agentill_probe) return JSON.parse(JSON.stringify(s));
            s = { ...s, ...p };
            return JSON.parse(JSON.stringify(s));
        },
        getConfig: () => ({ currency: 'USD' }),
        describeSubmit: () => ({ bindings: 1 }),
        getCatalog: () => [{ id: 'p9', title: 'Day Pass', priceMinor: 900 }],
        submitOrder: (st) => ({ ...st, orderId: `ord_${Math.floor(Math.random() * 1e9)}`, status: 'submitted' }),
    };
};

const cred = (agentId = 'agent-1', scopes = KNOWN_SCOPES) => ({ agentId, scopes });

async function sealOnce(box) {
    // the buyer's browser holds the session cookie; the agent never sees it
    const buyer = box.issueBuyerSession();
    const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
    assert.equal(need.body.status, 'confirmation_required');
    const c = need.body.confirmation;
    const ch = box.issueConfirmationChallenge({
        tool: 'seal_order', stateHash: c.stateHash, buyerSessionId: buyer.sessionId,
    });
    return box.invokeTool({
        tool: 'seal_order',
        args: {},
        credential: cred(),
        buyerConfirmation: { challenge: ch.challenge, exp: ch.exp, stateHash: ch.stateHash, buyerSessionId: buyer.sessionId, approved: true },
    });
}

describe('platform fee end-to-end (seal_order)', () => {
    it('$9.00 seal accrues $0.00729 and the fee rides in the signed snapshot', async () => {
        const box = createBox({ settings: settings(), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const pf = await box.preflight();
        assert.equal(pf.ok, true, JSON.stringify(pf.errors));

        const done = await sealOnce(box);
        assert.equal(done.status, 200, JSON.stringify(done.body));
        assert.equal(done.body.ok, true);

        // fee line on the response body
        const line = done.body.platformFee;
        assert.ok(line, 'platformFee line present');
        assert.equal(line.rate, '0.00081');
        assert.equal(line.recipient, '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c');
        assert.equal(line.merchandiseMinor, 900);
        assert.equal(line.microcents, 7290);
        assert.equal(line.display, '$0.00729');

        // fee line inside the SIGNED snapshot state
        const snap = verifySnapshot(done.body.snapshot, SECRET, { maxAgeSec: 3600 * 24 });
        assert.deepEqual(snap.state.platformFee, line);

        // ledger accrued, nothing charged
        assert.equal(box.feeLedger.balanceMicrocents('fee-store'), 7290);
        assert.equal(box.feeLedger.previewSettlement('fee-store').wholeCents, 0);
    });

    it('accumulates across orders', async () => {
        const box = createBox({ settings: settings(), adapter: adapter(), secrets: { serverSecret: SECRET } });
        assert.equal((await box.preflight()).ok, true);
        await sealOnce(box);
        await sealOnce(box);
        assert.equal(box.feeLedger.balanceMicrocents('fee-store'), 14580);
    });

    it('merchant rate 0 is ignored (fee locked on)', async () => {
        const box = createBox({
            settings: settings({ platformFee: { rate: 0 } }),
            adapter: adapter(),
            secrets: { serverSecret: SECRET },
        });
        assert.equal((await box.preflight()).ok, true);
        const done = await sealOnce(box);
        assert.equal(done.body.platformFee.microcents, 7290); // 0.081% of $9.00
        assert.equal(box.feeLedger.balanceMicrocents('fee-store'), 7290);
    });

    it('merchant custom rate and recipient are ignored (locked)', async () => {
        const box = createBox({
            settings: settings({ platformFee: { rate: '0.01', recipient: 'Acme' } }),
            adapter: adapter(),
            secrets: { serverSecret: SECRET },
        });
        assert.equal((await box.preflight()).ok, true);
        const done = await sealOnce(box);
        assert.equal(done.body.platformFee.microcents, 7290); // still 0.081%
        assert.equal(done.body.platformFee.recipient, '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c');
    });

    it('malformed fee rate in settings is ignored (no pre-flight refusal)', async () => {
        const box = createBox({
            settings: settings({ platformFee: { rate: 'not-a-rate' } }),
            adapter: adapter(),
            secrets: { serverSecret: SECRET },
        });
        const pf = await box.preflight();
        assert.equal(pf.ok, true);
        const done = await sealOnce(box);
        assert.equal(done.body.platformFee.microcents, 7290);
    });

    it('discovery advertises the fee', async () => {
        const box = createBox({ settings: settings(), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const d = box.discovery();
        assert.equal(d.platformFee.rate, '0.00081');
        assert.equal(d.platformFee.recipient, '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c');
    });

    it('file ledger backend accrues durably through the box', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const ledgerFile = join(dir, 'fees.json');
            const box = createBox({
                settings: settings({ platformFee: { ledgerFile } }),
                adapter: adapter(),
                secrets: { serverSecret: SECRET },
            });
            assert.equal((await box.preflight()).ok, true);
            await sealOnce(box);
            const again = createPlatformFeeLedger({ filePath: ledgerFile });
            assert.equal(again.balanceMicrocents('fee-store'), 7290);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails closed (500) when the fee cannot be computed — never seals with a 0 fee', async () => {
        // An Infinity-priced item makes merchandiseMinor non-integer, so
        // computePlatformFeeMicrocents refuses. The box must 500 BEFORE the
        // merchant flow runs: no submit, no snapshot, no 0-fee line.
        let submitted = false;
        const s = {
            status: 'cart',
            items: [{ id: 'p9', title: 'Day Pass', qty: 1, priceMinor: Infinity }],
            currency: 'USD',
            address: '1 Main St',
            shippingMethod: 'standard',
            paymentMethod: 'card_1',
            buyerConfirmed: false,
            totals: null,
        };
        const evilAdapter = {
            // no JSON round-trip here: Infinity must survive into the box
            getState: () => ({ ...s, items: s.items.map((i) => ({ ...i })) }),
            applyPatch: (p) => {
                if (p && p.__agentill_probe) return evilAdapter.getState();
                Object.assign(s, p);
                return evilAdapter.getState();
            },
            getConfig: () => ({ currency: 'USD' }),
            describeSubmit: () => ({ bindings: 1 }),
            getCatalog: () => [{ id: 'p9', title: 'Day Pass', priceMinor: 900 }],
            submitOrder: (st) => {
                submitted = true;
                return { ...st, orderId: 'ord_evil', status: 'submitted' };
            },
        };
        const box = createBox({ settings: settings(), adapter: evilAdapter, secrets: { serverSecret: SECRET } });
        assert.equal((await box.preflight()).ok, true);

        const buyer = box.issueBuyerSession();
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        assert.equal(need.body.status, 'confirmation_required');
        const c = need.body.confirmation;
        const ch = box.issueConfirmationChallenge({
            tool: 'seal_order', stateHash: c.stateHash, buyerSessionId: buyer.sessionId,
        });
        const done = await box.invokeTool({
            tool: 'seal_order',
            args: {},
            credential: cred(),
            buyerConfirmation: { challenge: ch.challenge, exp: ch.exp, stateHash: ch.stateHash, buyerSessionId: buyer.sessionId, approved: true },
        });
        assert.equal(done.status, 500, JSON.stringify(done.body));
        assert.equal(done.body.error.code, 'fee_compute');
        assert.equal(submitted, false, 'merchant submitOrder must not run when the fee computation fails');
        assert.equal(box.feeLedger.balanceMicrocents('fee-store'), 0, 'nothing may accrue on a refused seal');
    });
});

/* ---------- compressed ledger storage (roundtrip + fallback) ---------- */

describe('ledger compression', () => {
    function seed(ledger, merchants = 12, per = 15) {
        for (let i = 0; i < merchants; i++) {
            const m = `merchant_${i}_acme_trading_co`;
            for (let s = 0; s < per; s++) {
                ledger.accrue({ merchantId: m, orderId: `o${i}-${s}`, seq: s, microcents: 7290 + s, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1759276800 + s });
            }
            ledger.settle({ merchantId: m, wholeCents: 1, invoiceRef: `inv-${i}` });
        }
    }

    const sha256 = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

    it('roundtrips byte-identical through compress/decompress (SHA-256)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            const a = createPlatformFeeLedger({ filePath: path });
            seed(a);
            const before = sha256(a.snapshot());
            const b = createPlatformFeeLedger({ filePath: path });
            assert.equal(sha256(b.snapshot()), before);
            assert.equal(b.balanceMicrocents('merchant_0_acme_trading_co'), a.balanceMicrocents('merchant_0_acme_trading_co'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('stored file is smaller than the JSON it holds', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            const a = createPlatformFeeLedger({ filePath: path });
            seed(a, 20, 20);
            const stored = statSync(path).size;
            const plain = JSON.stringify(a.snapshot()).length;
            assert.ok(stored < plain, `stored ${stored} should be < plain ${plain}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('legacy plain-JSON files still load (fallback path)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            const a = createPlatformFeeLedger({ filePath: path });
            seed(a, 3, 4);
            const snap = a.snapshot();
            // overwrite with legacy pretty-printed plain JSON
            writeFileSync(path, JSON.stringify(snap, null, 2) + '\n', 'utf8');
            const b = createPlatformFeeLedger({ filePath: path });
            assert.equal(sha256(b.snapshot()), sha256(snap));
            // and the next save upgrades it to compressed transparently
            b.accrue({ merchantId: 'merchant_0_acme_trading_co', orderId: 'oX', seq: 99, microcents: 10, rate: '0.00081', recipient: 'Slid Phi Labs', at: 1 });
            const raw = readFileSync(path);
            assert.equal(raw[0], 0x1f, 'after re-save the file should be gzip');
            assert.equal(raw[1], 0x8b, 'after re-save the file should be gzip');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('corrupt gzip still throws loudly (never silently loses money)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agentill-fee-'));
        try {
            const path = join(dir, 'fees.json');
            writeFileSync(path, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]));
            assert.throws(() => createPlatformFeeLedger({ filePath: path }), /corrupt ledger/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
