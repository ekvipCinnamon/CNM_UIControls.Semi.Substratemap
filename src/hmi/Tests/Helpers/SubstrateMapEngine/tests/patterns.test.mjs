/*
 * patterns.test.mjs - the WM-811K generator (LOD Task 27).
 *
 * A fixture generator is only worth having if it is reproducible, so that is
 * asserted first and hardest: same seed, same bytes, across calls and across
 * process boundaries. Everything else it produces is only as trustworthy as
 * that.
 */
import { makeHarness, onCrash } from './lib/harness.mjs';
import {
    BIN_DEFS, CODES, FAIL, PASS, PATTERNS, fingerprint, rng, wafer,
} from './lib/patterns.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();

/* Section 6 renders, so it needs the DOM shims and the engine. Imported at the
 * top rather than inside the section, because `section` takes a plain callback
 * and `await` inside one is a syntax error, not a slow path. */
const S = await import('./lib/dom-shims.mjs');
S.installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import('../Engine.js');
const Agg = await import('../GridAggregate.js');
const Filter = await import(new URL('../SpatialFilter.js', import.meta.url).href);

/** Recorded fingerprints, in PATTERNS order. */
const PINNED_1 = ['721de2ff', '1ab1b674', 'eb4d1590', '7908efc1', 'b017a0fd', '2ecb0fac', '1b1946e6'];
/** See {@link PINNED_1}. */
const PINNED_21 = ['37f2a525', 'a4bc73b7', 'd150c09c', 'ee0200d3', 'f461383b', '980bc79a', '5a21ef01'];
onCrash(counts);

/* ------------------------------------------------------------------ */

section('1. the PRNG is deterministic and not Math.random', () => {
    attempt('the same seed gives the same stream', () => {
        const a = rng(12345);
        const b = rng(12345);
        const bad = [];
        for (let i = 0; i < 1000; i++) { if (a() !== b()) { bad.push(i); } }
        eq(bad.length, 0, `1000 draws agree exactly  ${bad[0] ?? ''}`);
    });

    attempt('different seeds give different streams', () => {
        const a = rng(1);
        const b = rng(2);
        let same = 0;
        for (let i = 0; i < 1000; i++) { if (a() === b()) { same++; } }
        ok(same < 5, `${same} coincidences in 1000 draws — the seed reaches the output`);
    });

    attempt('the stream is in range and not obviously banded', () => {
        const r = rng(99);
        const buckets = new Array(10).fill(0);
        const bad = [];
        for (let i = 0; i < 10000; i++) {
            const x = r();
            if (!(x >= 0 && x < 1)) { bad.push(x); }
            buckets[Math.min(9, Math.floor(x * 10))]++;
        }
        eq(bad.length, 0, 'every draw is 0 <= x < 1');
        const lo = Math.min(...buckets);
        const hi = Math.max(...buckets);
        ok(hi - lo < 250,
            `10 deciles of 10 000 draws span ${lo}..${hi} — flat enough that a pattern's density is `
            + 'the density it was asked for');
    });
});

section('2. reproducibility — the property a fixture generator lives by', () => {
    /* Done-when 1. */
    attempt('every pattern at a fixed seed is byte-identical across runs', () => {
        const bad = [];
        for (const p of PATTERNS) {
            const a = wafer(p, { size: 64, failRate: 0.02, seed: 7 });
            const b = wafer(p, { size: 64, failRate: 0.02, seed: 7 });
            if (fingerprint(a) !== fingerprint(b)) { bad.push(p); }
            for (let i = 0; i < a.cells.length; i++) {
                if (a.cells[i] !== b.cells[i]) { bad.push(`${p}@${i}`); break; }
            }
        }
        eq(bad.length, 0, `all ${PATTERNS.length} patterns reproduce  ${bad[0] ?? ''}`);
    });

    attempt('the fingerprints are pinned, so a silent change to the generator shows up', () => {
        /*
         * Recorded from the implementation, not derived from it: if the generator's
         * arithmetic moves, every fixture built on it moves too, and a test that
         * only compared a run against itself would never say so.
         *
         * Across THREE seeds, not one. A single seed pins a single rasterisation,
         * and a perturbation to the scratch's line-walking arithmetic happened to
         * reproduce that one exactly — it survived the pin until the pin covered
         * enough of the space to see it.
         */
        const across = (seed) => PATTERNS.map(
            (p) => fingerprint(wafer(p, { size: 64, failRate: 0.02, seed })));
        deep(across(7),
            ['d488b45c', 'daa02ef0', '06342377', '0574553c', '9151b11c', '7b1ebbbd', '4425086a'],
            'seed 7');
        deep(across(1), PINNED_1, 'seed 1');
        deep(across(21), PINNED_21, 'seed 21');
    });

    attempt('a different seed gives a different map', () => {
        const bad = [];
        for (const p of PATTERNS) {
            if (fingerprint(wafer(p, { seed: 1 })) === fingerprint(wafer(p, { seed: 2 }))) {
                bad.push(p);
            }
        }
        eq(bad.length, 0, `the seed reaches every pattern  ${bad[0] ?? ''}`);
    });

    attempt('generating one pattern does not disturb the next', () => {
        const alone = fingerprint(wafer('Scratch', { seed: 4 }));
        for (const p of PATTERNS) { wafer(p, { seed: 99 }); }
        eq(fingerprint(wafer('Scratch', { seed: 4 })), alone,
            'each call seeds its own generator — no shared global stream to sequence-couple '
            + 'fixtures through');
    });
});

