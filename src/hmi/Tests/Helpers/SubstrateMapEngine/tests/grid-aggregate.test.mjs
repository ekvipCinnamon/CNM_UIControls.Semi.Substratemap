/*
 * grid-aggregate.test.mjs - the bucket accumulator.
 *
 * The scatter pass is the thing that makes aggregation possible at all, so this
 * suite pins the three properties everything above it will assume: every non-null
 * cell is counted exactly once, no null cell is counted at all, and the result does
 * not depend on where the cells happen to be visited.
 *
 * The counterpart is `grid-aliasing.test.mjs`, which measures what happens WITHOUT
 * this: a single failing die vanishing at every one of eight subpixel phases once
 * the factor reaches 20. Section 4 here shows the same die surviving.
 */

import { readFileSync } from 'node:fs';
import { makeHarness, onCrash } from './lib/harness.mjs';
import { DOMMatrix, installDomShims, makeContext2D } from './lib/dom-shims.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(new URL('../Engine.js', import.meta.url).href);
const Agg = await import(new URL('../GridAggregate.js', import.meta.url).href);
const Filter = await import(new URL('../SpatialFilter.js', import.meta.url).href);
const Ok = await import(new URL('../Oklch.js', import.meta.url).href);

const PLACEMENT = {
    originXmm: 0, originYmm: 0,
    colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1,
    cellWmm: 1, cellLmm: 1,
    sideMirror: false,
};
const BIN_DEFS = [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Fail' }];
const CODES = ['.', '1', '9'];

/**
 * A round map with a null border, optionally with one failing die.
 * @param n      Side length.
 * @param failAt `[col, row]` for the failing die, or null.
 * @returns `{ grid, nonNull, severity }`.
 */
function roundMap(n, failAt) {
    const cells = new Uint32Array(n * n);
    const c0 = (n - 1) / 2;
    const rad = (n / 2 - 1) ** 2;
    let nonNull = 0;
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if ((c - c0) ** 2 + (r - c0) ** 2 > rad) { continue; }   // off substrate
            cells[r * n + c] = 1;
            nonNull++;
        }
    }
    if (failAt) {
        const [fc, fr] = failAt;
        if (cells[fr * n + fc] === 0) { throw new Error('the failing die must be on the substrate'); }
        cells[fr * n + fc] = 2;
    }
    const grid = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
    return { grid, nonNull, severity: Engine.binSeverityTable(grid.binTable) };
}

/** @param scale Device px per cell. @returns The lattice->device matrix. */
const at = (scale) => new DOMMatrix([scale, 0, 0, scale, 0, 0]);
/** @param u A Uint32Array. @returns Its sum. */
const sum = (u) => u.reduce((a, b) => a + b, 0);

section('1. the null bin is in neither numerator nor denominator', () => {
    /* Done-when 1. A pixel with no substrate under it must be distinguishable from
     * a pixel full of passing dies — the renderer leaves the first transparent. */
    const cells = new Uint32Array(64);                     // 8x8, every cell null
    const grid = Engine.buildGridModel(PLACEMENT, { cols: 8, rows: 8, cells, codes: CODES }, BIN_DEFS);
    const b = Agg.accumulateBuckets(grid, at(1), 8, 8, new Uint32Array([0, 1, 3]), 'max');

    eq(sum(b.total), 0, 'a fully null 8x8 region contributes nothing to any total');
    eq(b.counted, 0, '  and counts nothing');
    ok([...b.acc].every((v) => v === 0), '  and leaves the accumulator untouched');
    ok(![...b.total].some((t) => t > 0), 'no bucket claims substrate');
    eq(Agg.bucketIsPainted(b, 3, 3), false, 'so no pixel is painted');

    /*
     * The CENTRE convention, and it needs a scale where the half-cell offset is
     * observable. At 1 device px per cell, floor(c + 0.5) and floor(c) are the same
     * pixel, so a mutation projecting the corner instead of the centre survives
     * every assertion in this file — which it did, until this one.
     *
     * At 2 px per cell, cell (0,0)'s centre is device (1,1) and its corner (0,0).
     * The centre is the point `getCellAtPos` tests, so a bucket holds the cells a
     * click would land in.
     */
    attempt('a cell is scattered by its CENTRE, not its corner', () => {
        const one = new Uint32Array(4);
        one[0] = 1;                                        // cell (0,0) only
        const g = Engine.buildGridModel(PLACEMENT, { cols: 2, rows: 2, cells: one, codes: CODES }, BIN_DEFS);
        const b = Agg.accumulateBuckets(g, at(2), 4, 4, new Uint32Array([0, 1, 3]), 'sum');
        eq(Agg.bucketIsPainted(b, 1, 1), true,
            'cell (0,0) at 2 px per cell lands at device (1,1) — its centre');
        eq(Agg.bucketIsPainted(b, 0, 0), false, '  and NOT at (0,0), which is its corner');
    });

    attempt('a single non-null cell among nulls is counted, and only it', () => {
        const one = new Uint32Array(64);
        one[27] = 1;                                       // (3,3)
        const g = Engine.buildGridModel(PLACEMENT, { cols: 8, rows: 8, cells: one, codes: CODES }, BIN_DEFS);
        const bb = Agg.accumulateBuckets(g, at(1), 8, 8, new Uint32Array([0, 1, 3]), 'sum');
        eq(sum(bb.total), 1, 'exactly one cell counted');
        eq(Agg.bucketIsPainted(bb, 3, 3), true, '  at its own pixel');
        eq(Agg.bucketIsPainted(bb, 4, 3), false, '  and nowhere else');
    });
});

section('2. totals are exact at every factor', () => {
    /*
     * Done-when 2. The sum of the buckets must equal the number of non-null cells,
     * exactly — not approximately, and not at one factor. A scatter that
     * double-counted or dropped a cell would still produce a plausible picture.
     */
    const { grid, nonNull, severity } = roundMap(32, [17, 13]);
    ok(nonNull > 600, `the fixture has ${nonNull} non-null cells inside the outline`);

    for (const factor of [1, 2, 3, 4, 8, 16]) {
        const s = 1 / factor;
        const side = Math.ceil(32 * s) + 1;
        const b = Agg.accumulateBuckets(grid, at(s), side, side, severity, 'max');
        eq(sum(b.total), nonNull, `factor ${factor}: bucket totals sum to every non-null cell`);
        eq(b.counted, nonNull, `  and counted agrees`);
        eq(b.dropped, 0, `  with nothing projected off the bitmap`);
    }

    attempt('cells landing outside the bitmap are dropped and reported', () => {
        const b = Agg.accumulateBuckets(grid, at(1), 8, 8, severity, 'max');
        ok(b.dropped > 0, 'a bitmap smaller than the map drops cells');
        eq(b.counted + b.dropped, nonNull,
            '  and counted + dropped is still every non-null cell — nothing vanishes silently');
    });
});

section('3. the combine modes', () => {
    const { grid, severity } = roundMap(16, [9, 9]);

    attempt('max takes the worst value in the bucket', () => {
        const b = Agg.accumulateBuckets(grid, at(1 / 8), 3, 3, severity, 'max');
        eq(Math.max(...b.acc), Engine.SEVERITY_FAIL,
            'the failing die reaches its bucket even at 8 cells per pixel across');
        ok([...b.acc].filter((v) => v === Engine.SEVERITY_FAIL).length === 1,
            '  and only its own bucket carries the fail rank');
    });

    /*
     * `sum` must be distinguishable from `max`, which needs at least TWO
     * contributing cells in one bucket — with one failing die the two modes agree
     * and a "sum is a max" mutation survives. It did.
     */
    attempt('sum counts, and is not a max', () => {
        const n = 8;
        const cells = new Uint32Array(n * n).fill(1);
        cells[0] = 2;
        cells[1] = 2;
        cells[n] = 2;                                      // three failing dies, all in bucket 0
        const g = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
        const failFlag = new Uint32Array(g.binTable.length);
        for (let i = 1; i < g.binTable.length; i++) {
            failFlag[i] = Engine.binSeverity(g.binTable[i]) >= Engine.SEVERITY_FAIL ? 1 : 0;
        }
        const summed = Agg.accumulateBuckets(g, at(1 / n), 1, 1, failFlag, 'sum');
        const maxed = Agg.accumulateBuckets(g, at(1 / n), 1, 1, failFlag, 'max');
        eq(summed.acc[0], 3, 'sum reports all three failing dies');
        eq(maxed.acc[0], 1, '  where max reports only that there was at least one');
        eq(summed.total[0], n * n, 'and the denominator is every cell in the bucket');
    });

    attempt('max never exceeds the largest value present', () => {
        const b = Agg.accumulateBuckets(grid, at(1 / 4), 5, 5, severity, 'max');
        ok(Math.max(...b.acc) <= Math.max(...severity),
            'aggregation cannot invent a severity no bin has');
    });
});

