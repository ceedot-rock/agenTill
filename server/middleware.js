/**
 * agentill / server/middleware.js
 *
 * Drop-in server middleware. Framework-agnostic: works as Express/connect
 * middleware `(req, res, next)` and with plain node:http (it reads the
 * request body itself when `req.body` is not already parsed).
 *
 * Routes:
 *   GET  /.well-known/agentill    discovery document
 *   POST /agentill/preflight      run full pre-flight (validate+semantic+dry-run); returns report
 *   POST /agentill/confirm/challenge  issue a buyer-confirmation challenge
 *   POST /agentill/tools/invoke   the tool pipeline
 *
 * Invoke pipeline (each step refuses loudly, nothing half-executes):
 *   1. activation valid?                       -> 503 if not
 *   2. agent identity verifies? trust >= tool?  -> 401 / 403
 *   3. grant (if supplied) verifies + scopes?   -> 403
 *   4. EXACT-GATE tool.allowlist                -> 403
 *   5. toll quote (only when settings.tolls set); if charged and unpaid -> 402 + PaymentRequirements
 *   6. EXACT-GATE checkout.confirmation         -> 200 {status:'confirmation_required'} if needed
 *   7. map tool -> state-machine action; EXACT-GATE checkout.transition -> 409 if illegal
 *   8. adapter.applyPatch / adapter.submitOrder (the merchant's OWN flow)
 *   9. sign state snapshot; issue toll receipt (when tolls enabled)
 */
import {
    TOOL_NAMES,
    evaluateToolAllowlist,
    confirmationRequired,
    transitionCheckoutState,
    recomputeTotals,
    grantAllowsScope,
    canon,
} from '../core/gates.js';
import {
    TokenError,
    parseXPaymentHeader,
    verifyX402Payment,
    paymentRequiredBody,
    buildPaymentRequirements,
    signSnapshot,
} from '../core/tokens.js';
import { verifyGrant } from '../core/grants.js';
import { applyQuota, issueReceipt, DEFAULT_TOLL_TABLE } from '../core/tolls.js';
import { activate as preflightActivate, verifyActivation } from '../validator/preflight.js';
import { identityAdapterFor, toolTrustFor, meetsTrust } from '../core/identity.js';
import {
    DEFAULT_PLATFORM_FEE,
    resolvePlatformFee,
    computePlatformFeeMicrocents,
    feeLineForSnapshot,
} from '../core/platformFee.js';
import { createPlatformFeeLedger, createMemoryPlatformFeeLedger } from '../ledger/platformFees.js';
import { createHmac } from 'node:crypto';

/** Scopes each tool needs (checked against JWT scopes + merchant allow-list). */
export const TOOL_SCOPES = {
    browse_catalog: ['read:catalog'],
    read_checkout: ['read:checkout'],
    amend_checkout: ['write:cart', 'write:shipping'],
    seal_order: ['submit:order'],
};

const TOOL_DESCRIPTIONS = {
    browse_catalog: 'Search the merchant catalog. Read-only.',
    read_checkout: 'Read the shared checkout object (agent and buyer see the same state). Read-only.',
    amend_checkout: 'Patch the shared checkout object (items, address, shipping, discount). Buyer confirmation required when money or identity fields change.',
    seal_order: 'Submit the checkout AFTER buyer confirmation. Never autonomous.',
};

function sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    res.end(body);
}

