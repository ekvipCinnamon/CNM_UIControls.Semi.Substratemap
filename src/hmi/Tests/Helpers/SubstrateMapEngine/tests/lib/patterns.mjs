/*
 * patterns.mjs - synthetic wafer maps in the WM-811K defect taxonomy.
 *
 * ============================================================================
 *  SYNTHETIC, PROCEDURAL, SEEDED. There are no customer maps in this repository
 *  and there will not be: the data is under NDA, and the constraint is accepted
 *  rather than worked around. What matters for testing a RENDERER is the spatial
 *  SHAPE of a defect population - clustered at the rim, strung along a line,
 *  scattered uniformly - and shape is exactly what can be generated.
 *
 *  The taxonomy is the one WM-811K uses, minus `Near-full` and `none`: Center,
 *  Donut, Edge-Loc, Edge-Ring, Loc, Random, Scratch. It is worth naming because
 *  it is the vocabulary a process engineer already has, and because clustering
 *  is what broke the predicted-saturation rule at D-093 - `1 - (1-p)^n` assumes
 *  independence and every one of these except Random violates it.
 * ============================================================================
 *
 * Determinism is the whole point of a fixture generator, so nothing here calls
 * `Math.random`. Same seed, same bytes, always - asserted rather than assumed.
 */

/** The bin codes every generated map uses: null, pass, fail. */
export const CODES = ['.', '1', '9'];

/** `BinDefinitions` matching {@link CODES}. */
export const BIN_DEFS = [
    { code: '1', quality: 'Pass' },
    { code: '9', quality: 'Fail' },
];

/*
 * ---- A RICHER CORPUS, FOR REVIEWING WHAT A MAP ACTUALLY LOOKS LIKE (W-24a) ----
 *
 * Two bins and a fully processed disc is enough to exercise the RENDER, and it
 * is what every task up to `W-24` needed. It is not enough to JUDGE a difference
 * view, for two reasons the user named:
 *
 *   - a real map has SORT BINS, not one failure colour. "This die changed from
 *     bin 3 to bin 7" is the difference an engineer looks for, and a two-bin
 *     corpus cannot show it at all;
 *   - a real map is often only PARTLY PROCESSED. An untested region is null, and
 *     null is not a bin - it is the case `W-23`'s grey-not-hidden argument exists
 *     for, and the two-bin disc has no way to put one on the page.
 *
 * `SORT_CODES` and the `unprocessed` option below add both. Neither changes the
 * default: `wafer()` with no options produces exactly what it always did, which
 * `patterns` asserts by fingerprint.
 */

/*
 * `T` is a TEST DIE, and it is not a defect.
 *
 * A wafer carries structures that are neither product nor failure: test dies,
 * dummy dies, process-control monitors. They occupy real positions and they
 * carry a bin code that is not a pass bin, so to a plain map they look exactly
 * like a defect - and usually a regular one, a row or a cross, which is worse,
 * because a regular defect pattern is what an operator is trained to notice.
 *
 * They are the reason a golden map is worth binding: a reference containing them
 * greys them out and what stays lit is what is actually wrong. Without them in
 * the corpus a reference adds no information, which is what the first review
 * sheet showed and what took two rounds to hear.
 */
export const TEST_DIE_CODE = 'T';

/** Ascii codes for a multi-bin sort: pass, five failure modes, and a test die. */
export const SORT_CODES = ['.', '1', '3', '4', '5', '7', '9', TEST_DIE_CODE];

