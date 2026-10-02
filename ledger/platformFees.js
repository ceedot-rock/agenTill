/**
 * agentill / ledger/platformFees.js
 *
 * DURABLE PLATFORM-FEE LEDGER (0.3.0).
 *
 * Per-merchant accrual of platform fees in integer microcents. Fractional
 * cents are NEVER charged: the ledger accrues exactly, and settlement
 * releases whole cents only (floor), carrying the sub-cent remainder
 * forward. Settlement itself happens OUTSIDE this module — see
 * docs/platform-fee-settlement.md for the monthly Stripe-invoice flow.
 * This module only records what accrued and what was marked settled.
 *
 * Two backends:
 *   - createPlatformFeeLedger({ filePath }) — gzip-compressed JSON file,
 *     atomic write (tmp + rename), fsync-free but crash-tolerant enough
 *     for 0.3.0. Legacy plain-JSON files (pretty or minified) still load:
 *     the loader sniffs the gzip magic and falls back to raw JSON.
 *     This is the durable backend: point it at ledger/data/platform-fees.json.
 *   - createMemoryPlatformFeeLedger() — same interface, in-memory.
 *     Used by tests and as the box default when no ledgerFile is configured.
 *
 * Compression: node:zlib (stdlib) behind one encode/decode pair, so the
 * lab's own PCC binary can replace it later without touching callers.
 *
 * File shape:
 *   { version: 1,
 *     merchants: { "<merchantId>": {
 *        accruedMicrocents: int, settledMicrocents: int,
 *        entries: [ { orderId, seq, microcents, rate, recipient, at } ],
 *        settlements: [ { at, wholeCents, invoiceRef } ] } } }
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { wholeCentsDue } from '../core/platformFee.js';

const LEDGER_VERSION = 1;

/* Gzip magic: 0x1f 0x8b. One codec pair — swap for PCC later if wanted. */
function encodeLedger(data) {
    return gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
}

function decodeLedgerBytes(buf) {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return gunzipSync(buf).toString('utf8');
    }
    return buf.toString('utf8'); // legacy plain-JSON files keep loading
}

function blankFile() {
    return { version: LEDGER_VERSION, merchants: {} };
}

function blankMerchant() {
    return { accruedMicrocents: 0, settledMicrocents: 0, entries: [], settlements: [] };
}

function checkEntry(e) {
    if (!e || typeof e.merchantId !== 'string' || e.merchantId.length === 0) {
        return 'merchantId must be a non-empty string';
    }
    if (!Number.isInteger(e.microcents) || e.microcents < 0) {
        return 'microcents must be a non-negative integer';
    }
    return null;
}

function makeStore({ load, save }) {
    const api = {
        /** Record one sealed order's fee. Throws on bad input. */
        accrue(entry) {
            const bad = checkEntry(entry);
            if (bad) throw new Error(`platform-fee ledger: ${bad}`);
            const data = load();
            const m = data.merchants[entry.merchantId] || (data.merchants[entry.merchantId] = blankMerchant());
            m.accruedMicrocents += entry.microcents;
            m.entries.push({
                orderId: entry.orderId || null,
                seq: entry.seq == null ? null : Math.trunc(entry.seq),
                microcents: entry.microcents,
                rate: entry.rate,
                recipient: entry.recipient,
                at: entry.at == null ? null : Math.trunc(entry.at),
            });
            save(data);
            return { accruedMicrocents: m.accruedMicrocents };
        },

        /** Accrued-but-unsettled balance, integer microcents. */
        balanceMicrocents(merchantId) {
            const data = load();
            const m = data.merchants[merchantId];
            if (!m) return 0;
            return m.accruedMicrocents - m.settledMicrocents;
        },

        /**
         * Whole cents currently releasable for settlement (floor) plus the
         * sub-cent remainder that stays accrued. Never charges fractions.
         */
        previewSettlement(merchantId) {
            const balance = api.balanceMicrocents(merchantId);
            const due = wholeCentsDue(balance);
            if (!due.ok) throw new Error(`platform-fee ledger: ${due.error}`);
            return { merchantId, wholeCents: due.wholeCents, remainderMicrocents: due.remainderMicrocents, balanceMicrocents: balance };
        },

        /**
         * Mark wholeCents as settled against an external invoice reference
         * (e.g. a Stripe invoice id created via the documented monthly flow).
         * wholeCents must not exceed the releasable amount. Records the
         * settlement; does NOT move money itself.
         */
        settle({ merchantId, wholeCents, invoiceRef, at = null }) {
            if (typeof merchantId !== 'string' || merchantId.length === 0) {
                throw new Error('platform-fee ledger: merchantId must be a non-empty string');
            }
            if (!Number.isInteger(wholeCents) || wholeCents <= 0) {
                throw new Error('platform-fee ledger: wholeCents must be a positive integer');
            }
            if (typeof invoiceRef !== 'string' || invoiceRef.length === 0) {
                throw new Error('platform-fee ledger: invoiceRef is required (the external invoice that collected this amount)');
            }
            const data = load();
            const m = data.merchants[merchantId] || (data.merchants[merchantId] = blankMerchant());
            const due = wholeCentsDue(m.accruedMicrocents - m.settledMicrocents);
            if (wholeCents > due.wholeCents) {
                throw new Error(`platform-fee ledger: cannot settle ${wholeCents}c; only ${due.wholeCents}c releasable (remainder carries forward)`);
            }
            m.settledMicrocents += wholeCents * 10000;
            m.settlements.push({ at: at == null ? null : Math.trunc(at), wholeCents, invoiceRef });
            save(data);
            return { merchantId, settledCents: wholeCents, invoiceRef, remainingMicrocents: m.accruedMicrocents - m.settledMicrocents };
        },

        /** Full ledger content (for inspection / the settle CLI). */
        snapshot() {
            return load();
        },
    };
    return api;
}

/** Durable JSON-file backend. */
export function createPlatformFeeLedger({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('platform-fee ledger: filePath is required');
    }
    const load = () => {
        if (!existsSync(filePath)) return blankFile();
        let data;
        try {
            data = JSON.parse(decodeLedgerBytes(readFileSync(filePath)));
        } catch (e) {
            throw new Error(`platform-fee ledger: corrupt ledger file at ${filePath}: ${e.message}`);
        }
        if (!data || data.version !== LEDGER_VERSION || typeof data.merchants !== 'object') {
            throw new Error(`platform-fee ledger: unsupported ledger version at ${filePath}`);
        }
        return data;
    };
    const save = (data) => {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, encodeLedger(data));
        renameSync(tmp, filePath); // atomic replace on POSIX
    };
    // fail fast on a bad path at construction time
    load();
    return makeStore({ load, save });
}

/** In-memory backend: same interface, no persistence. */
export function createMemoryPlatformFeeLedger() {
    let data = blankFile();
    const load = () => data;
    const save = (next) => { data = next; };
    return makeStore({ load, save });
}
