/*
 * SpatialFilter.ts - the screen-space filters, over the aggregation pass's
 * {@link FilterBuffers}.
 *
 * ---- WHAT IS FILTERED, AND WHY IT IS NOT RGB ----
 *
 * The PALETTE INDEX. Every pixel of an aggregated tile is an index into a
 * palette the control owns, so a median over indices returns an index, which is
 * always a real bin color. A per-channel median on RGB is forbidden and the
 * reason is worth keeping in front of the code: the mean of green and red is
 * brown, and brown is not a bin category. With two colors nobody notices; with
 * eight sort grades the image turns to mud.
 *
 * ---- WHY MEDIAN FIRST ----
 *
 * Of the filters offered here it is the one with a defensible reason rather than a
 * borrowed one. It removes scattered single failures and leaves clusters
 * standing, which is the operation the WM-811K literature puts in front of every
 * pattern classification. Its tests measure exactly that pair of properties,
 * because neither alone would do: a filter that erases everything
 * also removes 80 % of random failures.
 *
 * ---- EDGES CLAMP ----
 *
 * A wafer is not a torus. Wrapping would carry a defect from one edge to the
 * opposite one, which is not a thing that happens to silicon. Clamping repeats
 * the border pixel, which is the standard choice and the one that does not
 * invent structure.
 *
 * ---- THE HISTOGRAM IS SLIDING, AND THAT IS WHY THIS IS AFFORDABLE ----
 *
 * The alphabet is small: at most 256 palette indices, and in practice four or
 * sixty-four. So a window of radius `r` maintains a count per index and, moving
 * one pixel right, removes one column and adds another - O(r) per pixel rather
 * than O(r^2). At 640 000 pixels and r = 3 that is a few million operations, not
 * tens of millions.
 */

import { FILTER_INDEX_EMPTY, type FilterBuffers } from './Engine.js';

/**
 * The largest palette a filter will index.
 *
 * `FILTER_INDEX_EMPTY` is 255, so a real index is 0..254 and the histogram needs
 * 255 slots. A palette larger than this never produced buffers in the first
 * place, so this is a second line rather than the only one.
 */
export const FILTER_HISTOGRAM_SLOTS = 255;

/*
 * ---- TWO GUARDS HERE ARE NOT MUTATION-TESTED, DELIBERATELY ----
 *
 * `r === 0` in the early return is an OPTIMIZATION. A radius of zero gives a
 * 1x1 window and the median of one pixel is itself, so removing the check
 * changes no output at any input - it only makes the identity case walk the
 * whole image to discover it. No mutation can catch it because there is nothing
 * to catch.
 *
 * The `continue` that skips `FILTER_INDEX_EMPTY` when counting is BELT AND
 * BRACES. `counts` has 255 slots and the empty marker is 255, so `counts[255]++`
 * writes past the end of a typed array, which does nothing, and the winner loop
 * never reads that far. Empties therefore cannot win the vote even with the
 * guard removed. It stays because relying on an out-of-range write to express
 * "this is not a category" would be unreadable, and because widening the
 * histogram by one - a plausible future change - would silently make empties
 * votable.
 *
 * Both are recorded rather than left for the next reader to rediscover, and the
 * mutations that WOULD catch a real regression in either are the ones in
 * `check-negatives`: making the empty marker a countable index, and letting the
 * window wrap.
 */

/**
 * Replaces every pixel with the most common palette index around it.
 *
 * ---- EMPTY PIXELS ARE NOT A CATEGORY ----
 *
 * `FILTER_INDEX_EMPTY` marks a pixel no bucket reached - off the substrate, or
 * outside the map's box. Those are NOT counted, and a pixel that is empty stays
 * empty. Counting them would let the space around a wafer vote on the wafer's
 * edge, and at radius 3 an edge die would be outvoted by nothing at all and
 * disappear. This is the same rule as `bucketIsPainted` one layer down: emptiness
 * is the absence of a reading, never a reading of zero.
 *
 * ---- TIES GO TO THE LOWER INDEX ----
 *
 * A deliberate and stated choice rather than an accident of iteration order. In
 * every palette here a lower index is a milder reading - `bySeverity` runs null,
 * pass, unknown, fail, and a ramp runs light to heavy - so a tie resolves
 * towards the less alarming answer. A filter that broke ties the other way would
 * turn a 50/50 neighborhood into a failure, which is the opposite of what a
 * noise filter is for.
 * @param src    The buffers to read.
 * @param radius Window radius in pixels; `0` returns a copy unchanged.
 * @returns A new index array, the same length as `src.index`.
 */
