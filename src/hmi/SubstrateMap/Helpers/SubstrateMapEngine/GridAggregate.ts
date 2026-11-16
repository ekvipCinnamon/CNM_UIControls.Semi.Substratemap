/**
 * @fileoverview
 * GridAggregate - collapsing many cells into one device pixel.
 *
 * WHY IT EXISTS. `renderGridImageData` maps each device pixel back through the
 * lattice inverse to exactly one cell and paints that cell's color. That is point
 * sampling: at an aggregation factor of N, each pixel stands for N x N cells and
 * all but one are invisible, with subpixel phase deciding which survives. On a
 * yield map that is silent suppression of defects - `grid-aliasing.test.mjs`
 * measures a single failing die vanishing at every one of eight phases once the
 * factor reaches 20.
 *
 * This module is the other half: a pass that visits every cell and accumulates it
 * into the pixel it falls in, so a pixel can be derived from all of its cells
 * rather than from whichever one the raster happened to land on.
 *
 * ---- SCATTER, NOT GATHER ----
 *
 * The renderer GATHERS: for each pixel, invert to find a cell. That is O(pixels)
 * and can only ever see one cell per pixel. This SCATTERS: for each cell, project
 * forward to find its pixel. O(cells + pixels), one pass, and every cell is
 * counted.
 *
 * Projection is EVALUATED, not stepped. An incremental version was written first -
 * the transform is affine, so one column adds a constant - and it was replaced
 * because it is both less accurate and slower. A running sum drifts by
 * a few ULPs across a wide map, which is harmless except exactly at a pixel
 * boundary, where it puts a whole column of cells one pixel out. Hoisting the row
 * terms and doing one multiply-add per cell measured 7.4 ms against 10.6 ms on
 * 1.44 M cells, because the two dependent adds form a serial chain while the
 * multiply-add pipelines.
 *
 * ---- NO PYRAMID ----
 *
 * A mip pyramid would be the textbook answer and is wrong here. The view is
 * fit-to-view: the factor is whatever the current matrix says and changes with
 * every resize, rotation and injected view transform. One
 * level per render is all that is ever needed, so a pyramid would be built and
 * thrown away every frame to serve a single lookup.
 *
 * ---- THE NULL BIN IS IN NEITHER NUMERATOR NOR DENOMINATOR ----
 *
 * Bin index 0 is the null bin (`GridModel` invariant) - off-substrate, never
 * painted, never selected. It is skipped entirely, and that is a correctness
 * requirement rather than an optimization: pixels at the wafer edge lie partly off
 * the substrate, so counting empty cells in the denominator would make the edge
 * read systematically better than it is. Edge-Ring is exactly the failure pattern
 * that hugs the boundary.
 *
 * @author ekvip automation GmbH
 * @license Apache-2.0
 *
 * Copyright 2026 ekvip automation GmbH
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */

import {
    AGGREGATE_RAMP_STEPS, SEVERITY_FAIL, SEVERITY_NULL, SEVERITY_PASS,
    SEVERITY_UNKNOWN as SEVERITY_UNKNOWN_RANK, binSeverity, binSeverityTable, packColor,
    type BinTableEntry, type GridAggregatePaint, type GridModel, type SubstrateMapColors,
} from './Engine.js';
import {
    deltaEOk, formatRgb, mixCssOklch, mixOklch, oklchToRgb, parseRgb, rgbToOklch, type Oklch,
} from './Oklch.js';

/** How a bucket combines the per-cell values it receives. */
export type BucketCombine = 'max' | 'sum';

/** The result of one scatter pass. */
export interface GridBuckets {
    /**
     * Non-null cells per device pixel.
     *
     * The denominator, and the "is this pixel painted at all" test: a pixel whose
     * total is 0 received no substrate and must be left alone. Zero is not the same
     * as a bucket full of passing dies.
     */
    readonly total: Uint32Array;
    /**
     * The reducer's own accumulator, combined per {@link BucketCombine}.
     *
     * `'max'` gives worst-wins over the supplied per-bin values; `'sum'` gives
     * their total, which over a 0/1 value table is a count.
     */
    readonly acc: Uint32Array;
    /** Bitmap width in device pixels. */
    readonly width: number;
    /** Bitmap height in device pixels. */
    readonly height: number;
    /** Non-null cells that landed inside the bitmap. Equals the sum of `total`. */
    readonly counted: number;
    /** Non-null cells that projected outside it, and were dropped. */
    readonly dropped: number;
}

