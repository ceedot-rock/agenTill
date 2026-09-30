import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    canon,
    deepEqual,
    TOOL_NAMES,
    KNOWN_SCOPES,
    evaluateToolAllowlist,
    confirmationRequired,
    transitionCheckoutState,
    recomputeTotals,
    grantAllowsScope,
    determinismSelfCheck,
    GATE_REGISTRY,
} from '../core/gates.js';

const policy = () => ({
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
});

describe('canon', () => {
    it('is key-order independent and deterministic', () => {
        assert.equal(canon({ b: 1, a: 2 }), canon({ a: 2, b: 1 }));
        assert.equal(canon({ x: [3, 2] }), canon({ x: [3, 2] }));
        assert.ok(deepEqual({ a: 1 }, { a: 1 }));
        assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
    });
});

describe('tool.allowlist', () => {
    it('allows a fully-scoped tool', () => {
        const r = evaluateToolAllowlist({ tool: 'amend_checkout', scopes: ['write:cart', 'write:shipping'], policy: policy() });
        assert.equal(r.allowed, true);
    });

    it('denies unknown tools', () => {
        const r = evaluateToolAllowlist({ tool: 'delete_everything', scopes: [], policy: policy() });
        assert.equal(r.allowed, false);
        assert.match(r.reason, /allow-list/);
    });

    it('denies merchant-disabled tools', () => {
        const p = policy();
        p.disabledTools = ['amend_checkout'];
        const r = evaluateToolAllowlist({ tool: 'amend_checkout', scopes: ['write:cart', 'write:shipping'], policy: p });
        assert.equal(r.allowed, false);
        assert.match(r.reason, /disabled/);
    });

    it('denies when scopes are missing', () => {
        const r = evaluateToolAllowlist({ tool: 'seal_order', scopes: ['write:cart'], policy: policy() });
        assert.equal(r.allowed, false);
        assert.match(r.reason, /submit:order/);
    });

    it('is deterministic across input orderings', () => {
        const a = evaluateToolAllowlist({ tool: 'read_checkout', scopes: ['read:checkout'], policy: policy() });
        const b = evaluateToolAllowlist({ tool: 'read_checkout', scopes: ['read:checkout'], policy: policy() });
        assert.ok(deepEqual(a, b));
    });
});

describe('checkout.confirmation', () => {
    it('seal_order ALWAYS needs the buyer', () => {
        for (const mode of ['always', 'threshold']) {
            const p = policy();
            p.confirmation = { mode, amountThresholdMinor: 10 ** 9 };
            const r = confirmationRequired({ tool: 'seal_order', action: { patch: {} }, policy: p, state: {} });
            assert.equal(r.required, true);
            assert.equal(r.level, 'buyer');
        }
    });

    it('read-only tools never need confirmation', () => {
        for (const t of ['read_checkout', 'browse_catalog']) {
            const r = confirmationRequired({ tool: t, action: {}, policy: policy(), state: {} });
            assert.equal(r.required, false);
        }
    });

    it('amend_checkout touching money needs the buyer', () => {
        const r = confirmationRequired({
            tool: 'amend_checkout',
            action: { patch: { shippingMethod: 'express' } },
            policy: policy(),
            state: {},
        });
        assert.equal(r.required, true);
        assert.match(r.reason, /shippingMethod/);
    });

    it('threshold mode fires on amount', () => {
        const p = policy();
        p.confirmation = { mode: 'threshold', amountThresholdMinor: 5000 };
        const r = confirmationRequired({ tool: 'amend_checkout', action: { patch: { note: 'hi' }, amountMinor: 6000 }, policy: p, state: {} });
        assert.equal(r.required, true);
    });

    it('step-up hands back to the buyer UI', () => {
        const r = confirmationRequired({ tool: 'amend_checkout', action: { patch: {}, requiresStepUp: true }, policy: policy(), state: {} });
        assert.equal(r.required, true);
        assert.equal(r.level, 'stepup');
    });
});

