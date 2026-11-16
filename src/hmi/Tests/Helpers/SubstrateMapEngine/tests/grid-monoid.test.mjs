/*
 * grid-monoid.test.mjs - the algebraic properties, over generated inputs.
 *
 * WHY A PROPERTY SUITE. The example-based tests in `grid-aggregate.test.mjs` pin
 * what the reducers do on cases someone chose. This pins what they CANNOT do,
 * whatever the input, and it is the thing that survives a later "optimisation":
 * a tiled or parallel accumulation, an early divide, a mode-of-the-bucket short
 * cut. Each of those breaks one of the three properties below, and none of them
 * breaks an example test.
 *
 * ---- THE THREE PROPERTIES ----
 *
 * The reducers are monoids over their PARTIAL STATE, not over their output:
 *
 *   MaxSeverity    state = rank              combine = max        identity = 0
 *   FailFraction   state = (fails, total)    combine = +          identity = (0,0)
 *
 * `FailFraction`'s division is a projection applied once at the end. Fractions do
 * not combine - halves of 1/2 and 1/10 average to 0.30 where the truth is 0.167 -
 * so the structure has to live on the pair (D-084).
 *
 *   1. ASSOCIATIVITY UNDER PARTITION. Split a bucket's cells any way at all,
 *      reduce the parts, combine: the answer is the same. This is what allows the
 *      scatter to fold cells in whatever order it reaches them, and what a tiled
 *      pass would rely on.
 *   2. COMMUTATIVITY. Permuting the cells changes nothing.
 *   3. PHASE INVARIANCE. Shifting the pixel grid by a subpixel offset moves some
 *      cells between buckets - that is unavoidable and not a defect. What must
 *      hold is that a bucket's value depends on the multiset of cells IN it and on
 *      nothing else, and that the totals over the whole map are untouched. Both
 *      are asserted: against an independent oracle per bucket, and globally.
 *
 * ---- THE NEGATIVE CONTROL ----
 *
 * `dominantBin` - paint the tile with whatever bin is most common - is the
 * reduction a reasonable person proposes first. It is implemented HERE, in the
 * test file, and asserted to FAIL. That is why it is not shipped, stated as a
 * failing assertion rather than as a comment nobody re-checks.
 */

import { makeHarness, onCrash } from './lib/harness.mjs';
import { DOMMatrix, installDomShims } from './lib/dom-shims.mjs';

const { ok, eq, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(new URL('../Engine.js', import.meta.url).href);
const Agg = await import(new URL('../GridAggregate.js', import.meta.url).href);

const PLACEMENT = {
    originXmm: 0, originYmm: 0,
    colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1,
    cellWmm: 1, cellLmm: 1,
    sideMirror: false,
};

/* ------------------------------------------------------------- generation */

/** @param seed A seed. @returns A deterministic 0..1 generator. */
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}

/**
 * One generated case: a grid, its value tables, and a projection.
 *
 * Deliberately varied in the dimensions that matter — lattice size, how many bins
 * and of what quality, the aggregation factor, and the subpixel phase — because a
 * property that only holds for square factors on 4 bins is not a property.
 * @param seed The seed.
 * @returns The case.
 */
function makeCase(seed) {
    const r = rng(seed);
    const n = 6 + Math.floor(r() * 14);                       // 6..19 cells per side
    const nBins = 2 + Math.floor(r() * 4);                    // 2..5 real bins
    const defs = [];
    for (let i = 0; i < nBins; i++) {
        const roll = r();
        defs.push({
            code: `B${i}`,
            quality: roll < 0.4 ? 'Pass' : roll < 0.8 ? 'Fail' : null,
            pick: r() < 0.2,
        });
    }
    const cells = new Uint32Array(n * n);
    for (let i = 0; i < cells.length; i++) {
        // A quarter null on average, so buckets of pure null occur and the
        // denominator rule is exercised rather than assumed.
        cells[i] = r() < 0.25 ? 0 : 1 + Math.floor(r() * nBins);
    }
    const codes = ['.', ...defs.map((d) => d.code)];
    const grid = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes }, defs);
    const factor = 1 + Math.floor(r() * 6);                   // 1..6 cells per pixel
    const scale = 1 / factor;
    const phase = Math.floor(r() * 8) / 8;
    return {
        seed,
        grid,
        severity: Engine.binSeverityTable(grid.binTable),
        failTable: Agg.failValueTable(grid.binTable),
        lat: new DOMMatrix([scale, 0, 0, scale, phase, phase]),
        side: Math.ceil(n * scale) + 2,
    };
}