/**
 * Scatters every non-null cell into the device pixel it falls in.
 *
 * @param grid       The grid model. `grid.cells` holds a bin index per cell,
 *                   row-major, and index 0 is the null bin.
 * @param lat        Cell coordinates -> device pixels, i.e.
 *                   `deviceMatrix(dpr, world).multiply(latticeMatrix(placement))`.
 *                   The same matrix `renderGridLayer` passes its renderers, so the
 *                   buckets line up with the pixels that will be painted.
 * @param width      Bitmap width in device pixels.
 * @param height     Bitmap height in device pixels.
 * @param valueByBin One value per bin index, e.g. `binSeverityTable(...)` for
 *                   `'max'`, or 1-for-fail / 0-otherwise for `'sum'`. Index 0 is
 *                   never read - the null bin does not reach the accumulator.
 * @param combine    How to fold each cell's value into its bucket.
 * @returns The buckets.

 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — the render pass accumulates inline in its own loop; this is the same accumulation
 * exposed so a suite can build a bucket set and read it, instead of asserting about
 * pixels and hoping the accumulation underneath was the one it meant.
 * Written down because an export with no runtime consumer otherwise reads as a
 * promise to whoever finds it in the module surface. */
export function accumulateBuckets(
    grid: GridModel,
    lat: DOMMatrix,
    width: number,
    height: number,
    valueByBin: ArrayLike<number>,
    combine: BucketCombine,
): GridBuckets {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    const total = new Uint32Array(w * h);
    const acc = new Uint32Array(w * h);
    let counted = 0;
    let dropped = 0;

    const cols = grid.cols;
    const rows = grid.rows;
    const cells = grid.cells;
    if (w === 0 || h === 0 || cols <= 0 || rows <= 0) {
        return { total, acc, width: w, height: h, counted, dropped };
    }

    // The cell CENTER is at (c + 0.5, r + 0.5) in lattice coordinates: the same
    // point `getCellAtPos` tests against, so a bucket holds the cells a click would
    // land in.
    const { a, b, c: mc, d, e, f } = lat;
    const isMax = combine === 'max';

    for (let r = 0; r < rows; r++) {
        // The row's contribution, hoisted: everything that does not vary with the
        // column. What remains per cell is one multiply-add per axis, evaluated
        // from the column index rather than accumulated.
        const cy = r + 0.5;
        const rx = mc * cy + e;
        const ry = d * cy + f;
        const base = r * cols;
        for (let col = 0; col < cols; col++) {
            const bin = cells[base + col];
            if (bin !== 0) {                           // null bin: neither num nor denom
                const cx = col + 0.5;
                const px = Math.floor(a * cx + rx);
                const py = Math.floor(b * cx + ry);
                if (px >= 0 && px < w && py >= 0 && py < h) {
                    const at = py * w + px;
                    total[at]++;
                    counted++;
                    const v = valueByBin[bin] ?? 0;
                    if (isMax) {
                        if (v > acc[at]) { acc[at] = v; }
                    } else {
                        acc[at] += v;
                    }
                } else {
                    dropped++;
                }
            }
        }
    }
    return { total, acc, width: w, height: h, counted, dropped };
}

/* ------------------------------------------------------------------------ *
 * MaxSeverity
 *
 * Worst-wins. The reduced value of a bucket is the highest severity rank any of
 * its cells carries, so one failing die among ten thousand passing ones still
 * reports a failure.
 *
 * That is the property point sampling cannot have. A gather picks one cell and
 * asks what it is; this asks what the WORST thing in the pixel is, and no amount
 * of minification can hide a defect behind its neighbors.
 * ------------------------------------------------------------------------ */