export function medianIndex(src: FilterBuffers, radius: number): Uint8Array {
    return slide(src, radius, majority);
}

/**
 * Dilation: every pixel takes the WORST severity in its neighborhood.
 *
 * A defect grows by the radius. Used to close gaps in a thin feature - `Max`
 * then `Min` at the same radius is a morphological CLOSING, which reconnects a
 * broken line without leaving it fattened.
 *
 * ---- OVER THE RANK, RETURNING AN INDEX ----
 *
 * Ordered by `src.rankByIndex`, not by the index itself. Today the two agree,
 * because every palette here happens to be ordered by severity - but a palette
 * that was not would make an index comparison silently order by color, and a
 * dilation that spread the prettiest bin instead of the worst one would look
 * plausible and be wrong. Ties go to the lower INDEX, as everywhere here.
 * @param src    The buffers.
 * @param radius Window radius; `0` is the identity.
 * @returns A new index array.
 */
export function maxIndex(src: FilterBuffers, radius: number): Uint8Array {
    const rank = src.rankByIndex;
    return slide(src, radius, (counts, act, n) => extreme(counts, rank, true, act, n));
}

/**
 * Erosion: every pixel takes the MOST HARMLESS severity in its neighborhood.
 *
 * A defect shrinks by the radius, and anything smaller than the window vanishes.
 * `Min` then `Max` is a morphological OPENING, which removes isolated failures
 * without shrinking what survives.
 * @param src    The buffers.
 * @param radius Window radius; `0` is the identity.
 * @returns A new index array.
 */
export function minIndex(src: FilterBuffers, radius: number): Uint8Array {
    const rank = src.rankByIndex;
    return slide(src, radius, (counts, act, n) => extreme(counts, rank, false, act, n));
}

/**
 * The index with the highest count; ties go to the lowest index.
 * @param counts Occupancy per index.
 * @returns The winning index.
 */
function majority(counts: Uint32Array, active: Uint8Array, n: number): number {
    let best = FILTER_HISTOGRAM_SLOTS;
    let bestCount = -1;
    for (let k = 0; k < n; k++) {
        const i = active[k];
        /*
         * Ties go to the LOWER INDEX. The old scan got that free by walking
         * 0..254 in order; `active` is in arrival order, so the tie has to be
         * broken explicitly. Losing this was the one behavioral risk in the
         * change, and it is what `patterns.test.mjs` checks by construction.
         */
        if (counts[i] > bestCount || (counts[i] === bestCount && i < best)) {
            bestCount = counts[i];
            best = i;
        }
    }
    return best === FILTER_HISTOGRAM_SLOTS ? 0 : best;
}

/**
 * The present index with the highest or lowest RANK; ties go to the lowest index.
 * @param counts Occupancy per index.
 * @param rank   Severity rank per index.
 * @param wantMax Whether to take the worst rank rather than the mildest.
 * @returns The winning index.
 */
function extreme(counts: Uint32Array, rank: Uint8Array, wantMax: boolean,
    active: Uint8Array, n: number): number {
    let best = FILTER_HISTOGRAM_SLOTS;
    let bestRank = wantMax ? -1 : Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
        const i = active[k];
        // A palette shorter than the histogram leaves the tail unranked; treating a
        // missing entry as its own index keeps the ordering total rather than
        // collapsing the tail onto rank 0.
        const rk = i < rank.length ? rank[i] : i;
        // Ties to the lower index — see `majority`.
        if (wantMax ? (rk > bestRank || (rk === bestRank && i < best))
            : (rk < bestRank || (rk === bestRank && i < best))) {
            bestRank = rk;
            best = i;
        }
    }
    return best === FILTER_HISTOGRAM_SLOTS ? 0 : best;
}

