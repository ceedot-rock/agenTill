import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    openIdentity,
    es256JwtIdentity,
    identityAdapterFor,
    toolTrustFor,
    RIDER_PRESET,
    TRUST_LEVELS,
    meetsTrust,
} from '../core/identity.js';
import { generateEs256Keypair, mintAgentJwt } from '../core/tokens.js';

const NOW = 1800000000;

describe('identity adapters', () => {
    it('open adapter accepts any agent with a self-asserted id', async () => {
        const a = openIdentity();
        assert.equal(a.id, 'open');
        const ok = await a.verifyIdentity({ credential: { agentId: 'shopper-1', scopes: ['read:catalog'] } });
        assert.equal(ok.ok, true);
        assert.equal(ok.agentId, 'shopper-1');
        assert.equal(ok.trust, 'open');
        assert.deepEqual(ok.scopes, ['read:catalog']);
    });

    it('open adapter defaults missing credentials to anonymous', async () => {
        const a = openIdentity();
        const ok = await a.verifyIdentity({ credential: null });
        assert.equal(ok.ok, true);
        assert.equal(ok.agentId, 'anonymous');
    });

    it('es256-jwt adapter verifies generic JWTs', async () => {
        const { publicJwk, privateJwk } = generateEs256Keypair();
        const a = es256JwtIdentity({ publicJwk });
        const tok = mintAgentJwt({ privateJwk, agentId: 'agent-7', trust: 'verified', scopes: ['read:catalog'], nowSec: NOW });
        const ok = await a.verifyIdentity({ credential: tok, nowSec: NOW });
        assert.equal(ok.ok, true);
        assert.equal(ok.agentId, 'agent-7');
        assert.equal(ok.trust, 'verified');
    });

    it('es256-jwt adapter rejects bad tokens with ok:false (never throws)', async () => {
        const { publicJwk } = generateEs256Keypair();
        const a = es256JwtIdentity({ publicJwk });
        const bad = await a.verifyIdentity({ credential: 'not-a-jwt', nowSec: NOW });
        assert.equal(bad.ok, false);
        assert.ok(bad.code);
    });

    it('es256-jwt adapter requires a public key at construction', () => {
        assert.throws(() => es256JwtIdentity({}), /publicJwk/);
    });

    it('RIDER_PRESET maps Rider-shaped JWTs onto generic trust', async () => {
        const { publicJwk, privateJwk } = generateEs256Keypair();
        const { createPrivateKey, createSign } = await import('node:crypto');
        const b64u = (b) => Buffer.from(b).toString('base64url');
        const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
        const payload = b64u(JSON.stringify({
            agent_id: 'rider-1', iss: 'rider', iat: NOW, exp: NOW + 900,
            clearance: 'L3', scopes: ['read:catalog'], jti: 'j',
        }));
        const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
        const sig = b64u(createSign('SHA256').update(`${header}.${payload}`).sign(key));
        const a = es256JwtIdentity({ publicJwk, issuer: 'rider', ...RIDER_PRESET });
        const ok = await a.verifyIdentity({ credential: `${header}.${payload}.${sig}`, nowSec: NOW });
        assert.equal(ok.ok, true);
        assert.equal(ok.agentId, 'rider-1');
        assert.equal(ok.trust, 'verified'); // L3 -> verified
    });

    it('RIDER_PRESET rejects unmapped trust values', async () => {
        const { publicJwk, privateJwk } = generateEs256Keypair();
        const { createPrivateKey, createSign } = await import('node:crypto');
        const b64u = (b) => Buffer.from(b).toString('base64url');
        const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
        const payload = b64u(JSON.stringify({
            agent_id: 'rider-1', iss: 'rider', iat: NOW, exp: NOW + 900,
            clearance: 'L9', scopes: [], jti: 'j',
        }));
        const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
        const sig = b64u(createSign('SHA256').update(`${header}.${payload}`).sign(key));
        const a = es256JwtIdentity({ publicJwk, issuer: 'rider', ...RIDER_PRESET });
        const bad = await a.verifyIdentity({ credential: `${header}.${payload}.${sig}`, nowSec: NOW });
        assert.equal(bad.ok, false);
        assert.equal(bad.code, 'bad_trust');
    });

    it('identityAdapterFor defaults to open and rejects unknown adapters', () => {
        assert.equal(identityAdapterFor({}).id, 'open');
        assert.equal(identityAdapterFor({ identity: { adapter: 'open' } }).id, 'open');
        assert.throws(() => identityAdapterFor({ identity: { adapter: 'nope' } }), /unknown identity adapter/);
    });

    it('toolTrustFor defaults all tools to open and merges overrides', () => {
        const t = toolTrustFor({});
        assert.deepEqual(Object.keys(t).sort(), ['amend_checkout', 'browse_catalog', 'read_checkout', 'seal_order']);
        assert.ok(Object.values(t).every((v) => v === 'open'));
        const t2 = toolTrustFor({ toolTrust: { seal_order: 'elevated' } });
        assert.equal(t2.seal_order, 'elevated');
        assert.equal(t2.browse_catalog, 'open');
    });

    it('trust levels order open < verified < elevated', () => {
        assert.deepEqual(TRUST_LEVELS, ['open', 'verified', 'elevated']);
        assert.equal(meetsTrust('open', 'open'), true);
        assert.equal(meetsTrust('elevated', 'open'), true);
        assert.equal(meetsTrust('open', 'elevated'), false);
    });
});