section('3. the disc and the bin vocabulary', () => {
    attempt('cells off the wafer are the null bin', () => {
        const w = wafer('Random', { size: 32, failRate: 0.1, seed: 3 });
        const corner = w.cells[0];
        eq(corner, 0, 'the corner of the bounding square is off substrate');
        ok(w.onSubstrate < 32 * 32,
            `${w.onSubstrate} of ${32 * 32} cells are on the wafer — a disc, not a square`);
        ok(w.onSubstrate > 32 * 32 * 0.7, '  and most of it is, so the fixture is not mostly nothing');
    });

    attempt('only three bin values ever appear', () => {
        const seen = new Set();
        for (const p of PATTERNS) {
            for (const v of wafer(p, { size: 48, failRate: 0.05, seed: 11 }).cells) { seen.add(v); }
        }
        deep([...seen].sort(), [0, PASS, FAIL], 'null, pass, fail and nothing else');
        eq(CODES.length, 3, 'and the code table matches');
        eq(BIN_DEFS.length, 2, 'with a quality for each non-null code');
    });

    attempt('no failure is placed off the wafer', () => {
        const bad = [];
        for (const p of PATTERNS) {
            const w = wafer(p, { size: 64, failRate: 0.2, seed: 5, background: 0.05 });
            const g = wafer(p, { size: 64, failRate: 0, seed: 5 });
            for (let i = 0; i < w.cells.length; i++) {
                if (w.cells[i] === FAIL && g.cells[i] === 0) { bad.push(`${p}@${i}`); }
            }
        }
        eq(bad.length, 0, `every defect lands on substrate  ${bad[0] ?? ''}`);
    });
});

section('4. Scratch is exactly one cell wide', () => {
    /*
     * Done-when 2, and the reason the generator exists. A scratch is where
     * `MaxSeverity` and `FailFraction` give opposite answers: a handful of dies in
     * a million keeps saturation near zero, so worst-wins still says something,
     * while a factor rule sees only the zoom and reduces the scratch to a tint
     * (D-093). That only holds if the line really is one cell across.
     */
    /** @param w A map. @returns Failing cells as `{x, y}`. */
    const fails = (w) => {
        const out = [];
        for (let i = 0; i < w.cells.length; i++) {
            if (w.cells[i] === FAIL) { out.push({ x: i % w.cols, y: (i / w.cols) | 0 }); }
        }
        return out;
    };

    attempt('no 2x2 block of the map is entirely failing', () => {
        /* The crisp definition of width, and it holds at any angle — unlike a
         * per-row count, which is large for a shallow line and small for a steep
         * one without either meaning the line got thicker. */
        const bad = [];
        for (let seed = 1; seed <= 40; seed++) {
            const w = wafer('Scratch', { size: 64, failRate: 0.3, seed });
            const f = (x, y) => w.cells[y * w.cols + x] === FAIL;
            for (let y = 0; y < w.rows - 1; y++) {
                for (let x = 0; x < w.cols - 1; x++) {
                    if (f(x, y) && f(x + 1, y) && f(x, y + 1) && f(x + 1, y + 1)) {
                        bad.push(`seed ${seed} at ${x},${y}`);
                    }
                }
            }
        }
        eq(bad.length, 0, `40 scratches, none two cells thick anywhere  ${bad[0] ?? ''}`);
    });

    attempt('it is one cell per step along its own major axis', () => {
        const bad = [];
        for (let seed = 1; seed <= 40; seed++) {
            const w = wafer('Scratch', { size: 64, failRate: 0.3, seed });
            const perCol = new Map();
            const perRow = new Map();
            for (const { x, y } of fails(w)) {
                perCol.set(x, (perCol.get(x) ?? 0) + 1);
                perRow.set(y, (perRow.get(y) ?? 0) + 1);
            }
            const flat = (m) => [...m.values()].every((n) => n === 1);
            // Whichever axis the line advances on monotonically must hold exactly
            // one cell per index; the other may hold several, which is what a
            // shallow line looks like and is not extra width.
            if (!flat(perCol) && !flat(perRow)) {
                bad.push(`seed ${seed}: cols ${[...perCol.values()].join()} rows ${[...perRow.values()].join()}`);
            }
        }
        eq(bad.length, 0, `every scratch is single-file along its major axis  ${bad[0] ?? ''}`);
    });

    attempt('it is connected — a line, not a scatter', () => {
        const bad = [];
        for (let seed = 1; seed <= 20; seed++) {
            const w = wafer('Scratch', { size: 64, failRate: 0.3, seed });
            const f = fails(w);
            if (f.length < 3) { bad.push(`seed ${seed}: only ${f.length} cells`); continue; }
            const key = ({ x, y }) => `${x},${y}`;
            const set = new Set(f.map(key));
            const seen = new Set([key(f[0])]);
            const stack = [f[0]];
            while (stack.length > 0) {
                const { x, y } = stack.pop();
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const k = `${x + dx},${y + dy}`;
                        if (set.has(k) && !seen.has(k)) {
                            seen.add(k);
                            stack.push({ x: x + dx, y: y + dy });
                        }
                    }
                }
            }
            if (seen.size !== f.length) { bad.push(`seed ${seed}: ${seen.size} of ${f.length} connected`); }
        }
        eq(bad.length, 0, `20 scratches, each one 8-connected run  ${bad[0] ?? ''}`);
    });

    attempt('asking for a high fail rate widens nothing', () => {
        const low = wafer('Scratch', { size: 64, failRate: 0.001, seed: 8 });
        const high = wafer('Scratch', { size: 64, failRate: 0.5, seed: 8 });
        eq(high.regionSize, low.regionSize, 'the region is the same line either way');
        ok(high.failed <= high.regionSize,
            `${high.failed} failures cannot exceed the ${high.regionSize}-cell line`);
        ok(high.failRate < 0.5,
            `so the achieved rate is ${(high.failRate * 100).toFixed(2)} %, not the 50 % requested — `
            + 'the generator reports what it did rather than widening the shape to hit a number');
        eq(high.requestedFailRate, 0.5, '  and says what was asked for, so a test can see the gap');
    });
});

