/**
 * agentill / sdk/agentill.js
 *
 * Drop-in browser SDK. No dependencies. The merchant adds one script tag;
 * the SDK binds the box's four agent tools to the merchant's existing
 * checkout page and gates every submission on buyer confirmation.
 *
 * Two modes:
 *   server mode (normal):  AgenTill.init({ baseUrl }) — tool calls go to the
 *                          merchant's box middleware; the server is the
 *                          authority on identity, payment, confirmation and
 *                          state. The SDK handles the buyer-confirmation UX.
 *   local mode (demos):    AgenTill.init({ adapter }) — runs against a local
 *                          adapter object { getState, applyPatch } with the
 *                          same confirmation gating (no identity/tolls).
 *
 * The server is ALWAYS authoritative in server mode: the SDK never decides
 * allow-listing, payment or submission by itself.
 */
(function (global) {
    'use strict';

    const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;

    const AT = {
        _baseUrl: null,
        _adapter: null,
        _credential: null,
        _buyerSessionId: null,
        _confirmer: null,
        _listeners: {},
        _tools: {},
    };

    /* ------------------------------ events ------------------------------ */

    AT.on = function (evt, fn) {
        (AT._listeners[evt] = AT._listeners[evt] || []).push(fn);
        return function off() {
            AT._listeners[evt] = (AT._listeners[evt] || []).filter((f) => f !== fn);
        };
    };

    AT.emit = function (evt, data) {
        (AT._listeners[evt] || []).forEach((fn) => {
            try { fn(data); } catch (e) { console.error('[agentill]', e); }
        });
    };

    /* ------------------------------ setup ------------------------------- */

    AT.init = function (opts) {
        opts = opts || {};
        AT._baseUrl = opts.baseUrl ? String(opts.baseUrl).replace(/\/$/, '') : null;
        AT._adapter = opts.adapter || null;
        AT._buyerSessionId = opts.buyerSessionId || ('buyer-' + Math.random().toString(36).slice(2, 10));
        if (opts.confirmer) AT._confirmer = opts.confirmer;
        AT.emit('init', { baseUrl: AT._baseUrl, local: !AT._baseUrl });
        return AT;
    };

    AT.setCredential = function (jwt) { AT._credential = jwt; return AT; };
    AT.setBuyerSessionId = function (id) { AT._buyerSessionId = id; return AT; };
    AT.setConfirmer = function (fn) { AT._confirmer = fn; return AT; };

    AT.registerTool = function (def) {
        if (!def || !def.name) throw new Error('[agentill] registerTool needs { name }');
        AT._tools[def.name] = def;
        return AT;
    };

    /* --------------------------- server calls --------------------------- */

    async function post(path, body) {
        const res = await fetch(AT._baseUrl + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data, headers: res.headers };
    }

    AT.getDiscovery = async function () {
        const res = await fetch(AT._baseUrl + '/.well-known/agentill');
        return res.json();
    };

    AT.preflight = async function () {
        const out = await post('/agentill/preflight', {});
        return out.data;
    };

    /* ------------------------- buyer confirmation ------------------------ */

    function defaultConfirmer(request) {
        // request: { summary, level, reason, timeoutMs }
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.setAttribute('data-agentill', 'confirm-overlay');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
            const card = document.createElement('div');
            card.style.cssText = 'background:#fff;color:#111;border-radius:12px;padding:24px;max-width:420px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.35);';
            const s = request.summary || {};
            const money = s.totalMinor != null
                ? `<p style="font-size:22px;font-weight:700;margin:8px 0;">${escapeHtml(s.currency || 'USD')} ${(s.totalMinor / 100).toFixed(2)}</p>`
                : '';
            card.innerHTML =
                '<h2 style="margin:0 0 4px;font-size:18px;">An AI agent wants to act on your checkout</h2>' +
                `<p style="margin:0 0 8px;color:#555;font-size:14px;">${escapeHtml(request.reason || '')}</p>` +
                money +
                `<p style="font-size:14px;color:#333;">${escapeHtml(describeSummary(s))}</p>` +
                '<div style="display:flex;gap:12px;margin-top:16px;">' +
                '<button data-agentill="deny" style="flex:1;padding:12px;border-radius:8px;border:1px solid #ccc;background:#fff;font-size:15px;cursor:pointer;">Deny</button>' +
                '<button data-agentill="approve" style="flex:1;padding:12px;border-radius:8px;border:none;background:#111;color:#fff;font-size:15px;cursor:pointer;">Approve</button>' +
                '</div>' +
                '<p style="font-size:12px;color:#888;margin:12px 0 0;">Nothing is submitted without your approval. Denying is always safe.</p>';
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            const done = (v) => { try { document.body.removeChild(overlay); } catch (e) {} resolve(v); };
            card.querySelector('[data-agentill="approve"]').addEventListener('click', () => done(true));
            card.querySelector('[data-agentill="deny"]').addEventListener('click', () => done(false));
            setTimeout(() => done(false), request.timeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS);
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function describeSummary(s) {
        if (!s) return '';
        if (s.what === 'seal order') return `Submit order of ${s.items} item(s).`;
        if (s.patchKeys) return `Update checkout: ${s.patchKeys.join(', ')}.`;
        return s.what || '';
    }

    AT.confirmWithBuyer = function (request) {
        const fn = AT._confirmer || defaultConfirmer;
        AT.emit('confirmation:shown', request);
        return Promise.resolve(fn(request)).then((approved) => {
            AT.emit('confirmation:decided', { approved, request });
            return !!approved;
        });
    };

    /* ------------------------------ invoke ------------------------------- */

    AT.invoke = async function (tool, args, opts) {
        opts = opts || {};
        args = args || {};
        if (AT._baseUrl) return AT._invokeRemote(tool, args, opts);
        return AT._invokeLocal(tool, args, opts);
    };

    AT._invokeRemote = async function (tool, args, opts) {
        const buyerSessionId = opts.buyerSessionId || AT._buyerSessionId;
        const send = (extra) => post('/agentill/tools/invoke', {
            tool, args, credential: AT._credential, grant: opts.grant || null,
            xpayment: opts.xpayment || null, buyerConfirmation: extra || null,
            buyerSessionId,
        });

        let out = await send(null);
        if (out.status === 402) {
            AT.emit('payment:required', out.data);
            if (opts.onPaymentRequired) return opts.onPaymentRequired(out.data, (xpayment) => AT._invokeRemote(tool, args, { ...opts, xpayment }));
            const err = new Error('payment required for tool call');
            err.code = 'payment_required';
            err.requirements = out.data;
            throw err;
        }
        const data = out.data || {};
        if (data.status === 'confirmation_required') {
            const c = data.confirmation || {};
            AT.emit('confirmation:required', c);
            const approved = await AT.confirmWithBuyer({ summary: c.summary, level: c.level, reason: c.reason });
            if (!approved) {
                const err = new Error('buyer denied the action');
                err.code = 'buyer_denied';
                throw err;
            }
            out = await send({ challenge: c.challenge, exp: c.exp, stateHash: c.stateHash, buyerSessionId, approved: true });
            return AT._handleResult(tool, out);
        }
        return AT._handleResult(tool, out);
    };

    AT._handleResult = function (tool, out) {
        const data = out.data || {};
        if (!data.ok) {
            const err = new Error((data.error && data.error.message) || 'tool call failed');
            err.code = (data.error && data.error.code) || 'failed';
            err.status = out.status;
            throw err;
        }
        if (data.snapshot) AT.emit('snapshot', data.snapshot);
        if (data.receipt) AT.emit('receipt', data.receipt);
        AT.emit('tool:result', { tool, result: data.result });
        return data;
    };

    // Local mode: same confirmation UX, no identity/tolls. For demos and tests.
    AT._invokeLocal = async function (tool, args, opts) {
        const adapter = AT._adapter;
        if (!adapter) throw new Error('[agentill] local mode needs init({ adapter })');
        const needsConfirm = tool === 'seal_order' ||
            (tool === 'amend_checkout' && args && args.patch && Object.keys(args.patch).some((k) => ['items', 'shippingMethod', 'discountCode', 'address', 'paymentMethod'].includes(k)));
        if (needsConfirm) {
            const approved = await AT.confirmWithBuyer({
                summary: { tool, what: tool === 'seal_order' ? 'seal order' : 'amend checkout', patchKeys: Object.keys((args && args.patch) || {}) },
                level: 'buyer',
                reason: tool === 'seal_order' ? 'order submission always requires buyer confirmation' : 'update touches money/identity fields',
            });
            if (!approved) { const e = new Error('buyer denied the action'); e.code = 'buyer_denied'; throw e; }
        }
        let result;
        if (tool === 'browse_catalog') {
            const q = String((args && args.query) || '').toLowerCase();
            result = { results: (adapter.getCatalog() || []).filter((it) => !q || it.title.toLowerCase().includes(q)) };
        } else if (tool === 'read_checkout') {
            result = { checkout: adapter.getState() };
        } else if (tool === 'amend_checkout') {
            result = adapter.applyPatch((args && args.patch) || {});
        } else if (tool === 'seal_order') {
            result = adapter.submitOrder(adapter.applyPatch({ buyerConfirmed: true }));
        } else if (AT._tools[tool] && typeof AT._tools[tool].handler === 'function') {
            result = await AT._tools[tool].handler({ args, adapter });
        } else {
            throw new Error('[agentill] unknown tool: ' + tool);
        }
        AT.emit('tool:result', { tool, result });
        return { ok: true, result };
    };

    global.AgenTill = AT;
    return AT;
})(typeof window !== 'undefined' ? window : globalThis);
