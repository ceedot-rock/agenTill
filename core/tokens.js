/**
 * agentill / core/tokens.js
 *
 * TOKEN STRUCTURES (Node side — uses node:crypto).
 *
 * Three token families, mirroring the box's trust model:
 *   (a) identity  — generic ES256 JWT agent credentials (any issuer; the
 *                   merchant maps its own claim names, e.g. a Rider-style
 *                   agent_id/clearance/scopes shape via RIDER_PRESET in
 *                   core/identity.js)
 *   (b) payment   — x402 payment requirements / X-PAYMENT responses
 *   (c) state     — HMAC-signed checkout snapshots binding agent actions
 *                   to the shared checkout object
 *
 * Full spec: docs/token-structures.md
 */
import {
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    createSign,
    createVerify,
    generateKeyPairSync,
    randomBytes,
} from 'node:crypto';
import { canon } from './gates.js';

export class TokenError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TokenError';
        this.code = code;
    }
}

const b64urlEncode = (buf) => Buffer.from(buf).toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url');

/* ------------------------------------------------------------------ */
/* (a) agent identity — generic ES256 JWT credential                   */
/*                                                                     */
/* Default claims: { agent_id, iss, iat, exp, trust, scopes, jti }.     */
/* claimNames remaps them (e.g. trust:'clearance' for Rider-style JWTs);*/
/* trustMap translates a foreign trust vocabulary onto the box's       */
/* generic levels: 'open' < 'verified' < 'elevated'.                   */
/* ------------------------------------------------------------------ */

export const TRUST_LEVELS = ['open', 'verified', 'elevated'];

export function trustRank(level) {
    const i = TRUST_LEVELS.indexOf(level);
    return i === -1 ? -1 : i;
}

/** meetsTrust('verified', 'open') === true — have must be >= need. Pure. */
export function meetsTrust(have, need) {
    return trustRank(have) >= 0 && trustRank(need) >= 0 && trustRank(have) >= trustRank(need);
}

export function generateEs256Keypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        publicJwk: publicKey.export({ format: 'jwk' }),
        privateJwk: privateKey.export({ format: 'jwk' }),
    };
}

const DEFAULT_CLAIM_NAMES = { agentId: 'agent_id', trust: 'trust', scopes: 'scopes' };

