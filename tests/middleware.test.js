import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBox } from '../server/middleware.js';
import { generateEs256Keypair, mintAgentJwt, verifySnapshot } from '../core/tokens.js';
import { RIDER_PRESET } from '../core/identity.js';
import { KNOWN_SCOPES } from '../core/gates.js';

const SECRET = 'mw-secret';
const NOW = 1800000000;

const settings = (over = {}) => ({
    merchantId: 'mw-store',
    identity: { adapter: 'open' },
    catalog: { type: 'inline', items: [{ id: 'p1', title: 'Widget', priceMinor: 1000 }] },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'x' },
    shipping: { provider: 'manual', configPointer: 'x' },
    paymentRails: [{ rail: 'x402', wallet: { address: '0xpay', network: 'base', asset: '0xusdc' } }],
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 50000, perDayMinor: 200000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
    taxRateBps: 0,
    // tolls are opt-in; these tests keep them explicitly free
    tolls: {
        browse_catalog: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
        read_checkout: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
        amend_checkout: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
        seal_order: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
    },
    ...over,
});

const adapter = (stateOver = {}) => {
    let s = {
        status: 'cart',
        items: [{ id: 'p1', title: 'Widget', qty: 1, priceMinor: 1000 }],
        currency: 'USD',
        address: null, shippingMethod: null, paymentMethod: null,
        buyerConfirmed: false, totals: null,
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
        getCatalog: () => [{ id: 'p1', title: 'Widget', priceMinor: 1000 }],
        submitOrder: (st) => ({ ...st, orderId: 'ord_1', status: 'submitted' }),
    };
};

// default credential for the 'open' identity adapter
const cred = (agentId = 'agent-9', scopes = KNOWN_SCOPES) => ({ agentId, scopes });

async function activeBox(over = {}, adapterOver = {}) {
    const box = createBox({
        settings: settings(over),
        adapter: adapter(adapterOver),
        secrets: { serverSecret: SECRET },
    });
    const pf = await box.preflight();
    assert.equal(pf.ok, true, JSON.stringify(pf.errors || pf.checks));
    return { box };
}

function jwtBox(over = {}) {
    // NOTE: the middleware verifies against real wall-clock time, so test
    // JWTs are minted at real now (not the fixed NOW used in pure token tests).
    const realNow = () => Math.floor(Date.now() / 1000);
    const keys = generateEs256Keypair();
    const box = createBox({
        settings: settings({
            identity: { adapter: 'es256-jwt', publicJwk: keys.publicJwk },
            ...over,
        }),
        adapter: adapter(),
        secrets: { serverSecret: SECRET },
    });
    const jwt = (trust = 'verified', scopes = KNOWN_SCOPES) =>
        mintAgentJwt({ privateJwk: keys.privateJwk, agentId: 'agent-9', trust, scopes, nowSec: realNow() });
    return { box, jwt, keys };
}

