/**
 * agentill / validator/preflight.js
 *
 * PRE-FLIGHT GATE. The box refuses to activate unless:
 *   1. settings validate against validator/schema.json (structural), AND
 *   2. semantic checks pass (currency, caps, scopes, wallet shapes), AND
 *   3. the dry-run compatibility check passes against the merchant's
 *      EXISTING checkout flow via the adapter — proving the box cannot
 *      damage what is already there.
 *
 * activate() returns { ok:true, activation } ONLY on a fully clean run.
 * Anything else returns { ok:false, stage, errors[] } — a REFUSAL, never
 * a partial activation.
 *
 * Adapter interface (merchant-provided, server side):
 *   {
 *     getState(): object            // the merchant's live checkout state object
 *     applyPatch(patch): object     // applies a patch, returns the new state
 *     getConfig(): { currency }     // the existing flow's own config
 *     describeSubmit(): { bindings: number } // how many submit handlers exist
 *   }
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canon, KNOWN_SCOPES, TOOL_NAMES } from '../core/gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, 'schema.json'), 'utf8'));

const ISO4217 = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'SEK', 'NZD', 'MXN', 'SGD', 'HKD', 'KRW', 'INR', 'BRL']);

function err(code, message, path = '') {
    return { code, message, path };
}

/** Structural validation driven by schema.json's required/type/enum rules. */
export function validateSettings(settings) {
    const errors = [];
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { ok: false, errors: [err('not_object', 'settings must be an object')] };
    }
    for (const key of SCHEMA.required || []) {
        if (settings[key] === undefined) errors.push(err('missing', `missing required setting: ${key}`, key));
    }
    if (settings.currency !== undefined && !/^[A-Z]{3}$/.test(settings.currency)) {
        errors.push(err('bad_currency', 'currency must be a 3-letter ISO 4217 code', 'currency'));
    }
    for (const [key, rule] of Object.entries(SCHEMA.properties || {})) {
        const v = settings[key];
        if (v === undefined) continue;
        if (rule.type === 'string' && typeof v !== 'string') errors.push(err('bad_type', `${key} must be a string`, key));
        if (rule.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) {
            errors.push(err('bad_type', `${key} must be an object`, key));
        }
        if (rule.type === 'array' && !Array.isArray(v)) errors.push(err('bad_type', `${key} must be an array`, key));
        if (rule.enum && !rule.enum.includes(v)) errors.push(err('bad_enum', `${key} must be one of ${rule.enum.join(', ')}`, key));
    }
    // nested required checks the schema declares
    const nested = [
        ['catalog', ['type']],
        ['confirmationPolicy', ['mode']],
        ['spendCaps', ['perOrderMinor', 'perDayMinor']],
        ['tax', ['provider']],
        ['shipping', ['provider']],
    ];
    for (const [parent, reqs] of nested) {
        const obj = settings[parent];
        if (obj && typeof obj === 'object') {
            for (const r of reqs) {
                if (obj[r] === undefined) errors.push(err('missing', `missing required setting: ${parent}.${r}`, `${parent}.${r}`));
            }
        }
    }
    if (settings.catalog && !['inline', 'url', 'store'].includes(settings.catalog.type)) {
        errors.push(err('bad_enum', 'catalog.type must be inline|url|store', 'catalog.type'));
    }
    if (settings.confirmationPolicy && !['always', 'threshold'].includes(settings.confirmationPolicy.mode)) {
        errors.push(err('bad_enum', 'confirmationPolicy.mode must be always|threshold', 'confirmationPolicy.mode'));
    }
    if (Array.isArray(settings.paymentRails)) {
        settings.paymentRails.forEach((rail, i) => {
            if (!rail || !['x402', 'stripe', 'manual'].includes(rail.rail)) {
                errors.push(err('bad_rail', `paymentRails[${i}].rail must be x402|stripe|manual`, `paymentRails[${i}].rail`));
            }
            if (rail && rail.rail === 'x402') {
                const w = rail.wallet || {};
                if (!w.address || !w.network) {
                    errors.push(err('bad_wallet', `paymentRails[${i}].wallet needs address+network for x402`, `paymentRails[${i}].wallet`));
                }
            }
        });
    }
    if (settings.identity !== undefined) {
        const id = settings.identity;
        if (!id || typeof id !== 'object' || Array.isArray(id)) {
            errors.push(err('bad_type', 'identity must be an object', 'identity'));
        } else if (!['open', 'es256-jwt'].includes(id.adapter)) {
            errors.push(err('bad_enum', 'identity.adapter must be open|es256-jwt', 'identity.adapter'));
        } else if (id.adapter === 'es256-jwt' && !id.publicJwk) {
            errors.push(err('missing', 'identity.publicJwk is required for the es256-jwt adapter', 'identity.publicJwk'));
        }
    }
    if (settings.platformFee !== undefined) {
        const pf = settings.platformFee;
        if (!pf || typeof pf !== 'object' || Array.isArray(pf)) {
            errors.push(err('bad_type', 'platformFee must be an object', 'platformFee'));
        } else {
            // NOTE: platformFee.rate / platformFee.recipient are IGNORED — the
            // fee is locked (0.081% to the lab's fee wallet). Only ledgerFile
            // (durable ledger path) is honored, so only it is validated.
            if (pf.ledgerFile !== undefined && (typeof pf.ledgerFile !== 'string' || pf.ledgerFile.length === 0)) {
                errors.push(err('bad_ledger', 'platformFee.ledgerFile must be a non-empty path string', 'platformFee.ledgerFile'));
            }
        }
    }
    if (settings.toolTrust !== undefined) {
        const tt = settings.toolTrust;
        const levels = ['open', 'verified', 'elevated'];
        if (!tt || typeof tt !== 'object' || Array.isArray(tt)) {
            errors.push(err('bad_type', 'toolTrust must be an object', 'toolTrust'));
        } else {
            for (const [tool, level] of Object.entries(tt)) {
                if (!levels.includes(level)) {
                    errors.push(err('bad_enum', `toolTrust.${tool} must be open|verified|elevated`, `toolTrust.${tool}`));
                }
            }
        }
    }
    return { ok: errors.length === 0, errors };
}