/**
 * Walks a square window across the buffer, maintaining an occupancy histogram.
 *
 * ONE implementation for all three morphological filters. The window bookkeeping
 * - clamped edges, empty pixels excluded, the row rebuild, the column slide - is
 * the part that is easy to get subtly wrong, and three copies of it would be
 * three chances to get it wrong differently. Only the CHOICE differs, and that
 * is the callback.
 * @param src    The buffers.
 * @param radius Window radius; `0` returns a copy unchanged.
 * @param choose Picks the output index from the window's occupancy.
 * @returns A new index array.
 */
function slide(src: FilterBuffers, radius: number,
    choose: (counts: Uint32Array, active: Uint8Array, n: number) => number): Uint8Array {
    const { width: w, height: h, index } = src;
    const out = new Uint8Array(index.length);
    const r = Math.max(0, Math.floor(radius));
    if (r === 0 || w === 0 || h === 0) {
        out.set(index);
        return out;
    }

    const counts = new Uint32Array(FILTER_HISTOGRAM_SLOTS);
    /*
     * ---- WHICH SLOTS ARE OCCUPIED, NOT MERELY HOW FULL ----
     *
     * `majority` and `extreme` scanned all 255 slots per pixel, so the cost was
     * 255 per pixel whatever the radius. Measured: 324 ms for a median over
     * 640 000 pixels, and FLAT from r=1 to r=5 - the signature of a cost that has
     * nothing to do with the window.
     *
     * A bin map has two to ten distinct values in a window, never 255. `active`
     * lists the ones present; `where` gives each one's slot in `active`, so a
     * removal is O(1) by swapping the last entry down into the hole.
     *
     * ---- INLINE, NOT CLOSURES ----
     *
     * The first attempt wrapped this in `gain()`/`lose()` arrow functions and made
     * the median **18x slower** - 324 ms to 5811 ms - because two closures called
     * a hundred million times defeat the JIT entirely. The maintenance is four
     * statements; they belong at the call sites.
     */
    const active = new Uint8Array(FILTER_HISTOGRAM_SLOTS);
    const where = new Int32Array(FILTER_HISTOGRAM_SLOTS);
    let nActive = 0;

    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);

        /*
         * The window is rebuilt at the start of each ROW and sled along it. Rebuilt
         * per row rather than carried down the image because moving down changes
         * `2r + 1` columns at once, which is the same cost as starting over.
         */
        counts.fill(0);
        nActive = 0;
        let inWindow = 0;
        for (let yy = y0; yy <= y1; yy++) {
            const base = yy * w;
            for (let xx = 0; xx <= Math.min(w - 1, r); xx++) {
                const v = index[base + xx];
                if (v === FILTER_INDEX_EMPTY) { continue; }
                if (counts[v] === 0) { where[v] = nActive; active[nActive++] = v; }
                counts[v]++;
                inWindow++;
            }
        }

        for (let x = 0; x < w; x++) {
            const at = y * w + x;
            if (index[at] === FILTER_INDEX_EMPTY) {
                // Empty stays empty. The filter smooths what was measured; it does
                // not extend the map into space where nothing was.
                out[at] = FILTER_INDEX_EMPTY;
            } else if (inWindow === 0) {
                // Every neighbor is empty and this pixel is not, which the loop
                // above cannot produce - `index[at]` is inside its own window. Kept
                // because relying on that to be true forever is how a later change
                // to the window bounds becomes a silent wrong answer.
                out[at] = index[at];
            } else {
                out[at] = choose(counts, active, nActive);
            }

            // Slide: drop the column leaving on the left, add the one entering on
            // the right. Guarded so a window clamped at an edge neither drops a
            // column it never added nor adds one past the end.
            const drop = x - r;
            const add = x + r + 1;
            for (let yy = y0; yy <= y1; yy++) {
                const base = yy * w;
                if (drop >= 0) {
                    const v = index[base + drop];
                    if (v !== FILTER_INDEX_EMPTY) {
                        counts[v]--;
                        inWindow--;
                        if (counts[v] === 0) {
                            // Swap the last entry into the hole so `active` stays dense.
                            const slot = where[v];
                            const last = active[--nActive];
                            active[slot] = last;
                            where[last] = slot;
                        }
                    }
                }
                if (add < w) {
                    const v = index[base + add];
                    if (v !== FILTER_INDEX_EMPTY) {
                        if (counts[v] === 0) { where[v] = nActive; active[nActive++] = v; }
                        counts[v]++;
                        inWindow++;
                    }
                }
            }
        }
    }
    return out;
}