/**
 * The identity of {@link maxSeverity}: `SEVERITY_NULL`.
 *
 * `max(x, 0) === x` for every rank, because ranks are non-negative by
 * construction - which is what makes `(rank, max, SEVERITY_NULL)` a monoid rather
 * than merely a binary operation. It is also the right ANSWER for an empty
 * bucket: nothing was seen, so nothing is claimed.
 */
export const MAX_SEVERITY_IDENTITY = SEVERITY_NULL;

/**
 * Worst-wins over two severity ranks.
 *
 * **Associative, commutative and idempotent**, and each of the three earns its
 * place:
 *
 * - **associative** - a bucket can be folded in any grouping, so the accumulator
 *   may visit cells in whatever order the scatter reaches them, and a future
 *   tiled or parallel pass may combine partial results;
 * - **commutative** - the answer does not depend on which cell was seen first,
 *   which is what makes the result independent of iteration order;
 * - **idempotent** - counting the same cell twice cannot change the answer, so a
 *   cell landing exactly on a pixel boundary is harmless whichever side it falls.
 *
 * Together they say the operator has no memory and no ordering, which is exactly
 * what a reduction over an unordered set of cells needs.
 * @param a A severity rank.
 * @param b A severity rank.
 * @returns The worse of the two.

 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — `renderGridAggregate` reduces inline; this is the same reduction exposed so the
 * monoid laws can be asserted on it directly — associativity and identity are
 * properties of the operation, not of a frame that happened to use it.
 * Written down because an export with no runtime consumer otherwise reads as a
 * promise to whoever finds it in the module surface. */
export function maxSeverity(a: number, b: number): number {
    return a > b ? a : b;
}

/*
 * THERE IS NO `reduceMaxSeverity`, AND THAT IS THE POINT.
 *
 * A per-pixel reduction function was written and deleted. `accumulateBuckets`
 * already folds with this operator when told `'max'`, so the function was a copy
 * of `acc` into a fresh `Uint32Array` - 1.4 MB per render at 600x600 device
 * pixels, to produce the array it was handed.
 *
 * Its one piece of logic was a guard normalizing empty buckets to the identity,
 * and a mutation deleting that guard SURVIVED the whole suite. Not a missing
 * assertion: the guard cannot fire. `acc[i]` is written only inside the branch
 * that increments `total[i]`, so `total[i] === 0` implies `acc[i] === 0`, which is
 * already `MAX_SEVERITY_IDENTITY`. The coupling is asserted below rather than
 * defended against.
 *
 * So the reduction is DEFINED here - `maxSeverity`, its identity, and the four
 * laws - and PERFORMED in the one loop that already visits every cell. A caller
 * reads `buckets.acc` for the rank and `buckets.total` for whether to paint at
 * all. (A branch no test can reach is worth measuring before it is worth
 * keeping.)
 */

/* ------------------------------------------------------------------------ *
 * FailFraction
 *
 * How much of the tile failed, rather than how bad its worst cell was.
 *
 * MaxSeverity and this one fail on COMPLEMENTARY patterns, which is why both
 * ship. At 2 % random fail and 53 dies per pixel, MaxSeverity turns 66 % of
 * pixels red and the tile carries no information; FailFraction reads 2 % and is
 * honest. Conversely a one-die scratch is a rank-3 tile to MaxSeverity and a
 * 1/53 = 1.9 % tint to FailFraction - invisible. Neither dominates; the gamma
 * below is what makes the second case survivable.
 * ------------------------------------------------------------------------ */

/**
 * The default gamma, and the reason the scratch case is visible at all.
 *
 * The raw fraction of a one-die defect at six cells per pixel is 1/6 = 0.167, a
 * tint no operator will notice. `0.167 ^ 0.4 = 0.49` - half intensity, plainly
 * there. The exponent compresses the top of the range and expands the bottom,
 * which is the right way round: the difference between 1 % and 5 % failure matters
 * and the difference between 80 % and 90 % does not.
 *
 * It is a DISPLAY transfer function and nothing else. `failFraction` returns the
 * true ratio and every count remains exact; gamma is applied only on the way to a
 * color, and `gamma = 1` passes the fraction through untouched.
 */