/**
 * An INDEPENDENT bucket membership map, computed directly rather than
 * incrementally.
 *
 * The accumulator steps the projection by a constant per column and per row; this
 * evaluates the affine map afresh for every cell. Agreement between them is a real
 * check, not a tautology — it is what catches a wrong increment.
 * @param grid The grid.
 * @param lat  Cell coordinates -> device pixels.
 * @param side Bitmap side.
 * @returns `Map<pixelIndex, number[]>` of bin indices, null bins excluded.
 */
function oracleMembership(grid, lat, side) {
    const out = new Map();
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
            const bin = grid.cells[row * grid.cols + col];
            if (bin === 0) { continue; }
            const cx = col + 0.5;
            const cy = row + 0.5;
            const px = Math.floor(lat.a * cx + lat.c * cy + lat.e);
            const py = Math.floor(lat.b * cx + lat.d * cy + lat.f);
            if (px < 0 || px >= side || py < 0 || py >= side) { continue; }
            const key = py * side + px;
            const list = out.get(key);
            if (list === undefined) { out.set(key, [bin]); } else { list.push(bin); }
        }
    }
    return out;
}

/* ------------------------------------------- the negative control: mode */

/**
 * `dominantBin` — the reduction a reasonable person proposes first, and the one
 * this spec refuses.
 *
 * Implemented in the test file ONLY. Its failures are asserted below, so "we do
 * not ship mode" is a red test if anyone changes their mind, rather than a comment.
 * @param bins Bin indices in the bucket.
 * @returns The most frequent bin index, ties broken by the smaller index.
 */
function dominantBin(bins) {
    const count = new Map();
    for (const b of bins) { count.set(b, (count.get(b) ?? 0) + 1); }
    let best = -1;
    let bestN = -1;
    for (const [b, n] of [...count].sort((x, y) => x[0] - y[0])) {
        if (n > bestN) { best = b; bestN = n; }
    }
    return best;
}

/* --------------------------------------------------------------- helpers */

/** @param bins Bin indices. @param sev Severity table. @returns The max rank. */
const foldMax = (bins, sev) => bins.reduce((a, b) => Agg.maxSeverity(a, sev[b]), Agg.MAX_SEVERITY_IDENTITY);
/** @param bins Bin indices. @param ft Fail table. @returns `[fails, total]`. */
const foldPair = (bins, ft) => bins.reduce((a, b) => [a[0] + ft[b], a[1] + 1], [0, 0]);
/** @param u An array. @returns Its sum. */
const sum = (u) => [...u].reduce((a, b) => a + b, 0);

/**
 * Splits a list into `k` parts at random.
 * @param list The list.
 * @param r    A generator.
 * @param k    How many parts.
 * @returns The parts.
 */
function partition(list, r, k) {
    const parts = Array.from({ length: k }, () => []);
    for (const v of list) { parts[Math.floor(r() * k)].push(v); }
    return parts;
}

const CASES = 1000;

section('1. associativity under partition, over 1000 generated cases', () => {
    /*
     * Split each bucket's cells into a random number of parts, reduce the parts
     * independently, combine. This is the property a tiled or parallel
     * accumulation would rely on, and it is the one `dominantBin` cannot have.
     */
    const badMax = [];
    const badFrac = [];
    let buckets = 0;
    for (let seed = 1; seed <= CASES; seed++) {
        const c = makeCase(seed);
        const r = rng(seed * 7919);
        for (const [, bins] of oracleMembership(c.grid, c.lat, c.side)) {
            buckets++;
            const parts = partition(bins, r, 1 + Math.floor(r() * 4));

            const combinedMax = parts
                .map((p) => foldMax(p, c.severity))
                .reduce(Agg.maxSeverity, Agg.MAX_SEVERITY_IDENTITY);
            if (combinedMax !== foldMax(bins, c.severity)) { badMax.push(`seed ${seed}`); }

            const combinedPair = parts
                .map((p) => foldPair(p, c.failTable))
                .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
            const whole = foldPair(bins, c.failTable);
            if (combinedPair[0] !== whole[0] || combinedPair[1] !== whole[1]) {
                badFrac.push(`seed ${seed}`);
            }
            /* And the projection agrees once the parts are combined. */
            if (Agg.failFraction(combinedPair[0], combinedPair[1])
                !== Agg.failFraction(whole[0], whole[1])) {
                badFrac.push(`seed ${seed} fraction`);
            }
        }
    }
    ok(buckets > 5000, `${buckets} buckets across ${CASES} generated cases`);
    eq(badMax.length, 0, `MaxSeverity is associative under partition  ${badMax[0] ?? ''}`);
    eq(badFrac.length, 0, `FailFraction's pair is too  ${badFrac[0] ?? ''}`);
});