describe('checkout.transition', () => {
    const cart = () => ({ status: 'cart', items: [{ qty: 1, priceMinor: 1000 }], currency: 'USD' });

    it('walks the lifecycle', () => {
        let s = cart();
        for (const t of ['begin_details', 'begin_payment', 'begin_review']) {
            const r = transitionCheckoutState(s, { type: t });
            assert.equal(r.ok, true);
            s = r.state;
        }
        assert.equal(s.status, 'review');
    });

    it('refuses submit without buyer confirmation', () => {
        const r = transitionCheckoutState({ ...cart(), status: 'review' }, { type: 'submit' });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'confirmation_missing');
    });

    it('refuses submit on an incomplete checkout', () => {
        const r = transitionCheckoutState({ status: 'review', items: [], buyerConfirmed: true }, { type: 'submit' });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'inseal_order');
        assert.match(r.error.message, /items/);
    });

    it('submits a complete, confirmed checkout', () => {
        const s = {
            status: 'review', buyerConfirmed: true, currency: 'USD',
            items: [{ qty: 1, priceMinor: 1000 }], address: 'x', shippingMethod: 'standard', paymentMethod: 'card',
        };
        const r = transitionCheckoutState(s, { type: 'submit' });
        assert.equal(r.ok, true);
        assert.equal(r.state.status, 'submitted');
    });

    it('refuses illegal transitions', () => {
        const r = transitionCheckoutState(cart(), { type: 'begin_review' });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'illegal_transition');
    });

    it('submit is legal from any live status but still needs confirmation', () => {
        const r = transitionCheckoutState(cart(), { type: 'submit' });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'confirmation_missing');
    });

    it('buyer_confirm then submit works', () => {
        let s = { status: 'review', items: [{ qty: 1, priceMinor: 100 }], address: 'a', shippingMethod: 's', paymentMethod: 'p', currency: 'USD' };
        s = transitionCheckoutState(s, { type: 'buyer_confirm' }).state;
        const r = transitionCheckoutState(s, { type: 'submit' });
        assert.equal(r.ok, true);
    });

    it('recomputes totals on item changes', () => {
        const r = transitionCheckoutState(cart(), {
            type: 'add_item',
            patch: { items: [{ qty: 2, priceMinor: 1000 }] },
            policy: { taxRateBps: 1000 },
        });
        assert.equal(r.ok, true);
        assert.equal(r.state.totals.subtotalMinor, 2000);
        assert.equal(r.state.totals.taxMinor, 200);
        assert.equal(r.state.totals.totalMinor, 2200);
    });

    it('refuses negative money', () => {
        const r = recomputeTotals({ items: [{ qty: 1, priceMinor: -5 }] }, {});
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'bad_money');
    });
});

describe('grant.scope', () => {
    const g = { tools: ['amend_checkout'], scopes: ['write:cart'], exp: 2000000000 };
    it('allows covered tool+scope', () => {
        assert.equal(grantAllowsScope(g, 'amend_checkout', 'write:cart', 1000000000).allowed, true);
    });
    it('denies uncovered tool / scope / expiry', () => {
        assert.equal(grantAllowsScope(g, 'seal_order', 'write:cart', 1000000000).allowed, false);
        assert.equal(grantAllowsScope(g, 'amend_checkout', 'submit:order', 1000000000).allowed, false);
        assert.equal(grantAllowsScope(g, 'amend_checkout', 'write:cart', 3000000000).allowed, false);
    });
    it('wildcard grants work', () => {
        const w = { tools: ['*'], scopes: ['*'], exp: 2000000000 };
        assert.equal(grantAllowsScope(w, 'seal_order', 'submit:order', 1).allowed, true);
    });
});

describe('gate registry + determinism', () => {
    it('every gate is registered', () => {
        const ids = GATE_REGISTRY.map((g) => g.id);
        for (const id of ['tool.allowlist', 'checkout.confirmation', 'checkout.transition', 'checkout.totals', 'grant.scope']) {
            assert.ok(ids.includes(id), `missing gate ${id}`);
        }
    });

    it('self-check passes: same inputs, byte-identical outputs', () => {
        const r = determinismSelfCheck();
        assert.equal(r.ok, true);
        assert.ok(r.cases.length >= 7);
        assert.ok(r.cases.every((c) => c.pass));
    });
});