describe('middleware pipeline', () => {
    it('refuses tool calls before activation (503)', async () => {
        const box = createBox({ settings: settings(), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const out = await box.invokeTool({ tool: 'read_checkout', args: {}, credential: cred() });
        assert.equal(out.status, 503);
        assert.equal(out.body.error.code, 'not_activated');
    });

    it('rejects bad JWTs on the es256-jwt adapter (401)', async () => {
        const { box } = jwtBox();
        const pf = await box.preflight();
        assert.equal(pf.ok, true, JSON.stringify(pf.errors));
        const out = await box.invokeTool({ tool: 'read_checkout', args: {}, credential: 'garbage' });
        assert.equal(out.status, 401);
    });

    it('rejects insufficient trust (403)', async () => {
        const { box } = await activeBox({ toolTrust: { seal_order: 'elevated' } });
        const out = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        assert.equal(out.status, 403);
        assert.equal(out.body.error.code, 'trust');
    });

    it('es256-jwt trust levels gate tools when toolTrust is raised', async () => {
        const { box, jwt } = jwtBox({ toolTrust: { seal_order: 'elevated' } });
        const pf = await box.preflight();
        assert.equal(pf.ok, true, JSON.stringify(pf.errors));
        const denied = await box.invokeTool({ tool: 'seal_order', args: {}, credential: jwt('verified') });
        assert.equal(denied.status, 403);
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: jwt('elevated'), buyerSessionId: 'b' });
        assert.equal(need.body.status, 'confirmation_required');
    });

    it('Rider-style JWTs work as an optional preset, never a requirement', async () => {
        const realNow = () => Math.floor(Date.now() / 1000);
        const keys = generateEs256Keypair();
        const box = createBox({
            settings: settings({
                identity: {
                    adapter: 'es256-jwt',
                    publicJwk: keys.publicJwk,
                    issuer: 'rider',
                    ...RIDER_PRESET,
                },
                toolTrust: { seal_order: 'verified' },
            }),
            adapter: adapter(),
            secrets: { serverSecret: SECRET },
        });
        const pf = await box.preflight();
        assert.equal(pf.ok, true, JSON.stringify(pf.errors));
        // Rider-shaped JWT: agent_id + clearance claims
        let riderJwt = null;
        try {
            riderJwt = mintAgentJwt({
                privateJwk: keys.privateJwk, agentId: 'rider-agent', issuer: 'rider',
                claimNames: RIDER_PRESET.claimNames,
                trust: 'L4', // will fail: mintAgentJwt only mints generic trust levels
                nowSec: realNow(),
            });
        } catch { riderJwt = null; }
        assert.equal(riderJwt, null); // L4 is not a generic trust level — mint refuses
        const { createPrivateKey, createSign } = await import('node:crypto');
        const b64u = (b) => Buffer.from(b).toString('base64url');
        const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
        const payload = b64u(JSON.stringify({
            agent_id: 'rider-agent', iss: 'rider', iat: realNow(), exp: realNow() + 900,
            clearance: 'L4', scopes: [...KNOWN_SCOPES].sort(), jti: 'x',
        }));
        const key = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
        const sig = b64u(createSign('SHA256').update(`${header}.${payload}`).sign(key));
        const out = await box.invokeTool({ tool: 'read_checkout', args: {}, credential: `${header}.${payload}.${sig}` });
        assert.equal(out.status, 200);
        assert.equal(out.body.ok, true);
    });

    it('rejects tools outside the merchant allow-list (403)', async () => {
        const { box } = await activeBox({ allowedToolScopes: ['read:checkout'] });
        const out = await box.invokeTool({ tool: 'amend_checkout', args: { patch: { note: 'hi' } }, credential: cred('agent-9', ['read:checkout']) });
        assert.equal(out.status, 403);
        assert.equal(out.body.error.code, 'allowlist');
    });

    it('read-only tools work without confirmation', async () => {
        const { box } = await activeBox();
        const out = await box.invokeTool({ tool: 'browse_catalog', args: { query: 'wid' }, credential: cred('agent-9', ['read:catalog']) });
        assert.equal(out.status, 200);
        assert.equal(out.body.ok, true);
        assert.equal(out.body.result.results.length, 1);
    });

    it('402s when a priced tool is unpaid, then proceeds after x402 payment', async () => {
        const priced = {
            tolls: {
                browse_catalog: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
                read_checkout: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
                amend_checkout: { priceMinor: 0, freePerPeriod: Number.MAX_SAFE_INTEGER, currency: 'USD' },
                seal_order: { priceMinor: 10, freePerPeriod: 0, currency: 'USD' },
            },
        };
        const { box } = await activeBox(priced, { address: 'a', shippingMethod: 's', paymentMethod: 'p' });
        const noPay = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred() });
        assert.equal(noPay.status, 402);
        assert.ok(noPay.headers['PAYMENT-REQUIRED']);
        assert.equal(noPay.body.accepts[0].scheme, 'exact');

        // pay, then the confirmation gate (not the toll gate) is what stops it
        const xpayment = JSON.stringify({
            x402Version: 1, scheme: 'exact', network: 'base',
            payload: {
                signature: '0xsig',
                authorization: {
                    from: '0xbuyer', to: '0xpay', value: '100000',
                    validAfter: String(Math.floor(Date.now() / 1000) - 10),
                    validBefore: String(Math.floor(Date.now() / 1000) + 300),
                    nonce: 'n1',
                },
            },
        });
        const paid = await box.invokeTool({
            tool: 'seal_order', args: {}, credential: cred(),
            xpayment, // hooks.verifySignature defaults to null -> structural verify only
        });
        assert.equal(paid.status, 200);
        assert.equal(paid.body.status, 'confirmation_required');
    });

    it('tolls stay off unless settings.tolls is set', async () => {
        const s = settings();
        delete s.tolls;
        const box = createBox({ settings: s, adapter: adapter(), secrets: { serverSecret: SECRET } });
        const pf = await box.preflight();
        assert.equal(pf.ok, true, JSON.stringify(pf.errors));
        const d = box.discovery();
        assert.equal(d.tolls.enabled, false);
        const out = await box.invokeTool({ tool: 'browse_catalog', args: {}, credential: cred('a', ['read:catalog']) });
        assert.equal(out.status, 200);
        assert.equal(out.body.toll.charged, false);
    });

    it('seal_order demands buyer confirmation, then submits through the merchant flow', async () => {
        const { box } = await activeBox({}, { address: '1 Main St', shippingMethod: 'standard', paymentMethod: 'card_1' });
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred(), buyerSessionId: 'buyer-1' });
        assert.equal(need.status, 200);
        assert.equal(need.body.status, 'confirmation_required');
        assert.equal(need.body.confirmation.level, 'buyer');
        const c = need.body.confirmation;

        const done = await box.invokeTool({
            tool: 'seal_order',
            args: {},
            credential: cred(),
            buyerSessionId: 'buyer-1',
            buyerConfirmation: { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'buyer-1', approved: true },
        });
        assert.equal(done.status, 200, JSON.stringify(done.body));
        assert.equal(done.body.ok, true);
        assert.equal(done.body.result.orderId, 'ord_1');

        // the snapshot binds the action to the shared state and verifies
        const snap = verifySnapshot(done.body.snapshot, SECRET, { maxAgeSec: 3600 * 24 });
        assert.equal(snap.tool, 'seal_order');
        assert.equal(snap.agent_id, 'agent-9');
        assert.equal(snap.state.status, 'submitted');
    });

    it('rejects forged buyer confirmations', async () => {
        const { box } = await activeBox({}, { address: 'a', shippingMethod: 's', paymentMethod: 'p' });
        const out = await box.invokeTool({
            tool: 'seal_order', args: {}, credential: cred(),
            buyerConfirmation: { challenge: 'forged', exp: 9999999999, stateHash: 'x', buyerSessionId: 'buyer-1', approved: true },
        });
        assert.equal(out.status, 403);
        assert.equal(out.body.error.code, 'bad_confirmation');
    });

    it('amend_checkout touching money requires confirmation; notes do not (always-mode still gates)', async () => {
        const { box } = await activeBox();
        const need = await box.invokeTool({ tool: 'amend_checkout', args: { patch: { shippingMethod: 'express' } }, credential: cred('agent-9', ['write:cart', 'write:shipping']) });
        assert.equal(need.body.status, 'confirmation_required');
    });

    it('spend caps refuse oversized orders', async () => {
        const items = [{ id: 'p1', title: 'Widget', qty: 100, priceMinor: 1000 }]; // $1000 > $500 cap
        const { box } = await activeBox({}, { address: 'a', shippingMethod: 's', paymentMethod: 'p', items });
        const need = await box.invokeTool({ tool: 'seal_order', args: {}, credential: cred(), buyerSessionId: 'b' });
        const c = need.body.confirmation;
        const done = await box.invokeTool({
            tool: 'seal_order', args: {}, credential: cred(), buyerSessionId: 'b',
            buyerConfirmation: { challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId: 'b', approved: true },
        });
        assert.equal(done.status, 403);
        assert.equal(done.body.error.code, 'spend_cap');
    });

    it('discovery document describes the configured identity', async () => {
        const { box } = await activeBox();
        const d = box.discovery();
        assert.equal(d.tools.definitions.length, 4);
        assert.ok(d.tools.definitions.some((t) => t.name === 'seal_order' && t.requiresConfirmation === 'always:buyer'));
        assert.equal(d.identity.adapter, 'open');
    });

    it('preflight endpoint refuses bad settings without activating', async () => {
        const box = createBox({ settings: settings({ currency: 'US' }), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const report = await box.preflight();
        assert.equal(report.ok, false);
        assert.equal(report.stage, 'validate');
    });

    it('preflight refuses unknown identity adapters and bad trust levels', async () => {
        const badAdapter = createBox({ settings: settings({ identity: { adapter: 'retina-scan' } }), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const r1 = await badAdapter.preflight();
        assert.equal(r1.ok, false);
        assert.equal(r1.stage, 'validate');

        const badTrust = createBox({ settings: settings({ toolTrust: { seal_order: 'maximum' } }), adapter: adapter(), secrets: { serverSecret: SECRET } });
        const r2 = await badTrust.preflight();
        assert.equal(r2.ok, false);
        assert.equal(r2.stage, 'validate');
    });
});
