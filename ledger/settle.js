#!/usr/bin/env node
/**
 * agentill / ledger/settle.js
 *
 * Operator CLI for the platform-fee ledger. This tool COMPUTES and MARKS —
 * it never moves money. Actual collection happens via the monthly Stripe
 * invoice flow documented in docs/platform-fee-settlement.md.
 *
 *   node ledger/settle.js --ledger ledger/data/platform-fees.json --preview
 *   node ledger/settle.js --ledger ledger/data/platform-fees.json --preview --merchant demo-store
 *   node ledger/settle.js --ledger ledger/data/platform-fees.json --settle \
 *        --merchant demo-store --cents 102 --invoice in_1ABCxyz
 *
 * --preview prints whole cents currently releasable per merchant (floor of
 * the accrued balance; sub-cent remainders carry forward and are shown).
 * --settle marks wholeCents as collected against an external invoice id.
 * It refuses to settle more than the releasable amount.
 */
import { createPlatformFeeLedger } from './platformFees.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER = join(HERE, 'data', 'platform-fees.json');

function arg(name, def = null) {
    const i = process.argv.indexOf(name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}

function main() {
    const ledgerPath = arg('--ledger', DEFAULT_LEDGER);
    const ledger = createPlatformFeeLedger({ filePath: ledgerPath });
    const onlyMerchant = arg('--merchant', null);

    if (arg('--preview', false)) {
        const data = ledger.snapshot();
        const ids = onlyMerchant ? [onlyMerchant] : Object.keys(data.merchants).sort();
        const rows = ids.map((id) => ledger.previewSettlement(id));
        console.log(JSON.stringify({ ledger: ledgerPath, settlements: rows }, null, 2));
        return;
    }

    if (arg('--settle', false)) {
        const merchantId = arg('--merchant');
        const cents = Number(arg('--cents'));
        const invoiceRef = arg('--invoice');
        if (!merchantId || !Number.isInteger(cents) || !invoiceRef || invoiceRef === true) {
            console.error('usage: settle.js --settle --merchant ID --cents N --invoice INVOICE_ID [--ledger PATH]');
            process.exit(2);
        }
        const out = ledger.settle({ merchantId, wholeCents: cents, invoiceRef, at: Math.floor(Date.now() / 1000) });
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    console.error('usage: settle.js --preview [--merchant ID] | --settle --merchant ID --cents N --invoice INVOICE_ID');
    process.exit(2);
}

main();