section('5. the patterns are the shapes they are named for', () => {
    /** @param w A map. @returns Mean normalised radius of the failures. */
    const meanRadius = (w) => {
        const c = (w.cols - 1) / 2;
        const r = w.cols / 2 - 0.5;
        let n = 0;
        let sum = 0;
        for (let i = 0; i < w.cells.length; i++) {
            if (w.cells[i] !== FAIL) { continue; }
            sum += Math.hypot((i % w.cols) - c, ((i / w.cols) | 0) - c) / r;
            n++;
        }
        return n === 0 ? 0 : sum / n;
    };

    attempt('Center, Donut and Edge-Ring sit at increasing radius', () => {
        const c = meanRadius(wafer('Center', { size: 64, failRate: 0.03, seed: 2 }));
        const d = meanRadius(wafer('Donut', { size: 64, failRate: 0.03, seed: 2 }));
        const e = meanRadius(wafer('Edge-Ring', { size: 64, failRate: 0.03, seed: 2 }));
        ok(c < d && d < e,
            `mean radius ${c.toFixed(2)} < ${d.toFixed(2)} < ${e.toFixed(2)} — the three concentric `
            + 'patterns are distinguishable by the one number that names them');
        ok(c < 0.3, 'Center is central');
        ok(e > 0.85, 'and Edge-Ring is at the rim');
    });

    attempt('Edge-Loc is an arc and Edge-Ring is not', () => {
        const spread = (w) => {
            const c = (w.cols - 1) / 2;
            const angles = [];
            for (let i = 0; i < w.cells.length; i++) {
                if (w.cells[i] === FAIL) {
                    angles.push(Math.atan2(((i / w.cols) | 0) - c, (i % w.cols) - c));
                }
            }
            /* Circular spread via the mean resultant length: 1 is a tight arc, 0 is
             * uniform around the rim. A plain angle range cannot tell them apart,
             * because an arc straddling -pi looks like the full circle. */
            const sx = angles.reduce((a, t) => a + Math.cos(t), 0) / angles.length;
            const sy = angles.reduce((a, t) => a + Math.sin(t), 0) / angles.length;
            return Math.hypot(sx, sy);
        };
        const loc = spread(wafer('Edge-Loc', { size: 64, failRate: 0.03, seed: 6 }));
        const ring = spread(wafer('Edge-Ring', { size: 64, failRate: 0.03, seed: 6 }));
        ok(loc > 0.7, `Edge-Loc is concentrated in one arc (${loc.toFixed(2)})`);
        ok(ring < 0.3, `  while Edge-Ring is spread around the rim (${ring.toFixed(2)})`);
    });

    attempt('Loc is a blob that does not touch the rim', () => {
        const bad = [];
        for (let seed = 1; seed <= 20; seed++) {
            const w = wafer('Loc', { size: 64, failRate: 0.05, seed });
            const c = (w.cols - 1) / 2;
            const r = w.cols / 2 - 0.5;
            for (let i = 0; i < w.cells.length; i++) {
                if (w.cells[i] !== FAIL) { continue; }
                const d = Math.hypot((i % w.cols) - c, ((i / w.cols) | 0) - c) / r;
                if (d > 0.95) { bad.push(`seed ${seed}: ${d.toFixed(2)}`); break; }
            }
        }
        eq(bad.length, 0, `20 blobs, none touching the rim — that would be an Edge-Loc  ${bad[0] ?? ''}`);
    });

    attempt('Random is the only one that fills the whole disc', () => {
        const w = wafer('Random', { size: 64, failRate: 0.05, seed: 9 });
        eq(w.regionSize, w.onSubstrate, 'its region IS the substrate');
        const bad = PATTERNS.filter((p) => p !== 'Random'
            && wafer(p, { size: 64, seed: 9 }).regionSize >= w.onSubstrate);
        eq(bad.length, 0, `and every other pattern is a proper subset  ${bad[0] ?? ''}`);
    });

    attempt('the fail rate is honoured where the region has room', () => {
        const bad = [];
        for (const p of ['Center', 'Donut', 'Edge-Ring', 'Random']) {
            const w = wafer(p, { size: 96, failRate: 0.02, seed: 13 });
            if (Math.abs(w.failRate - 0.02) > 0.006) {
                bad.push(`${p}: ${(w.failRate * 100).toFixed(2)} %`);
            }
        }
        eq(bad.length, 0, `within half a point of the 2 % requested  ${bad[0] ?? ''}`);
    });
});