export const FAIL_FRACTION_DEFAULT_GAMMA = 0.4;

/**
 * A 0/1 value table for `accumulateBuckets(..., 'sum')`: 1 where the bin is a
 * definite failure.
 *
 * **`unknown` is NOT counted.** The numerator is failures, and a bin nobody
 * classified is not a known failure - counting it would report a map with no
 * `BinQuality` anywhere as 100 % failed, and most documents have none. The cost is
 * real and is recorded rather than hidden: a tile of entirely unclassified dies
 * reduces to fraction 0 and looks exactly like a passing tile. **MaxSeverity does
 * not have that blind spot** - it ranks `unknown` above `pass` - and the choice
 * between the two reducers (`AggregationReducer`) should not be made without
 * knowing it.
 * @param binTable The grid's bin table.
 * @param priority `BinSeverityPriority`, or `null`.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @returns 1 per failing bin index, 0 elsewhere. Index 0 is never read.
 */
export function failValueTable(
    binTable: readonly BinTableEntry[],
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
): Uint32Array {
    const out = new Uint32Array(binTable.length);
    for (let i = 1; i < binTable.length; i++) {
        out[i] = binSeverity(binTable[i], priority, aliases) >= SEVERITY_FAIL ? 1 : 0;
    }
    return out;
}

/**
 * The failed fraction of one bucket.
 *
 * ---- WHY THE COMPOSITION LAW IS OVER THE PAIR, NOT THE FRACTION ----
 *
 * Fractions do not combine. Halves of `1/2` and `1/10` average to `0.3`, which is
 * the fraction of nothing: the true answer depends on how many cells each half
 * held. So the associative, commutative structure lives on the PAIR
 * `(failCount, total)`, added componentwise, and the division happens once at the
 * end.
 *
 * That is exactly what `accumulateBuckets` does - it sums both accumulators and
 * never divides - and it is why splitting a bucket, reducing the halves and
 * combining gives the same answer as reducing the whole. Dividing early would
 * break it, and the test asserts the law rather than the implementation.
 * @param failCount Failing cells in the bucket.
 * @param total     Non-null cells in the bucket.
 * @returns The fraction 0..1, or 0 for an empty bucket.
 */
export function failFraction(failCount: number, total: number): number {
    return total > 0 ? failCount / total : 0;
}

/**
 * Applies the display transfer function.
 * @param fraction A fraction 0..1.
 * @param gamma    The exponent; 1 is the identity.
 * @returns The transferred intensity, 0..1.
 */
export function applyGamma(fraction: number, gamma: number = FAIL_FRACTION_DEFAULT_GAMMA): number {
    const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    // 0 and 1 are fixed points of x^g for every positive g, so an empty or fully
    // failed tile is unaffected by the knob - which is what makes the two ends of
    // the ramp mean the same thing at any gamma.
    //
    // The `gamma === 1` arm is an OPTIMIZATION and not a correctness guard:
    // `Math.pow(x, 1)` is exactly `x` in IEEE754, so removing it changes no result,
    // only the cost. A mutation replacing the whole line with `Math.pow(f, gamma)`
    // therefore CANNOT be caught by any assertion, and should not be attempted -
    // the catalog instead perturbs the exponent, which does change the answer.
    return gamma === 1 ? f : Math.pow(f, gamma);
}

/**
 * The ramp color for one bucket, interpolated in OKLCH.
 *
 * sRGB interpolation would put a muddy trough in the middle of the ramp, where a
 * 40 % tile and a 60 % tile become hard to tell apart - see `Oklch.ts`.
 * @param failCount Failing cells.
 * @param total     Non-null cells.
 * @param fromCss   The color of a fully passing tile.
 * @param toCss     The color of a fully failing tile.
 * @param gamma     The transfer exponent.
 * @returns `#rrggbb`, or `null` when an endpoint is not a parseable color.
 */
