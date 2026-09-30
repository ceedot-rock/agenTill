/**
 * agentill / core/identity.js
 *
 * PLUGGABLE AGENT IDENTITY.
 *
 * The box never hard-requires one identity system. The merchant picks an
 * identity adapter in settings.identity:
 *
 *   { adapter: 'open' }                                // default: any agent, self-asserted id
 *   { adapter: 'es256-jwt', publicJwk, issuer?, ... }  // generic signed-JWT identity
 *
 * Adapter interface:
 *   {
 *     id: string,            // 'open' | 'es256-jwt' | custom
 *     description: string,
 *     verifyIdentity({ credential, tool, settings, nowSec })
 *       -> { ok:true, agentId, scopes:[...], trust }
 *        | { ok:false, code, message }
 *   }
 *
 * Trust levels are generic: 'open' < 'verified' < 'elevated'. Each tool has
 * a minimum trust (settings.toolTrust, defaults below). The real guard on
 * money movement is buyer confirmation, not identity — so the default lets
 * any agent drive the full flow, and merchants raise trust levels or plug
 * in signed JWTs when they want stronger agent identity.
 *
 * A vendor-specific system (e.g. Rider JWTs) is just a configuration of the
 * generic es256-jwt adapter — see RIDER_PRESET. It is never required.
 */
import { verifyAgentJwt, meetsTrust, TRUST_LEVELS } from './tokens.js';

export { TRUST_LEVELS, meetsTrust };

/**
 * Default minimum trust per tool. All 'open': buyer confirmation — not
 * identity — is what guards money, and seal_order always requires it.
 */
export const TOOL_TRUST_DEFAULT = {
    browse_catalog: 'open',
    read_checkout: 'open',
    amend_checkout: 'open',
    seal_order: 'open',
};

/** 'open' adapter: any agent may call. The agent asserts its own id. */
export function openIdentity() {
    return {
        id: 'open',
        description: 'Any agent may call. The agent asserts its own id; scopes come from the credential or default to none.',
        async verifyIdentity({ credential }) {
            const c = credential && typeof credential === 'object' ? credential : {};
            const agentId = c.agentId || c.agent_id || 'anonymous';
            const scopes = Array.isArray(c.scopes) ? c.scopes : [];
            return { ok: true, agentId: String(agentId), scopes, trust: 'open' };
        },
    };
}

/**
 * 'es256-jwt' adapter: generic ES256 JWT agent identity. The merchant
 * supplies the verification key and the claim mapping; foreign trust
 * vocabularies map through trustMap (see RIDER_PRESET).
 */
export function es256JwtIdentity(opts = {}) {
    const { publicJwk, issuer, claimNames, trustMap, skewSec } = opts;
    if (!publicJwk) throw new Error("es256-jwt identity adapter needs { publicJwk }");
    return {
        id: 'es256-jwt',
        description: 'Generic ES256 JWT agent identity. The merchant supplies the verification key and claim mapping.',
        async verifyIdentity({ credential, nowSec = Math.floor(Date.now() / 1000) }) {
            try {
                const claims = verifyAgentJwt(credential, { publicJwk, issuer, claimNames, trustMap, nowSec, skewSec });
                return { ok: true, agentId: claims.agentId, scopes: claims.scopes, trust: claims.trust };
            } catch (e) {
                return { ok: false, code: e.code || 'bad_credential', message: e.message };
            }
        },
    };
}

/**
 * RIDER_PRESET — one OPTIONAL configuration of the generic es256-jwt
 * adapter, for merchants whose agents carry Rider JWTs
 * (agent_id, clearance L0–L4, scopes):
 *
 *   settings.identity = {
 *     adapter: 'es256-jwt',
 *     publicJwk: <issuer public JWK>,
 *     issuer: 'rider',
 *     ...RIDER_PRESET,
 *   }
 */
export const RIDER_PRESET = {
    claimNames: { agentId: 'agent_id', trust: 'clearance', scopes: 'scopes' },
    trustMap: { L0: 'open', L1: 'open', L2: 'verified', L3: 'verified', L4: 'elevated' },
};

/** Pick the adapter from settings.identity (default: 'open'). */
export function identityAdapterFor(settings) {
    const cfg = (settings && settings.identity) || { adapter: 'open' };
    if (cfg.adapter === 'open') return openIdentity();
    if (cfg.adapter === 'es256-jwt') return es256JwtIdentity(cfg);
    throw new Error(`unknown identity adapter: ${cfg.adapter}`);
}

/** Per-tool minimum trust, merchant-overridable via settings.toolTrust. */
export function toolTrustFor(settings) {
    return { ...TOOL_TRUST_DEFAULT, ...((settings && settings.toolTrust) || {}) };
}
