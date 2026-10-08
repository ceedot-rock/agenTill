/**
 * agentill / tests/buyer-approval-adversarial.test.js
 *
 * ADVERSARIAL TESTS for the buyer-approval guarantee:
 * "There is no way for an agent to buy anything on its own."
 *
 * The attack model: an agent with a plain HTTP client (no browser, no
 * HttpOnly cookie) tries to seal an order with zero human involvement.
 * Before the fix this succeeded — the challenge endpoint issued challenges
 * to any caller and the in-band `confirmation_required` response handed the
 * agent a usable challenge to self-approve with. These tests FAIL on the
 * vulnerable code and PASS after the fix.
 *
 * Run: node --test tests/buyer-approval-adversarial.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBox } from '../server/middleware.js';
import { KNOWN_SCOPES } from '../core/gates.js';

const SECRET = 'adversarial-secret';

const settings = () => ({
    merchantId: 'adv-store',
    identity: { adapter: 'open' },
    catalog: { type: 'inline', items: [{ id: 'p1', title: 'Widget', priceMinor: 1000 }] },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'x' },
    shipping: { provider: 'manual', configPointer: 'x' },
    paymentRails: [{ rail: 'manual' }],
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 50000, perDayMinor: 200000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 0,
    // tolls are opt-in; these tests keep them off
});

const adapter = () => {
    const s = {
        status: 'cart',
        items: [{ id: 'p1', title: 'Widget', qty: 1, priceMinor: 1000 }],
        currency: 'USD',
        address: '1 Main St',
        shippingMethod: 'standard',
        paymentMethod: 'card_1',
        buyerConfirmed: false,
        totals: null,
    };
    return {
        getState: () => JSON.parse(JSON.stringify(s)),
        applyPatch: (p) => {
            if (p && p.__agentill_probe) return JSON.parse(JSON.stringify(s));
            Object.assign(s, p);
            return JSON.parse(JSON.stringify(s));
        },
        getConfig: () => ({ currency: 'USD' }),
        describeSubmit: () => ({ bindings: 1 }),
        getCatalog: () => [{ id: 'p1', title: 'Widget', priceMinor: 1000 }],
        submitOrder: (st) => ({ ...st, orderId: 'ord_adv_1', status: 'submitted' }),
    };
};

const cred = () => ({ agentId: 'rogue-agent', scopes: KNOWN_SCOPES });

async function activeBox() {
    const box = createBox({ settings: settings(), adapter: adapter(), secrets: { serverSecret: SECRET } });
    const pf = await box.preflight();
    assert.equal(pf.ok, true, JSON.stringify(pf.errors || pf.checks));
    return box;
}

/** Drive the box's HTTP middleware with fake req/res (no network). */
function callRoute(box, { headers = {}, body = {} }) {
    const req = { method: 'POST', url: '/agentill/confirm/challenge', headers, body };
    const res = {
        status: null, headers: null, chunks: '',
        writeHead(s, h) { this.status = s; this.headers = h; },
        end(b) { this.chunks = String(b); },
    };
    return box.middleware()(req, res).then(() => ({
        status: res.status,
        body: JSON.parse(res.chunks),
    }));
}