section('6. the generator against the decision it exists to test (D-093)', () => {
    /*
     * The closing argument for measured saturation over predicted saturation.
     *
     * All seven patterns below carry the SAME fail rate and are rendered at the
     * SAME factor. A factor rule reads one number and must give one answer for all
     * seven. A prediction from the fail rate reads `1 - (1-p)^n`, which assumes
     * defects are INDEPENDENT — so it gives one answer too.
     *
     * The measurement gives seven, and it is the only one of the three that can.
     */
    const PL = { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
        rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false };
    const COLORS = { bg: '#000', body: '#dcdcdc', edge: '#6e6e6e', selection: '#005ac8',
        unknown: 'rgb(110,110,110)', binPass: 'rgb(0, 158, 115)', binFail: 'rgb(213, 94, 0)' };
    const SIDE = 256;
    const DEV = 32;                       // 64 cells per device pixel

    /** @param p A pattern. @returns `{ rate, saturation, reducer }`. */
    const measure = (p) => {
        const w = wafer(p, { size: SIDE, failRate: 0.02, seed: 21 });
        const grid = Engine.buildGridModel(PL,
            { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
        const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8));
        paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
        const ctx = S.makeContext2D(DEV, DEV);
        const sat = Engine.renderGridLayer(ctx, grid,
            new S.DOMMatrix([DEV / SIDE, 0, 0, DEV / SIDE, 0, 0]), paint, DEV, DEV, true, 'MaxSeverity');
        return { rate: w.failRate, saturation: sat, reducer: Engine.selectReducer('MaxSeverity', sat) };
    };

    const got = Object.fromEntries(PATTERNS.map((p) => [p, measure(p)]));

    attempt('every pattern really does carry about the same fail rate', () => {
        const bad = PATTERNS.filter((p) => p !== 'Scratch' && Math.abs(got[p].rate - 0.02) > 0.004);
        eq(bad.length, 0,
            `six of seven are within 0.4 points of 2 %  ${bad[0] ?? ''} — so any difference below `
            + 'is spatial, not a difference in how many dies failed');
        ok(got.Scratch.rate < 0.005,
            `and Scratch is ${(got.Scratch.rate * 100).toFixed(3)} % because a one-cell line cannot `
            + 'hold more, which is the honest cap and not a flaw');
    });

    attempt('clustering separates the patterns that a prediction cannot', () => {
        const p = 0.02;
        const n = (SIDE / DEV) ** 2;
        const predicted = 1 - Math.pow(1 - p, n);
        ok(Math.abs(predicted - 0.727) < 0.01,
            `1 - (1-p)^n predicts ${predicted.toFixed(3)} saturation for ALL of them`);

        const wrong = PATTERNS.filter((q) => Math.abs(got[q].saturation - predicted) > 0.2);
        eq(wrong.length, 6,
            `and it is wrong for six of the seven: ${wrong.join(', ')} — every one of them a `
            + 'CLUSTERED pattern, which is what the independence assumption rules out');
        ok(!wrong.includes('Random'),
            'Random is the one it gets right, and the one that barely needs a rule');
    });

    attempt('measured saturation gives a different answer per pattern, at one factor', () => {
        eq(got.Random.reducer, 'FailFraction',
            `uniform 2 % saturates worst-wins at ${got.Random.saturation.toFixed(3)}, so FailFraction`);
        const clustered = PATTERNS.filter((q) => q !== 'Random');
        const bad = clustered.filter((q) => got[q].reducer !== 'MaxSeverity');
        eq(bad.length, 0,
            `while all six clustered patterns keep MaxSeverity  ${bad[0] ?? ''} — a factor rule `
            + 'reads one number here and must answer all seven the same way');
        ok(got.Scratch.saturation < 0.05,
            `and Scratch is the extreme case at ${got.Scratch.saturation.toFixed(3)}: worst-wins `
            + 'still finds it, and a rule that switched would have reduced it to a tint');
    });
});