/** Mint an agent JWT (ops/test helper — production mints at the merchant's issuer). */
export function mintAgentJwt({ privateJwk, agentId, trust = 'open', scopes = [], ttlSec = 900, issuer = 'agentill', claimNames = {}, nowSec = Math.floor(Date.now() / 1000) }) {
    const names = { ...DEFAULT_CLAIM_NAMES, ...claimNames };
    if (!TRUST_LEVELS.includes(trust)) throw new TokenError('bad_trust', `unknown trust level ${trust}`);
    const header = { alg: 'ES256', typ: 'JWT' };
    const payload = {
        [names.agentId]: agentId,
        iss: issuer,
        iat: nowSec,
        exp: nowSec + ttlSec,
        [names.trust]: trust,
        [names.scopes]: [...scopes].sort(),
        jti: randomBytes(8).toString('hex'),
    };
    const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
    const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
    const sig = createSign('SHA256').update(signingInput).sign(key);
    return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Verify an agent JWT. Throws TokenError on any failure (bad shape, bad alg,
 * bad signature, expired, missing claims). Returns the mapped claims:
 * { agentId, trust, scopes, iss, iat, exp, jti }.
 */
export function verifyAgentJwt(token, { publicJwk, issuer, claimNames = {}, trustMap = null, nowSec = Math.floor(Date.now() / 1000), skewSec = 60 } = {}) {
    const names = { ...DEFAULT_CLAIM_NAMES, ...claimNames };
    if (typeof token !== 'string' || token.split('.').length !== 3) {
        throw new TokenError('bad_shape', 'JWT must have three segments');
    }
    const [hB64, pB64, sB64] = token.split('.');
    let header, payload;
    try {
        header = JSON.parse(b64urlDecode(hB64).toString('utf8'));
        payload = JSON.parse(b64urlDecode(pB64).toString('utf8'));
    } catch {
        throw new TokenError('bad_encoding', 'JWT segments are not valid JSON');
    }
    if (header.alg !== 'ES256') throw new TokenError('bad_alg', `refusing alg ${header.alg}; only ES256 accepted`);
    if (!publicJwk) throw new TokenError('no_key', 'no verification key configured');

    const key = createPublicKey({ key: publicJwk, format: 'jwk' });
    const ok = createVerify('SHA256').update(`${hB64}.${pB64}`).verify(key, b64urlDecode(sB64));
    if (!ok) throw new TokenError('bad_signature', 'ES256 signature verification failed');

    if (typeof payload.exp !== 'number' || payload.exp + skewSec <= nowSec) {
        throw new TokenError('expired', 'JWT expired');
    }
    if (typeof payload.iat === 'number' && payload.iat - skewSec > nowSec) {
        throw new TokenError('not_yet_valid', 'JWT issued in the future');
    }
    const agentId = payload[names.agentId];
    if (!agentId || typeof agentId !== 'string') {
        throw new TokenError('no_agent', `JWT missing ${names.agentId}`);
    }
    let trust = payload[names.trust];
    if (trustMap) {
        if (trust == null || !(trust in trustMap)) {
            throw new TokenError('bad_trust', `trust value ${trust} not in trustMap`);
        }
        trust = trustMap[trust];
    }
    if (!TRUST_LEVELS.includes(trust)) {
        throw new TokenError('bad_trust', `unknown trust level ${trust}`);
    }
    if (issuer && payload.iss !== issuer) {
        throw new TokenError('bad_issuer', `expected issuer ${issuer}`);
    }
    const scopes = payload[names.scopes];
    return {
        agentId,
        iss: payload.iss,
        iat: payload.iat,
        exp: payload.exp,
        trust,
        scopes: Array.isArray(scopes) ? scopes : [],
        jti: payload.jti,
    };
}

/* ------------------------------------------------------------------ */
/* (b) x402 payment — requirements & X-PAYMENT                          */
/*                                                                     */
/* Follows the x402 wire shapes:                                       */
/*   402 response: { x402Version, error?, accepts: [PaymentRequirements] }*/
/*   PaymentRequirements: { scheme:"exact", network, payTo,             */
/*     maxAmountRequired (atomic units, string), asset, resource,       */
/*     description, mimeType, outputSchema, maxTimeoutSeconds }         */
/*   X-PAYMENT header: { x402Version, scheme, network,                  */
/*     payload: { signature, authorization: { from,to,value,            */
/*                validAfter,validBefore,nonce } } }                    */
/* ------------------------------------------------------------------ */

export const X402_VERSION = 1;

export function buildPaymentRequirements({ network, payTo, amountAtomic, asset, resource, description = '', maxTimeoutSeconds = 300, mimeType = 'application/json' }) {
    if (!network || !payTo || amountAtomic == null || !asset || !resource) {
        throw new TokenError('bad_requirements', 'network, payTo, amountAtomic, asset and resource are required');
    }
    return {
        x402Version: X402_VERSION,
        scheme: 'exact',
        network,
        payTo,
        maxAmountRequired: String(amountAtomic),
        asset,
        resource,
        description,
        mimeType,
        outputSchema: {
            type: 'object',
            properties: {
                signature: { type: 'string' },
                authorization: {
                    type: 'object',
                    properties: {
                        from: { type: 'string' },
                        to: { type: 'string' },
                        value: { type: 'string' },
                        validAfter: { type: 'string' },
                        validBefore: { type: 'string' },
                        nonce: { type: 'string' },
                    },
                },
            },
        },
        maxTimeoutSeconds,
    };
}

/** 402 envelope the middleware returns when payment is missing/insufficient. */
export function paymentRequiredBody(accepts) {
    const list = Array.isArray(accepts) ? accepts : [accepts];
    return { x402Version: X402_VERSION, error: 'payment required', accepts: list };
}

export function parseXPaymentHeader(value) {
    if (!value || typeof value !== 'string') throw new TokenError('no_payment', 'missing X-PAYMENT header');
    let doc;
    try {
        doc = JSON.parse(value);
    } catch {
        throw new TokenError('bad_payment', 'X-PAYMENT is not valid JSON');
    }
    const auth = doc && doc.payload && doc.payload.authorization;
    if (!doc || doc.scheme !== 'exact' || !doc.network || !doc.payload || !doc.payload.signature || !auth) {
        throw new TokenError('bad_payment', 'X-PAYMENT missing scheme/network/payload.signature/authorization');
    }
    for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
        if (auth[k] == null) throw new TokenError('bad_payment', `X-PAYMENT authorization missing ${k}`);
    }
    return doc;
}