section('4. what point sampling loses, the accumulator keeps', () => {
    /*
     * The counterpart to grid-aliasing.test.mjs. There, one failing die vanishes at
     * every subpixel phase from factor 20 upward. Here it survives every phase at
     * every factor, which is the whole claim of the feature — and it is asserted
     * against the SAME shape of probe so the two are comparable.
     */
    const { grid, severity } = roundMap(60, [31, 29]);
    const PHASES = 8;

    for (const factor of [2, 6, 20, 50]) {
        const s = 1 / factor;
        const side = Math.ceil(60 * s) + 2;
        const missing = [];
        for (let k = 0; k < PHASES; k++) {
            const off = k / PHASES;
            const b = Agg.accumulateBuckets(
                grid, new DOMMatrix([s, 0, 0, s, off, off]), side, side, severity, 'max');
            if (!([...b.acc].some((v) => v === Engine.SEVERITY_FAIL))) { missing.push(`${k}/${PHASES}`); }
        }
        eq(missing.length, 0,
            `factor ${factor}: the failing die reaches a bucket at all ${PHASES} phases`
            + `${missing.length ? ` — lost at ${missing.join(', ')}` : ''}`);
    }
});

section('5. order independence', () => {
    /*
     * The reducers above this are meant to be associative and commutative, which is
     * only meaningful if the accumulator does not smuggle in an order dependence of
     * its own. Same cells, permuted into a different arrangement that preserves
     * per-bucket membership, must give identical buckets.
     */
    attempt('a row-reversed map gives the mirror of the same buckets', () => {
        const n = 12;
        const cells = new Uint32Array(n * n).fill(1);
        cells[5 * n + 3] = 2;
        const g1 = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
        const sev = Engine.binSeverityTable(g1.binTable);
        const b1 = Agg.accumulateBuckets(g1, at(1), n, n, sev, 'max');

        /* Reverse each row, and mirror the read-out. Same multiset per bucket. */
        const mirrored = new Uint32Array(n * n);
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) { mirrored[r * n + (n - 1 - c)] = cells[r * n + c]; }
        }
        const g2 = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells: mirrored, codes: CODES }, BIN_DEFS);
        const b2 = Agg.accumulateBuckets(g2, at(1), n, n, sev, 'max');

        eq(sum(b1.total), sum(b2.total), 'the same cells are counted');
        eq(Math.max(...b1.acc), Math.max(...b2.acc), 'and the worst value is the same');
        const back = [];
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) { back.push(b2.acc[r * n + (n - 1 - c)]); }
        }
        deep(back, [...b1.acc], 'and mirroring the result back reproduces it exactly');
    });

    attempt('the same bucket is reached whatever the iteration order would be', () => {
        /* Two failing dies in one bucket: `max` must give the same answer whichever
         * is visited first, which is what makes the reducer above it idempotent. */
        const n = 8;
        const cells = new Uint32Array(n * n).fill(1);
        cells[0] = 2;
        cells[n + 1] = 2;
        const g = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
        const sev = Engine.binSeverityTable(g.binTable);
        const b = Agg.accumulateBuckets(g, at(1 / n), 2, 2, sev, 'max');
        eq(b.acc[0], Engine.SEVERITY_FAIL, 'both fails land in bucket 0 and it reports the fail rank');
        eq(sum(b.total), n * n, '  with every cell counted once');
    });
});

section('6. degenerate inputs are refused rather than guessed at', () => {
    const { grid, severity } = roundMap(16, null);

    attempt('a zero-sized bitmap yields empty buckets', () => {
        const b = Agg.accumulateBuckets(grid, at(1), 0, 0, severity, 'max');
        eq(b.total.length, 0, 'no buckets');
        eq(b.counted, 0, '  and nothing counted');
        eq(Agg.bucketIsPainted(b, 0, 0), false, '  and nothing painted');
    });

    attempt('an out-of-range probe is not painted', () => {
        const b = Agg.accumulateBuckets(grid, at(1), 16, 16, severity, 'max');
        eq(Agg.bucketIsPainted(b, -1, 0), false, 'negative x');
        eq(Agg.bucketIsPainted(b, 0, 99), false, 'y past the end');
        eq(Agg.bucketIsPainted(b, 8, 8), true, '  while the middle is');
    });

    attempt('a value table shorter than the bin table does not throw', () => {
        const b = Agg.accumulateBuckets(grid, at(1), 16, 16, new Uint32Array([0]), 'max');
        eq(sum(b.total), Agg.accumulateBuckets(grid, at(1), 16, 16, severity, 'max').counted,
            'the denominator is unaffected by a missing value');
        eq(Math.max(...b.acc), 0, '  and an absent value reads as 0 rather than NaN');
    });
});