section('the median filter (W-20)', () => {
    /*
     * `W-20`'s two Done-when numbers exist as a PAIR: 80 % of random failures
     * removed would also be satisfied by a filter that erases everything, so a
     * second number has to show that something survives.
     *
     * The task names the scratch as that second number. It cannot be - see the
     * deviation below - so a cluster is measured instead, which is what the task's
     * own rationale actually claims: *removes scattered single failures and leaves
     * clusters standing*.
     */
    const PLACE = {
        originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
        rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false,
    };
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const FAIL_INDEX = 3;          // bySeverity is indexed by LEVEL: 0 null, 1 pass, 2 unknown, 3 fail

    /** @param name A pattern. @param rate Fail rate. @returns The filter buffers. */
    const buffers = (name, rate) => {
        const w = wafer(name, { size: 128, failRate: rate, seed: 7 });
        const grid = Engine.buildGridModel(PLACE,
            { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
        const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8));
        paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
        const side = 68;
        const sink = { buffers: null };
        Engine.renderGridLayer(S.makeContext2D(side, side), grid,
            new S.DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), paint, side, side, true, 'MaxSeverity', sink);
        return sink.buffers;
    };
    const fails = (idx) => idx.reduce((n, v) => n + (v === FAIL_INDEX ? 1 : 0), 0);

    attempt('Random at 2 %: radius 1 removes more than 80 % of the fail pixels', () => {
        /* Done-when 1, measured. The number goes in the handback, not a prediction. */
        const b = buffers('Random', 0.02);
        const before = fails(b.index);
        const after = fails(Filter.medianIndex(b, 1));
        const removed = (before - after) / before;
        ok(before > 100, `${before} fail pixels before`);
        ok(removed > 0.8,
            `${(removed * 100).toFixed(1)} % removed (${before} -> ${after}) — the bar is 80 %`);
    });

    attempt('a CLUSTER survives, which is what stops the first number being vacuous', () => {
        /*
         * The replacement for Done-when 2. `Loc` is a localised cluster - the thing
         * a median is supposed to leave standing - and it comes back slightly
         * LARGER, because the filter also fills the pass-coloured holes inside it.
         * That is the behaviour, not a rounding accident: a consolidated blob is
         * easier to see than a stippled one, and that is the point of the filter.
         */
        for (const [name, floor] of [['Loc', 0.9], ['Center', 0.9]]) {
            const b = buffers(name, 0.02);
            const before = fails(b.index);
            const after = fails(Filter.medianIndex(b, 1));
            ok(before > 50, `${name}: ${before} fail pixels before`);
            ok(after / before > floor,
                `  ${((after / before) * 100).toFixed(0)} % kept (${before} -> ${after})`);
        }
    });

    attempt('DEVIATION — a one-die Scratch does NOT stay continuous, and cannot', () => {
        /*
         * Done-when 2 as written: *on the Scratch pattern, the line stays continuous
         * at radius 1*. Measured, it does not - 21 fail pixels become 0.
         *
         * NOT A DEFECT. A median of radius r replaces a pixel with the majority of
         * its (2r+1)^2 window, so any feature thinner than r+1 pixels in its narrow
         * direction is by definition a minority and is removed. That is the
         * operation, and it is the same property that removes the random noise in
         * the first assertion.
         *
         * `Scratch` is one DIE wide by construction, and the bucket pass only runs
         * below one device pixel per die - so the line is at most one pixel wide at
         * any zoom where a filter applies. The two Done-when lines ask for opposite
         * things from the same operation.
         *
         * The width rule is pinned exactly below, so a reader can see where the
         * boundary is rather than taking this paragraph on trust.
         */
        const b = buffers('Scratch', 0.02);
        const before = fails(b.index);
        const after = fails(Filter.medianIndex(b, 1));
        ok(before > 0, `${before} fail pixels before`);
        eq(after, 0, `  and ${after} after — the line is removed, as a median must remove it`);
    });

    attempt('the exact width rule: radius r erases anything thinner than r + 1 px', () => {
        /* On a synthetic line rather than a wafer, because the property is about the
         * operation and not about silicon. This is the number that makes the
         * deviation above checkable instead of an excuse. */
        const W = 21;
        const H = 21;
        const line = (thickness) => {
            const index = new Uint8Array(W * H).fill(1);
            for (let y = 0; y < H; y++) {
                for (let t = 0; t < thickness; t++) { index[y * W + (10 + t)] = FAIL_INDEX; }
            }
            return {
                x: 0, y: 0, width: W, height: H, index,
                palette: new Uint32Array([0, 1, 2, 3]), scalar: new Float32Array(W * H),
                rankByIndex: new Uint8Array([0, 1, 2, 3]), reducer: 'MaxSeverity',
            };
        };
        eq(fails(Filter.medianIndex(line(1), 1)), 0, 'r=1 erases a 1 px line');
        eq(fails(Filter.medianIndex(line(2), 1)), 2 * H, 'r=1 keeps a 2 px line, entire');
        eq(fails(Filter.medianIndex(line(3), 1)), 3 * H, '  and a 3 px line');
        eq(fails(Filter.medianIndex(line(2), 2)), 0, 'r=2 erases the 2 px line');
        eq(fails(Filter.medianIndex(line(3), 2)), 3 * H, '  and keeps the 3 px one');
    });

    attempt('radius 0 is the identity, and edges clamp rather than wrap', () => {
        const b = buffers('Loc', 0.02);
        deep([...Filter.medianIndex(b, 0)], [...b.index], 'radius 0 changes nothing');

        /*
         * A wafer is not a torus. The fixture is a fail column at EACH edge and pass
         * between: clamped, each edge column ties 3-3 against its inner neighbour
         * and loses to pass, so both are erased. Wrapping joins the two columns into
         * a six-of-nine majority and both survive - which is how the two answers are
         * told apart.
         *
         * The first version of this put a block only on the LEFT and checked the
         * right edge for it. Wrapping cannot produce that: 3 fails of 9 is not a
         * majority, so the assertion passed either way and the mutation was MISSED.
         */
        const W = 7;
        const both = new Uint8Array(W * 3).fill(1);
        for (let y = 0; y < 3; y++) { both[y * W] = FAIL_INDEX; both[y * W + W - 1] = FAIL_INDEX; }
        const b2 = {
            x: 0, y: 0, width: W, height: 3, index: both, palette: new Uint32Array([0, 1, 2, 3]),
            scalar: new Float32Array(W * 3), rankByIndex: new Uint8Array([0, 1, 2, 3]),
            reducer: 'MaxSeverity',
        };
        const out = Filter.medianIndex(b2, 1);
        eq(fails(out), 0,
            'both one-wide edge columns are erased — a wrapping window would keep them');
    });

    attempt('an empty pixel stays empty, and never votes', () => {
        /*
         * `FILTER_INDEX_EMPTY` is the absence of a reading, not a reading. If it
         * voted, the space around a wafer would outvote the edge dies and the map
         * would shrink; if it could be written, the filter would extend the map
         * into space where nothing was measured.
         */
        const b = buffers('Center', 0.02);
        const out = Filter.medianIndex(b, 2);
        let leaked = 0;
        let filled = 0;
        let voted = 0;
        for (let i = 0; i < b.index.length; i++) {
            const wasEmpty = b.index[i] === Engine.FILTER_INDEX_EMPTY;
            const isEmpty = out[i] === Engine.FILTER_INDEX_EMPTY;
            if (wasEmpty && !isEmpty) { filled++; }
            if (!wasEmpty && isEmpty) { leaked++; }
            /*
             * The third case, and the one the first version missed: a painted pixel
             * turning into index 0. Zero is the NULL entry - nothing painted - so it
             * can never be the legitimate median of painted neighbours. If empties
             * were counted as a category they would come out as this, all around the
             * wafer's edge, and neither `filled` nor `leaked` would notice.
             */
            if (!wasEmpty && out[i] === 0) { voted++; }
        }
        eq(filled, 0, 'no empty pixel was filled in');
        eq(leaked, 0, 'no painted pixel was emptied');
        eq(voted, 0, 'and no painted pixel took the null index — emptiness never votes');
    });

    attempt('ties go to the lower index, and that is the milder reading', () => {
        /* Deliberate: in every palette here a lower index is milder - null, pass,
         * unknown, fail - so a 50/50 neighbourhood resolves towards the less
         * alarming answer rather than towards a failure. */
        const E = Engine.FILTER_INDEX_EMPTY;
        const mk = (cells) => ({
            x: 0, y: 0, width: 3, height: 3, index: Uint8Array.from(cells),
            palette: new Uint32Array([0, 1, 2, 3]), scalar: new Float32Array(9),
            rankByIndex: new Uint8Array([0, 1, 2, 3]), reducer: 'MaxSeverity',
        });
        /*
         * AN EXACT TIE, two against two, made by emptying the rest of the window. A
         * 3x3 window of nine painted pixels can never tie, so the first version of
         * this assertion used 5-4 and 4-5 - two clear majorities, no tie exercised,
         * and the mutation that flips the tie-break was MISSED.
         */
        eq(Filter.medianIndex(mk([E, 3, E, 1, 1, 3, E, E, E]), 1)[4], 1,
            'two pass against two fail resolves to pass, the lower index and the milder reading');
        eq(Filter.medianIndex(mk([1, 3, 1, 3, 1, 3, 1, 3, 1]), 1)[4], 1, 'a 5-4 majority of pass wins');
        eq(Filter.medianIndex(mk([1, 3, 1, 3, 3, 3, 1, 3, 1]), 1)[4], 3, 'and a 5-4 majority of fail wins');
    });
});