/**
 * Repaints a bitmap from a filtered index array.
 *
 * Separate from the filter so the filter stays a pure function of a typed array
 * and can be asserted without a canvas - and so the `Min`/`Max` and `Box`/`Gauss`
 * kernels share this half rather than each growing their own copy.
 * @param src      The buffers the filter read, for geometry and palette.
 * @param filtered The filtered index array.
 * @param bitmap   The bitmap as packed words, indexed by the FULL bitmap width.
 * @param stride   The bitmap's width in pixels.
 * @returns How many pixels changed color.
 */
export function repaintFromIndex(src: FilterBuffers, filtered: Uint8Array,
    bitmap: Uint32Array, stride: number): number {
    let changed = 0;
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const i = y * src.width + x;
            const v = filtered[i];
            if (v === FILTER_INDEX_EMPTY) { continue; }
            const at = (src.y + y) * stride + (src.x + x);
            const word = src.palette[v];
            if (bitmap[at] !== word) { bitmap[at] = word; changed++; }
        }
    }
    return changed;
}

/*
 * ---- THE SCALAR HALF ----
 *
 * `Box` and `Gauss` average, and an average of two bin indices is not a bin. So
 * they never touch the index buffer: they run over the FLOAT field, and the
 * result is colored through the same ramp `FailFraction` already uses. The
 * output is a density map and is not claiming to be a bin map, which is exactly
 * what `filterApplies` refuses to let an author confuse.
 */

/**
 * Separable box blur over the scalar field, conserving the total.
 *
 * ---- SCATTER, NOT GATHER, AND THAT IS WHY THE SUM SURVIVES ----
 *
 * A gathering blur - `out[i] = mean of the window around i` - does not conserve
 * anything at an edge. Zero padding lets mass fall off the end; clamped padding
 * counts the edge pixel several times and INVENTS mass. Either way the total
 * moves, and a density map whose total moves is a density map that cannot be
 * compared with the one beside it.
 *
 * So each source pixel SPREADS its value: weight `1 / (2r + 1)` to each of its
 * `2r + 1` targets. Any share that would land outside the buffer, or on a pixel
 * nothing painted, folds back onto the source instead. Every source therefore
 * distributes exactly its own value and no more, and the total is preserved to
 * floating-point precision - which is the property the edge behavior is really
 * about.
 *
 * ---- EMPTY IS NOT ZERO ----
 *
 * `NaN` marks a pixel no bucket reached. Those neither give nor receive: a blur
 * that read them as zero would fade the wafer's rim towards nothing, and one
 * that wrote them would spread the map into space where nothing was measured.
 * The same rule as the median, for the same reason.
 * @param src    The buffers to read.
 * @param radius Window radius in pixels; `0` returns a copy unchanged.
 * @returns A new scalar array, the same length as `src.scalar`.
 */
export function boxScalar(src: FilterBuffers, radius: number): Float32Array {
    const r = Math.max(0, Math.floor(radius));
    const weights = new Float64Array(2 * r + 1).fill(1 / (2 * r + 1));
    return convolveScalar(src, r, weights);
}