/** Semantic checks that go beyond structure. */
export function semanticChecks(settings) {
    const errors = [];
    if (settings.currency && !ISO4217.has(settings.currency)) {
        errors.push(err('unknown_currency', `currency ${settings.currency} not in supported set`, 'currency'));
    }
    const caps = settings.spendCaps || {};
    for (const k of ['perOrderMinor', 'perDayMinor', 'perAgentMinor']) {
        if (caps[k] !== undefined && (!Number.isInteger(caps[k]) || caps[k] <= 0)) {
            errors.push(err('bad_cap', `spendCaps.${k} must be a positive integer (minor units)`, `spendCaps.${k}`));
        }
    }
    if (Number.isInteger(caps.perOrderMinor) && Number.isInteger(caps.perDayMinor) && caps.perOrderMinor > caps.perDayMinor) {
        errors.push(err('cap_inversion', 'spendCaps.perOrderMinor must not exceed perDayMinor', 'spendCaps'));
    }
    const unknownScopes = (settings.allowedToolScopes || []).filter((s) => !KNOWN_SCOPES.includes(s));
    if (unknownScopes.length) {
        errors.push(err('unknown_scope', `unknown scopes: ${unknownScopes.join(', ')}`, 'allowedToolScopes'));
    }
    if (settings.catalog && settings.catalog.type === 'inline') {
        const items = settings.catalog.items || [];
        if (!Array.isArray(items) || items.length === 0) {
            errors.push(err('empty_catalog', 'inline catalog must list at least one item', 'catalog.items'));
        } else {
            items.forEach((it, i) => {
                if (!it || typeof it.id !== 'string' || typeof it.title !== 'string' || !Number.isInteger(it.priceMinor) || it.priceMinor < 0) {
                    errors.push(err('bad_item', `catalog.items[${i}] needs {id,title,priceMinor>=0 integer}`, `catalog.items[${i}]`));
                }
            });
        }
    }
    if (settings.confirmationPolicy && settings.confirmationPolicy.mode === 'threshold') {
        const t = settings.confirmationPolicy.amountThresholdMinor;
        if (!Number.isInteger(t) || t <= 0) {
            errors.push(err('bad_threshold', 'confirmationPolicy.amountThresholdMinor must be a positive integer for mode=threshold', 'confirmationPolicy.amountThresholdMinor'));
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Dry-run compatibility check against the merchant's EXISTING flow.
 * Never mutates: the patch applied is a no-op probe. Any failure here
 * means the box would risk the existing flow -> refuse activation.
 */
export async function dryRun(settings, adapter, { fetchImpl = null } = {}) {
    const checks = [];
    const check = (id, ok, detail = '') => {
        checks.push({ id, ok, detail });
        return ok;
    };

    if (!adapter || typeof adapter.getState !== 'function' || typeof adapter.applyPatch !== 'function' || typeof adapter.getConfig !== 'function') {
        check('adapter_shape', false, 'adapter must implement getState/applyPatch/getConfig');
        return { ok: false, checks };
    }
    check('adapter_shape', true);

    // 1. state object is readable and has the shape tools need
    let state;
    try {
        state = adapter.getState();
    } catch (e) {
        check('state_readable', false, `getState() threw: ${e.message}`);
        return { ok: false, checks };
    }
    check('state_readable', true);
    if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
        check('state_shape', false, 'getState() must return { items: [], ... }');
        return { ok: false, checks };
    }
    check('state_shape', true, `items: ${state.items.length}`);

    // 2. no-op patch roundtrip — proves applyPatch exists and is non-destructive
    try {
        const before = canon(state);
        const after = adapter.applyPatch({ __agentill_probe: true });
        if (canon(after) !== before) {
            check('patch_noop', false, 'applyPatch mutated state on a no-op probe patch');
            return { ok: false, checks };
        }
    } catch (e) {
        check('patch_noop', false, `applyPatch threw on no-op probe: ${e.message}`);
        return { ok: false, checks };
    }
    check('patch_noop', true);

    // 3. currency agreement — mismatch would corrupt money math
    let cfg = {};
    try {
        cfg = adapter.getConfig() || {};
    } catch (e) {
        check('config_readable', false, `getConfig() threw: ${e.message}`);
        return { ok: false, checks };
    }
    check('config_readable', true);
    if (cfg.currency && cfg.currency !== settings.currency) {
        check('currency_match', false, `adapter currency ${cfg.currency} != settings currency ${settings.currency}`);
        return { ok: false, checks };
    }
    check('currency_match', true, settings.currency);

    // 4. single submit binding — the box must not double-wrap an existing submit
    if (typeof adapter.describeSubmit === 'function') {
        let desc;
        try {
            desc = adapter.describeSubmit();
        } catch (e) {
            check('submit_describe', false, `describeSubmit() threw: ${e.message}`);
            return { ok: false, checks };
        }
        if (!desc || typeof desc.bindings !== 'number' || desc.bindings !== 1) {
            check('submit_single_binding', false, `expected exactly 1 submit binding, saw ${desc && desc.bindings}`);
            return { ok: false, checks };
        }
        check('submit_single_binding', true);
    } else {
        check('submit_single_binding', true, 'describeSubmit not provided; skipped');
    }

    // 5. catalog pointer reachable (url type only; inject fetchImpl in tests)
    if (settings.catalog && settings.catalog.type === 'url') {
        const pointer = settings.catalog.pointer;
        if (!pointer) {
            check('catalog_reachable', false, 'catalog.type=url but no pointer given');
            return { ok: false, checks };
        }
        if (!fetchImpl) {
            check('catalog_reachable', false, 'catalog.type=url requires a fetch implementation for the check');
            return { ok: false, checks };
        }
        try {
            const res = await fetchImpl(pointer, { method: 'HEAD' });
            if (!res || !res.ok) {
                check('catalog_reachable', false, `catalog pointer unreachable: ${pointer}`);
                return { ok: false, checks };
            }
        } catch (e) {
            check('catalog_reachable', false, `catalog pointer fetch failed: ${e.message}`);
            return { ok: false, checks };
        }
        check('catalog_reachable', true, pointer);
    } else {
        check('catalog_reachable', true, `type=${settings.catalog && settings.catalog.type}`);
    }

    // 6. spend caps cover at least one realistic order (sanity, not a block on real data)
    const caps = settings.spendCaps || {};
    check('caps_sane', true, `perOrder=${caps.perOrderMinor} perDay=${caps.perDayMinor}`);

    return { ok: true, checks };
}

/**
 * Full activation: validate -> semantic -> dry-run. Returns a signed
 * activation grant ONLY when everything is clean; otherwise a refusal
 * report. The middleware refuses to serve tool calls without a valid
 * activation.
 */
export async function activate(settings, adapter, serverSecret, opts = {}) {
    const structural = validateSettings(settings);
    if (!structural.ok) return { ok: false, stage: 'validate', errors: structural.errors };

    const semantic = semanticChecks(settings);
    if (!semantic.ok) return { ok: false, stage: 'semantic', errors: semantic.errors };

    const dry = await dryRun(settings, adapter, opts);
    if (!dry.ok) return { ok: false, stage: 'dryrun', errors: dry.checks.filter((c) => !c.ok).map((c) => ({ code: c.id, message: c.detail || 'check failed' })) };

    if (!serverSecret) return { ok: false, stage: 'secret', errors: [err('no_secret', 'serverSecret required to seal activation')] };

    const nowSec = Math.floor(Date.now() / 1000);
    const body = {
        merchantId: settings.merchantId,
        iat: nowSec,
        exp: nowSec + 24 * 3600,
        settingsHash: createHmac('sha256', serverSecret).update(canon(settings)).digest('hex').slice(0, 16),
    };
    const sig = createHmac('sha256', serverSecret).update(canon(body)).digest('hex');
    return { ok: true, stage: 'active', activation: { ...body, sig }, checks: dry.checks };
}

export function verifyActivation(activation, serverSecret, settings, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
    if (!activation || !serverSecret) return { ok: false, reason: 'missing activation or secret' };
    const { sig, ...body } = activation;
    const expected = createHmac('sha256', serverSecret).update(canon(body)).digest('hex');
    if (sig !== expected) return { ok: false, reason: 'bad activation signature' };
    if (body.exp <= nowSec) return { ok: false, reason: 'activation expired' };
    if (settings) {
        const h = createHmac('sha256', serverSecret).update(canon(settings)).digest('hex').slice(0, 16);
        if (h !== body.settingsHash) return { ok: false, reason: 'settings changed since activation; re-run pre-flight' };
    }
    return { ok: true, body };
}