describe('adversarial: agent self-approval of buyer confirmation', () => {
    it('an agent with no buyer cookie cannot obtain a challenge (401)', async () => {
        const box = await activeBox();
        // no cookie at all
        const noCookie = await callRoute(box, { body: { tool: 'seal_order', stateHash: 'x' } });
        assert.equal(noCookie.status, 401, `expected 401, got ${noCookie.status}: ${JSON.stringify(noCookie.body)}`);
        assert.equal(noCookie.body.error.code, 'buyer_session_required');
        // forged cookie value
        const forged = await callRoute(box, { headers: { cookie: 'agentill_buyer=forged-token' }, body: { tool: 'seal_order', stateHash: 'x' } });
        assert.equal(forged.status, 401);
        assert.equal(forged.body.error.code, 'buyer_session_required');
    });

    it('an agent cannot self-approve a seal with a challenge it obtained itself', async () => {
        const box = await activeBox();
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        assert.equal(need.body.status, 'confirmation_required');
        const c = need.body.confirmation;

        // The strongest agent-side attack on each version of the code:
        let attack;
        if (c.challenge) {
            // VULNERABLE code hands the agent a usable challenge in-band.
            attack = { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'anonymous', approved: true };
        } else {
            // FIXED code: no in-band challenge, and the route needs the cookie.
            const routeRes = await callRoute(box, { body: { tool: 'seal_order', stateHash: c.stateHash } });
            assert.equal(routeRes.status, 401, 'challenge route must refuse the agent');
            const forged = box.issueConfirmationChallenge({
                tool: 'seal_order', stateHash: c.stateHash, buyerSessionId: 'rogue-session',
            });
            attack = { challenge: forged.challenge, exp: forged.exp, stateHash: forged.stateHash, buyerSessionId: 'rogue-session', approved: true };
        }
        const seal = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred(), buyerConfirmation: attack });
        assert.equal(seal.status, 403, `agent must not seal; got ${seal.status}: ${JSON.stringify(seal.body).slice(0, 200)}`);
        assert.equal(seal.body.error.code, 'bad_confirmation');
        assert.ok(!seal.body.ok);
    });

    it('a bare approved:true with no challenge never seals', async () => {
        const box = await activeBox();
        const seal = await box.invokeTool({
            tool: 'seal_order', args: {}, credential: cred(),
            buyerConfirmation: { approved: true },
        });
        assert.equal(seal.body.ok, false, 'must not seal');
        assert.ok(!seal.body.result || !seal.body.result.orderId, 'no order may be created');
    });
});

describe('legit buyer flow with session cookie', () => {
    it('a buyer with the session cookie obtains a challenge and seals', async () => {
        const box = await activeBox();
        // page load: the merchant opens a session and sets the HttpOnly cookie
        const sess = box.issueBuyerSession();
        const cookie = { cookie: `agentill_buyer=${sess.token}` };

        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        assert.equal(need.body.status, 'confirmation_required');
        const c = need.body.confirmation;
        assert.ok(!('challenge' in c), 'the agent must never be handed a challenge in-band');

        // the buyer's browser fetches the challenge with its cookie
        const routeRes = await callRoute(box, { headers: cookie, body: { tool: 'seal_order', stateHash: c.stateHash } });
        assert.equal(routeRes.status, 200, JSON.stringify(routeRes.body));
        assert.equal(routeRes.body.buyerSessionId, sess.sessionId);

        const seal = await box.invokeTool({
            tool: 'seal_order',
            args: {},
            credential: cred(),
            buyerConfirmation: {
                challenge: routeRes.body.challenge,
                exp: routeRes.body.exp,
                stateHash: routeRes.body.stateHash,
                buyerSessionId: routeRes.body.buyerSessionId,
                approved: true,
            },
        });
        assert.equal(seal.status, 200, JSON.stringify(seal.body));
        assert.equal(seal.body.ok, true);
        assert.equal(seal.body.result.orderId, 'ord_adv_1');
    });

    it('expired buyer sessions are refused at the challenge route', async () => {
        const box = await activeBox();
        const sess = box.issueBuyerSession({ ttlSec: -1 }); // already expired
        const cookie = { cookie: `agentill_buyer=${sess.token}` };
        const routeRes = await callRoute(box, { headers: cookie, body: { tool: 'seal_order', stateHash: 'x' } });
        assert.equal(routeRes.status, 401);
        assert.equal(box.buyerSessionActive(sess.sessionId), false);
    });

    it('a confirmation for a changed checkout state is refused', async () => {
        const box = await activeBox();
        const sess = box.issueBuyerSession();
        const cookie = { cookie: `agentill_buyer=${sess.token}` };
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        const c = need.body.confirmation;
        const routeRes = await callRoute(box, { headers: cookie, body: { tool: 'seal_order', stateHash: c.stateHash } });
        assert.equal(routeRes.status, 200);
        // the agent tampers the stateHash the buyer approved
        const seal = await box.invokeTool({
            tool: 'seal_order',
            args: {},
            credential: cred(),
            buyerConfirmation: {
                challenge: routeRes.body.challenge,
                exp: routeRes.body.exp,
                stateHash: 'tampered-state-hash',
                buyerSessionId: routeRes.body.buyerSessionId,
                approved: true,
            },
        });
        assert.equal(seal.status, 403);
        assert.equal(seal.body.error.code, 'bad_confirmation');
    });
});