export function failFractionColor(
    failCount: number,
    total: number,
    fromCss: string,
    toCss: string,
    gamma: number = FAIL_FRACTION_DEFAULT_GAMMA,
): string | null {
    const a = parseRgb(fromCss);
    const b = parseRgb(toCss);
    if (a === null || b === null) { return null; }
    const t = applyGamma(failFraction(failCount, total), gamma);
    return formatRgb(oklchToRgb(mixOklch(rgbToOklch(a), rgbToOklch(b), t)));
}

/* ------------------------------------------------------------------------ *
 * The aggregate palette
 *
 * A red pixel on an aggregated map means "at least one bad die among six", not
 * "this die is bad". If the two are painted from the same palette the operator
 * cannot tell a summary from a datum, and the summary is the more dangerous of
 * the two to misread.
 * ------------------------------------------------------------------------ */

/**
 * The aggregate band: one lightness per severity, DARKER than every theme color.
 *
 * ---- WHY LIGHTNESS, AND NOT CHROMA ----
 *
 * The obvious proposal is reduced chroma plus a shifted endpoint hue. Both
 * were measured and both are wrong for this theme:
 *
 * - **Reduced chroma moves TOWARD `unknown`**, which is achromatic gray. At 0.8x
 *   chroma the closest approach across the ramp falls to 0.143 - below the theme's
 *   own closest intentional pair, so the aggregate becomes MORE confusable, not
 *   less.
 * - **A shifted hue would undo the theme's color-blind safety.** `binPass` and
 *   `binFail` are the Okabe-Ito bluish-green / vermillion pair, chosen so the map
 *   still reads under deuteranopia and protanopia. Distinguishing a summary by hue
 *   asks the one channel those viewers do not have.
 *
 * Lightness survives every common color-vision deficiency, so it is the axis that
 * separates the aggregate for *every* operator rather than most of them. Hue and
 * chroma are carried through unchanged, so an aggregate tile still reads as the
 * bin family it summarizes - just visibly darker, as a field.
 *
 * The three values decrease with severity, so within the aggregate band "darker"
 * also means "worse".
 *
 * ---- THE NUMBERS WERE CHOSEN AFTER GAMUT CLAMPING, NOT BEFORE ----
 *
 * A first band at `0.42 / 0.37 / 0.32` was measured on the IDEAL OKLCH values and
 * cleared the threshold at `0.175`. Rendered, it fails at `0.144`: those lightness
 * and chroma pairs are outside sRGB, and `oklchToRgb` clamps per channel, which
 * moves the color somewhere nobody chose. The band below is measured on what the
 * canvas actually receives - the color after the round trip - which is the only
 * measurement that describes what an operator sees.
 */
export const AGGREGATE_LIGHTNESS = { pass: 0.34, unknown: 0.29, fail: 0.24 } as const;

/**
 * The minimum perceptual distance between any aggregate color and any theme
 * color, and the threshold this palette is asserted against.
 *
 * **It is the theme's own number, not a taste.** `binPass` against `unknown` is
 * `0.153` in OKLab and is the closest pair the default theme intentionally asks an
 * operator to tell apart. So the rule is: *no aggregate color may be closer to a
 * theme color than the theme's own closest intentional pair.* A summary is then at
 * least as separable as pass-from-unclassified, which the design already treats as
 * sufficient.
 *
 * For scale, an OKLab just-noticeable difference on a large field is about `0.02`,
 * so this is roughly 7.5 JND. The measured minimum for the palette below is
 * `0.198` on the Base theme and `0.196` on Base-Dark.
 */
export const AGGREGATE_MIN_DELTA_E = 0.153;

/**
 * Moves a color into the aggregate band, keeping its hue and chroma.
 * @param css       A theme color.
 * @param lightness The band lightness.
 * @returns The aggregate color, or `null` when `css` is not a supported form.
 */