/**
 * Structural verification of an X-PAYMENT against requirements.
 * Checks scheme/network/payee/amount/window — NOT the chain signature itself.
 * Pass verifySignature: async ({payment, requirements}) => boolean to also
 * check the signature against chain state (deployment hook).
 */
export async function verifyX402Payment(payment, requirements, { nowSec = Math.floor(Date.now() / 1000), verifySignature = null } = {}) {
    if (payment.scheme !== requirements.scheme) throw new TokenError('scheme_mismatch', 'payment scheme mismatch');
    if (payment.network !== requirements.network) throw new TokenError('network_mismatch', 'payment network mismatch');
    const auth = payment.payload.authorization;
    if (String(auth.to).toLowerCase() !== String(requirements.payTo).toLowerCase()) {
        throw new TokenError('payee_mismatch', 'payment payee does not match requirements');
    }
    if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
        throw new TokenError('underpaid', 'payment value below required amount');
    }
    const after = Number(auth.validAfter);
    const before = Number(auth.validBefore);
    if (!(after <= nowSec && nowSec <= before)) {
        throw new TokenError('stale_payment', 'payment outside validAfter/validBefore window');
    }
    if (verifySignature) {
        const ok = await verifySignature({ payment, requirements });
        if (!ok) throw new TokenError('bad_signature', 'on-chain signature verification failed');
    }
    return { ok: true, from: auth.from, value: auth.value, network: payment.network };
}

/* ------------------------------------------------------------------ */
/* (c) checkout state snapshots — signed, replay-safe                   */
/*                                                                     */
/* snapshot: { state, agent_id, tool, seq, iat, stateHash }             */
/* sig = HMAC-SHA256(serverSecret, canon(snapshot))                    */
/* ------------------------------------------------------------------ */

export function hashState(state) {
    return createHash('sha256').update(canon(state)).digest('hex');
}

export function signSnapshot({ state, agentId, tool, seq, serverSecret, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!serverSecret) throw new TokenError('no_secret', 'serverSecret required to sign snapshots');
    const snapshot = {
        state,
        agent_id: agentId,
        tool,
        seq: Math.trunc(seq),
        iat: nowSec,
        stateHash: createHash('sha256').update(canon(state)).digest('hex'),
    };
    const sig = createHmac('sha256', serverSecret).update(canon(snapshot)).digest('hex');
    return { snapshot, sig };
}

export function verifySnapshot(signed, serverSecret, { maxAgeSec = 600, nowSec = Math.floor(Date.now() / 1000), minSeq = null } = {}) {
    if (!signed || typeof signed !== 'object' || !signed.snapshot || !signed.sig) {
        throw new TokenError('bad_snapshot', 'malformed signed snapshot');
    }
    if (!serverSecret) throw new TokenError('no_secret', 'serverSecret required to verify snapshots');
    const { snapshot, sig } = signed;
    const expected = createHmac('sha256', serverSecret).update(canon(snapshot)).digest('hex');
    if (typeof sig !== 'string' || sig.length !== expected.length) {
        throw new TokenError('bad_sig', 'snapshot signature mismatch');
    }
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) throw new TokenError('bad_sig', 'snapshot signature mismatch');

    const actualHash = createHash('sha256').update(canon(snapshot.state)).digest('hex');
    if (actualHash !== snapshot.stateHash) throw new TokenError('hash_mismatch', 'snapshot stateHash does not match state');

    if (typeof snapshot.iat === 'number' && nowSec - snapshot.iat > maxAgeSec) {
        throw new TokenError('stale_snapshot', 'snapshot older than maxAgeSec');
    }
    if (minSeq != null && !(snapshot.seq > minSeq)) {
        throw new TokenError('replay', `snapshot seq ${snapshot.seq} not greater than ${minSeq}`);
    }
    return snapshot;
}
