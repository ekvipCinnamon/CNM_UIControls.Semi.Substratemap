/*
 * BinPalette.ts - the categorical fallback for bin codes nobody colored.
 *
 * WHY THIS FILE EXISTS. `categoricalPalette` was built, measured and tested,
 * and called by no render path. An author who
 * wanted eight sort grades in eight colors wrote eight hex values by hand, and a
 * map with eight unqualified codes drew the same gray eight times - which is a
 * map that says nothing about the thing it is a map of.
 *
 * ---- WHY IT IS NOT IN Engine.ts ----
 *
 * The aggregate palette could not live in `buildGridPaint` because
 * building it needs `Oklch`, and the split is BY NEED - the pixel loop and the
 * typed arrays stay in `Engine.ts`, palette construction moves out. The same
 * reasoning applies here unchanged. `Oklch.ts` imports nothing, so `Engine.ts`
 * COULD import it without a cycle; the reason not to is about what belongs in
 * the hot module - the pixel loop and its typed arrays - rather than about
 * acyclicity.
 *
 * So the assignment is computed here, once, and handed to `buildGridPaint` and
 * `binStatistics` as an argument - the same shape `buildGridPaint` already uses
 * for a value field's `fill`. That is also what keeps the MAP and the CHART
 * agreeing: one computation, two readers. Two independent fallbacks would let
 * the map and the chart give the same code two different colors.
 *
 * ---- THE PRECEDENCE THIS ADDS TO ----
 *
 *   1. an explicit `StatusColorMapping` entry        unchanged
 *   2. a resolved `BinQuality` of pass or fail       unchanged
 *   3. the categorical palette, by position          NEW
 *   4. the unknown color                            now only past the cap
 *
 * A map whose codes all carry a quality never reaches step 3 and renders exactly
 * as it did before. That is asserted, byte for byte.
 */

import {
    oklchToRgb,
    parseRgb,
    rgbToOklch,
    CATEGORICAL_CAP,
    CATEGORICAL_MIN_DELTA_E,
    CATEGORICAL_OTHER,
    categoricalPalette,
    minPairwiseDeltaE,
} from './Oklch.js';
import { resolveBinQuality, type BinTableEntry } from './BinSeverity.js';

/**
 * The same color with its chroma removed: same lightness, chroma 0, in OKLCH.
 *
 * ---- GRAY, NOT HIDDEN ----
 *
 * A hidden cell is indistinguishable from a null cell, and
 * the difference between *there is nothing here* and *there is something here
 * that does not concern you right now* is exactly the one an operator needs. A
 * die that has been tested and passed is not the same as a die that was never
 * placed, and a filter that erased the first would be lying about the wafer.
 *
 * ---- WHY LIGHTNESS IS KEPT ----
 *
 * Dropping everything to one gray would flatten the map into two tones and lose
 * the structure a person navigates by - a bright pass field and a dark
 * unclassified region read differently even when neither is the thing being
 * looked for. Keeping L and zeroing C removes the COLOR information while
 * leaving the shape, which is what "one color of light" describes.
 *
 * This is not a spatial operation and no convolution performs it: it is a
 * per-color transform, and it belongs beside the palette rather than beside
 * the filters.
 * ---- AND WHERE THE TWO RULES COLLIDE, SEPARATION WINS ----
 *
 * Keeping the lightness is not always possible. A pale bin on a pale substrate
 * mutes to something the eye cannot separate from an EMPTY cell - measured,
 * `#f0e442` becomes `#dedede`, which sits `dE 0.06` from a `#f2f2f2` body, and
 * `#ffffff` becomes itself. That is the exact failure graying was chosen to
 * avoid, arrived at from the other direction.
 *
 * So the lightness is preserved EXCEPT where preserving it would make the cell
 * vanish, and there it is pushed to `minDeltaE` away from `avoid` - downwards if
 * that fits, upwards otherwise. Between two grays the OKLCH distance IS the
 * lightness difference, so the push is exact rather than iterative.
 *
 * Losing a little lightness fidelity is the cheaper mistake: the point of the
 * whole operation is that a muted cell still SAYS something is there.
 * @param css A CSS color.
 * @param avoid The color showing where nothing is painted - the substrate body -
 *        or omitted to skip the separation step entirely.
 * @param minDeltaE How far to stay from it.
 * @returns The desaturated color as `#rrggbb`, or the input when it does not parse.
 */
export function desaturate(css: string, avoid?: string | null, minDeltaE: number = 0): string {
    const rgb = parseRgb(css);
    if (rgb === null) { return css; }
    const c = rgbToOklch(rgb);
    let L = c.L;

    if (typeof avoid === 'string' && minDeltaE > 0) {
        const bg = parseRgb(avoid);
        if (bg !== null) {
            const bl = rgbToOklch(bg).L;
            if (Math.abs(L - bl) < minDeltaE) {
                /*
                 * A MARGIN, because the answer is quantized to eight bits on the way
                 * out. Landing exactly on the bar gives 0.1517 against a bar of
                 * 0.153 once the color is rounded to three bytes - measured, on
                 * `#f0e442` over a white body. One 8-bit step of lightness near
                 * mid-gray is about 0.004, so twice that clears it everywhere and
                 * costs nothing anyone can see.
                 */
                const want = minDeltaE + 0.008;
                const down = bl - want;
                const up = bl + want;
                // Down first: a muted cell reads as recessive, and darkening keeps it
                // so. Up only when there is no room below, which is a dark theme.
                L = down >= 0 ? down : Math.min(1, up);
            }
        }
    }

    const out = oklchToRgb({ L, C: 0, h: c.h });
    return '#' + [out.r, out.g, out.b]
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('');
}