/** Bin definitions matching {@link SORT_CODES}. */
export const SORT_BIN_DEFS = [
    { code: '1', quality: 'Pass' },
    { code: '3', quality: 'Fail' },
    { code: '4', quality: 'Fail' },
    { code: '5', quality: 'Fail' },
    { code: '7', quality: 'Unknown' },
    { code: '9', quality: 'Fail' },
    /*
     * `Fail`, and that is the point rather than a shortcut.
     *
     * A test die is not product and did not fail at anything - but it bins as a
     * DEFECT BY DESIGN, which is how a real sort program records it, and a map
     * therefore paints it as one. That is precisely why it is a problem: a regular
     * row of failure-coloured dies is the shape an operator is trained to notice,
     * and it means nothing.
     *
     * Making it `Unknown` here would have coloured it grey, hidden the difficulty,
     * and made the review sheet prove nothing - which is what the first version
     * did.
     */
    { code: TEST_DIE_CODE, quality: 'Fail' },
];

/** Bin index of a passing die. */
export const PASS = 1;
/** Bin index of a failing die. */
export const FAIL = 2;

/** The patterns this module generates, in WM-811K's own spelling. */
export const PATTERNS = [
    'Center', 'Donut', 'Edge-Loc', 'Edge-Ring', 'Loc', 'Random', 'Scratch',
];

/**
 * A deterministic 32-bit PRNG (mulberry32).
 *
 * Chosen over the LCG used elsewhere in these tests because an LCG's low bits
 * cycle short, and several patterns here sample a 2-D position from consecutive
 * draws - which is exactly where that shows up as visible banding.
 * @param seed Any integer.
 * @returns A function returning 0 <= x < 1.
 */
export function rng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The disc of on-substrate cells.
 * @param size Cells per side.
 * @returns `{ cells, onSubstrate, cx, cy, r }`.
 */
function disc(size) {
    const cells = new Uint32Array(size * size);
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const r = size / 2 - 0.5;
    let onSubstrate = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
                cells[y * size + x] = PASS;
                onSubstrate++;
            }
        }
    }
    return { cells, onSubstrate, cx, cy, r };
}

/**
 * The cells a pattern's defects may occupy, as linear indices.
 *
 * Each region is the SHAPE the taxonomy names, and nothing more - the density
 * inside it is chosen afterwards to hit the requested rate. Keeping the two
 * apart is what lets `Scratch` stay one cell wide at any fail rate: its region
 * simply runs out of room, and the generator reports the rate it achieved
 * rather than widening the line to reach the one it was asked for.
 * @param pattern One of {@link PATTERNS}.
 * @param g       The disc geometry.
 * @param size    Cells per side.
 * @param rand    The PRNG.
 * @returns Linear indices, all on substrate.
 */