/**
 * Separable Gaussian blur over the scalar field, conserving the total.
 *
 * `sigma = r / 2`, truncated at the radius and renormalized so the discrete
 * kernel sums to one - the continuous Gaussian's tail beyond `2 sigma` is about
 * 4.6 %, and dropping it without renormalizing would darken the whole field by
 * that much.
 * @param src    The buffers to read.
 * @param radius Window radius in pixels; `0` returns a copy unchanged.
 * @returns A new scalar array.
 */
export function gaussScalar(src: FilterBuffers, radius: number): Float32Array {
    const r = Math.max(0, Math.floor(radius));
    const weights = new Float64Array(2 * r + 1);
    if (r === 0) {
        weights[0] = 1;
        return convolveScalar(src, 0, weights);
    }
    const sigma = r / 2;
    let total = 0;
    for (let i = -r; i <= r; i++) {
        const wgt = Math.exp(-(i * i) / (2 * sigma * sigma));
        weights[i + r] = wgt;
        total += wgt;
    }
    for (let i = 0; i < weights.length; i++) { weights[i] /= total; }
    return convolveScalar(src, r, weights);
}

/**
 * Two separable scatter passes with a symmetric kernel.
 *
 * Separable because a 2-D kernel of radius `r` costs `(2r+1)^2` per pixel and two
 * 1-D passes cost `2(2r+1)`. At `r = 8` that is 289 against 34.
 * @param src     The buffers.
 * @param r       Radius.
 * @param weights `2r + 1` weights summing to 1.
 * @returns A new scalar array.
 */
function convolveScalar(src: FilterBuffers, r: number, weights: Float64Array): Float32Array {
    const { width: w, height: h, scalar } = src;
    const out = new Float32Array(scalar.length);
    if (r === 0 || w === 0 || h === 0) {
        out.set(scalar);
        return out;
    }
    const mid = new Float64Array(scalar.length).fill(Number.NaN);
    const acc = new Float64Array(scalar.length);

    /**
     * One scatter pass along a fixed stride.
     * @param read   Source values; `NaN` is empty.
     * @param write  Destination, pre-filled with `NaN`.
     * @param outer  How many lines. @param inner Line length.
     * @param at     Maps `(line, position)` to an index.
     * @returns Nothing.
     */
    const pass = (read: ArrayLike<number>, write: Float64Array,
        outer: number, inner: number, at: (a: number, b: number) => number): void => {
        acc.fill(0);
        for (let a = 0; a < outer; a++) {
            for (let b = 0; b < inner; b++) {
                const from = at(a, b);
                const v = read[from];
                if (Number.isNaN(v)) { continue; }
                /*
                 * FOLD-BACK, in two cases and for one reason: the value must go
                 * somewhere, and the only somewhere that is not a lie is the pixel it
                 * came from. Off the end of the line, and onto a pixel nothing
                 * painted.
                 */
                let kept = 0;
                for (let k = -r; k <= r; k++) {
                    const target = b + k;
                    if (target < 0 || target >= inner) { kept += weights[k + r]; continue; }
                    const to = at(a, target);
                    if (Number.isNaN(read[to])) { kept += weights[k + r]; continue; }
                    acc[to] += v * weights[k + r];
                }
                if (kept > 0) { acc[from] += v * kept; }
            }
        }
        for (let a = 0; a < outer; a++) {
            for (let b = 0; b < inner; b++) {
                const i = at(a, b);
                write[i] = Number.isNaN(read[i]) ? Number.NaN : acc[i];
            }
        }
    };

    pass(scalar, mid, h, w, (y, x) => y * w + x);
    const vert = new Float64Array(scalar.length).fill(Number.NaN);
    pass(mid, vert, w, h, (x, y) => y * w + x);
    for (let i = 0; i < out.length; i++) { out[i] = vert[i]; }
    return out;
}

