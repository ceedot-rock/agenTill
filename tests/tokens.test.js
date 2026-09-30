import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateEs256Keypair,
    mintAgentJwt,
    verifyAgentJwt,
    meetsTrust,
    TokenError,
    buildPaymentRequirements,
    parseXPaymentHeader,
    verifyX402Payment,
    paymentRequiredBody,
    signSnapshot,
    verifySnapshot,
    hashState,
} from '../core/tokens.js';

const NOW = 1800000000;

function keys() {
    return generateEs256Keypair();
}

describe('agent jwt', () => {
    it('round-trips: mint then verify', () => {
        const { publicJwk, privateJwk } = keys();
        const tok = mintAgentJwt({ privateJwk, agentId: 'agent-1', trust: 'verified', scopes: ['read:checkout'], nowSec: NOW });
        const claims = verifyAgentJwt(tok, { publicJwk, nowSec: NOW });
        assert.equal(claims.agentId, 'agent-1');
        assert.equal(claims.trust, 'verified');
        assert.deepEqual(claims.scopes, ['read:checkout']);
    });

    it('rejects expired tokens', () => {
        const { publicJwk, privateJwk } = keys();
        const tok = mintAgentJwt({ privateJwk, agentId: 'a', ttlSec: 60, nowSec: NOW - 3600 });
        assert.throws(() => verifyAgentJwt(tok, { publicJwk, nowSec: NOW }), (e) => e.code === 'expired');
    });

    it('rejects wrong-key signatures', () => {
        const a = keys();
        const b = keys();
        const tok = mintAgentJwt({ privateJwk: a.privateJwk, agentId: 'a', nowSec: NOW });
        assert.throws(() => verifyAgentJwt(tok, { publicJwk: b.publicJwk, nowSec: NOW }), (e) => e.code === 'bad_signature');
    });

    it('rejects non-ES256 alg', () => {
        const { publicJwk, privateJwk } = keys();
        const tok = mintAgentJwt({ privateJwk, agentId: 'a', nowSec: NOW });
        const [h, p, s] = tok.split('.');
        const badH = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        assert.throws(() => verifyAgentJwt(`${badH}.${p}.${s}`, { publicJwk, nowSec: NOW }), (e) => e.code === 'bad_alg');
    });

    it('rejects a validly-signed token missing agent_id', async () => {
        const { createSign, createPrivateKey } = await import('node:crypto');
        const { publicJwk, privateJwk } = keys();
        const header = { alg: 'ES256', typ: 'JWT' };
        const payload = { iss: 'agentill', iat: NOW, exp: NOW + 900, trust: 'open', scopes: [] }; // no agent_id
        const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
        const sig = createSign('SHA256').update(input).sign(createPrivateKey({ key: privateJwk, format: 'jwk' }));
        const tok = `${input}.${Buffer.from(sig).toString('base64url')}`;
        assert.throws(() => verifyAgentJwt(tok, { publicJwk, nowSec: NOW }), (e) => e.code === 'no_agent');
    });

    it('trust ordering is monotonic open < verified < elevated', () => {
        assert.equal(meetsTrust('verified', 'verified'), true);
        assert.equal(meetsTrust('elevated', 'verified'), true);
        assert.equal(meetsTrust('open', 'verified'), false);
        assert.equal(meetsTrust('open', 'elevated'), false);
        assert.equal(meetsTrust('bogus', 'open'), false);
    });
});