function region(pattern, g, size, rand) {
    const { cells, cx, cy, r } = g;
    const out = [];
    const on = (x, y) => x >= 0 && x < size && y >= 0 && y < size
        && cells[y * size + x] !== 0;
    const push = (x, y) => { if (on(x, y)) { out.push(y * size + x); } };
    const dist = (x, y) => Math.hypot(x - cx, y - cy);

    if (pattern === 'Random') {
        for (let i = 0; i < cells.length; i++) { if (cells[i] !== 0) { out.push(i); } }
        return out;
    }
    if (pattern === 'Center') {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) { if (on(x, y) && dist(x, y) <= r * 0.3) { push(x, y); } }
        }
        return out;
    }
    if (pattern === 'Donut') {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const d = dist(x, y);
                if (on(x, y) && d >= r * 0.42 && d <= r * 0.62) { push(x, y); }
            }
        }
        return out;
    }
    if (pattern === 'Edge-Ring') {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) { if (on(x, y) && dist(x, y) >= r * 0.88) { push(x, y); } }
        }
        return out;
    }
    if (pattern === 'Edge-Loc') {
        // An ARC of the rim, not the whole of it: Edge-Loc is Edge-Ring's local
        // cousin and the difference between them is angular extent.
        const a0 = rand() * Math.PI * 2;
        const span = Math.PI / 3;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (!on(x, y) || dist(x, y) < r * 0.82) { continue; }
                let a = Math.atan2(y - cy, x - cx) - a0;
                a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
                if (a <= span) { push(x, y); }
            }
        }
        return out;
    }
    if (pattern === 'Loc') {
        // A blob somewhere in the interior, placed by rejection so it never
        // straddles the rim - that would make it an Edge-Loc.
        /*
         * The sampling BOUND keeps the blob clear of the rim, so there is nothing to
         * reject. `d <= 0.85(r - rad)`, hence `d + rad <= 0.85r + 0.15rad < 0.9r`
         * for any `rad < r/3` — measured at 0.883 over 100 000 samples against a
         * 0.9 threshold. The first version wrapped this in a rejection loop that
         * could never fire, which is a branch no input can reach (the D-081 rule).
         */
        const rad = Math.max(2, r * 0.22);
        const a = rand() * Math.PI * 2;
        const d = rand() * (r - rad) * 0.85;
        const bx = cx + Math.cos(a) * d;
        const by = cy + Math.sin(a) * d;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (on(x, y) && Math.hypot(x - bx, y - by) <= rad) { push(x, y); }
            }
        }
        return out;
    }
    if (pattern === 'Scratch') {
        /*
         * EXACTLY ONE CELL WIDE, which is the property the whole generator exists
         * to provide: a scratch is the case where `MaxSeverity` and `FailFraction`
         * give opposite answers, because a handful of dies in a million keeps
         * saturation near zero while a factor rule sees only the zoom (D-093).
         *
         * Walked cell by cell with Bresenham rather than sampled along a
         * parameter - sampling a line at t = 0, 0.01, ... duplicates cells on the
         * shallow axis and SKIPS them on the steep one, which would make the
         * "one cell wide" claim false in one direction and unfalsifiable in the
         * other.
         */
        const a = rand() * Math.PI * 2;
        const len = r * (0.5 + rand() * 0.7);
        const mx = cx + (rand() - 0.5) * r * 0.7;
        const my = cy + (rand() - 0.5) * r * 0.7;
        let x0 = Math.round(mx - Math.cos(a) * len / 2);
        let y0 = Math.round(my - Math.sin(a) * len / 2);
        const x1 = Math.round(mx + Math.cos(a) * len / 2);
        const y1 = Math.round(my + Math.sin(a) * len / 2);
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (let guard = 0; guard < size * 4; guard++) {
            push(x0, y0);
            if (x0 === x1 && y0 === y1) { break; }
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
        return out;
    }
    throw new Error(`unknown pattern ${JSON.stringify(pattern)}`);
}

/**
 * Generates one wafer map.
 *
 * @param pattern One of {@link PATTERNS}.
 * @param opts    `{ size = 64, failRate = 0.02, seed = 1, background = 0,
 *                unprocessed = 0, sortBins = false }`. `unprocessed` is the
 *                fraction of the WIDTH left untested, as a band from the left;
 *                `sortBins` spreads failures over five bins instead of one;
 *                `testRows` lays that many rows of TEST DIES across the wafer,
 *                which are not defects and need `sortBins`.
 *                `failRate` is the target fraction of ON-SUBSTRATE dies that
 *                fail; `background` is a uniform rate applied outside the
 *                pattern's region, since a real wafer has both.
 * @returns `{ cols, rows, cells, codes, binDefs, onSubstrate, failed, failRate,
 *          requestedFailRate, regionSize }`.
 */