section('7. MaxSeverity: the operator and its algebra (LOD-10)', () => {
    const RANKS = [0, 1, 2, 3, 4, 7, 11];

    eq(Agg.MAX_SEVERITY_IDENTITY, Engine.SEVERITY_NULL,
        'the identity is SEVERITY_NULL — nothing seen, nothing claimed');

    attempt('it is a monoid: identity, associative, commutative, idempotent', () => {
        const bad = [];
        for (const x of RANKS) {
            if (Agg.maxSeverity(x, Agg.MAX_SEVERITY_IDENTITY) !== x) { bad.push(`identity ${x}`); }
            if (Agg.maxSeverity(x, x) !== x) { bad.push(`idempotent ${x}`); }
            for (const y of RANKS) {
                if (Agg.maxSeverity(x, y) !== Agg.maxSeverity(y, x)) { bad.push(`commutative ${x},${y}`); }
                for (const z of RANKS) {
                    const l = Agg.maxSeverity(Agg.maxSeverity(x, y), z);
                    const r = Agg.maxSeverity(x, Agg.maxSeverity(y, z));
                    if (l !== r) { bad.push(`associative ${x},${y},${z}`); }
                }
            }
        }
        eq(bad.length, 0, `all four laws hold over ${RANKS.length ** 3} triples  ${bad[0] ?? ''}`);
    });

    /*
     * Done-when 2. Order independence, at the OPERATOR: folding the same multiset
     * in many different orders must give one answer. This is what lets the scatter
     * visit cells in whatever order it reaches them.
     */
    attempt('folding a shuffled multiset gives one answer', () => {
        const values = [0, 1, 1, 2, 3, 1, 0, 2, 3, 1, 1, 1];
        const fold = (xs) => xs.reduce(Agg.maxSeverity, Agg.MAX_SEVERITY_IDENTITY);
        const expected = fold(values);
        eq(expected, 3, 'the worst value present is 3');

        let seed = 12345;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const differing = [];
        for (let trial = 0; trial < 200; trial++) {
            const shuffled = values.slice();
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            if (fold(shuffled) !== expected) { differing.push(shuffled.join(',')); }
        }
        eq(differing.length, 0,
            `200 shuffles of the same multiset all fold to ${expected}  ${differing[0] ?? ''}`);
    });

    /* Done-when 1. "A bucket of any size" is the claim worth pinning: it is exactly
     * what point sampling cannot do, and the bigger the bucket the more it matters. */
    attempt('one failing die produces the fail rank in a bucket of any size', () => {
        const missed = [];
        for (const n of [1, 2, 10, 40, 100]) {
            const cells = new Uint32Array(n * n).fill(1);
            cells[Math.floor(n * n / 3)] = 2;              // exactly one failing die
            const g = Engine.buildGridModel(PLACEMENT,
                { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
            const sev = Engine.binSeverityTable(g.binTable);
            // The whole map into ONE pixel: the largest bucket there is.
            const b = Agg.accumulateBuckets(g, at(1 / n), 1, 1, sev, 'max');
            if (b.acc[0] !== Engine.SEVERITY_FAIL) {
                missed.push(`${n}x${n} (${n * n} cells) gave ${b.acc[0]}`);
            }
            if (b.total[0] !== n * n) { missed.push(`${n}x${n} counted ${b.total[0]}`); }
        }
        eq(missed.length, 0,
            `one failing die survives a bucket of 1, 4, 100, 1600 and 10000 cells  ${missed[0] ?? ''}`);
    });

    /*
     * THE INVARIANT that let `reduceMaxSeverity` be deleted. `acc[i]` is written
     * only inside the branch that increments `total[i]`, so an empty bucket already
     * holds the identity and needs no normalising. Asserted here over a real map
     * rather than defended against in code that could not be reached.
     */
    attempt('an empty bucket already holds the identity', () => {
        const { grid, severity } = roundMap(24, [13, 11]);
        const b = Agg.accumulateBuckets(grid, at(1 / 3), 9, 9, severity, 'max');
        const empty = [];
        for (let i = 0; i < b.total.length; i++) {
            if (b.total[i] === 0 && b.acc[i] !== Agg.MAX_SEVERITY_IDENTITY) { empty.push(i); }
        }
        ok([...b.total].some((t) => t === 0),
            'the round map leaves some corner buckets empty, so there is something to check');
        eq(empty.length, 0,
            'every empty bucket holds the identity by construction — acc is written only where '
            + 'total is incremented');
        const at00 = 0;
        eq(Agg.bucketIsPainted(b, 0, 0), b.total[at00] > 0,
            'and `total` — not the rank — is what says whether a pixel is painted');
    });

    /*
     * Order independence at the GRID level, which is the claim the Done-when
     * actually makes. Permuting cells WITHIN a bucket leaves each bucket's multiset
     * identical, so every reduced value must be unchanged.
     */
    attempt('permuting cells within their buckets changes nothing', () => {
        const n = 12;
        const factor = 4;                                   // 3x3 buckets of 4x4 cells
        const base = new Uint32Array(n * n).fill(1);
        base[0 * n + 1] = 2;
        base[5 * n + 6] = 2;
        base[9 * n + 3] = 0;                                // a null cell, to move too

        let seed = 999;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        /** @param src Cells. @returns A copy with each 4x4 block shuffled in place. */
        const shuffleBlocks = (src) => {
            const out = src.slice();
            for (let by = 0; by < n; by += factor) {
                for (let bx = 0; bx < n; bx += factor) {
                    const idx = [];
                    for (let r = by; r < by + factor; r++) {
                        for (let c = bx; c < bx + factor; c++) { idx.push(r * n + c); }
                    }
                    const vals = idx.map((i) => out[i]);
                    for (let i = vals.length - 1; i > 0; i--) {
                        const j = Math.floor(rnd() * (i + 1));
                        [vals[i], vals[j]] = [vals[j], vals[i]];
                    }
                    idx.forEach((i, k) => { out[i] = vals[k]; });
                }
            }
            return out;
        };

        const reduceOf = (cells) => {
            const g = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
            const sev = Engine.binSeverityTable(g.binTable);
            const b = Agg.accumulateBuckets(g, at(1 / factor), n / factor, n / factor, sev, 'max');
            return { reduced: [...b.acc], total: [...b.total] };
        };

        const original = reduceOf(base);
        ok(original.reduced.includes(Engine.SEVERITY_FAIL),
            'the fixture has a failing die to lose');
        const differing = [];
        for (let trial = 0; trial < 50; trial++) {
            const got = reduceOf(shuffleBlocks(base));
            if (got.reduced.join(',') !== original.reduced.join(',')) {
                differing.push(`ranks ${got.reduced.join(',')}`);
            }
            if (got.total.join(',') !== original.total.join(',')) {
                differing.push(`totals ${got.total.join(',')}`);
            }
        }
        eq(differing.length, 0,
            `50 within-bucket permutations leave every reduced value untouched  ${differing[0] ?? ''}`);
    });

    attempt('a bucket cannot report a rank no cell in it carries', () => {
        const n = 8;
        const cells = new Uint32Array(n * n).fill(1);       // all pass, no fail anywhere
        const g = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
        const sev = Engine.binSeverityTable(g.binTable);
        const b = Agg.accumulateBuckets(g, at(1 / n), 1, 1, sev, 'max');
        eq(b.acc[0], Engine.SEVERITY_PASS,
            'an all-passing bucket reports pass — worst-wins does not invent a failure');
    });
});

section('8. OKLCH, against published values rather than a round trip (LOD-11)', () => {
    /*
     * Rule 10. A round trip through this file's own matrices passes just as
     * happily with a transposed matrix, so the check is against the published
     * OKLab constants for sRGB white, black and the three primaries — values
     * computed elsewhere and written here as literals.
     */
    /** @param a Actual. @param b Expected. @param eps Tolerance. @returns Whether close. */
    const near = (a, b, eps = 5e-4) => Math.abs(a - b) < eps;

    const cases = [
        ['white', { r: 255, g: 255, b: 255 }, 1.0000, 0.0000, null],
        ['black', { r: 0, g: 0, b: 0 }, 0.0000, 0.0000, null],
        ['red', { r: 255, g: 0, b: 0 }, 0.6280, 0.2577, 29.2],
        ['green', { r: 0, g: 255, b: 0 }, 0.8664, 0.2948, 142.5],
        ['blue', { r: 0, g: 0, b: 255 }, 0.4520, 0.3132, 264.1],
    ];
    const wrong = [];
    for (const [name, rgb, L, C, h] of cases) {
        const got = Ok.rgbToOklch(rgb);
        if (!near(got.L, L)) { wrong.push(`${name} L ${got.L} != ${L}`); }
        if (!near(got.C, C)) { wrong.push(`${name} C ${got.C} != ${C}`); }
        if (h !== null && !near(got.h, h, 0.1)) { wrong.push(`${name} h ${got.h} != ${h}`); }
    }
    eq(wrong.length, 0, `all five reference colours convert correctly  ${wrong[0] ?? ''}`);

    attempt('a grey reports hue 0 rather than an arbitrary angle', () => {
        eq(Ok.rgbToOklch({ r: 128, g: 128, b: 128 }).h, 0,
            'hue is undefined for a grey, and atan2 would answer anyway');
        ok(Ok.rgbToOklch({ r: 128, g: 128, b: 128 }).C < 1e-7, '  and its chroma is zero');
    });

    attempt('the hue takes the shorter arc', () => {
        /* 350 deg to 10 deg is 20 deg forward through 0, not 340 back through green.
         * Halfway must be 0, and a naive lerp would give 180 — the far side. */
        const mid = Ok.mixOklch({ L: 0.5, C: 0.1, h: 350 }, { L: 0.5, C: 0.1, h: 10 }, 0.5);
        ok(near(mid.h, 0, 1e-9) || near(mid.h, 360, 1e-9),
            `halfway between hue 350 and 10 is 0, not 180 — got ${mid.h}`);
    });

    attempt('mixing toward a grey reddens rather than rotating', () => {
        const mid = Ok.mixOklch({ L: 0.5, C: 0, h: 0 }, { L: 0.5, C: 0.2, h: 142 }, 0.5);
        ok(near(mid.h, 142, 1e-9), 'the grey end borrows the other end\'s hue');
        ok(near(mid.C, 0.1, 1e-9), '  and only the chroma moves');
    });

    attempt('the endpoints survive a round trip exactly', () => {
        for (const css of ['#00aa00', '#aa0000', '#888888', '#123456']) {
            eq(Ok.formatRgb(Ok.oklchToRgb(Ok.rgbToOklch(Ok.parseRgb(css)))), css,
                `${css} round-trips to itself`);
        }
    });

    attempt('unsupported colour forms are refused, not guessed', () => {
        eq(Ok.parseRgb('rebeccapurple'), null, 'a named colour');
        eq(Ok.parseRgb('hsl(200 50% 50%)'), null, 'and hsl()');
        eq(Ok.mixCssOklch('#00aa00', 'not-a-colour', 0.5), null, '  and a mix with one is null');
        deep(Ok.parseRgb('#0a0'), { r: 0, g: 170, b: 0 }, 'while #rgb expands');
    });
});

section('9. FailFraction (LOD-11)', () => {
    /* Done-when 1: the scratch case is visible. The spec's own arithmetic —
     * "at 6:1, gamma 0.4 lifts 1/6 from 0.17 to 0.49". */
    attempt('one failing die at 6 cells per pixel is visible', () => {
        const raw = Agg.failFraction(1, 6);
        ok(Math.abs(raw - 1 / 6) < 1e-12, `the raw fraction is 1/6 = ${raw.toFixed(4)} — a tint`);
        const out = Agg.applyGamma(raw);
        ok(out >= 0.45,
            `gamma ${Agg.FAIL_FRACTION_DEFAULT_GAMMA} lifts it to ${out.toFixed(4)}, which is >= 0.45`);
        ok(out < 1, '  without saturating — a one-die scratch is not a solid red tile');
    });

    /* Done-when 2: the knob is honest. */
    attempt('gamma 1.0 reproduces the linear fraction exactly', () => {
        const bad = [];
        for (const [f, t] of [[0, 5], [1, 6], [3, 7], [2, 3], [5, 5], [1, 1000]]) {
            const raw = Agg.failFraction(f, t);
            if (Agg.applyGamma(raw, 1) !== raw) { bad.push(`${f}/${t}`); }
        }
        eq(bad.length, 0, `gamma 1 is the identity, exactly — not to a tolerance  ${bad[0] ?? ''}`);
        eq(Agg.applyGamma(0), 0, 'and 0 is a fixed point at any gamma');
        eq(Agg.applyGamma(1), 1, '  as is 1, so both ends of the ramp mean the same thing');
    });

    /*
     * Done-when 3, and the one that constrains the DESIGN: fractions do not
     * combine, so the associative structure has to live on the pair.
     */
    attempt('sums compose: two half-buckets equal the whole', () => {
        const halves = [[1, 2], [1, 10]];
        const whole = [halves[0][0] + halves[1][0], halves[0][1] + halves[1][1]];
        eq(Agg.failFraction(whole[0], whole[1]), Agg.failFraction(2, 12),
            'summing the PAIRS and dividing once gives the true fraction');
        const averaged = (Agg.failFraction(...halves[0]) + Agg.failFraction(...halves[1])) / 2;
        ok(Math.abs(averaged - Agg.failFraction(whole[0], whole[1])) > 0.1,
            `averaging the two FRACTIONS gives ${averaged.toFixed(3)} instead of `
            + `${Agg.failFraction(whole[0], whole[1]).toFixed(3)} — which is why the reducer never `
            + 'divides early');
    });

    attempt('the accumulator composes the same way over a real grid', () => {
        const n = 12;
        const cells = new Uint32Array(n * n).fill(1);
        for (const i of [0, 5, 17, 40, 100]) { cells[i] = 2; }
        const g = Engine.buildGridModel(PLACEMENT, { cols: n, rows: n, cells, codes: CODES }, BIN_DEFS);
        const table = Agg.failValueTable(g.binTable);

        const whole = Agg.accumulateBuckets(g, at(1 / n), 1, 1, table, 'sum');
        const quarters = Agg.accumulateBuckets(g, at(1 / (n / 2)), 2, 2, table, 'sum');
        eq(sum(quarters.acc), whole.acc[0], 'the quarters\' fail counts sum to the whole\'s');
        eq(sum(quarters.total), whole.total[0], '  and so do their totals');
        eq(Agg.failFraction(sum(quarters.acc), sum(quarters.total)),
            Agg.failFraction(whole.acc[0], whole.total[0]),
            '  so reducing the parts and combining equals reducing the whole');
    });

    attempt('the value table counts definite failures only', () => {
        const g = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 4, cells: new Uint32Array(16).fill(1), codes: ['.', '1', '9', 'U'] },
            [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Fail' }, { code: 'U', quality: null }]);
        const table = Agg.failValueTable(g.binTable);
        eq(table[0], 0, 'the null bin is never counted');
        const byCode = new Map(g.binTable.map((e, i) => [e.code, table[i]]));
        eq(byCode.get('1'), 0, 'pass is not a failure');
        eq(byCode.get('9'), 1, 'fail is');
        eq(byCode.get('U'), 0,
            'and UNKNOWN is not — which is the documented blind spot: an all-unclassified tile '
            + 'reduces to 0 and looks like a passing one. MaxSeverity does not have it');
    });

    attempt('an empty bucket is 0, not NaN', () => {
        eq(Agg.failFraction(0, 0), 0, 'no cells means no fraction, and no division by zero');
        eq(Agg.applyGamma(Agg.failFraction(0, 0)), 0, '  and gamma leaves it alone');
    });

    attempt('the ramp is monotonic and ends where its endpoints do', () => {
        const from = '#00aa00';
        const to = '#aa0000';
        eq(Agg.failFractionColor(0, 10, from, to), from, 'a fully passing tile is the pass colour');
        eq(Agg.failFractionColor(10, 10, from, to), to, 'a fully failing one is the fail colour');
        /* Monotonic in the transferred intensity, which is what the eye reads as
         * "worse". Lightness is not monotonic between these endpoints, so the
         * check is on the parameter rather than on a channel. */
        let prev = -1;
        const bad = [];
        for (let f = 0; f <= 10; f++) {
            const t = Agg.applyGamma(Agg.failFraction(f, 10));
            if (t <= prev) { bad.push(`${f}/10`); }
            prev = t;
            if (Agg.failFractionColor(f, 10, from, to) === null) { bad.push(`${f}/10 unparseable`); }
        }
        eq(bad.length, 0, `every step up the ramp is a step up in intensity  ${bad[0] ?? ''}`);
    });

    attempt('an unparseable endpoint gives null rather than a wrong colour', () => {
        eq(Agg.failFractionColor(1, 2, '#00aa00', 'chartreuse'), null,
            'a named colour is refused at the ramp, as it is at the parser');
    });
});

section('10. the aggregate palette is visibly distinct (LOD-13)', () => {
    /*
     * The default themes as shipped, read from Themes/Base/Style.css and
     * Themes/Base-Dark/Style.css. Written out rather than read from disk: a test
     * that parses the stylesheet would drift silently with it, where these
     * literals go red and say which colour moved.
     */
    const BASE = {
        binPass: 'rgb(0, 158, 115)', binFail: 'rgb(213, 94, 0)',
        unknown: 'rgb(110, 110, 110)', body: 'rgb(220, 220, 220)',
        edge: 'rgb(110, 110, 110)', selection: 'rgb(0, 90, 200)',
    };
    const DARK = {
        binPass: 'rgb(0, 190, 140)', binFail: 'rgb(240, 120, 30)',
        unknown: 'rgb(110, 110, 110)', body: 'rgb(220, 220, 220)',
        edge: 'rgb(110, 110, 110)', selection: 'rgb(0, 90, 200)',
    };

    /*
     * THE THRESHOLD IS THE THEME'S OWN NUMBER. `binPass` against `unknown` is the
     * closest pair the default theme intentionally asks an operator to tell apart,
     * so the rule is that no aggregate colour may be closer to a theme colour than
     * that. Asserted here rather than taken on faith, so the justification cannot
     * drift away from the constant.
     */
    attempt('the threshold is the theme\'s closest intentional pair', () => {
        const d = Ok.deltaECss(BASE.binPass, BASE.unknown);
        ok(Math.abs(d - 0.153) < 0.001,
            `binPass against unknown is ${d.toFixed(4)} — the number AGGREGATE_MIN_DELTA_E is set to`);
        eq(Agg.AGGREGATE_MIN_DELTA_E, 0.153, 'and the constant says so');
        ok(Ok.deltaECss(BASE.binPass, BASE.binFail) > d,
            '  while pass against fail is wider, so this is the binding constraint');
    });

    /* Done-when 1, on both shipped themes. */
    for (const [name, theme] of [['Base', BASE], ['Base-Dark', DARK]]) {
        attempt(`no aggregate colour collides with a ${name} theme colour`, () => {
            const closest = Agg.aggregateClosestApproach(theme);
            ok(closest.deltaE >= Agg.AGGREGATE_MIN_DELTA_E,
                `closest approach is ${closest.deltaE.toFixed(4)} >= ${Agg.AGGREGATE_MIN_DELTA_E} `
                + `(${closest.aggregate} against ${closest.theme})`);
            ok(closest.deltaE < 1, '  and the measurement found a real pair rather than nothing');
        });
    }

    attempt('the aggregate is separated by LIGHTNESS, which colour blindness preserves', () => {
        /*
         * `binPass` and `binFail` are the Okabe-Ito pair, chosen so the map reads
         * under deuteranopia and protanopia. Separating the summary by hue would ask
         * the one channel those viewers do not have; separating it by lightness
         * works for everyone. So the aggregate keeps hue and chroma and moves L.
         */
        const aggPass = Ok.rgbToOklch(Ok.parseRgb(Agg.aggregateSeverityColor(Engine.SEVERITY_PASS, BASE)));
        const binPass = Ok.rgbToOklch(Ok.parseRgb(BASE.binPass));
        ok(aggPass.L < binPass.L - 0.2,
            `the aggregate pass swatch is much darker: L ${aggPass.L.toFixed(3)} against `
            + `${binPass.L.toFixed(3)}`);
        ok(Math.abs(aggPass.h - binPass.h) < 12,
            '  at essentially the same hue, so it still reads as the bin family it summarises');
    });

    attempt('darker means worse within the band', () => {
        const L = (rank) => Ok.rgbToOklch(Ok.parseRgb(Agg.aggregateSeverityColor(rank, BASE))).L;
        ok(L(Engine.SEVERITY_PASS) > L(Engine.SEVERITY_UNKNOWN),
            'pass is lighter than unknown');
        ok(L(Engine.SEVERITY_UNKNOWN) > L(Engine.SEVERITY_FAIL),
            '  and unknown is lighter than fail — the same order as the severity ladder');
    });

    attempt('a priority rank shares the fail swatch', () => {
        eq(Agg.aggregateSeverityColor(9, BASE), Agg.aggregateSeverityColor(Engine.SEVERITY_FAIL, BASE),
            'ranks above fail come from BinSeverityPriority and are all "worse than fail" — the '
            + 'ordering decides which cell wins a bucket, not what the legend has to explain');
    });

    attempt('the null rank paints nothing', () => {
        eq(Agg.aggregateSeverityColor(Engine.SEVERITY_NULL, BASE), null,
            'no substrate, no colour — the caller must leave the pixel alone');
    });

    attempt('the fraction ramp ends on the aggregate swatches, not the bin colours', () => {
        eq(Agg.aggregateFractionColor(0, 10, BASE),
            Agg.aggregateSeverityColor(Engine.SEVERITY_PASS, BASE),
            'a fully passing tile is the aggregate pass swatch');
        eq(Agg.aggregateFractionColor(10, 10, BASE),
            Agg.aggregateSeverityColor(Engine.SEVERITY_FAIL, BASE),
            '  and a fully failing one the aggregate fail swatch');
        ok(Agg.aggregateFractionColor(0, 10, BASE) !== BASE.binPass,
            '  and neither end is a bin colour');
    });

    attempt('an unparseable theme colour yields null rather than a wrong swatch', () => {
        eq(Agg.toAggregate('rebeccapurple', 0.3), null, 'a named colour is refused');
        eq(Agg.aggregateSeverityColor(Engine.SEVERITY_FAIL,
            { ...BASE, binFail: 'chartreuse' }), null, '  and propagates');
    });
});

section('11. the categorical palette generator (LOD-14)', () => {
    /* Done-when 1, at a floor derived from the cap rather than chosen. */
    attempt('K = 8 clears the stated floor', () => {
        const p = Ok.categoricalPalette(8);
        eq(p.colors.length, 8, 'eight colours');
        eq(p.other, null, '  and nothing capped');
        eq(p.warning, null, '  so nothing to report');
        const min = Ok.minPairwiseDeltaE(p.colors);
        ok(min >= Ok.CATEGORICAL_MIN_DELTA_E,
            `pairwise minimum ${min.toFixed(4)} >= ${Ok.CATEGORICAL_MIN_DELTA_E}`);
        ok(min > 0.09, `  and comfortably so — ${min.toFixed(4)}, about 4.5 JND`);
    });

    /*
     * THE FLOOR IS THE CAP'S CONSEQUENCE. At K = CATEGORICAL_CAP the adjacent
     * spacing is what it is; the floor sits just under that, so everything the
     * generator can produce clears it. Asserted, so the two constants cannot drift
     * apart.
     */
    attempt('the floor is binding exactly at the cap', () => {
        const atCap = Ok.minPairwiseDeltaE(Ok.categoricalPalette(Ok.CATEGORICAL_CAP).colors);
        ok(atCap >= Ok.CATEGORICAL_MIN_DELTA_E,
            `the cap itself clears the floor: ${atCap.toFixed(4)} >= ${Ok.CATEGORICAL_MIN_DELTA_E}`);
        ok(atCap < Ok.CATEGORICAL_MIN_DELTA_E + 0.01,
            '  and only just — the floor is derived from the cap, not picked independently');
        const bad = [];
        for (let k = 2; k <= Ok.CATEGORICAL_CAP; k++) {
            const m = Ok.minPairwiseDeltaE(Ok.categoricalPalette(k).colors);
            if (m < Ok.CATEGORICAL_MIN_DELTA_E) { bad.push(`K=${k} at ${m.toFixed(4)}`); }
        }
        eq(bad.length, 0, `every K from 2 to the cap clears the floor  ${bad[0] ?? ''}`);
    });

    /* Done-when 2. */
    attempt('K = 200 gives the cap plus one "other", and warns once', () => {
        const p = Ok.categoricalPalette(200);
        eq(p.colors.length, Ok.CATEGORICAL_CAP, `capped at ${Ok.CATEGORICAL_CAP} colours`);
        eq(p.other, Ok.CATEGORICAL_OTHER, '  with a single "other" entry');
        eq(p.requested, 200, '  remembering what was asked for');
        ok(typeof p.warning === 'string', 'and one warning');
        ok(p.warning.includes('200'), '  naming how many were asked for');
        ok(p.warning.includes('ten'), '  and why the cap exists');
        /* One warning, not one per bin over the cap — the field is a string. */
        eq(Ok.categoricalPalette(11).warning === null, false, 'one over the cap already warns');
        eq(Ok.categoricalPalette(Ok.CATEGORICAL_CAP).warning, null,
            '  and exactly at the cap says nothing');

        /*
         * AND THE CAPPED PALETTE IS STILL SPREAD OVER THE WHOLE WHEEL. Every other
         * separation check in this section uses K <= cap, where the capped count
         * and the requested count are the same number — so a generator dividing the
         * wheel by the REQUEST would put ten colours in 1/20th of it and pass
         * everything. It did, until this line.
         */
        const spread = Ok.minPairwiseDeltaE(p.colors);
        ok(spread >= Ok.CATEGORICAL_MIN_DELTA_E,
            `the ten colours kept for a 200-bin request are still ${spread.toFixed(4)} apart — the `
            + 'wheel is divided by what is KEPT, not by what was asked for');
        eq(spread.toFixed(6), Ok.minPairwiseDeltaE(Ok.categoricalPalette(Ok.CATEGORICAL_CAP).colors).toFixed(6),
            '  identical to an uncapped palette of the same size');
    });

    attempt('"other" is far from every colour it must be told apart from', () => {
        const p = Ok.categoricalPalette(200);
        let min = Infinity;
        for (const c of p.colors) { min = Math.min(min, Ok.deltaECss(p.other, c)); }
        ok(min >= Ok.CATEGORICAL_MIN_DELTA_E,
            `the "other" grey is ${min.toFixed(4)} from the nearest palette colour`);
        /* Not exactly 0: a grey round-tripped through linear light and back lands
         * within a few times 1e-8 of the achromatic axis, which is the sRGB
         * transfer function's rounding rather than a colour with a hue. */
        ok(Ok.rgbToOklch(Ok.parseRgb(p.other)).C < 1e-6,
            'and it is achromatic — grey is what "no further distinction" already means here');
    });

    /*
     * OBSERVATION 99's LESSON, asserted. Constant lightness and chroma in OKLCH is
     * not constant on screen: the hues nearest the sRGB corners clamp, and an
     * "evenly spaced" wheel stops being evenly spaced. `CATEGORICAL_C` was chosen
     * under the measured in-gamut ceiling so this holds.
     */
    attempt('the palette survives the gamut clamp', () => {
        const drift = [];
        for (const k of [3, 5, 8, 10]) {
            for (const css of Ok.categoricalPalette(k).colors) {
                const c = Ok.rgbToOklch(Ok.parseRgb(css));
                if (Math.abs(c.L - Ok.CATEGORICAL_L) > 0.004) { drift.push(`${css} L ${c.L.toFixed(4)}`); }
                if (Math.abs(c.C - Ok.CATEGORICAL_C) > 0.004) { drift.push(`${css} C ${c.C.toFixed(4)}`); }
            }
        }
        eq(drift.length, 0,
            `every generated colour round-trips at the requested lightness and chroma  ${drift[0] ?? ''}`);
    });

    attempt('hues are evenly spaced, and the offset rotates the whole wheel', () => {
        const p = Ok.categoricalPalette(6);
        const hues = p.colors.map((c) => Ok.rgbToOklch(Ok.parseRgb(c)).h);
        const gaps = hues.map((h, i) => ((hues[(i + 1) % 6] - h + 360) % 360));
        const bad = gaps.filter((g) => Math.abs(g - 60) > 1.5);
        eq(bad.length, 0, `six colours 60 degrees apart  ${bad[0]?.toFixed(2) ?? ''}`);

        const rotated = Ok.categoricalPalette(6, 60);
        eq(rotated.colors[0], p.colors[1],
            'rotating by one step re-labels the wheel and produces the same colours');
        eq(Ok.minPairwiseDeltaE(rotated.colors).toFixed(6), Ok.minPairwiseDeltaE(p.colors).toFixed(6),
            '  with the separation untouched');
    });

    attempt('degenerate K is handled rather than thrown at', () => {
        eq(Ok.categoricalPalette(0).colors.length, 0, 'zero colours for zero bins');
        eq(Ok.categoricalPalette(0).warning, null, '  and nothing to warn about');
        eq(Ok.categoricalPalette(-5).colors.length, 0, 'a negative count is zero, not a crash');
        eq(Ok.categoricalPalette(-5).requested, 0,
            '  and `requested` is clamped too, so a caller quoting it in a message cannot print -5');
        eq(Ok.categoricalPalette(3.7).colors.length, 3, 'a fractional count floors');
        eq(Ok.categoricalPalette(1).colors.length, 1, 'one bin gets one colour');
        eq(Ok.minPairwiseDeltaE(Ok.categoricalPalette(1).colors), Infinity,
            '  and a single colour has no pairwise distance, which is Infinity rather than 0');
    });
});

section('12. the bucket pass composites, so a control with no layer cache aggregates (W-5)', () => {
    /*
     * `D-094` and observation 110. `putImageData` REPLACES its rect, including the
     * pixels no bucket reached, so on a shared canvas it erased the substrate body
     * around the map. The bucket pass therefore sat behind `allowImageData`, and a
     * control with no `GridLayerCache` never aggregated at any factor — which is
     * why no reference panel has ever reached the aggregate path, and why the
     * layer cache was load-bearing for CORRECTNESS rather than only for speed.
     *
     * The pass now composites when it does not own the rect. Everything below is a
     * pixel assertion through the shims, and the fixture is a ROUND map, so the
     * corners of its device box are genuinely empty and there is somewhere for the
     * body to survive.
     */
    const N = 120;
    const SCALE = 0.25;                        // 4 cells per device pixel, well under 1
    const SIDE = Math.ceil(N * SCALE) + 4;
    const BODY = 0xff204060;                   // a distinctive opaque word for the substrate

    /* The same palette the other render suites use; this file had no need of one
     * until now, because everything before this section reads buckets rather than
     * pixels. */
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const { grid } = roundMap(N, [61, 59]);
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);

    /** @returns A context whose every pixel is the body colour. */
    const withBody = () => {
        const ctx = makeContext2D(SIDE, SIDE);
        const img = ctx.createImageData(SIDE, SIDE);
        new Uint32Array(img.data.buffer).fill(BODY);
        ctx.putImageData(img, 0, 0);
        return ctx;
    };

    /** @param ctx A context. @returns Its pixels as words. */
    const words = (ctx) => new Uint32Array(ctx.pixels.buffer);

    attempt('an UNCACHED render reaches the bucket pass and measures saturation', () => {
        const ctx = makeContext2D(SIDE, SIDE);
        const sat = Engine.renderGridLayer(ctx, grid, at(SCALE), paint, SIDE, SIDE, false, 'MaxSeverity');
        ok(sat !== null, `saturation is reported (${sat}) — before W-5 this branch returned null`);
        eq(ctx.fills.length, 0, 'and it did NOT fall back to the run strategy');
        ok(words(ctx).some((w) => w !== 0), 'pixels were painted');
    });

    attempt('the substrate body survives where no bucket reached — the pixel that was erased', () => {
        /*
         * The corner of the device box. The map is round, so its bounding box has
         * corners with no cell in them; before W-5 `putImageData` wrote transparent
         * black over them and the body was gone.
         */
        const ctx = withBody();
        Engine.renderGridLayer(ctx, grid, at(SCALE), paint, SIDE, SIDE, false, 'MaxSeverity');
        const w = words(ctx);
        eq(w[0], BODY, 'the top-left corner of the box still carries the body colour');
        const mid = Math.floor(SIDE / 2) * SIDE + Math.floor(SIDE / 2);
        ok(w[mid] !== BODY && w[mid] !== 0, 'and the middle of the map carries a bucket colour instead');
    });

    attempt('the OWNED path still replaces, which is what it is for', () => {
        /* The contrast that shows the change is real rather than a no-op: given the
         * same body underneath, owning the rect erases it exactly as before. */
        const ctx = withBody();
        Engine.renderGridLayer(ctx, grid, at(SCALE), paint, SIDE, SIDE, true, 'MaxSeverity');
        eq(words(ctx)[0], 0, 'an owned render leaves the empty corner transparent');
    });

    attempt('over an empty destination, compositing is byte-identical to replacing', () => {
        /*
         * The property that justifies keeping `putImageData` on the owned path
         * rather than compositing everywhere: source-over onto nothing is the
         * identity, so the cached bitmap cannot have changed. Asserted here as a
         * property; the cached path's actual bytes are compared against a
         * pre-change hash in gates/W-5.md.
         */
        const a = makeContext2D(SIDE, SIDE);
        const b = makeContext2D(SIDE, SIDE);
        Engine.renderGridLayer(a, grid, at(SCALE), paint, SIDE, SIDE, true, 'FailFraction');
        Engine.renderGridLayer(b, grid, at(SCALE), paint, SIDE, SIDE, false, 'FailFraction');
        const wa = words(a);
        const wb = words(b);
        const differ = wa.reduce((n, v, i) => n + (v === wb[i] ? 0 : 1), 0);
        eq(differ, 0, `${wa.length} pixels identical between the owned and composited paths`);
    });

    attempt('a DECORATED map blends its marks over the body instead of replacing', () => {
        /*
         * The decoration mark is the one thing the bucket pass emits at less than
         * full alpha, so it is the only case where the arithmetic in
         * `compositeOver` runs at all — everything else takes the transparent or
         * the opaque shortcut. A blended pixel must be neither the body nor the
         * colour the owned path would have written: strictly between them.
         */
        const decorated = new Uint8Array(N * N).fill(1);
        const deco = { ...grid, decorated };
        const owned = makeContext2D(SIDE, SIDE);
        Engine.renderGridLayer(owned, deco, at(SCALE), paint, SIDE, SIDE, true, 'MaxSeverity');
        const over = withBody();
        Engine.renderGridLayer(over, deco, at(SCALE), paint, SIDE, SIDE, false, 'MaxSeverity');

        const wo = words(owned);
        const wv = words(over);
        const mid = Math.floor(SIDE / 2) * SIDE + Math.floor(SIDE / 2);
        ok(wo[mid] !== 0, `the owned render marks the centre (${wo[mid].toString(16)})`);
        ok(wv[mid] !== wo[mid], '  and the composited one differs from it');
        ok(wv[mid] !== BODY, '  and from the bare body');
        // Every channel of the blend must lie between the body and the mark.
        const chan = (w, k) => (w >>> (k * 8)) & 0xff;
        const between = [0, 1, 2].every((k) => {
            const lo = Math.min(chan(wo[mid], k), chan(BODY, k));
            const hi = Math.max(chan(wo[mid], k), chan(BODY, k));
            return chan(wv[mid], k) >= lo && chan(wv[mid], k) <= hi;
        });
        ok(between, '  and every colour channel lands between the two');
    });
});

section('13. the filter buffers (W-18)', () => {
    /*
     * Phase 3 filters a BITMAP, and it filters palette indices rather than RGB -
     * the mean of green and red is brown, and brown is not a bin category. So the
     * bucket pass records what it painted, as it paints it.
     *
     * Both buffers fall out of the render: the pass already computes the index to
     * choose the colour, and `FailFraction` already computes the scalar. Deriving
     * either afterwards would be a second pass that could disagree with the first,
     * and a filter that disagrees with the picture is worse than no filter.
     */
    const N = 120;
    const SCALE = 0.25;
    const SIDE = 40;
    const { grid } = roundMap(N, [61, 59]);
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);

    /** @param mode The reducer. @returns `{ buffers, pixels }`. */
    const render = (mode) => {
        const ctx = makeContext2D(SIDE, SIDE);
        const sink = { buffers: null };
        Engine.renderGridLayer(ctx, grid, at(SCALE), paint, SIDE, SIDE, true, mode, sink);
        return { b: sink.buffers, px: new Uint32Array(ctx.pixels.buffer) };
    };

    attempt('the index agrees with the colour actually painted, at every pixel', () => {
        /*
         * Done-when 1, and it is a comparison rather than a belief because the
         * buffers carry their palette: `palette[index[i]]` is the very word the
         * pass wrote. Checked for both reducers, because the index means a
         * different thing in each - a severity LEVEL, or a ramp step.
         */
        for (const mode of ['MaxSeverity', 'FailFraction']) {
            const { b, px } = render(mode);
            ok(b !== null, `${mode} produced buffers`);
            let checked = 0;
            let wrong = 0;
            for (let by = 0; by < b.height; by++) {
                for (let bx = 0; bx < b.width; bx++) {
                    const i = by * b.width + bx;
                    if (b.index[i] === Engine.FILTER_INDEX_EMPTY) { continue; }
                    checked++;
                    if (b.palette[b.index[i]] !== px[(b.y + by) * SIDE + (b.x + bx)]) { wrong++; }
                }
            }
            ok(checked > 500, `  ${checked} painted pixels examined`);
            eq(wrong, 0, `  and every one matches its palette entry`);
        }
    });

    attempt('the buffers say WHERE they are, or a consumer reads the wrong pixels', () => {
        /*
         * The bucket pass allocates an `ImageData` the size of the map's device box
         * and blits it at an offset. A buffer indexed like the bitmap would be
         * mostly empty; one indexed like the box, without the origin, reads the
         * wrong pixels. This was found by an assertion that did exactly that - 589
         * of 900 "disagreed" and the buffers were right.
         */
        const { b } = render('MaxSeverity');
        ok(b.width < SIDE && b.height < SIDE,
            `the box is ${b.width}x${b.height} inside a ${SIDE}x${SIDE} bitmap, so the origin matters`);
        eq(b.index.length, b.width * b.height, 'the index buffer is exactly the box');
        eq(b.scalar.length, b.width * b.height, '  and so is the scalar');

        /*
         * ON AN OFFSET FIXTURE, because `at(SCALE)` puts this map's box at 0,0 and a
         * wrong origin is invisible there - the mutation that zeroes it was MISSED
         * until this was written. A translated matrix moves the box, and then the
         * origin is the only thing that makes the index agree with the bitmap.
         */
        const ctx = makeContext2D(SIDE, SIDE);
        const sink = { buffers: null };
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([SCALE, 0, 0, SCALE, 5, 7]),
            paint, SIDE, SIDE, true, 'MaxSeverity', sink);
        const off = sink.buffers;
        const px = new Uint32Array(ctx.pixels.buffer);
        ok(off.x > 0 && off.y > 0, `the offset fixture reports its box at ${off.x},${off.y}`);
        let wrong = 0;
        for (let by = 0; by < off.height; by++) {
            for (let bx = 0; bx < off.width; bx++) {
                const i = by * off.width + bx;
                if (off.index[i] === Engine.FILTER_INDEX_EMPTY) { continue; }
                if (off.palette[off.index[i]] !== px[(off.y + by) * SIDE + (off.x + bx)]) { wrong++; }
            }
        }
        eq(wrong, 0, '  and the index still agrees with the bitmap through it');
    });

    attempt('an unpainted pixel is 255, not 0 — 0 is a real index', () => {
        /*
         * The same defect `bucketIsPainted` prevents one layer down. If empty were
         * 0, a median over a partly empty neighbourhood would count empty space as
         * the first palette entry, and the map would grow a bin that is not there.
         */
        const { b, px } = render('MaxSeverity');
        let empties = 0;
        let emptyButPainted = 0;
        for (let by = 0; by < b.height; by++) {
            for (let bx = 0; bx < b.width; bx++) {
                const i = by * b.width + bx;
                if (b.index[i] !== Engine.FILTER_INDEX_EMPTY) { continue; }
                empties++;
                if (px[(b.y + by) * SIDE + (b.x + bx)] !== 0) { emptyButPainted++; }
            }
        }
        ok(empties > 0, `${empties} pixels are outside the round map`);
        eq(emptyButPainted, 0, 'and none of them was painted');
        eq(Engine.FILTER_INDEX_EMPTY, 255, 'the marker is 255');
        for (const i of [...b.index].slice(0, 400)) {
            if (i !== 255) { ok(i < b.palette.length, `index ${i} is inside the palette`); break; }
        }
    });

    attempt('the scalar is NaN where nothing was painted, and in [0,1] where it was', () => {
        /* NaN rather than 0, for the reason 255 is not 0: a density map must not
         * read empty space as a zero reading. */
        for (const mode of ['MaxSeverity', 'FailFraction']) {
            const { b } = render(mode);
            let bad = 0;
            let finite = 0;
            for (let i = 0; i < b.scalar.length; i++) {
                const painted = b.index[i] !== Engine.FILTER_INDEX_EMPTY;
                const v = b.scalar[i];
                if (!painted) { if (!Number.isNaN(v)) { bad++; } continue; }
                finite++;
                if (!(v >= 0 && v <= 1)) { bad++; }
            }
            eq(bad, 0, `${mode}: ${finite} painted pixels, all in [0,1], all others NaN`);
        }
    });

    attempt('the rank table comes from the severity ladder, not from a coincidence', () => {
        /*
         * `Min` and `Max` are erosion and dilation over SEVERITY. Under
         * `MaxSeverity` the index is a severity LEVEL, so the table is the ladder
         * from `BinSeverity.ts` and clamps at fail - a priority list can push a rank
         * past it, and the palette has four entries whatever the author writes.
         */
        const { b } = render('MaxSeverity');
        eq(b.rankByIndex.length, b.palette.length, 'one rank per palette entry');
        deep([...b.rankByIndex], [0, 1, 2, 3], 'null, pass, unknown, fail — the ladder');
        const ff = render('FailFraction').b;
        eq(ff.rankByIndex.length, ff.palette.length, 'and one per ramp step');
        ok(ff.rankByIndex[63] > ff.rankByIndex[0],
            'ordered, because a higher step is a worse bucket even with no bin behind it');
    });

    attempt('NO SINK, NO ALLOCATION — Done-when 2', () => {
        /*
         * Asserted as the absence of a code path rather than by measuring the heap:
         * the buffers are allocated inside `if (sink != null)`, so a control with no
         * filter cannot pay for them. The render still works, which is the half a
         * flag-based design would break.
         */
        const ctx = makeContext2D(SIDE, SIDE);
        const sat = Engine.renderGridLayer(ctx, grid, at(SCALE), paint, SIDE, SIDE, true, 'MaxSeverity');
        ok(sat !== null, 'the frame renders normally with no sink at all');
        ok(new Uint32Array(ctx.pixels.buffer).some((w) => w !== 0), '  and paints pixels');

        const src = readFileSync(new URL('../Engine.js', import.meta.url), 'utf8');
        /*
         * ---- THIS ASSERTION DESCRIBED THE DEFECT (W-40a) ----
         *
         * `W-18` pinned the allocation to `sink != null` and called that the
         * design. It was: no control ever supplied a sink, so `fIndex` was always
         * null, and when `W-40a` finally wired a filter into the render the branch
         * it needed could not be reached even once it existed.
         *
         * The RULE was right - do not allocate for a control that wants nothing -
         * and the CONDITION was too narrow. A frame allocates when someone will
         * read the buffers, and there are two such someones: a sink, and a filter.
         */
        ok(/const wantBuffers = \(sink != null \|\| filter != null\)/.test(src),
            'the allocation is guarded on someone WANTING the buffers — a sink or a filter');
        ok(!/const wantBuffers = true/.test(src),
            '  and not on nothing at all, which would allocate for every frame');
    });

    attempt('a strategy that does not bucket leaves the sink empty rather than stale', () => {
        /* Above one device pixel per cell the pass draws one rect per run, so there
         * is no per-pixel index to record. `null` says so; a stale buffer from an
         * earlier frame would be filtered as though it described this one. */
        const ctx = makeContext2D(SIDE, SIDE);
        const sink = { buffers: { width: 1, height: 1 } };
        Engine.renderGridLayer(ctx, grid, at(4), paint, SIDE, SIDE, true, 'MaxSeverity', sink);
        deep(sink.buffers, { width: 1, height: 1 },
            'the run strategy does not touch the sink — a filter checks the frame it asked for');
    });
});