section('Min and Max: erosion and dilation (W-21)', () => {
    /*
     * `Max` keeps the worst rank in the neighbourhood, `Min` the mildest. Neither
     * is useful alone - dilation fattens everything and erosion eats everything -
     * which is why both Done-when lines are about a PAIR:
     *
     *   Max then Min  = closing, and it reconnects a broken line
     *   Min then Max  = opening, and it removes isolated failures
     *
     * The pair is what leaves the surviving shape its original size. That is the
     * whole reason morphology is two operations rather than one.
     */
    const PLACE = {
        originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
        rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false,
    };
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const FAIL_INDEX = 3;

    /** @param name Pattern. @param rate Fail rate. @param seed Seed. @returns The buffers. */
    const buffers = (name, rate, seed) => {
        const w = wafer(name, { size: 128, failRate: rate, seed });
        const grid = Engine.buildGridModel(PLACE,
            { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
        const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8));
        paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
        const side = 68;
        const sink = { buffers: null };
        Engine.renderGridLayer(S.makeContext2D(side, side), grid,
            new S.DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), paint, side, side, true, 'MaxSeverity', sink);
        return sink.buffers;
    };
    const derive = (b, index) => ({ ...b, index });
    const closing = (b, r) => Filter.minIndex(derive(b, Filter.maxIndex(b, r)), r);
    const opening = (b, r) => Filter.maxIndex(derive(b, Filter.minIndex(b, r)), r);
    const fails = (idx) => idx.reduce((n, v) => n + (v === FAIL_INDEX ? 1 : 0), 0);

    /**
     * 8-connected components of failing pixels.
     * @param b   The buffers, for geometry. @param idx An index array.
     * @returns How many separate pieces the failures form.
     */
    const components = (b, idx) => {
        const { width: w, height: h } = b;
        const seen = new Uint8Array(w * h);
        let n = 0;
        for (let i = 0; i < idx.length; i++) {
            if (idx[i] !== FAIL_INDEX || seen[i] !== 0) { continue; }
            n++;
            const stack = [i];
            seen[i] = 1;
            while (stack.length > 0) {
                const p = stack.pop();
                const px = p % w;
                const py = (p / w) | 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const qx = px + dx;
                        const qy = py + dy;
                        if (qx < 0 || qy < 0 || qx >= w || qy >= h) { continue; }
                        const q = qy * w + qx;
                        if (idx[q] === FAIL_INDEX && seen[q] === 0) { seen[q] = 1; stack.push(q); }
                    }
                }
            }
        }
        return n;
    };

    attempt('both are the identity at radius 0, by pixel', () => {
        /* Done-when 3. Asserted on a real wafer rather than a toy, so a filter that
         * was the identity only for a uniform image would not pass. */
        const b = buffers('Loc', 0.02, 7);
        deep([...Filter.maxIndex(b, 0)], [...b.index], 'Max at radius 0 changes nothing');
        deep([...Filter.minIndex(b, 0)], [...b.index], 'and neither does Min');
    });

    attempt('Max spreads the worst rank, Min the mildest', () => {
        /* The primitives, before the pairs. Dilation can only add failures and
         * erosion can only remove them; a filter that did the reverse would still
         * pass a closing test, because closing composes the two. */
        const b = buffers('Loc', 0.02, 7);
        const base = fails(b.index);
        const dilated = fails(Filter.maxIndex(b, 1));
        const eroded = fails(Filter.minIndex(b, 1));
        ok(dilated > base, `Max grows the defect: ${base} -> ${dilated}`);
        ok(eroded < base, `Min shrinks it: ${base} -> ${eroded}`);
    });

    attempt('a gap of g closes when g <= 2r, and not when it is wider', () => {
        /*
         * The exact rule, on a synthetic line, because it is what makes the wafer
         * measurement below interpretable rather than anecdotal. Dilation grows each
         * end of a break by `r`, so a gap of `2r` just meets in the middle and
         * erosion then restores the line's original width.
         */
        const W = 25;
        const H = 5;
        const line = (gap) => {
            const index = new Uint8Array(W * H).fill(1);
            const start = 12 - Math.floor(gap / 2);
            for (let x = 2; x < W - 2; x++) {
                if (x >= start && x < start + gap) { continue; }
                index[2 * W + x] = FAIL_INDEX;
            }
            return {
                x: 0, y: 0, width: W, height: H, index,
                palette: new Uint32Array([0, 1, 2, 3]), scalar: new Float32Array(W * H),
                rankByIndex: new Uint8Array([0, 1, 2, 3]), reducer: 'MaxSeverity',
            };
        };
        const whole = (b, idx) => components(b, idx) === 1;
        for (const [gap, r, expected] of [[2, 1, true], [3, 1, false], [4, 2, true],
            [5, 2, false], [6, 3, true], [7, 3, false]]) {
            const b = line(gap);
            eq(whole(b, closing(b, r)), expected,
                `a gap of ${gap} at radius ${r} is ${expected ? 'bridged' : 'too wide'} (2r = ${2 * r})`);
        }
    });

    attempt('closing reconnects a BROKEN Scratch, measured', () => {
        /*
         * Done-when 1. At the default 2 % the generator fills a scratch SOLID - its
         * region is smaller than the requested fail count, so density clamps to 1 -
         * and a solid line has no gaps to fill. Measured at 0.08 %, where the line
         * comes out broken, which is also the realistic case: a scratch is detected
         * as an interrupted row of dies.
         */
        const b = buffers('Scratch', 0.0008, 2);
        const before = components(b, b.index);
        const after1 = components(b, closing(b, 1));
        const after2 = components(b, closing(b, 2));
        eq(before, 5, `the broken line is in ${before} pieces`);
        ok(after1 < before, `  closing at r=1 joins them into ${after1}`);
        ok(after2 <= after1, `  and at r=2 into ${after2}`);
        eq(after2, 1, '  one continuous line');
    });

    attempt('opening removes isolated failures in Random, measured', () => {
        /* Done-when 2. Every random failure is smaller than the window, so erosion
         * takes all of them and there is nothing left for the dilation to restore. */
        const b = buffers('Random', 0.02, 7);
        const before = fails(b.index);
        const after = fails(opening(b, 1));
        ok(before > 100, `${before} scattered fail pixels`);
        eq(after, 0, `  and ${after} after opening — all of them isolated`);
    });

    attempt('opening keeps a cluster, which is what stops that number being vacuous', () => {
        /* The same trap as `W-20`'s: a filter that erases everything also removes
         * every isolated failure. A blob has to survive. */
        const b = buffers('Loc', 0.02, 7);
        const before = fails(b.index);
        const after = fails(opening(b, 1));
        ok(after > 0, `the cluster survives opening: ${before} -> ${after}`);
        ok(after / before > 0.2, `  keeping ${((after / before) * 100).toFixed(0)} %`);
    });

    attempt('the order is over the RANK, not over the index', () => {
        /*
         * Today every palette here happens to be ordered by severity, so an index
         * comparison would agree by accident. This gives `Max` a rank table that
         * REVERSES the order and checks that it follows the ranks - which is the
         * only way to tell the two apart before a palette exists that differs.
         */
        const W = 3;
        const idx = new Uint8Array([1, 1, 1, 1, 3, 1, 1, 1, 1]);
        const mk = (rank) => ({
            x: 0, y: 0, width: W, height: W, index: idx,
            palette: new Uint32Array([0, 1, 2, 3]), scalar: new Float32Array(9),
            rankByIndex: rank, reducer: 'MaxSeverity',
        });
        eq(Filter.maxIndex(mk(new Uint8Array([0, 1, 2, 3])), 1)[0], 3,
            'with the normal ladder, Max spreads index 3 — the worst rank');
        eq(Filter.maxIndex(mk(new Uint8Array([3, 2, 1, 0])), 1)[0], 1,
            'with a REVERSED ladder it spreads index 1, because that is now the worst rank');
    });

    attempt('empties neither vote nor are written', () => {
        /* Erosion is where this matters most: if empty counted as the mildest rank,
         * `Min` would eat the entire wafer edge on the first pass. */
        const b = buffers('Center', 0.02, 7);
        for (const [name, out] of [['Min', Filter.minIndex(b, 2)], ['Max', Filter.maxIndex(b, 2)]]) {
            let filled = 0;
            let leaked = 0;
            let voted = 0;
            for (let i = 0; i < b.index.length; i++) {
                const wasEmpty = b.index[i] === Engine.FILTER_INDEX_EMPTY;
                if (wasEmpty && out[i] !== Engine.FILTER_INDEX_EMPTY) { filled++; }
                if (!wasEmpty && out[i] === Engine.FILTER_INDEX_EMPTY) { leaked++; }
                if (!wasEmpty && out[i] === 0) { voted++; }
            }
            eq(filled + leaked + voted, 0,
                `${name}: nothing filled, emptied, or given the null index`);
        }
    });
});