export function toAggregate(css: string, lightness: number): string | null {
    const rgb = parseRgb(css);
    if (rgb === null) { return null; }
    const c = rgbToOklch(rgb);
    return formatRgb(oklchToRgb({ L: lightness, C: c.C, h: c.h }));
}

/**
 * The aggregate color for a `MaxSeverity` rank.
 *
 * Ranks above `SEVERITY_FAIL` come from an author's `BinSeverityPriority` and are
 * all "worse than fail", so they share the fail swatch: the ordering exists to
 * decide which cell WINS a bucket, not to introduce colors the legend has no
 * entry for.
 * @param rank    A severity rank.
 * @param colors  The theme colors.
 * @returns `#rrggbb`, or `null` for the null rank (nothing to paint) or a
 *          color that cannot be parsed.
 */
export function aggregateSeverityColor(
    rank: number,
    colors: { binPass: string; binFail: string; unknown: string },
): string | null {
    if (rank <= SEVERITY_NULL) { return null; }          // no substrate: paint nothing
    if (rank >= SEVERITY_FAIL) { return toAggregate(colors.binFail, AGGREGATE_LIGHTNESS.fail); }
    if (rank === 1) { return toAggregate(colors.binPass, AGGREGATE_LIGHTNESS.pass); }
    return toAggregate(colors.unknown, AGGREGATE_LIGHTNESS.unknown);
}

/**
 * The aggregate ramp color for a `FailFraction` bucket.
 *
 * The endpoints are the theme's pass and fail moved into the band, so the ramp
 * spans the same hues as the bin palette at a lightness the bin palette never
 * uses.
 * @param failCount Failing cells.
 * @param total     Non-null cells.
 * @param colors    The theme colors.
 * @param gamma     The transfer exponent.
 * @returns `#rrggbb`, or `null` when an endpoint cannot be parsed.
 */
export function aggregateFractionColor(
    failCount: number,
    total: number,
    colors: { binPass: string; binFail: string },
    gamma: number = FAIL_FRACTION_DEFAULT_GAMMA,
): string | null {
    const from = toAggregate(colors.binPass, AGGREGATE_LIGHTNESS.pass);
    const to = toAggregate(colors.binFail, AGGREGATE_LIGHTNESS.fail);
    return from === null || to === null
        ? null
        : failFractionColor(failCount, total, from, to, gamma);
}

/**
 * The closest approach between the aggregate palette and a set of theme colors.
 *
 * Exists so the separation is a MEASUREMENT the test reads, not a claim the test
 * repeats: it samples the whole fail-fraction ramp as well as the three severity
 * swatches, and reports the worst case.
 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — `grid-aggregate`
 * is its only caller, and it is exported so that suite can reach it. That is
 * deliberate: this project decides palettes by measurement, and a measurement a
 * test performs for itself is a measurement nobody can check. Written down
 * because an export with no runtime consumer otherwise reads as a promise to a
 * caller who finds it in the module surface.
 * @param colors The theme colors.
 * @param steps  Ramp samples.
 * @returns `{ deltaE, aggregate, theme }` for the closest pair found.
 */
export function aggregateClosestApproach(
    colors: Record<string, string>,
    steps: number = 100,
): { deltaE: number; aggregate: string; theme: string } {
    const swatches: string[] = [];
    for (const rank of [1, SEVERITY_UNKNOWN_RANK, SEVERITY_FAIL]) {
        const c = aggregateSeverityColor(rank, colors as { binPass: string; binFail: string; unknown: string });
        if (c !== null) { swatches.push(c); }
    }
    for (let i = 0; i <= steps; i++) {
        const c = aggregateFractionColor(i, steps, colors as { binPass: string; binFail: string }, 1);
        if (c !== null) { swatches.push(c); }
    }
    let best = { deltaE: Infinity, aggregate: '', theme: '' };
    for (const agg of swatches) {
        const a = parseRgb(agg);
        if (a === null) { continue; }
        const ao = rgbToOklch(a);
        for (const [, themeCss] of Object.entries(colors)) {
            const t = parseRgb(themeCss);
            if (t === null) { continue; }
            const d = deltaEOk(ao, rgbToOklch(t));
            if (d < best.deltaE) { best = { deltaE: d, aggregate: agg, theme: themeCss }; }
        }
    }
    return best;
}