section('14. FailDensity forces the density view at any zoom (W-22a)', () => {
    /*
     * `W-22`'s third Done-when, split out because it needed a different
     * accumulation rather than a flag.
     *
     * Below one device pixel per cell the scatter writes a cell's CENTRE, which is
     * right: many cells land in each pixel. Above it the same loop leaves holes -
     * at 4 px/cell a cell covers sixteen pixels and marks one, so 6.3 % of the tile
     * is painted. That is why `D-094`'s gate refused to bucket there at all, and
     * `FailDensity` asks for a density map anyway.
     */
    const N = 32;
    const { grid } = roundMap(N, [17, 15]);
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);

    /** @param scale Device px per cell. @param force Whether to force. @returns The result. */
    const render = (scale, force) => {
        const side = Math.ceil(N * scale) + 4;
        const ctx = makeContext2D(side, side);
        const sink = { buffers: null };
        Engine.renderGridLayer(ctx, grid, at(scale), paint, side, side, true, 'FailFraction',
            sink, force);
        return { b: sink.buffers, ctx, side };
    };

    attempt('without the override, nothing above 1 px/cell buckets at all', () => {
        /* Unchanged behaviour, asserted so the override is visibly an ADDITION. */
        for (const scale of [1, 2, 4]) {
            eq(render(scale, false).b, null, `${scale} px/cell does not bucket on its own`);
        }
        ok(render(0.5, false).b !== null, 'and below one pixel it still does');
    });

    attempt('with it, a 4-pixel die buckets and the tile has NO HOLES', () => {
        /*
         * The measurement the split existed for. A point scatter here would paint
         * one pixel in sixteen; a footprint fills them all. Holes are counted as
         * empty pixels with painted neighbours on all four sides - an unpainted
         * pixel at the wafer's rim is not a hole, it is off the substrate.
         */
        const { b } = render(4, true);
        ok(b !== null, 'the bucket pass ran at 4 px/cell');
        let holes = 0;
        for (let y = 1; y < b.height - 1; y++) {
            for (let x = 1; x < b.width - 1; x++) {
                const i = y * b.width + x;
                if (b.index[i] !== Engine.FILTER_INDEX_EMPTY) { continue; }
                const painted = (j) => b.index[j] !== Engine.FILTER_INDEX_EMPTY;
                if (painted(i - 1) && painted(i + 1)
                    && painted(i - b.width) && painted(i + b.width)) { holes++; }
            }
        }
        eq(holes, 0, 'no unpainted pixel is surrounded by painted ones');
    });

    attempt('the painted area scales with the square of the zoom', () => {
        /*
         * The check that the footprint is the RIGHT size rather than merely
         * non-empty. Doubling the scale must quadruple the painted pixels; a
         * footprint that was one pixel too small or large would drift from that
         * ratio and a point scatter would not scale at all.
         */
        const counts = [1, 2, 4, 8].map((scale) => {
            const { b } = render(scale, true);
            return b.index.reduce((n, v) => n + (v === Engine.FILTER_INDEX_EMPTY ? 0 : 1), 0);
        });
        for (let i = 1; i < counts.length; i++) {
            const ratio = counts[i] / counts[i - 1];
            ok(Math.abs(ratio - 4) < 0.05,
                `${counts[i - 1]} -> ${counts[i]} pixels is a ratio of ${ratio.toFixed(3)}`);
        }
    });

    attempt('it is a DENSITY, not the bin image', () => {
        /*
         * Done-when 3 proper. A single die is pass or fail, so the raw field at
         * 4 px/cell has exactly two values - it IS the bin image in greyscale, and
         * saying so is more honest than pretending otherwise. What makes it a
         * density is the blur, and the blur is only possible because the field
         * exists at this zoom at all.
         */
        const { b } = render(4, true);
        const raw = new Set([...b.scalar].filter((v) => !Number.isNaN(v)).map((v) => v.toFixed(3)));
        eq(raw.size, 2, `the raw field is per-die: ${[...raw].sort().join(', ')}`);
        /*
         * Asserted as a PROPERTY rather than a count: this fixture has one failing
         * die, so it yields ten distinct values where a real cluster yields fifty.
         * A threshold tuned to one fixture measures the fixture. What is true of
         * any of them is that the blur produces values strictly between the two
         * the raw field has - which is precisely what "density" means and what a
         * bin image can never contain.
         */
        const blurred = Filter.boxScalar(b, 3);
        const smooth = new Set([...blurred].filter((v) => !Number.isNaN(v)).map((v) => v.toFixed(3)));
        ok(smooth.size > raw.size,
            `the blurred field takes ${smooth.size} values against the raw field's ${raw.size}`);
        const between = [...blurred].filter((v) => !Number.isNaN(v) && v > 0.001 && v < 0.999);
        ok(between.length > 0,
            `  ${between.length} of them strictly between 0 and 1 — no die has such a value`);
    });

    attempt('the footprint path is NOT taken below one pixel per cell', () => {
        /*
         * The flag must not reach the hot path, and comparing force off against
         * force on cannot show it: `forceAggregate` only opens the gate, and below
         * one pixel the gate is open anyway - both sides take the same path and
         * agree trivially. The mutation that forces the footprint branch was MISSED
         * against that comparison.
         *
         * AT A FRACTIONAL OFFSET, which is what makes the two paths diverge: a cell
         * whose sub-pixel footprint straddles a boundary covers two pixels where the
         * point scatter marks one. At an integer offset they agree exactly, so a
         * fixture aligned to the grid cannot see the difference either.
         */
        const side = Math.ceil(N * 0.5) + 4;
        const ctx = makeContext2D(side, side);
        const sink = { buffers: null };
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([0.5, 0, 0, 0.5, 0.37, 0.37]),
            paint, side, side, true, 'FailFraction', sink, true);
        const b2 = sink.buffers;
        const painted = b2.index.reduce((n, v) => n + (v === Engine.FILTER_INDEX_EMPTY ? 0 : 1), 0);
        /*
         * Compared against the pixel set the POINT rule produces, computed here
         * independently: each cell marks the pixel containing its centre, and
         * nothing else. An inequality against the cell count was the first attempt
         * and it was vacuous - a 20x20 bitmap can never reach 716 cells, so it held
         * whichever path ran.
         */
        const expected = new Set();
        for (let r = 0; r < grid.rows; r++) {
            for (let c = 0; c < grid.cols; c++) {
                if (grid.cells[r * grid.cols + c] === 0) { continue; }
                const px = Math.floor(0.5 * (c + 0.5) + 0.37 - b2.x);
                const py = Math.floor(0.5 * (r + 0.5) + 0.37 - b2.y);
                if (px < 0 || px >= b2.width || py < 0 || py >= b2.height) { continue; }
                expected.add(py * b2.width + px);
            }
        }
        eq(painted, expected.size,
            `${painted} painted pixels, and the point rule marks exactly ${expected.size}`);
    });

    attempt('and the forced flag changes nothing there', () => {
        /*
         * The flag must not reach the hot path. Asserted as identical BITMAPS, not
         * merely identical buffers - the contact sheet says the same thing across
         * nineteen renders and is in `gates/W-22a.md`.
         */
        const off = render(0.5, false);
        const on = render(0.5, true);
        const a = new Uint32Array(off.ctx.pixels.buffer);
        const c = new Uint32Array(on.ctx.pixels.buffer);
        let differ = 0;
        for (let i = 0; i < a.length; i++) { if (a[i] !== c[i]) { differ++; } }
        eq(differ, 0, `${a.length} pixels identical below one device pixel per cell`);
    });
});

finish();
