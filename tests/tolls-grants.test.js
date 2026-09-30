import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOLL_TABLE, applyQuota, issueReceipt, quoteToX402 } from '../core/tolls.js';
import { issueGrant, verifyGrant, grantAllowsScope } from '../core/grants.js';

const SECRET = 'grant-secret';

describe('tolls', () => {
    it('free quota covers the first N calls, then charges', () => {
        const usage = {};
        const tool = 'amend_checkout'; // freePerPeriod: 100, priceMinor: 1
        let q;
        for (let i = 0; i < 100; i++) {
            q = applyQuota({ tool, agentId: 'a1', periodId: '2026-09', usage });
            assert.equal(q.charged, false);
            usage[`a1:${tool}:2026-09`] = q.usedAfter;
        }
        q = applyQuota({ tool, agentId: 'a1', periodId: '2026-09', usage });
        assert.equal(q.charged, true);
        assert.equal(q.amountMinor, 1);
    });

    it('seal_order has no free quota', () => {
        const q = applyQuota({ tool: 'seal_order', agentId: 'a1', periodId: '2026-09', usage: {} });
        assert.equal(q.charged, true);
        assert.equal(q.amountMinor, 10);
    });

    it('unknown tools are treated as free, not fatal', () => {
        const q = applyQuota({ tool: 'nope', agentId: 'a1', periodId: '2026-09', usage: {} });
        assert.equal(q.charged, false);
    });

    it('receipts are deterministic: same inputs, same receipt_id', () => {
        const a = issueReceipt({ agentId: 'a1', tool: 'amend_checkout', amountMinor: 1, seq: 7, periodId: '2026-09', nowSec: 1000 });
        const b = issueReceipt({ agentId: 'a1', tool: 'amend_checkout', amountMinor: 1, seq: 7, periodId: '2026-09', nowSec: 1000 });
        assert.equal(a.receipt_id, b.receipt_id);
        const c = issueReceipt({ agentId: 'a1', tool: 'amend_checkout', amountMinor: 1, seq: 8, periodId: '2026-09', nowSec: 1000 });
        assert.notEqual(a.receipt_id, c.receipt_id);
    });

    it('quoteToX402 converts a charged quote to payment requirements', () => {
        const reqs = quoteToX402(
            { charged: true, amountMinor: 10, tool: 'seal_order' },
            { network: 'base', payTo: '0xpay', asset: '0xusdc', assetDecimals: 6, resource: '/acb/tools/invoke:seal_order' }
        );
        assert.equal(reqs.scheme, 'exact');
        assert.equal(reqs.maxAmountRequired, '100000'); // $0.10 -> 100000 atomic units at 6 decimals
        assert.equal(quoteToX402({ charged: false, amountMinor: 0 }, { network: 'base', payTo: '0x', asset: '0x', resource: 'r' }), null);
    });

    it('default table covers all four tools', () => {
        for (const t of ['browse_catalog', 'read_checkout', 'amend_checkout', 'seal_order']) {
            assert.ok(DEFAULT_TOLL_TABLE[t], t);
        }
    });
});

describe('grants', () => {
    it('issue then verify round-trips', () => {
        const g = issueGrant({ agentId: 'a1', tools: ['amend_checkout'], scopes: ['write:cart'], issuerSecret: SECRET, nowSec: 1000 });
        const back = verifyGrant(g, SECRET, { nowSec: 1200 });
        assert.equal(back.agent_id, 'a1');
        assert.deepEqual(back.tools, ['amend_checkout']);
    });

    it('rejects tampered grants', () => {
        const g = issueGrant({ agentId: 'a1', tools: ['amend_checkout'], scopes: ['write:cart'], issuerSecret: SECRET, nowSec: 1000 });
        g.scopes.push('submit:order');
        assert.throws(() => verifyGrant(g, SECRET, { nowSec: 1200 }), (e) => e.code === 'bad_sig');
    });

    it('rejects expired grants', () => {
        const g = issueGrant({ agentId: 'a1', tools: ['*'], scopes: ['*'], ttlSec: 60, issuerSecret: SECRET, nowSec: 1000 });
        assert.throws(() => verifyGrant(g, SECRET, { nowSec: 2000 }), (e) => e.code === 'expired');
    });

    it('scope checks compose with the gate', () => {
        const g = issueGrant({ agentId: 'a1', tools: ['amend_checkout'], scopes: ['write:cart'], issuerSecret: SECRET, nowSec: 1000 });
        const body = verifyGrant(g, SECRET, { nowSec: 1200 });
        assert.equal(grantAllowsScope(body, 'amend_checkout', 'write:cart', 1200).allowed, true);
        assert.equal(grantAllowsScope(body, 'amend_checkout', 'submit:order', 1200).allowed, false);
    });
});