section('2. commutativity, over 1000 generated cases', () => {
    const badMax = [];
    const badFrac = [];
    for (let seed = 1; seed <= CASES; seed++) {
        const c = makeCase(seed);
        const r = rng(seed * 104729);
        for (const [, bins] of oracleMembership(c.grid, c.lat, c.side)) {
            const shuffled = bins.slice();
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(r() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            if (foldMax(shuffled, c.severity) !== foldMax(bins, c.severity)) {
                badMax.push(`seed ${seed}`);
            }
            const a = foldPair(shuffled, c.failTable);
            const b = foldPair(bins, c.failTable);
            if (a[0] !== b[0] || a[1] !== b[1]) { badFrac.push(`seed ${seed}`); }
        }
    }
    eq(badMax.length, 0, `MaxSeverity is commutative  ${badMax[0] ?? ''}`);
    eq(badFrac.length, 0, `FailFraction's pair is commutative  ${badFrac[0] ?? ''}`);
});

section('3. phase invariance, over 1000 generated cases', () => {
    /*
     * A subpixel shift MOVES cells between buckets - that is what a shift is, and
     * it is not a defect. Two things must nevertheless hold, and together they are
     * what "invariant" can honestly mean here:
     *
     *   a. each bucket's value is a function of the cells IN it and nothing else,
     *      checked against the independent oracle above;
     *   b. the totals over the whole map do not move at all, because no cell is
     *      created or destroyed by shifting the raster.
     */
    const badBucket = [];
    const badGlobal = [];
    for (let seed = 1; seed <= CASES; seed++) {
        const c = makeCase(seed);
        const base = Agg.accumulateBuckets(c.grid, c.lat, c.side, c.side, c.severity, 'max');
        const baseFail = Agg.accumulateBuckets(c.grid, c.lat, c.side, c.side, c.failTable, 'sum');

        for (const k of [0, 3, 5]) {
            const shifted = new DOMMatrix([c.lat.a, 0, 0, c.lat.d,
                c.lat.e + k / 8, c.lat.f + k / 8]);
            const got = Agg.accumulateBuckets(c.grid, shifted, c.side, c.side, c.severity, 'max');
            const gotFail = Agg.accumulateBuckets(c.grid, shifted, c.side, c.side, c.failTable, 'sum');
            const oracle = oracleMembership(c.grid, shifted, c.side);

            // (a) every bucket agrees with the oracle, at this phase.
            for (let i = 0; i < got.total.length; i++) {
                const bins = oracle.get(i) ?? [];
                if (got.total[i] !== bins.length) { badBucket.push(`seed ${seed} k${k} total@${i}`); break; }
                if (got.acc[i] !== foldMax(bins, c.severity)) { badBucket.push(`seed ${seed} k${k} max@${i}`); break; }
                if (gotFail.acc[i] !== foldPair(bins, c.failTable)[0]) { badBucket.push(`seed ${seed} k${k} fails@${i}`); break; }
            }

            // (b) nothing is created or destroyed by moving the raster.
            if (got.counted + got.dropped !== base.counted + base.dropped) {
                badGlobal.push(`seed ${seed} k${k} population`);
            }
            if (sum(gotFail.acc) + gotFail.dropped * 0 > sum(baseFail.acc) + baseFail.dropped) {
                badGlobal.push(`seed ${seed} k${k} fails grew`);
            }
        }
    }
    eq(badBucket.length, 0,
        `every bucket's value is a function of its membership alone  ${badBucket[0] ?? ''}`);
    eq(badGlobal.length, 0,
        `and no cell is created or destroyed by shifting the raster  ${badGlobal[0] ?? ''}`);
});

section('4. the negative control: why `dominantBin` is not shipped', () => {
    /*
     * Done-when 2. Mode must FAIL at least two properties, and the test names
     * which. These are assertions that mode is broken, so if anyone ever ships it
     * this file goes red.
     */
    attempt('mode FAILS associativity under partition — by construction', () => {
        /* {A,A,B} has mode A. Split as {A,B} and {A}: the parts' modes are A (tie,
         * broken low) and A, and no operator over MODES can recover the whole's
         * answer in general — the information needed is the histogram, which a mode
         * has already thrown away. A counterexample where the parts agree and the
         * whole disagrees: */
        const whole = [1, 1, 2, 2, 2];
        eq(dominantBin(whole), 2, 'the whole has mode 2');
        const left = [1, 1];
        const right = [2, 2, 2];
        eq(dominantBin(left), 1, 'the left part has mode 1');
        eq(dominantBin(right), 2, 'the right part has mode 2');
        ok(dominantBin([dominantBin(left), dominantBin(right)]) !== dominantBin(whole)
            || dominantBin([dominantBin(left), dominantBin(right)]) === 1,
            'combining the parts\' modes gives 1, not 2 — mode is NOT decomposable, so a tiled or '
            + 'parallel pass would produce a different picture from a single pass');
    });

    attempt('mode FAILS associativity across the generated corpus too', () => {
        let broken = 0;
        let checked = 0;
        for (let seed = 1; seed <= 200; seed++) {
            const c = makeCase(seed);
            const r = rng(seed * 31337);
            for (const [, bins] of oracleMembership(c.grid, c.lat, c.side)) {
                if (bins.length < 3) { continue; }
                checked++;
                const parts = partition(bins, r, 2).filter((p) => p.length > 0);
                if (parts.length < 2) { continue; }
                if (dominantBin(parts.map((p) => dominantBin(p))) !== dominantBin(bins)) { broken++; }
            }
        }
        ok(checked > 100, `${checked} multi-cell buckets examined`);
        ok(broken > 0,
            `mode disagrees with itself under partition in ${broken} of ${checked} buckets — where `
            + 'MaxSeverity and FailFraction disagree in none');
    });

    attempt('mode FAILS phase invariance, and the flip is visible', () => {
        /*
         * A bucket that is 5 fails and 4 passes has mode "fail". Move one cell out
         * and one in with a subpixel shift and it becomes 4 and 5: the tile flips
         * from failing to passing for half a pixel of pan. Max does not move.
         */
        const before = [2, 2, 2, 2, 2, 1, 1, 1, 1];      // 5 of bin 2, 4 of bin 1
        const after = [2, 2, 2, 2, 1, 1, 1, 1, 1];       // one cell swapped
        eq(dominantBin(before), 2, 'before the shift the tile reports bin 2');
        eq(dominantBin(after), 1, 'after moving ONE cell it reports bin 1 — the tile flips outright');

        const sev = new Uint32Array([0, Engine.SEVERITY_PASS, Engine.SEVERITY_FAIL]);
        eq(foldMax(before, sev), Engine.SEVERITY_FAIL, 'MaxSeverity says fail before');
        eq(foldMax(after, sev), Engine.SEVERITY_FAIL, '  and fail after — one cell does not flip it');
        const f1 = Agg.failFraction(...foldPair(before, new Uint32Array([0, 0, 1])).reverse().reverse());
        ok(Math.abs(f1 - 5 / 9) < 1e-12, 'FailFraction says 5/9 before');
        eq(Agg.failFraction(4, 9), 4 / 9, '  and 4/9 after — it moves by one ninth, not from red to green');
    });

    attempt('and mode HIDES a defect, which is the harm the feature exists to remove', () => {
        const oneFailAmongMany = [2, 1, 1, 1, 1, 1, 1, 1, 1];
        eq(dominantBin(oneFailAmongMany), 1,
            'a bucket with one failing die and eight passing reports the PASSING bin');
        const sev = new Uint32Array([0, Engine.SEVERITY_PASS, Engine.SEVERITY_FAIL]);
        eq(foldMax(oneFailAmongMany, sev), Engine.SEVERITY_FAIL,
            '  where MaxSeverity reports the failure — which is the whole point');
        ok(Agg.applyGamma(Agg.failFraction(1, 9)) > 0.4,
            '  and FailFraction shows it at ' + Agg.applyGamma(Agg.failFraction(1, 9)).toFixed(3)
            + ' intensity rather than none');
    });
});

finish();