function readBody(req) {
    if (req.body !== undefined) {
        return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    }
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(new TokenError('bad_json', 'request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}

const periodId = (nowSec) => {
    const d = new Date(nowSec * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function createBox({ settings, adapter, secrets, hooks = {} }) {
    if (!settings || !adapter || !secrets || !secrets.serverSecret) {
        throw new Error('createBox needs { settings, adapter, secrets:{ serverSecret } }');
    }
    // Per-call tolls are opt-in: without settings.tolls every tool is free.
    const tollTable = settings.tolls ? { ...DEFAULT_TOLL_TABLE, ...settings.tolls } : null;
    // The identity adapter resolves lazily so a bad adapter id is a
    // pre-flight REFUSAL (validate stage), not a construction throw.
    let identityAdapter = null;
    const getIdentityAdapter = () => {
        if (!identityAdapter) identityAdapter = identityAdapterFor(settings);
        return identityAdapter;
    };
    const toolTrust = toolTrustFor(settings);
    // Platform fee: a VISIBLE merchant setting (settings.platformFee), never a
    // hidden skim. Absent -> default 0.081% accruing to Slid Phi Labs; merchants
    // may change the rate (0 disables) and the recipient label. A malformed
    // rate is a pre-flight REFUSAL (validate stage), not a construction throw,
    // so fall back to the default here and let preflight speak precisely.
    const feeResolved = resolvePlatformFee(settings);
    const platformFeeCfg = (feeResolved.ok ? feeResolved : resolvePlatformFee({})).fee;
    // Fee ledger: durable JSON file when the merchant configures
    // settings.platformFee.ledgerFile, in-memory otherwise. Tests and the
    // default path stay side-effect free; production sets the file.
    const feeLedger = hooks.platformFeeLedger
        || (settings.platformFee && settings.platformFee.ledgerFile
            ? createPlatformFeeLedger({ filePath: settings.platformFee.ledgerFile })
            : createMemoryPlatformFeeLedger());
    const usage = new Map(); // "<agent>:<tool>:<period>" -> count (merchant persists in prod)
    const seqCounters = new Map(); // merchantId -> seq
    let activation = null;

    const box = {
        settings,
        adapter,
        secrets,
        /** Effective platform-fee config + the ledger it accrues into. */
        platformFee: { rate: platformFeeCfg.rate, recipient: platformFeeCfg.recipient },
        feeLedger,

        discovery() {
            const adapterId = ((settings.identity || {}).adapter) || 'open';
            let adapterDesc = '';
            try {
                adapterDesc = getIdentityAdapter().description;
            } catch {
                adapterDesc = `unknown adapter: ${adapterId} (pre-flight will refuse)`;
            }
            return {
                name: 'agentill',
                version: '0.3.0',
                tools: {
                    sharedState: true,
                    note: 'tools run against the merchant checkout state object; agent and buyer share one checkout',
                    definitions: TOOL_NAMES.map((name) => ({
                        name,
                        description: TOOL_DESCRIPTIONS[name],
                        minTrust: toolTrust[name],
                        scopes: TOOL_SCOPES[name],
                        requiresConfirmation: name === 'seal_order' ? 'always:buyer' : 'conditional',
                    })),
                },
                identity: { adapter: adapterId, description: adapterDesc, toolTrust },
                payments: { x402Version: 1, rails: (settings.paymentRails || []).map((r) => r.rail) },
                tolls: tollTable ? { table: tollTable, currency: 'USD' } : { enabled: false },
                platformFee: {
                    rate: platformFeeCfg.rate,
                    recipient: platformFeeCfg.recipient,
                    note: 'per sealed order, on merchandise value (subtotal minus discount); accrues in the fee ledger; fractional cents are never charged; settled monthly in whole cents',
                },
                confirmation: settings.confirmationPolicy,
                preflight: { required: true, endpoint: 'POST /agentill/preflight' },
            };
        },

        /** Run pre-flight and, if clean, store the activation. Refuses otherwise. */
        async preflight(opts = {}) {
            const report = await preflightActivate(settings, adapter, secrets.serverSecret, opts);
            if (report.ok) activation = report.activation;
            return report;
        },

        issueConfirmationChallenge({ tool, stateHash, buyerSessionId, ttlSec = 300, nowSec = Math.floor(Date.now() / 1000) }) {
            const exp = nowSec + ttlSec;
            const stable = { tool, stateHash, buyerSessionId, exp };
            const challenge = createHmac('sha256', secrets.serverSecret).update(canon(stable)).digest('hex');
            return { challenge, exp, tool, stateHash, buyerSessionId };
        },

        verifyConfirmationChallenge({ challenge, tool, stateHash, buyerSessionId, exp }, nowSec = Math.floor(Date.now() / 1000)) {
            if (!challenge || !tool || !stateHash || !buyerSessionId || !exp) return false;
            if (exp <= nowSec) return false;
            // iat is deliberately NOT part of the signed body: the challenge must
            // verify identically at issue time and at redemption time.
            const stable = { tool, stateHash, buyerSessionId, exp };
            const expected = createHmac('sha256', secrets.serverSecret).update(canon(stable)).digest('hex');
            return challenge === expected;
        },

        async invokeTool(body, { http = null } = {}) {
            const nowSec = Math.floor(Date.now() / 1000);
            const fail = (status, code, message, extra = {}) => ({ status, body: { ok: false, error: { code, message }, ...extra } });

            // 1. activation
            const act = verifyActivation(activation, secrets.serverSecret, settings, { nowSec });
            if (!act.ok) return fail(503, 'not_activated', `box not activated: ${act.reason}`);

            const { tool, args = {}, agentJwt, credential, grant, xpayment, buyerConfirmation } = body || {};
            if (!TOOL_NAMES.includes(tool)) return fail(400, 'unknown_tool', `unknown tool: ${tool}`);

            // 2. agent identity (pluggable adapter) + minimum trust per tool
            const ident = await getIdentityAdapter().verifyIdentity({
                credential: credential !== undefined ? credential : agentJwt, // agentJwt: legacy alias
                tool,
                settings,
                nowSec,
            });
            if (!ident.ok) {
                return fail(401, ident.code || 'bad_credential', `agent identity rejected: ${ident.message}`);
            }
            if (!meetsTrust(ident.trust, toolTrust[tool])) {
                return fail(403, 'trust', `tool ${tool} needs trust ${toolTrust[tool]}, agent has ${ident.trust}`);
            }

            // 3. grant (optional, merchant-issued capability)
            if (grant) {
                try {
                    const g = verifyGrant(grant, secrets.serverSecret, { nowSec });
                    if (g.agent_id !== ident.agentId) return fail(403, 'grant_agent', 'grant was issued for a different agent');
                    for (const s of TOOL_SCOPES[tool]) {
                        const chk = grantAllowsScope(g, tool, s, nowSec);
                        if (!chk.allowed) return fail(403, 'grant_scope', chk.reason);
                    }
                } catch (e) {
                    return fail(403, e.code || 'bad_grant', `grant rejected: ${e.message}`);
                }
            }

            // 4. EXACT-GATE: allow-list
            const policy = {
                allowedTools: TOOL_NAMES.filter((t) => !(settings.disabledTools || []).includes(t)),
                disabledTools: settings.disabledTools || [],
                toolScopes: Object.fromEntries(TOOL_NAMES.map((t) => [t, TOOL_SCOPES[t]])),
            };
            const allowedScopes = (settings.allowedToolScopes || []).filter((s) => (ident.scopes || []).includes(s));
            const al = evaluateToolAllowlist({ tool, scopes: allowedScopes, policy });
            if (!al.allowed) return fail(403, 'allowlist', al.reason);

            // 5. toll quote -> 402 when charged and unpaid (tolls are opt-in)
            const period = periodId(nowSec);
            const usageObj = Object.fromEntries(usage);
            const quote = tollTable
                ? applyQuota({ tool, agentId: ident.agentId, periodId: period, usage: usageObj, tollTable })
                : { charged: false, amountMinor: 0, usedAfter: 0, reason: 'tolls disabled' };
            quote.tool = tool;
            let receipt = null;
            if (quote.charged && quote.amountMinor > 0) {
                const rail = (settings.paymentRails || []).find((r) => r.rail === 'x402');
                if (!rail) return fail(402, 'no_rail', 'tool call requires payment but no x402 rail is configured');
                const reqs = buildPaymentRequirements({
                    network: rail.wallet.network,
                    payTo: rail.wallet.address,
                    amountAtomic: (BigInt(quote.amountMinor) * 10n ** 6n / 100n).toString(),
                    asset: rail.wallet.asset || '0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913',
                    resource: `/agentill/tools/invoke:${tool}`,
                    description: `agentill tool call: ${tool}`,
                });
                if (!xpayment) {
                    return {
                        status: 402,
                        headers: { 'PAYMENT-REQUIRED': JSON.stringify(reqs) },
                        body: paymentRequiredBody(reqs),
                    };
                }
                try {
                    const payment = parseXPaymentHeader(typeof xpayment === 'string' ? xpayment : JSON.stringify(xpayment));
                    await verifyX402Payment(payment, reqs, { nowSec, verifySignature: hooks.verifySignature || null });
                } catch (e) {
                    return fail(402, e.code || 'bad_payment', `payment rejected: ${e.message}`);
                }
            }

            // 6. EXACT-GATE: confirmation
            let state = adapter.getState();
            const confCheck = confirmationRequired({ tool, action: args, policy: { confirmation: settings.confirmationPolicy }, state });
            if (confCheck.required && confCheck.level !== 'none') {
                const bc = buyerConfirmation || {};
                const sessionId = body.buyerSessionId || (args && args.buyerSessionId) || 'anonymous';
                if (!bc.approved) {
                    const stateHash = createHmac('sha256', secrets.serverSecret).update(canon(state)).digest('hex').slice(0, 16);
                    const ch = this.issueConfirmationChallenge({ tool, stateHash, buyerSessionId: sessionId });
                    return {
                        status: 200,
                        body: {
                            ok: false,
                            status: 'confirmation_required',
                            confirmation: {
                                level: confCheck.level,
                                reason: confCheck.reason,
                                challenge: ch.challenge,
                                exp: ch.exp,
                                stateHash,
                                summary: summarizeAction(tool, args, state),
                            },
                        },
                    };
                }
                const okCh = this.verifyConfirmationChallenge({
                    challenge: bc.challenge,
                    tool,
                    stateHash: bc.stateHash,
                    buyerSessionId: bc.buyerSessionId,
                    exp: bc.exp,
                }, nowSec);
                if (!okCh) return fail(403, 'bad_confirmation', 'buyer confirmation challenge invalid or expired');
                // A verified buyer confirmation satisfies the state machine's
                // buyerConfirmed requirement for this invocation.
                if (tool === 'seal_order') {
                    state = { ...state, buyerConfirmed: true };
                }
            }

            // 7. map tool -> state-machine action; EXACT-GATE: transition legality.
            // Read-only tools skip the state machine: they cannot change state.
            const READ_ONLY = tool === 'browse_catalog' || tool === 'read_checkout';
            let tr = { ok: true, state };
            if (!READ_ONLY) {
                const mapped = mapToolToAction(tool, args, state);
                if (!mapped.ok) return fail(409, mapped.error.code, mapped.error.message);
                tr = transitionCheckoutState(state, { ...mapped.action, policy: { taxRateBps: settings.taxRateBps || 0 } });
                if (!tr.ok) return fail(409, tr.error.code, tr.error.message);
            }

            // 8. execute against the merchant's OWN flow
            let newState;
            try {
                newState = executeTool(tool, args, adapter, tr.state);
            } catch (e) {
                return fail(500, 'adapter_error', `merchant adapter failed: ${e.message}`);
            }

            // spend cap enforcement on the resulting totals
            const totals = recomputeTotals(newState, { taxRateBps: settings.taxRateBps || 0 });
            if (totals.ok && totals.totals.totalMinor > (settings.spendCaps || {}).perOrderMinor) {
                return fail(403, 'spend_cap', `order total ${totals.totals.totalMinor} exceeds per-order cap ${settings.spendCaps.perOrderMinor}`);
            }

            // 9. snapshot + receipt
            const seqKey = settings.merchantId;
            const seq = (seqCounters.get(seqKey) || 0) + 1;
            seqCounters.set(seqKey, seq);

            // 9b. platform fee on sealed orders: exact BigInt math, integer
            // microcents; fractional cents accrue in the ledger and are NEVER
            // charged. The fee line rides inside the signed snapshot state.
            let platformFeeLine = null;
            if (tool === 'seal_order' && totals.ok) {
                const merchandiseMinor = Math.max(0, totals.totals.subtotalMinor - totals.totals.discountMinor);
                const feeRes = computePlatformFeeMicrocents(merchandiseMinor, platformFeeCfg);
                const microcents = feeRes.ok ? feeRes.microcents : 0;
                if (microcents > 0) {
                    feeLedger.accrue({
                        merchantId: settings.merchantId,
                        orderId: newState.orderId || null,
                        seq,
                        microcents,
                        rate: platformFeeCfg.rate,
                        recipient: platformFeeCfg.recipient,
                        at: nowSec,
                    });
                }
                platformFeeLine = feeLineForSnapshot({
                    merchandiseMinor,
                    microcents,
                    rate: platformFeeCfg.rate,
                    recipient: platformFeeCfg.recipient,
                });
            }
            const snapshotState = platformFeeLine ? { ...newState, platformFee: platformFeeLine } : newState;
            const signed = signSnapshot({ state: snapshotState, agentId: ident.agentId, tool, seq, serverSecret: secrets.serverSecret, nowSec });
            usage.set(`${ident.agentId}:${tool}:${period}`, (usage.get(`${ident.agentId}:${tool}:${period}`) || 0) + 1);
            if (quote.charged) {
                receipt = issueReceipt({ agentId: ident.agentId, tool, amountMinor: quote.amountMinor, seq, periodId: period, nowSec });
            }
            if (hooks.onSnapshot) hooks.onSnapshot(signed);
            if (hooks.onReceipt && receipt) hooks.onReceipt(receipt);

            return { status: 200, body: { ok: true, result: summarizeResult(tool, newState), snapshot: signed, receipt, toll: { charged: quote.charged, amountMinor: quote.amountMinor }, platformFee: platformFeeLine } };
        },

        /** Framework-agnostic request handler. */
        middleware() {
            return async (req, res, next) => {
                try {
                    const url = new URL(req.url || '/', 'http://localhost');
                    const path = url.pathname;
                    if (req.method === 'GET' && path === '/.well-known/agentill') {
                        return sendJson(res, 200, this.discovery());
                    }
                    if (req.method === 'POST' && path === '/agentill/preflight') {
                        const report = await this.preflight();
                        return sendJson(res, report.ok ? 200 : 422, report);
                    }
                    if (req.method === 'POST' && path === '/agentill/confirm/challenge') {
                        const body = await readBody(req);
                        const ch = this.issueConfirmationChallenge(body);
                        return sendJson(res, 200, ch);
                    }
                    if (req.method === 'POST' && path === '/agentill/tools/invoke') {
                        const body = await readBody(req);
                        const out = await this.invokeTool(body);
                        return sendJson(res, out.status || 200, out.body, out.headers || {});
                    }
                    if (typeof next === 'function') return next();
                    return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown agentill route' } });
                } catch (e) {
                    return sendJson(res, e instanceof TokenError ? 400 : 500, {
                        ok: false,
                        error: { code: e.code || 'internal', message: e.message },
                    });
                }
            };
        },
    };
    return box;
}

/** Map one of the four tools onto state-machine actions (deterministic order). */
function mapToolToAction(tool, args, state) {
    const patch = (args && args.patch) || {};
    if (tool === 'browse_catalog' || tool === 'read_checkout') {
        return { ok: true, action: { type: 'noop' } };
    }
    if (tool === 'seal_order') {
        return { ok: true, action: { type: 'submit' } };
    }
    // amend_checkout: fixed key order so multi-key patches are deterministic
    const order = ['address', 'shippingMethod', 'paymentMethod', 'items', 'discountCode', 'note'];
    const kinds = { address: 'set_address', shippingMethod: 'set_shipping', paymentMethod: 'set_payment', items: 'add_item', discountCode: 'apply_discount', note: 'note' };
    const keys = order.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return { ok: false, error: { code: 'empty_patch', message: 'amend_checkout needs at least one patch field' } };
    // Return the FIRST lifecycle-relevant action; the rest ride along in patch.
    const primary = keys.find((k) => kinds[k] !== 'note') || 'note';
    return { ok: true, action: { type: kinds[primary], patch } };
}

/** Execute the tool against the merchant adapter (the merchant's own flow). */
function executeTool(tool, args, adapter, projectedState) {
    if (tool === 'browse_catalog') {
        const q = String((args && args.query) || '').toLowerCase();
        const limit = Math.min(Math.trunc(Number((args && args.limit) || 10)) || 10, 50);
        const catalog = adapter.getCatalog();
        return { results: catalog.filter((it) => !q || it.title.toLowerCase().includes(q)).slice(0, limit) };
    }
    if (tool === 'read_checkout') {
        return { checkout: adapter.getState() };
    }
    if (tool === 'amend_checkout') {
        return adapter.applyPatch((args && args.patch) || {});
    }
    if (tool === 'seal_order') {
        // buyerConfirmed was established by the verified confirmation challenge
        const withConfirm = adapter.applyPatch({ buyerConfirmed: true });
        return adapter.submitOrder(withConfirm);
    }
    throw new Error(`no executor for ${tool}`);
}

function summarizeAction(tool, args, state) {
    if (tool === 'seal_order') {
        let totalMinor = (state.totals && state.totals.totalMinor) ?? null;
        if (totalMinor == null) {
            const t = recomputeTotals(state, {});
            if (t.ok) totalMinor = t.totals.totalMinor;
        }
        return { tool, what: 'seal order', totalMinor, currency: (state.totals && state.totals.currency) || state.currency || 'USD', items: (state.items || []).length };
    }
    return { tool, what: 'amend checkout', patchKeys: Object.keys((args && args.patch) || {}) };
}

function summarizeResult(tool, newState) {
    if (tool === 'browse_catalog' || tool === 'read_checkout') return newState;
    if (newState && newState.orderId) return { orderId: newState.orderId, status: newState.status };
    return { status: newState.status, totals: newState.totals };
}