describe('x402 payment', () => {
    const reqs = () => buildPaymentRequirements({
        network: 'base',
        payTo: '0xabc',
        amountAtomic: '10000',
        asset: '0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913',
        resource: '/acb/tools/invoke:amend_checkout',
        description: 'toll',
    });

    it('builds well-formed requirements', () => {
        const r = reqs();
        assert.equal(r.scheme, 'exact');
        assert.equal(r.x402Version, 1);
        assert.equal(r.maxAmountRequired, '10000');
        assert.ok(r.outputSchema.properties.signature);
    });

    it('paymentRequiredBody wraps accepts[]', () => {
        const body = paymentRequiredBody(reqs());
        assert.equal(body.x402Version, 1);
        assert.equal(body.accepts.length, 1);
    });

    const goodPayment = () => ({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: {
            signature: '0xsig',
            authorization: { from: '0xbuyer', to: '0xABC', value: '10000', validAfter: String(NOW - 10), validBefore: String(NOW + 300), nonce: 'n1' },
        },
    });

    it('structural verify passes on a good payment', async () => {
        const out = await verifyX402Payment(goodPayment(), reqs(), { nowSec: NOW });
        assert.equal(out.ok, true);
    });

    it('rejects underpayment', async () => {
        const p = goodPayment();
        p.payload.authorization.value = '9999';
        await assert.rejects(verifyX402Payment(p, reqs(), { nowSec: NOW }), (e) => e.code === 'underpaid');
    });

    it('rejects wrong payee (case-insensitive compare)', async () => {
        const p = goodPayment();
        p.payload.authorization.to = '0xdef';
        await assert.rejects(verifyX402Payment(p, reqs(), { nowSec: NOW }), (e) => e.code === 'payee_mismatch');
    });

    it('rejects stale windows', async () => {
        const p = goodPayment();
        p.payload.authorization.validBefore = String(NOW - 5);
        await assert.rejects(verifyX402Payment(p, reqs(), { nowSec: NOW }), (e) => e.code === 'stale_payment');
    });

    it('rejects malformed X-PAYMENT headers', () => {
        assert.throws(() => parseXPaymentHeader(null), (e) => e.code === 'no_payment');
        assert.throws(() => parseXPaymentHeader('not-json'), (e) => e.code === 'bad_payment');
        assert.throws(() => parseXPaymentHeader('{}'), (e) => e.code === 'bad_payment');
    });

    it('honors the async on-chain signature hook', async () => {
        await assert.rejects(
            verifyX402Payment(goodPayment(), reqs(), { nowSec: NOW, verifySignature: async () => false }),
            (e) => e.code === 'bad_signature'
        );
        const out = await verifyX402Payment(goodPayment(), reqs(), { nowSec: NOW, verifySignature: async () => true });
        assert.equal(out.ok, true);
    });
});

describe('state snapshots', () => {
    const secret = 'test-secret';
    const state = { status: 'cart', items: [{ qty: 1, priceMinor: 100 }], currency: 'USD' };

    it('sign then verify round-trips', () => {
        const signed = signSnapshot({ state, agentId: 'a1', tool: 'amend_checkout', seq: 1, serverSecret: secret, nowSec: NOW });
        const back = verifySnapshot(signed, secret, { nowSec: NOW });
        assert.equal(back.agent_id, 'a1');
        assert.equal(back.seq, 1);
    });

    it('detects tampered state', () => {
        const signed = signSnapshot({ state, agentId: 'a1', tool: 'amend_checkout', seq: 1, serverSecret: secret, nowSec: NOW });
        signed.snapshot.state.items[0].qty = 999;
        assert.throws(() => verifySnapshot(signed, secret, { nowSec: NOW }), (e) => e.code === 'bad_sig' || e.code === 'hash_mismatch');
    });

    it('detects tampered signature', () => {
        const signed = signSnapshot({ state, agentId: 'a1', tool: 'amend_checkout', seq: 1, serverSecret: secret, nowSec: NOW });
        signed.sig = '0'.repeat(signed.sig.length);
        assert.throws(() => verifySnapshot(signed, secret, { nowSec: NOW }), (e) => e.code === 'bad_sig');
    });

    it('rejects stale snapshots', () => {
        const signed = signSnapshot({ state, agentId: 'a1', tool: 'amend_checkout', seq: 1, serverSecret: secret, nowSec: NOW - 3600 });
        assert.throws(() => verifySnapshot(signed, secret, { nowSec: NOW, maxAgeSec: 600 }), (e) => e.code === 'stale_snapshot');
    });

    it('rejects replays via seq monotonicity', () => {
        const signed = signSnapshot({ state, agentId: 'a1', tool: 'amend_checkout', seq: 3, serverSecret: secret, nowSec: NOW });
        assert.throws(() => verifySnapshot(signed, secret, { nowSec: NOW, minSeq: 3 }), (e) => e.code === 'replay');
        const back = verifySnapshot(signed, secret, { nowSec: NOW, minSeq: 2 });
        assert.equal(back.seq, 3);
    });

    it('hashState is deterministic', () => {
        assert.equal(hashState(state), hashState(JSON.parse(JSON.stringify(state))));
    });
});