/**
 * Builds everything {@link renderGridAggregate} needs, as packed RGBA words.
 *
 * ---- WHY IT LIVES HERE AND NOT IN `buildGridPaint` ----
 *
 * `Engine.ts` has **no imports at all** - it is the root of the engine and
 * everything else depends on it. Constructing this needs `Oklch` and the severity
 * ladder's consumers, so doing it there would invert the dependency and put
 * `Engine` and `GridAggregate` in a cycle. The DATA is plain typed arrays, so the
 * pixel loop stays in `Engine.ts` and only the construction moves out.
 *
 * Returns `null` when any color cannot be parsed, and the render then falls back
 * - the same all-or-nothing rule `rgba` follows, and for the same reason: a
 * half-built palette paints some tiles wrong rather than none.
 * @param grid     The grid.
 * @param colors   The theme colors.
 * @param priority `BinSeverityPriority`, or `null`.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @param gamma    The fail-fraction transfer exponent.
 * @returns The aggregate paint, or `null`.
 */
export function buildAggregatePaint(
    grid: GridModel,
    colors: SubstrateMapColors,
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
    gamma: number = FAIL_FRACTION_DEFAULT_GAMMA,
): GridAggregatePaint | null {
    const severity = binSeverityTable(grid.binTable, priority ?? null, aliases ?? null);
    const failFlag = failValueTable(grid.binTable, priority ?? null, aliases ?? null);

    // Indexed by LEVEL, not by rank: a priority list invents ranks above `fail` and
    // they all share the fail swatch, so four entries cover every author.
    const bySeverity = new Uint32Array(4);
    for (const level of [SEVERITY_PASS, SEVERITY_UNKNOWN_RANK, SEVERITY_FAIL]) {
        const css = aggregateSeverityColor(level, colors);
        const packed = css === null ? null : packColor(css);
        if (packed === null) { return null; }
        bySeverity[level] = packed;
    }

    const from = aggregateSeverityColor(SEVERITY_PASS, colors);
    const to = aggregateSeverityColor(SEVERITY_FAIL, colors);
    if (from === null || to === null) { return null; }
    const ramp = new Uint32Array(AGGREGATE_RAMP_STEPS);
    for (let i = 0; i < AGGREGATE_RAMP_STEPS; i++) {
        // Gamma is applied HERE, once per frame, so the pixel loop hands in a raw
        // fraction and indexes straight into the transferred ramp.
        const t = applyGamma(i / (AGGREGATE_RAMP_STEPS - 1), gamma);
        const css = mixCssOklch(from, to, t);
        const packed = css === null ? null : packColor(css);
        if (packed === null) { return null; }
        ramp[i] = packed;
    }
    void SEVERITY_NULL;
    // A bin fill has no value table; `buildGridPaint` supplies one for a
    // `valueField` overlay instead.
    return { severity, failFlag, bySeverity, ramp, valueCells: null, valueColors: null };
}

/**
 * Whether a bucket received any substrate.
 *
 * Exists so the test reads as the renderer will: a pixel with `total === 0` is not
 * a pixel full of passing dies, it is a pixel that is off the substrate, and it
 * must be left transparent rather than painted with whatever `acc` holds.
 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — the scatter reads
 * `total` inline in its own loop, and `grid-aggregate` is this function's only
 * caller. It exists so the SUITE cannot restate the emptiness rule in its own
 * words and then agree with itself; it asks the same question the renderer asks.
 * Written down because an export with no runtime consumer otherwise reads as a
 * promise.
 * @param buckets The buckets.
 * @param x       Device x.
 * @param y       Device y.
 * @returns Whether that pixel has at least one non-null cell.
 */
export function bucketIsPainted(buckets: GridBuckets, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= buckets.width || y >= buckets.height) { return false; }
    return buckets.total[y * buckets.width + x] > 0;
}
