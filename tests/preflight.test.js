import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, semanticChecks, dryRun, activate, verifyActivation } from '../validator/preflight.js';
import { KNOWN_SCOPES } from '../core/gates.js';

const SECRET = 'preflight-secret';

const goodSettings = () => ({
    merchantId: 'demo-store',
    catalog: { type: 'inline', items: [{ id: 'p1', title: 'Widget', priceMinor: 1000 }] },
    currency: 'USD',
    tax: { provider: 'manual', configPointer: 'demo://tax' },
    shipping: { provider: 'manual', configPointer: 'demo://ship' },
    paymentRails: [{ rail: 'x402', wallet: { address: '0xabc', network: 'base' } }],
    confirmationPolicy: { mode: 'always' },
    spendCaps: { perOrderMinor: 50000, perDayMinor: 200000 },
    allowedToolScopes: [...KNOWN_SCOPES],
    checkoutBinding: { applyPatch: 'adapter' },
});

const goodAdapter = (overrides = {}) => ({
    getState: () => ({ status: 'cart', items: [], currency: 'USD' }),
    applyPatch: (p) => (p && p.__agentill_probe ? goodAdapter().getState() : { status: 'cart', items: [], currency: 'USD', ...p }),
    getConfig: () => ({ currency: 'USD' }),
    describeSubmit: () => ({ bindings: 1 }),
    ...overrides,
});

describe('validateSettings', () => {
    it('accepts a complete valid settings object', () => {
        const r = validateSettings(goodSettings());
        assert.equal(r.ok, true, JSON.stringify(r.errors));
    });

    it('lists every missing required key', () => {
        const r = validateSettings({});
        assert.equal(r.ok, false);
        const paths = r.errors.map((e) => e.path);
        for (const k of ['merchantId', 'catalog', 'currency', 'paymentRails', 'spendCaps']) {
            assert.ok(paths.includes(k), `missing error for ${k}`);
        }
    });

    it('rejects bad currency shape and bad rail', () => {
        const s = goodSettings();
        s.currency = 'usd';
        s.paymentRails = [{ rail: 'teleport' }];
        const r = validateSettings(s);
        assert.equal(r.ok, false);
        assert.ok(r.errors.some((e) => e.code === 'bad_currency'));
        assert.ok(r.errors.some((e) => e.code === 'bad_rail'));
    });

    it('requires wallet address+network for x402 rails', () => {
        const s = goodSettings();
        s.paymentRails = [{ rail: 'x402', wallet: { address: '0xabc' } }];
        const r = validateSettings(s);
        assert.equal(r.ok, false);
        assert.ok(r.errors.some((e) => e.code === 'bad_wallet'));
    });

    it('rejects non-object input', () => {
        assert.equal(validateSettings(null).ok, false);
        assert.equal(validateSettings([]).ok, false);
    });
});

describe('semanticChecks', () => {
    it('accepts sane settings', () => {
        assert.equal(semanticChecks(goodSettings()).ok, true);
    });

    it('catches cap inversion and non-integer caps', () => {
        const s = goodSettings();
        s.spendCaps = { perOrderMinor: 999999, perDayMinor: 100 };
        const r = semanticChecks(s);
        assert.equal(r.ok, false);
        assert.ok(r.errors.some((e) => e.code === 'cap_inversion'));
    });

    it('catches unknown scopes and empty inline catalogs', () => {
        const s = goodSettings();
        s.allowedToolScopes = ['read:checkout', 'hack:everything'];
        s.catalog = { type: 'inline', items: [] };
        const r = semanticChecks(s);
        assert.ok(r.errors.some((e) => e.code === 'unknown_scope'));
        assert.ok(r.errors.some((e) => e.code === 'empty_catalog'));
    });

    it('requires a positive threshold for threshold mode', () => {
        const s = goodSettings();
        s.confirmationPolicy = { mode: 'threshold' };
        const r = semanticChecks(s);
        assert.ok(r.errors.some((e) => e.code === 'bad_threshold'));
    });
});

describe('dryRun', () => {
    it('passes against a healthy adapter', async () => {
        const r = await dryRun(goodSettings(), goodAdapter());
        assert.equal(r.ok, true, JSON.stringify(r.checks));
        assert.ok(r.checks.length >= 6);
        assert.ok(r.checks.every((c) => c.ok));
    });

    it('fails when getState throws (existing flow is broken)', async () => {
        const r = await dryRun(goodSettings(), goodAdapter({ getState: () => { throw new Error('db down'); } }));
        assert.equal(r.ok, false);
        assert.ok(r.checks.some((c) => c.id === 'state_readable' && !c.ok));
    });

    it('fails when applyPatch mutates on a no-op probe (would damage flow)', async () => {
        const evil = goodAdapter({ applyPatch: () => ({ status: 'cart', items: [{ id: 'x' }], currency: 'USD' }) });
        const r = await dryRun(goodSettings(), evil);
        assert.equal(r.ok, false);
        assert.ok(r.checks.some((c) => c.id === 'patch_noop' && !c.ok));
    });

    it('fails on currency mismatch (would corrupt money math)', async () => {
        const r = await dryRun(goodSettings(), goodAdapter({ getConfig: () => ({ currency: 'EUR' }) }));
        assert.equal(r.ok, false);
        assert.ok(r.checks.some((c) => c.id === 'currency_match' && !c.ok));
    });

    it('fails on double submit bindings (would double-submit orders)', async () => {
        const r = await dryRun(goodSettings(), goodAdapter({ describeSubmit: () => ({ bindings: 2 }) }));
        assert.equal(r.ok, false);
        assert.ok(r.checks.some((c) => c.id === 'submit_single_binding' && !c.ok));
    });

    it('fails when the url catalog is unreachable', async () => {
        const s = goodSettings();
        s.catalog = { type: 'url', pointer: 'https://example.invalid/catalog' };
        const r = await dryRun(s, goodAdapter(), { fetchImpl: async () => { throw new Error('dns'); } });
        assert.equal(r.ok, false);
        assert.ok(r.checks.some((c) => c.id === 'catalog_reachable' && !c.ok));
    });

    it('fails without an adapter at all', async () => {
        const r = await dryRun(goodSettings(), null);
        assert.equal(r.ok, false);
    });
});

describe('activate', () => {
    it('activates only on a fully clean run', async () => {
        const r = await activate(goodSettings(), goodAdapter(), SECRET);
        assert.equal(r.ok, true);
        assert.ok(r.activation.sig);
        const v = verifyActivation(r.activation, SECRET, goodSettings());
        assert.equal(v.ok, true);
    });

    it('refuses at the validate stage and never activates', async () => {
        const r = await activate({}, goodAdapter(), SECRET);
        assert.equal(r.ok, false);
        assert.equal(r.stage, 'validate');
        assert.ok(!r.activation);
    });

    it('refuses at the dryrun stage when the adapter is unsafe', async () => {
        const r = await activate(goodSettings(), goodAdapter({ describeSubmit: () => ({ bindings: 0 }) }), SECRET);
        assert.equal(r.ok, false);
        assert.equal(r.stage, 'dryrun');
    });

    it('activation is bound to the exact settings (tamper -> re-run preflight)', async () => {
        const r = await activate(goodSettings(), goodAdapter(), SECRET);
        const tampered = goodSettings();
        tampered.spendCaps = { perOrderMinor: 1, perDayMinor: 2 };
        const v = verifyActivation(r.activation, SECRET, tampered);
        assert.equal(v.ok, false);
        assert.match(v.reason, /re-run pre-flight/);
    });
});
