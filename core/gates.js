/**
 * agentill / core/gates.js
 *
 * EXACTNESS-GATED DECISION PATHS.
 *
 * Every function in this file is PURE and DETERMINISTIC:
 *   - same inputs  -> same outputs, byte-for-byte (compared via canon())
 *   - no Date.now(), no Math.random(), no I/O, no network, no exceptions for
 *     control flow (refusals are returned as { ok:false, error } objects)
 *   - safe to run on any seat; the exactness gate replays inputs and demands
 *     identical outputs, or the path REFUSES.
 *
 * This file has ZERO imports and no platform APIs, so the browser SDK can load
 * it verbatim with a <script> tag and evaluate the same gates client-side.
 *
 * Conventions:
 *   - money is integer minor units (cents) — never floats
 *   - timestamps are integer seconds, always passed in by the caller
 *   - every gate is listed in GATE_REGISTRY below
 */

/* EXACT-GATE: canon — canonical JSON, the byte-equality basis for every gate */
export function canon(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

/* EXACT-GATE: deepEqual — structural equality via canonical form */
export function deepEqual(a, b) {
    return canon(a) === canon(b);
}

/**
 * The box's four agent tools. `browse_catalog` is the
 * product-discovery tool; the other three bind to the shared checkout object.
 */
export const TOOL_NAMES = ['browse_catalog', 'read_checkout', 'amend_checkout', 'seal_order'];

export const KNOWN_SCOPES = [
    'read:catalog',
    'read:checkout',
    'write:cart',
    'write:address',
    'write:shipping',
    'write:payment',
    'write:discount',
    'submit:order',
];

/* EXACT-GATE: tool.allowlist — is this tool call permitted by merchant policy? */
export function evaluateToolAllowlist(input) {
    const { tool, scopes, policy } = input || {};
    const scopeList = Array.isArray(scopes) ? [...scopes].sort() : [];
    const allowedTools = (policy && policy.allowedTools) || [];
    const disabledTools = (policy && policy.disabledTools) || [];
    const toolScopes = (policy && policy.toolScopes) || {};

    if (typeof tool !== 'string' || tool.length === 0) {
        return { allowed: false, reason: 'missing tool name' };
    }
    if (disabledTools.includes(tool)) {
        return { allowed: false, reason: `tool disabled by merchant policy: ${tool}` };
    }
    if (!allowedTools.includes(tool)) {
        return { allowed: false, reason: `tool not in merchant allow-list: ${tool}` };
    }
    const required = [...(toolScopes[tool] || [])].sort();
    const missing = required.filter((s) => !scopeList.includes(s));
    if (missing.length > 0) {
        return { allowed: false, reason: `missing scopes for ${tool}: ${missing.join(', ')}` };
    }
    return { allowed: true, reason: 'ok', grantedScopes: required };
}

/**
 * Which fields of a checkout patch move money or identity. Anything in this
 * set forces buyer confirmation on amend_checkout.
 */
/* EXACT-GATE: checkout.confirmation — does this action need the buyer? */
export function confirmationRequired(input) {
    const { tool, action, policy, state } = input || {};
    const conf = (policy && policy.confirmation) || { mode: 'always' };
    const patch = (action && action.patch) || {};
    const amountMinor = (action && action.amountMinor) || 0;

    if (tool === 'seal_order') {
        return {
            required: true,
            level: 'buyer',
            reason: 'order submission always requires buyer confirmation',
        };
    }

    const MONEY_FIELDS = ['items', 'shippingMethod', 'discountCode', 'address', 'paymentMethod', 'totals'];
    const touched = Object.keys(patch);
    const touchesMoney = touched.some((k) => MONEY_FIELDS.includes(k));

    if (tool === 'amend_checkout' && touchesMoney) {
        return {
            required: true,
            level: 'buyer',
            reason: `update touches money/identity fields: ${touched.filter((k) => MONEY_FIELDS.includes(k)).join(', ')}`,
        };
    }

    if (conf.mode === 'threshold' && amountMinor >= (conf.amountThresholdMinor || 0) && amountMinor > 0) {
        return {
            required: true,
            level: 'buyer',
            reason: `amount ${amountMinor} meets confirmation threshold ${conf.amountThresholdMinor}`,
        };
    }

    const stepUp = conf.stepUpTools || [];
    if (stepUp.includes(tool) || (action && action.requiresStepUp === true)) {
        return {
            required: true,
            level: 'stepup',
            reason: 'hand back to buyer: step-up authentication required (e.g. 3-D Secure)',
        };
    }

    // read-only tools never need confirmation
    if (tool === 'read_checkout' || tool === 'browse_catalog') {
        return { required: false, level: 'none', reason: 'read-only tool' };
    }

    if (conf.mode === 'always' && tool === 'amend_checkout') {
        return { required: true, level: 'buyer', reason: 'merchant confirmation policy: always' };
    }

    return { required: false, level: 'none', reason: 'no confirmation triggers matched' };
}

export const CHECKOUT_STATUSES = ['cart', 'details', 'payment', 'review', 'submitted', 'cancelled'];

const TRANSITIONS = {
    // 'submit' is legal from any live status: the submit branch itself
    // enforces buyer confirmation + checkout completeness.
    cart: ['add_item', 'remove_item', 'apply_discount', 'set_address', 'cancel', 'begin_details', 'submit'],
    details: ['set_address', 'set_shipping', 'add_item', 'remove_item', 'apply_discount', 'cancel', 'begin_payment', 'submit'],
    payment: ['set_payment', 'set_address', 'set_shipping', 'add_item', 'remove_item', 'cancel', 'begin_review', 'submit'],
    review: ['buyer_confirm', 'set_payment', 'set_address', 'set_shipping', 'add_item', 'remove_item', 'cancel', 'submit'],
    submitted: [],
    cancelled: [],
};

/* EXACT-GATE: checkout.transition — pure checkout state machine */
export function transitionCheckoutState(state, action) {
    const s = state || {};
    const a = action || {};
    const status = s.status || 'cart';
    const type = a.type;

    if (!CHECKOUT_STATUSES.includes(status)) {
        return { ok: false, error: { code: 'bad_status', message: `unknown status: ${status}` } };
    }
    const allowed = TRANSITIONS[status] || [];
    if (!allowed.includes(type)) {
        return {
            ok: false,
            error: { code: 'illegal_transition', message: `action ${type} not allowed from status ${status}` },
        };
    }
    if (type === 'submit') {
        if (s.buyerConfirmed !== true) {
            return {
                ok: false,
                error: { code: 'confirmation_missing', message: 'submit refused: buyer confirmation missing' },
            };
        }
        // The four checkout tools carry no lifecycle steps, so submission is
        // allowed from any live status — but only when the shared checkout
        // object is complete. The merchant's own UI may still advance status.
        const missing = [];
        if (!Array.isArray(s.items) || s.items.length === 0) missing.push('items');
        if (!s.address) missing.push('address');
        if (!s.shippingMethod) missing.push('shippingMethod');
        if (!s.paymentMethod) missing.push('paymentMethod');
        if (missing.length > 0) {
            return {
                ok: false,
                error: { code: 'inseal_order', message: `submit refused: missing ${missing.join(', ')}` },
            };
        }
        return { ok: true, state: { ...s, status: 'submitted' } };
    }
    if (type === 'cancel') {
        return { ok: true, state: { ...s, status: 'cancelled' } };
    }
    if (type === 'buyer_confirm') {
        return { ok: true, state: { ...s, buyerConfirmed: true } };
    }
    if (type === 'begin_details') return { ok: true, state: { ...s, status: 'details' } };
    if (type === 'begin_payment') return { ok: true, state: { ...s, status: 'payment' } };
    if (type === 'begin_review') return { ok: true, state: { ...s, status: 'review' } };

    // item/address/shipping/payment/discount mutations return a new state;
    // totals are recomputed deterministically by recomputeTotals().
    const next = { ...s, ...(a.patch || {}) };
    if (type === 'add_item' || type === 'remove_item' || type === 'apply_discount' || type === 'set_shipping') {
        const t = recomputeTotals(next, a.policy || {});
        if (!t.ok) return t;
        next.totals = t.totals;
    }
    return { ok: true, state: next };
}

/* EXACT-GATE: checkout.totals — deterministic money math, integer minor units */
export function recomputeTotals(state, policy) {
    const items = Array.isArray(state.items) ? state.items : [];
    let subtotal = 0;
    for (const it of items) {
        const qty = Math.trunc(Number(it.qty) || 0);
        const price = Math.trunc(Number(it.priceMinor) || 0);
        if (qty < 0 || price < 0) {
            return { ok: false, error: { code: 'bad_money', message: 'negative qty or price refused' } };
        }
        subtotal += qty * price;
    }
    const discountMinor = Math.trunc(Number((state.discount && state.discount.amountMinor) || 0));
    const shippingMinor = Math.trunc(Number((state.shipping && state.shipping.priceMinor) || 0));
    const taxRateBps = Math.trunc(Number((policy && policy.taxRateBps) || 0));
    const taxable = Math.max(0, subtotal - discountMinor);
    const taxMinor = Math.trunc((taxable * taxRateBps) / 10000);
    const totalMinor = Math.max(0, taxable + taxMinor + shippingMinor);
    return {
        ok: true,
        totals: { subtotalMinor: subtotal, discountMinor, taxMinor, shippingMinor, totalMinor, currency: state.currency || 'USD' },
    };
}

/* EXACT-GATE: grant.scope — pure capability-grant scope check (expiry via caller-supplied now) */
export function grantAllowsScope(grant, tool, scope, nowSec) {
    if (!grant || typeof grant !== 'object') return { allowed: false, reason: 'no grant' };
    if (typeof nowSec === 'number' && typeof grant.exp === 'number' && nowSec > grant.exp) {
        return { allowed: false, reason: 'grant expired' };
    }
    const tools = grant.tools || [];
    const scopes = grant.scopes || [];
    if (!(tools.includes(tool) || tools.includes('*'))) {
        return { allowed: false, reason: `grant does not cover tool ${tool}` };
    }
    if (!(scopes.includes(scope) || scopes.includes('*'))) {
        return { allowed: false, reason: `grant does not cover scope ${scope}` };
    }
    return { allowed: true, reason: 'ok' };
}

/* EXACT-GATE: registry — every exactness-gated path, in one place */
export const GATE_REGISTRY = [
    { id: 'canon', fn: 'canon' },
    { id: 'tool.allowlist', fn: 'evaluateToolAllowlist' },
    { id: 'checkout.confirmation', fn: 'confirmationRequired' },
    { id: 'checkout.transition', fn: 'transitionCheckoutState' },
    { id: 'checkout.totals', fn: 'recomputeTotals' },
    { id: 'grant.scope', fn: 'grantAllowsScope' },
];

/**
 * Determinism self-check: run every gate twice over a fixed battery and
 * demand byte-identical outputs. Returns { ok, cases } — ok:false REFUSES.
 */
/* EXACT-GATE: selfcheck */
export function determinismSelfCheck() {
    const policy = {
        allowedTools: [...TOOL_NAMES],
        disabledTools: [],
        toolScopes: {
            browse_catalog: ['read:catalog'],
            read_checkout: ['read:checkout'],
            amend_checkout: ['write:cart', 'write:shipping'],
            seal_order: ['submit:order'],
        },
        confirmation: { mode: 'always' },
        taxRateBps: 875,
    };
    const cases = [
        ['tool.allowlist', () => evaluateToolAllowlist({ tool: 'amend_checkout', scopes: ['write:cart', 'write:shipping'], policy })],
        ['tool.allowlist.deny', () => evaluateToolAllowlist({ tool: 'seal_order', scopes: ['write:cart'], policy })],
        ['checkout.confirmation', () => confirmationRequired({ tool: 'seal_order', action: { patch: {} }, policy, state: {} })],
        ['checkout.confirmation.read', () => confirmationRequired({ tool: 'read_checkout', action: {}, policy, state: {} })],
        ['checkout.transition', () => transitionCheckoutState(
            { status: 'cart', items: [{ qty: 2, priceMinor: 1999 }], currency: 'USD' },
            { type: 'add_item', patch: { items: [{ qty: 2, priceMinor: 1999 }] }, policy }
        )],
        ['checkout.transition.refuse', () => transitionCheckoutState({ status: 'cart', buyerConfirmed: false }, { type: 'submit' })],
        ['checkout.totals', () => recomputeTotals({ items: [{ qty: 1, priceMinor: 5000 }], currency: 'USD' }, policy)],
        ['grant.scope', () => grantAllowsScope(
            { tools: ['amend_checkout'], scopes: ['write:cart'], exp: 2000000000 }, 'amend_checkout', 'write:cart', 1000000000
        )],
    ];
    const results = [];
    for (const [name, fn] of cases) {
        const a = canon(fn());
        const b = canon(fn());
        const pass = a === b;
        results.push({ name, pass, output: JSON.parse(a) });
        if (!pass) return { ok: false, cases: results };
    }
    return { ok: true, cases: results };
}
