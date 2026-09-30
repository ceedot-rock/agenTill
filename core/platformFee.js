/**
 * agentill / core/platformFee.js
 *
 * PLATFORM FEE — exact, deterministic fee math.
 *
 * The platform fee is a VISIBLE merchant setting (settings.platformFee),
 * never a hidden skim. Default: 0.081% of each sealed order's merchandise
 * value, accruing to 0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c. Merchants can see the setting, change
 * the rate (0 disables the fee), and change the recipient label. The core
 * paths carry no hard-coded lab lock-in: the default lives in one exported
 * constant and everything else flows from settings.
 *
 * Money discipline (same law as core/gates.js):
 *   - order values are integer minor units (cents) — never floats
 *   - the fee rate is parsed into an EXACT BigInt rational { num, den }
 *   - the fee is tracked in integer microcents (1e-6 of a currency unit),
 *     so fractional cents accrue exactly and are NEVER charged
 *   - settlement converts accrued microcents to whole cents with floor();
 *     the sub-cent remainder carries forward in the ledger
 *
 * This file has ZERO imports and no platform APIs: pure and deterministic,
 * safe to replay byte-for-byte like every other exactness-gated path.
 */

/** The default fee every merchant sees unless they change settings.platformFee. */
export const DEFAULT_PLATFORM_FEE = Object.freeze({
    rate: '0.00081', // 0.081%
    recipient: '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c',
});

/** Microcents per minor unit (cent): 1 cent = 10,000 microcents. */
export const MICRO_PER_MINOR = 10000n;

const RATE_RE = /^(\d+)(?:\.(\d{1,18}))?$/;

/**
 * Parse a decimal rate (number or string) into an exact { num, den } rational.
 * Accepts 0 <= rate <= 1. Returns { ok:true, num, den, rate } with num/den as
 * BigInt and rate as the canonical decimal string, or { ok:false, error }.
 */
/* EXACT-GATE: fee.rate — decimal rate to exact rational */
export function parseRate(rate) {
    let s;
    if (typeof rate === 'number') {
        if (!Number.isFinite(rate)) return { ok: false, error: 'rate must be a finite number' };
        if (rate < 0 || rate > 1) return { ok: false, error: 'rate must be between 0 and 1' };
        s = String(rate);
        // expand exponent notation (e.g. 1e-7) into plain decimals
        if (/[eE]/.test(s)) {
            const expanded = rate.toFixed(20);
            s = expanded.replace(/0+$/, '').replace(/\.$/, '');
            if (s === '-0') s = '0';
        }
    } else if (typeof rate === 'string') {
        s = rate.trim();
    } else {
        return { ok: false, error: 'rate must be a decimal number or string' };
    }
    const m = RATE_RE.exec(s);
    if (!m) return { ok: false, error: `rate is not a plain decimal (0..1): ${JSON.stringify(rate)}` };
    const intPart = m[1].replace(/^0+(?=\d)/, '') || '0';
    const fracPart = (m[2] || '').replace(/0+$/, '');
    const num = BigInt(intPart + fracPart || '0');
    const den = 10n ** BigInt(fracPart.length);
    if (num > den) return { ok: false, error: 'rate must not exceed 1' };
    const canonical = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
    return { ok: true, num, den, rate: canonical };
}

/**
 * Resolve the effective platform-fee config from merchant settings.
 * Absent settings.platformFee -> the lab default. Present -> merged over the
 * default ({...DEFAULT, ...settings.platformFee}) so a merchant can change
 * just the rate or just the recipient label.
 * Returns { ok:true, fee:{ rate, recipient, num, den } } or { ok:false, error }.
 */
/* EXACT-GATE: fee.resolve — settings to effective fee config */
export function resolvePlatformFee(settings) {
    const raw = (settings && settings.platformFee) || {};
    const merged = { ...DEFAULT_PLATFORM_FEE, ...raw };
    const parsed = parseRate(merged.rate);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const recipient = merged.recipient;
    if (typeof recipient !== 'string' || recipient.length === 0) {
        return { ok: false, error: 'platformFee.recipient must be a non-empty string' };
    }
    return {
        ok: true,
        fee: { rate: parsed.rate, recipient, num: parsed.num, den: parsed.den },
    };
}

/**
 * Exact fee for an order, in integer microcents, round-half-up.
 *   feeMicro = round_half_up(totalMinor * num/den * 10000)
 * totalMinor is integer minor units (cents), rate is number|string|{num,den}.
 * Returns { ok:true, microcents } (Number, exact for all realistic volumes)
 * or { ok:false, error }.
 */
/* EXACT-GATE: fee.compute — order value to integer microcents */
export function computePlatformFeeMicrocents(totalMinor, rate) {
    const t = Math.trunc(Number(totalMinor));
    if (!Number.isInteger(t) || t < 0) {
        return { ok: false, error: 'totalMinor must be a non-negative integer (minor units)' };
    }
    let num;
    let den;
    if (rate && typeof rate === 'object' && typeof rate.num === 'bigint' && typeof rate.den === 'bigint') {
        num = rate.num;
        den = rate.den;
    } else {
        const parsed = parseRate(rate);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        num = parsed.num;
        den = parsed.den;
    }
    if (den === 0n) return { ok: false, error: 'rate denominator is zero' };
    // exact rational: totalMinor * num/den cents -> *10000 microcents, half-up
    const n = BigInt(t) * num * MICRO_PER_MINOR;
    const q = n / den;
    const r = n % den;
    const rounded = 2n * r >= den ? q + 1n : q;
    return { ok: true, microcents: Number(rounded) };
}

/**
 * Whole cents releasable for settlement from an accrued microcent balance.
 * Floor: fractional cents are NEVER charged; the remainder stays accrued.
 * Returns { wholeCents, remainderMicrocents } as Numbers.
 */
/* EXACT-GATE: fee.settle — accrued microcents to whole cents due */
export function wholeCentsDue(accruedMicrocents) {
    const a = Math.trunc(Number(accruedMicrocents));
    if (!Number.isInteger(a) || a < 0) {
        return { ok: false, error: 'accruedMicrocents must be a non-negative integer' };
    }
    const wholeCents = Math.floor(a / 10000);
    return { ok: true, wholeCents, remainderMicrocents: a - wholeCents * 10000 };
}

/**
 * Display a microcent amount as USD text, e.g. 7290 -> "$0.00729",
 * 8100000 -> "$8.10". Deterministic: fixed 6 decimals, trailing zeros
 * trimmed, at least 2 decimals kept.
 */
export function formatMicrocentsUSD(microcents) {
    const m = Math.trunc(Number(microcents));
    if (!Number.isInteger(m) || m < 0) return '$?.??';
    const dollars = Math.floor(m / 1000000);
    const frac = String(m % 1000000).padStart(6, '0').replace(/0+$/, '');
    const frac2 = (frac + '00').slice(0, Math.max(2, frac.length));
    return `$${dollars}.${frac2}`;
}

/**
 * The fee line attached to a sealed order snapshot. Always present for
 * seal_order (microcents 0 when the merchant disabled the fee), so the fee
 * is visible on every sealed order — charged or not.
 */
export function feeLineForSnapshot({ merchandiseMinor, microcents, rate, recipient }) {
    return {
        rate,
        recipient,
        merchandiseMinor: Math.trunc(Number(merchandiseMinor)) || 0,
        microcents: Math.trunc(Number(microcents)) || 0,
        display: formatMicrocentsUSD(microcents),
        note: 'platform fee accrues to the recipient; fractional cents are never charged',
    };
}