/** What {@link categoricalBinFallback} returns. */
export interface CategoricalBinFallback {
    /**
     * One entry per `binTable` index: the categorical color for that bin, or
     * `null` when it does not take one.
     *
     * Indexed by table index and not packed, so a reader indexes rather than
     * searches, and so index 0 - the reserved null bin, never painted - is
     * naturally `null`.
     */
    readonly colors: readonly (string | null)[];
    /** How many codes qualified for a categorical color, before the cap. */
    readonly requested: number;
    /** How many distinct colors were issued: `min(requested, CATEGORICAL_CAP)`. */
    readonly issued: number;
    /**
     * A message for the control to log ONCE, or `null`.
     *
     * Two things can produce one: more codes than the cap, and - in principle - a
     * palette whose measured separation falls below `CATEGORICAL_MIN_DELTA_E`.
     */
    readonly warning: string | null;
}

/** An empty result, for a grid with nothing to color. */
const NONE: CategoricalBinFallback = { colors: [], requested: 0, issued: 0, warning: null };

/**
 * Assigns categorical colors to the bin codes nothing else colors.
 *
 * A code qualifies when it has NEITHER a `StatusColorMapping` entry NOR a
 * `BinQuality` that resolves to pass or fail. Qualifying codes are numbered in
 * TABLE ORDER, which is the order the document declared them, so the assignment
 * is a pure function of the document and two identical bindings color a map
 * identically.
 *
 * ---- PAST THE CAP ----
 *
 * The palette is capped at ten because ten is roughly what a person can hold
 * at once; past it, every further code takes {@link CATEGORICAL_OTHER}. Here that
 * is VISIBLE rather than silent - `readBinStatistics` counts every code while the
 * palette colors ten, so the eleventh is present in the numbers and gray on the
 * map. A legend can say so; a map cannot.
 * @param binTable The grid's bin table; index 0 is the reserved null bin.
 * @param mapping  `StatusColorMapping`, or `null`.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @returns The assignment.
 */
export function categoricalBinFallback(
    binTable: readonly BinTableEntry[],
    mapping: Record<string, string> | null,
    aliases: Record<string, string> | null,
): CategoricalBinFallback {
    if (binTable.length <= 1) { return NONE; }

    // Which table entries qualify, in table order. Index 0 is the null bin and is
    // never painted, so it never qualifies.
    const takers: number[] = [];
    for (let i = 1; i < binTable.length; i++) {
        const entry = binTable[i];
        const mapped = mapping ? mapping[entry.code] : undefined;
        if (typeof mapped === 'string' && mapped.trim() !== '') { continue; }
        const resolved = resolveBinQuality(entry.quality, aliases);
        if (resolved === 'pass' || resolved === 'fail') { continue; }
        takers.push(i);
    }
    if (takers.length === 0) { return NONE; }

    const palette = categoricalPalette(takers.length);
    const colors: (string | null)[] = new Array<string | null>(binTable.length).fill(null);
    for (let k = 0; k < takers.length; k++) {
        colors[takers[k]] = k < palette.colors.length ? palette.colors[k] : CATEGORICAL_OTHER;
    }

    /*
     * MEASURED, not assumed - and this is `minPairwiseDeltaE`'s only runtime
     * consumer.
     *
     * It cannot fire today: `categoricalPalette(k)` for `k <= 10` is deterministic
     * and its separation was measured at 0.07 when the constants were chosen. It is
     * here because those constants are editable - a smaller `CATEGORICAL_C`, a
     * larger `CATEGORICAL_CAP`, a different `CATEGORICAL_L` - and the failure that
     * would follow is a map whose colors a person cannot tell apart, which nothing
     * else in this tree would notice. Forty-five comparisons at the cap.
     *
     * The SUITE asserts the measured value rather than relying on this guard, so
     * the number is pinned in a place a reader can see it.
     */
    let warning = palette.warning;
    if (palette.colors.length > 1) {
        const separation = minPairwiseDeltaE(palette.colors);
        if (separation < CATEGORICAL_MIN_DELTA_E) {
            const measured = `the ${palette.colors.length} generated colors separate by only `
                + `${separation.toFixed(4)}, below the ${CATEGORICAL_MIN_DELTA_E} this palette `
                + 'promises; they will not be reliably distinguishable.';
            warning = warning === null ? measured : `${warning} Also: ${measured}`;
        }
    }

    return {
        colors,
        requested: takers.length,
        issued: Math.min(takers.length, CATEGORICAL_CAP),
        warning,
    };
}