section('Box and Gauss on the scalar field (W-22)', () => {
    /*
     * These two AVERAGE, and an average of two bin indices is not a bin, so they
     * never touch the index buffer. They run over the float field and the result
     * is a density map that is not claiming to be a bin map - which is exactly
     * what `filterApplies` refuses to let an author confuse.
     */
    const PLACE = {
        originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
        rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false,
    };
    const COLORS = {
        bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
        unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
    };
    const buffers = (name, rate, mode) => {
        const w = wafer(name, { size: 128, failRate: rate, seed: 7 });
        const grid = Engine.buildGridModel(PLACE,
            { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
        const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8));
        paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
        const side = 68;
        const sink = { buffers: null };
        Engine.renderGridLayer(S.makeContext2D(side, side), grid,
            new S.DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), paint, side, side, true, mode, sink);
        return sink.buffers;
    };
    const total = (a) => {
        let t = 0;
        for (const v of a) { if (!Number.isNaN(v)) { t += v; } }
        return t;
    };
    /**
     * How much non-zero mass sits next to a pixel nothing painted.
     *
     * The quantity a dropped fold-back would lose, and the reason the conservation
     * assertions run on `Edge-Ring` rather than on a mid-wafer cluster.
     * @param b The buffers. @returns The mass at the boundary.
     */
    const atBoundary = (b) => {
        let m = 0;
        for (let y = 0; y < b.height; y++) {
            for (let x = 0; x < b.width; x++) {
                const i = y * b.width + x;
                if (Number.isNaN(b.scalar[i]) || b.scalar[i] === 0) { continue; }
                let touches = false;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const qx = x + dx;
                        const qy = y + dy;
                        if (qx < 0 || qy < 0 || qx >= b.width || qy >= b.height
                            || Number.isNaN(b.scalar[qy * b.width + qx])) { touches = true; }
                    }
                }
                if (touches) { m += b.scalar[i]; }
            }
        }
        return m;
    };

    attempt('Gauss at radius 0 is the identity, value for value', () => {
        /* Done-when 1. `Object.is` rather than `===` so a `NaN` that moved would be
         * caught rather than silently comparing unequal to itself. */
        const b = buffers('Loc', 0.05, 'FailFraction');
        const out = Filter.gaussScalar(b, 0);
        let differ = 0;
        for (let i = 0; i < out.length; i++) { if (!Object.is(out[i], b.scalar[i])) { differ++; } }
        eq(differ, 0, `all ${out.length} values identical, NaNs included`);
        const box = Filter.boxScalar(b, 0);
        for (let i = 0; i < box.length; i++) { if (!Object.is(box[i], b.scalar[i])) { differ++; } }
        eq(differ, 0, 'and Box at radius 0 too');
    });

    attempt('the total is preserved under Box at every radius', () => {
        /*
         * Done-when 2, and the property the edge behaviour is really about. A
         * GATHERING blur conserves nothing at an edge: zero padding lets mass fall
         * off the end, clamped padding counts the edge pixel repeatedly and invents
         * it. So each source SCATTERS its value and any share that would land
         * outside, or on an unpainted pixel, folds back onto the source.
         *
         * The residual is Float32 storage precision - the accumulation is Float64
         * and the buffer is not.
         */
        /*
         * ON `Edge-Ring`, and the fixture is the point. `Loc` puts its cluster in
         * the middle of the wafer, where every rim value is 0.0 - so mass dropped
         * at the boundary is zero mass and conservation holds however the edge is
         * handled. Both fold-back mutations were MISSED against it.
         *
         * `Edge-Ring` puts 59 of its 175 units of mass in pixels that touch an
         * empty one, so a dropped fold-back is a third of the field.
         */
        const b = buffers('Edge-Ring', 0.05, 'FailFraction');
        const base = total(b.scalar);
        ok(base > 100, `a base total of ${base.toFixed(3)} to conserve`);
        ok(atBoundary(b) > base * 0.2,
            `  of which ${atBoundary(b).toFixed(1)} touches an empty pixel — the mass at risk`);
        for (const r of [1, 2, 3, 5, 8]) {
            const err = Math.abs(total(Filter.boxScalar(b, r)) - base) / base;
            ok(err < 1e-6, `r=${r}: relative error ${err.toExponential(2)}`);
        }
    });

    attempt('and under Gauss, whose kernel is renormalised after truncation', () => {
        /* The continuous Gaussian's tail past 2 sigma is about 4.6 %; dropping it
         * without renormalising would darken the whole field by that much. */
        const b = buffers('Edge-Ring', 0.05, 'FailFraction');
        const base = total(b.scalar);
        for (const r of [1, 3, 8]) {
            const err = Math.abs(total(Filter.gaussScalar(b, r)) - base) / base;
            ok(err < 1e-6, `r=${r}: relative error ${err.toExponential(2)}`);
        }
    });

    attempt('empty pixels neither give nor receive', () => {
        /* A blur that read `NaN` as zero would fade the wafer's rim towards nothing;
         * one that wrote them would spread the map into space where nothing was
         * measured. The same rule as the median, for the same reason. */
        const b = buffers('Center', 0.05, 'FailFraction');
        for (const [name, out] of [['Box', Filter.boxScalar(b, 3)], ['Gauss', Filter.gaussScalar(b, 3)]]) {
            let filled = 0;
            let emptied = 0;
            for (let i = 0; i < out.length; i++) {
                const wasEmpty = Number.isNaN(b.scalar[i]);
                const isEmpty = Number.isNaN(out[i]);
                if (wasEmpty && !isEmpty) { filled++; }
                if (!wasEmpty && isEmpty) { emptied++; }
            }
            eq(filled + emptied, 0, `${name}: the empty set is unchanged`);
        }
    });

    attempt('a blur SPREADS — the peak falls and the footprint grows', () => {
        /* Conservation alone is satisfied by the identity. Something has to move. */
        /*
         * ON `Random`, whose peaks are ISOLATED. The first version used `Loc` and
         * the peak did not move - correctly: a pixel in the middle of a solid fail
         * cluster has neighbours that are all 1.0, so its average is 1.0. A blur
         * lowers a peak only where there is something lower nearby, and choosing a
         * dense fixture to demonstrate spreading was the wrong fixture.
         */
        const b = buffers('Random', 0.05, 'FailFraction');
        const peak = (a) => a.reduce((m, v) => (Number.isNaN(v) ? m : Math.max(m, v)), 0);
        const spread = (a) => a.reduce((n, v) => n + (!Number.isNaN(v) && v > 0.001 ? 1 : 0), 0);
        const out = Filter.boxScalar(b, 3);
        ok(peak(out) < peak(b.scalar),
            `the peak falls ${peak(b.scalar).toFixed(3)} -> ${peak(out).toFixed(3)}`);
        ok(spread(out) > spread(b.scalar),
            `and the footprint grows ${spread(b.scalar)} -> ${spread(out)}`);
    });

    attempt('the scalar repaint runs the ramp, and gamma curves only the appearance', () => {
        /*
         * `D-088`'s rule, one layer along: the stored number stays a fraction and
         * only its route to a colour is curved. Asserted by giving the same field
         * two gammas and requiring different pixels from the same values.
         */
        const b = buffers('Loc', 0.05, 'FailFraction');
        const field = Filter.boxScalar(b, 2);
        const ramp = new Uint32Array(64);
        for (let i = 0; i < 64; i++) { ramp[i] = 0xff000000 | i; }
        const stride = 68;
        const flat = () => new Uint32Array(stride * stride);
        const a = flat();
        const c = flat();
        const nA = Filter.repaintFromScalar(b, field, ramp, 1, a, stride);
        const nC = Filter.repaintFromScalar(b, field, ramp, 0.4, c, stride);
        ok(nA > 100 && nC > 100, `${nA} and ${nC} pixels painted`);
        let differ = 0;
        for (let i = 0; i < a.length; i++) { if (a[i] !== c[i]) { differ++; } }
        ok(differ > 50, `${differ} pixels differ between gamma 1 and gamma 0.4`);
        ok(field.every((v) => Number.isNaN(v) || (v >= 0 && v <= 1)),
            'and the field itself is untouched by either');
    });
});

finish();
