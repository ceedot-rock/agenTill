/**
 * agentill / core/grants.js
 *
 * Capability grants: short-lived, merchant-signed scope
 * documents that authorize an agent for specific tools. The pure
 * scope check lives in core/gates.js (grantAllowsScope — EXACT-GATE);
 * this module handles issuance and HMAC verification (Node side).
 *
 * grant: { grant_id, agent_id, tools:[...], scopes:[...], iat, exp,
 *          issuer, sig }
 * sig = HMAC-SHA256(issuerSecret, canon(grant-without-sig))
 */
import { createHmac, randomBytes } from 'node:crypto';
import { canon, grantAllowsScope } from './gates.js';
import { TokenError } from './tokens.js';

export { grantAllowsScope };

function signGrantBody(body, issuerSecret) {
    return createHmac('sha256', issuerSecret).update(canon(body)).digest('hex');
}

export function issueGrant({ agentId, tools = [], scopes = [], ttlSec = 3600, issuer = 'merchant', issuerSecret, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!issuerSecret) throw new TokenError('no_secret', 'issuerSecret required to issue grants');
    if (!agentId) throw new TokenError('bad_grant', 'agentId required');
    const body = {
        grant_id: randomBytes(8).toString('hex'),
        agent_id: agentId,
        tools: [...tools].sort(),
        scopes: [...scopes].sort(),
        iat: nowSec,
        exp: nowSec + ttlSec,
        issuer,
    };
    return { ...body, sig: signGrantBody(body, issuerSecret) };
}

export function verifyGrant(grant, issuerSecret, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
    if (!grant || typeof grant !== 'object') throw new TokenError('bad_grant', 'malformed grant');
    if (!issuerSecret) throw new TokenError('no_secret', 'issuerSecret required to verify grants');
    const { sig, ...body } = grant;
    const expected = signGrantBody(body, issuerSecret);
    if (typeof sig !== 'string' || sig.length !== expected.length) throw new TokenError('bad_sig', 'grant signature mismatch');
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) throw new TokenError('bad_sig', 'grant signature mismatch');
    if (typeof body.exp === 'number' && nowSec > body.exp) throw new TokenError('expired', 'grant expired');
    if (!body.agent_id) throw new TokenError('bad_grant', 'grant missing agent_id');
    return body;
}