/**
 * Repaints a bitmap from a filtered scalar field, through the aggregate ramp.
 *
 * The same ramp and the same gamma `FailFraction` already uses, so a blurred
 * density map and an unblurred one are read against one scale. `gamma` is
 * applied on the way to the color and never to the stored value, which is
 * the rule throughout: the number stays a fraction and only its appearance is curved.
 * @param src      The buffers, for geometry.
 * @param filtered The filtered scalar field.
 * @param ramp     Packed colors, low to high.
 * @param gamma    Curve applied before the lookup; `1` is linear.
 * @param bitmap   The bitmap as packed words.
 * @param stride   The bitmap's width in pixels.
 * @returns How many pixels changed color.
 */
export function repaintFromScalar(src: FilterBuffers, filtered: Float32Array,
    ramp: Uint32Array, gamma: number, bitmap: Uint32Array, stride: number): number {
    if (ramp.length === 0) { return 0; }
    const last = ramp.length - 1;
    let changed = 0;
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const i = y * src.width + x;
            const v = filtered[i];
            if (Number.isNaN(v)) { continue; }
            const curved = gamma === 1 ? v : Math.pow(Math.max(0, Math.min(1, v)), gamma);
            const word = ramp[Math.max(0, Math.min(last, Math.round(curved * last)))];
            const at = (src.y + y) * stride + (src.x + x);
            if (bitmap[at] !== word) { bitmap[at] = word; changed++; }
        }
    }
    return changed;
}


/** What a caller asks for: a kernel, a radius, and the gamma for a scalar repaint. */
export interface SpatialFilterRequest {
    /** The kernel. `'None'` is legal and does nothing. */
    readonly kind: 'None' | 'Median' | 'Min' | 'Max' | 'Box' | 'Gauss';
    /** Window radius in device pixels. `0` does nothing, as surely as `'None'`. */
    readonly radius: number;
    /** Curve applied on the way to a color for the scalar filters. */
    readonly gamma: number;
    /** The aggregate ramp, for repainting a filtered scalar field. */
    readonly ramp: Uint32Array;
}

/**
 * Runs a filter over a frame's buffers and repaints its bitmap.
 *
 * ---- THE ONE PLACE THAT JOINS THE TWO HALVES ----
 *
 * The aggregation pass produces the buffers and the kernels above consume them;
 * this is the only call from one to the other. A kernel tested against a
 * `FilterBuffers` literal proves the maths, not the wiring - without this
 * function a bound `SpatialFilter` changes no pixel.
 *
 * ---- THE DISPATCH IS THE WHOLE FUNCTION ----
 *
 * Deliberately. Anything else it did would be a decision made twice: the
 * legality of a pairing is `filterApplies`, the radius clamp is the attribute
 * setter, the cache key is the control. What is left is choosing a kernel by
 * name, and choosing whether the result is an index or a field.
 *
 * An ILLEGAL pairing is not refused here. It cannot arrive: the control resolves
 * `__effectiveFilter()` to `'None'` and reports `E142_FILTER_NOT_APPLICABLE`
 * before the render is asked for. A second refusal here would be a second place
 * to keep the rule.
 * @param src     The frame's buffers.
 * @param request What to run.
 * @param bitmap  The frame's packed pixels, repainted in place.
 * @param stride  The bitmap's width in pixels.
 * @returns How many pixels changed color.
 */
export function applySpatialFilter(src: FilterBuffers, request: SpatialFilterRequest,
    bitmap: Uint32Array, stride: number): number {
    const r = Math.max(0, Math.floor(request.radius));
    if (r === 0 || request.kind === 'None') { return 0; }

    switch (request.kind) {
        case 'Median':
            return repaintFromIndex(src, medianIndex(src, r), bitmap, stride);
        case 'Min':
            return repaintFromIndex(src, minIndex(src, r), bitmap, stride);
        case 'Max':
            return repaintFromIndex(src, maxIndex(src, r), bitmap, stride);
        case 'Box':
            return repaintFromScalar(src, boxScalar(src, r), request.ramp, request.gamma,
                bitmap, stride);
        case 'Gauss':
            return repaintFromScalar(src, gaussScalar(src, r), request.ramp, request.gamma,
                bitmap, stride);
        default:
            return 0;
    }
}