export function wafer(pattern, opts = {}) {
    const size = opts.size ?? 64;
    const target = opts.failRate ?? 0.02;
    const background = opts.background ?? 0;
    const rand = rng(opts.seed ?? 1);

    const g = disc(size);
    const cells = g.cells;
    const idx = region(pattern, g, size, rand);

    /*
     * UNPROCESSED, before anything is failed. A fraction of the disc, taken as a
     * vertical band from the left, set back to the null bin. Null is not a bin and
     * not a quality: it is the absence of a reading, and the renderer paints
     * nothing there - which is precisely the thing a muted cell has to stay
     * distinguishable from.
     *
     * A band rather than a scatter because that is what a half-processed wafer
     * looks like: a lot stopped part way, not dies missing at random.
     */
    let unprocessed = 0;
    if ((opts.unprocessed ?? 0) > 0) {
        const cut = Math.round(size * Math.min(1, opts.unprocessed));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < cut; x++) {
                const i = y * size + x;
                if (cells[i] !== 0) { cells[i] = 0; unprocessed++; }
            }
        }
    }

    /*
     * Density inside the region, so the OVERALL rate lands on the request. When
     * the region is too small to hold that many - a scratch always is - it fills
     * completely and the achieved rate is reported instead of the requested one.
     * Widening the shape to hit a number would destroy the only property the
     * shape was generated for.
     */
    const want = Math.round(target * g.onSubstrate);
    // NOT mutation-tested: `rand() < min(1, x)` and `rand() < x` agree for every
    // x >= 1, and `density` is used nowhere else, so dropping the clamp changes no
    // output. It stays because "a probability" that can read 47 is a lie about the
    // quantity, and the next reader should not have to re-derive that it is safe.
    const density = idx.length === 0 ? 0 : Math.min(1, want / idx.length);
    /*
     * `cells[i] !== 0` because an UNTESTED die cannot have a test result. The
     * region is computed from the disc, before anything is marked unprocessed, so
     * without this guard a failure lands in the blank band - which the first
     * review sheet showed plainly: orange dies on a background that is supposed to
     * be empty. With `unprocessed = 0` no cell inside the disc is null and the
     * guard never fires, so the default corpus is unchanged.
     */
    for (const i of idx) { if (cells[i] !== 0 && rand() < density) { cells[i] = FAIL; } }

    if (background > 0) {
        const inRegion = new Uint8Array(cells.length);
        for (const i of idx) { inRegion[i] = 1; }
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === PASS && inRegion[i] === 0 && rand() < background) { cells[i] = FAIL; }
        }
    }

    /*
     * SORT BINS, assigned last so the pattern's SHAPE is unchanged: the same cells
     * fail, they are merely told apart. A failure's bin is drawn from the list
     * rather than derived from position, because a sort bin is a test outcome and
     * a real one does not correlate with where the die sat.
     */
    /*
     * TEST-DIE ROWS, placed last and independently of the pattern, because that is
     * what they are: a layout decision taken before any wafer was processed. They
     * overwrite whatever the pattern put there, since a position holding a test
     * structure never held product.
     */
    let testDies = 0;
    if ((opts.testRows ?? 0) > 0 && opts.sortBins === true) {
        const step = Math.max(2, Math.floor(size / (opts.testRows + 1)));
        for (let row = step; row < size; row += step) {
            for (let x = 0; x < size; x++) {
                const i = row * size + x;
                if (cells[i] !== 0) { cells[i] = 7; testDies++; }   // index of TEST_DIE_CODE
            }
        }
    }

    let codes = CODES;
    let binDefs = BIN_DEFS;
    if (opts.sortBins === true) {
        codes = SORT_CODES;
        binDefs = SORT_BIN_DEFS;
        // FAIL is index 2 in CODES; in SORT_CODES the failures are indices 2..6.
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === FAIL) { cells[i] = 2 + Math.floor(rand() * 5); }
        }
    }

    let failed = 0;
    for (let i = 0; i < cells.length; i++) { if (cells[i] > PASS) { failed++; } }
    return {
        cols: size,
        rows: size,
        cells,
        codes,
        binDefs,
        unprocessed,
        testDies,
        onSubstrate: g.onSubstrate - unprocessed,
        failed,
        failRate: g.onSubstrate - unprocessed === 0 ? 0 : failed / (g.onSubstrate - unprocessed),
        requestedFailRate: target,
        regionSize: idx.length,
    };
}

/**
 * A cheap content hash, for asserting reproducibility.
 * @param w A map from {@link wafer}.
 * @returns A hex string.
 */
export function fingerprint(w) {
    let h = 0x811c9dc5;
    for (let i = 0; i < w.cells.length; i++) {
        h ^= w.cells[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
