/*
 * grid-render.test.mjs - what the render path does TODAY, pinned before anything
 * changes it.
 *
 * WHY IT EXISTS. `latticeMatrix`, `makeWorldMatrix`, `deviceMatrix`,
 * `buildGridPaint`, `renderGridLayer` and `getCellAtPos` had no automated coverage
 * at all until LOD-1 and LOD-2 made them reachable from Node. They were verified by
 * looking at a nine-panel screenshot. Phase 2 is about to change what
 * `renderGridImageData` puts in each pixel, and without this file it could not tell
 * a fix from a regression.
 *
 * ---- HOW THE EXPECTATIONS ARE DERIVED ----
 *
 * Rule 10: nothing here is produced by the code under test. Every matrix
 * expectation is the arithmetic written out; every cell expectation is derived from
 * the placement by hand, in the comment above it. The round trip is the one
 * exception in FORM and not in kind - it composes two functions and asserts they
 * invert, which is a property, not a value someone typed.
 *
 * ---- THE PRIVATE RENDERERS ----
 *
 * `renderGridImageData` and `renderGridRuns` are module-private and are driven
 * through `renderGridLayer` (D-068). That is not a workaround: the dispatcher owns
 * the `GRID_RUN_STRATEGY_PX` decision, so driving it from both sides exercises the
 * switch AND both renderers, which is what this task's Done-when asks for.
 * Exporting the privates would test each strategy in isolation from the thing that
 * chooses between them.
 */

import { makeHarness, onCrash } from './lib/harness.mjs';
import { DOMMatrix, installDomShims, makeContext2D, pixelAt } from './lib/dom-shims.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(new URL('../Engine.js', import.meta.url).href);
const Agg = await import(new URL('../GridAggregate.js', import.meta.url).href);
const Ok = await import(new URL('../Oklch.js', import.meta.url).href);

/** @param m A matrix. @returns Its six components. */
const six = (m) => [m.a, m.b, m.c, m.d, m.e, m.f];
/** @param a Numbers. @param b Numbers. @returns Whether all pairs are within 1e-9. */
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/* A 1 mm lattice, 4 wide by 3 high, origin at S-frame (0,0), cells drawn at full
 * pitch so the half-extent test never rejects a centre. */
const PLACEMENT = {
    originXmm: 0, originYmm: 0,
    colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1,
    cellWmm: 1, cellLmm: 1,
    sideMirror: false,
};

/* Codes: 0 = null, 1 = pass, 2 = fail. The BinDefinitions carry a `quality`,
 * without which `resolveBinColor` returns `unknown` for BOTH and pass and fail
 * become the same colour (observation 77). */
const CELLS = new Uint32Array([
    0, 1, 1, 1,
    1, 1, 2, 1,
    1, 1, 1, 1,
]);
const PAYLOAD = { cols: 4, rows: 3, cells: CELLS, codes: ['.', '1', '9'] };
const BIN_DEFS = [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Fail' }];
const COLORS = {
    bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
    unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
};

/** @returns A fresh grid model. */
const makeGrid = () => Engine.buildGridModel(PLACEMENT, PAYLOAD, BIN_DEFS);

section('1. latticeMatrix — the six components, written out', () => {
    /* latticeMatrix(p) = [colStepX, colStepY, rowStepX, rowStepY, originX, originY].
     * Nothing is computed; the assertion is that nothing is REORDERED, which is the
     * only thing a six-component constructor can get wrong. */
    deep(six(Engine.latticeMatrix(PLACEMENT)), [1, 0, 0, 1, 0, 0],
        'the identity lattice: unit steps, origin at 0,0');

    const skew = { ...PLACEMENT, colStepXmm: 2, colStepYmm: 3, rowStepXmm: 5, rowStepYmm: 7,
        originXmm: 11, originYmm: 13 };
    deep(six(Engine.latticeMatrix(skew)), [2, 3, 5, 7, 11, 13],
        'and six distinct values land in a b c d e f in that order');

    attempt('it maps cell coordinates to the S frame', () => {
        const m = Engine.latticeMatrix({ ...PLACEMENT, originXmm: 10, originYmm: 20 });
        const p = m.transformPoint({ x: 3, y: 2 });
        /* origin (10,20) + 3 columns of (1,0) + 2 rows of (0,1) = (13,22). */
        deep([p.x, p.y], [13, 22], 'cell (3,2) on a unit lattice at origin (10,20) is S-frame (13,22)');
    });
});

section('2. deviceMatrix and makeWorldMatrix', () => {
    /* deviceMatrix(dpr, m) = [dpr,0,0,dpr,0,0] · m — the DPR scale applied AFTER m,
     * so it scales m's translation too. */
    deep(six(Engine.deviceMatrix(2, new DOMMatrix([1, 0, 0, 1, 5, 7]))), [2, 0, 0, 2, 10, 14],
        'deviceMatrix scales the whole chain, translation included');
    deep(six(Engine.deviceMatrix(1, new DOMMatrix([3, 0, 0, 3, 4, 4]))), [3, 0, 0, 3, 4, 4],
        'and dpr 1 leaves it alone');

    /*
     * makeWorldMatrix(cfg, s, rad) = T(center) · Sc(s, -s) · R(rad).
     * The -s is the ONE axis flip: S-frame y is up, screen y is down.
     * With center (100,50), s = 2, rad = 0:
     *   a=2  b=0  c=0  d=-2  e=100  f=50
     */
    const cfg = { center: { x: 100, y: 50 }, width: 200, height: 100, margin: 8 };
    deep(six(Engine.makeWorldMatrix(cfg, 2)), [2, 0, 0, -2, 100, 50],
        'world at rotation 0: scale s, -s about the centre');

    attempt('the y flip is real', () => {
        const w = Engine.makeWorldMatrix(cfg, 2);
        const up = w.transformPoint({ x: 0, y: 1 });     // +1 mm "up" in the S frame
        ok(up.y < 50, 'a point one unit up the S frame lands ABOVE the centre on screen');
        deep([up.x, up.y], [100, 48], '  at exactly centre.y - 2');
    });

    attempt('a quarter turn composes on the right', () => {
        /* R(90) sends (1,0) to (0,1) in S space; the -s flip then sends it to
         * screen (0,-1)·s, i.e. above the centre. Composed: x=100, y=50-2 = 48. */
        const w = Engine.makeWorldMatrix(cfg, 2, Math.PI / 2);
        const p = w.transformPoint({ x: 1, y: 0 });
        ok(near([p.x, p.y], [100, 48]),
            'with mapRotation 90 deg, S-frame +x points UP the screen');
        const q = Engine.makeWorldMatrix(cfg, 2, 0).transformPoint({ x: 1, y: 0 });
        deep([q.x, q.y], [102, 50], '  where at rotation 0 it points right');
    });
});

section('3. buildGridPaint', () => {
    const grid = makeGrid();
    ok(grid !== null, 'buildGridModel accepts the placement and payload');
    eq(grid.cols, 4, '  4 columns');
    eq(grid.rows, 3, '  3 rows');
    eq(grid.binTable.length, 3, '  and a bin table of null, pass, fail');

    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    /* Slot 0 is the null bin and is never painted, so `colors[0]` is the empty
     * string by construction. Pass and fail resolve through their QUALITY. */
    eq(paint.colors[0], '', 'group 0 is the unused null-bin slot');
    ok(paint.colors.includes('#00aa00'), 'pass resolves to binPass through its BinQuality');
    ok(paint.colors.includes('#aa0000'), 'and fail to binFail');
    eq(paint.groups[0], 0, 'the null bin maps to group 0');
    ok(paint.groups[1] !== paint.groups[2], 'pass and fail land in different groups');

    attempt('rgba is populated, which is what enables the ImageData strategy', () => {
        ok(paint.rgba !== null, 'rgba is a Uint32Array, not null');
        ok(paint.rgba[paint.groups[1]] !== paint.rgba[paint.groups[2]],
            '  and pass and fail pack to different words');
    });

    attempt('one unparsable colour disables the strategy entirely', () => {
        const bad = Engine.buildGridPaint(grid, null,
            { ...COLORS, binFail: 'not-a-colour' }, makeContext2D(8, 8));
        eq(bad.rgba, null,
            'rgba goes null rather than half-filled — the ImageData path is all-or-nothing');
        ok(bad.colors.includes('not-a-colour'),
            '  while the runs path still has the string and will let the browser judge it');
    });

    attempt('an explicit mapping outranks the quality', () => {
        const mapped = Engine.buildGridPaint(grid, { '9': '#0000ff' }, COLORS, makeContext2D(8, 8));
        ok(mapped.colors.includes('#0000ff'), 'the mapping wins for code 9');
        ok(!mapped.colors.includes('#aa0000'), '  and binFail is not used for it');
    });

    attempt('without a ctx there is no rgba at all', () => {
        eq(Engine.buildGridPaint(grid, null, COLORS, null).rgba, null,
            'a null ctx means no colour normalisation, so no packed words');
    });
});

section('4. the strategy switch, from both sides', () => {
    const grid = makeGrid();
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    /*
     * renderGridLayer picks by pxPerCell = min(cellW, cellL) * hypot(dev.a, dev.b).
     * With unit cells that is just the device scale, so the threshold is the scale.
     * GRID_RUN_STRATEGY_PX is 3: below it the ImageData path, at or above it runs.
     */
    eq(Engine.GRID_RUN_STRATEGY_PX, 3, 'the threshold is 3 device px per cell');

    /** @param scale Device scale. @param allow allowImageData. @returns The ctx. */
    const render = (scale, allow) => {
        const ctx = makeContext2D(64, 48);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([scale, 0, 0, scale, 0, 0]),
            paint, 64, 48, allow);
        return ctx;
    };

    const above = render(8, true);
    ok(above.fills.length > 0, 'at 8 px/cell the RUNS path draws');
    eq(above.puts.length, 0, '  and does not blit');

    const at = render(3, true);
    ok(at.fills.length > 0, 'at exactly 3 px/cell — the threshold — runs still wins');
    eq(at.puts.length, 0, '  the comparison is strictly less-than');

    const below = render(2.99, true);
    eq(below.fills.length, 0, 'a hair below 3 the IMAGEDATA path takes over');
    ok(below.puts.length > 0, '  and blits instead');

    const forced = render(1, false);
    ok(forced.fills.length > 0, 'and allowImageData=false forces runs at any scale');
    eq(forced.puts.length, 0, '  which is what protects an uncached canvas from being erased');
});

section('5. what each strategy actually paints', () => {
    const grid = makeGrid();
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));

    attempt('the ImageData path colours cells by bin', () => {
        const ctx = makeContext2D(8, 6);
        /* 1 device px per cell, origin at 0: cell (c,r) is pixel (c,r). */
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([1, 0, 0, 1, 0, 0]), paint, 8, 6, true);

        /* CELLS row 0 is [0,1,1,1] — cell (0,0) is the NULL bin and is never
         * painted, so it stays transparent. */
        deep(pixelAt(ctx, 0, 0), [0, 0, 0, 0], 'the null bin is left unpainted');

        const pass = pixelAt(ctx, 1, 0);
        const fail = pixelAt(ctx, 2, 1);          // CELLS row 1 is [1,1,2,1]
        ok(pass[3] === 255, 'a pass cell is opaque');
        ok(fail[3] === 255, 'a fail cell is opaque');
        deep(pass, [0, 170, 0, 255], '  pass is #00aa00');
        deep(fail, [170, 0, 0, 255], '  and fail is #aa0000 — the two are distinguishable');
    });

    attempt('the runs path coalesces equal neighbours into one fillRect', () => {
        const ctx = makeContext2D(64, 48);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([8, 0, 0, 8, 0, 0]), paint, 64, 48, false);
        /*
         * 12 cells: one null (never drawn), ten pass, one fail. The pass cells form
         * runs broken by the null at (0,0) and the fail at (2,1), so there are
         * strictly fewer fills than painted cells — that is the whole point of the
         * strategy.
         */
        ok(ctx.fills.length > 0, `the runs path emitted ${ctx.fills.length} fills`);
        ok(ctx.fills.length < 11, '  fewer than the 11 painted cells, so runs really coalesce');
        const styles = new Set(ctx.fills.map((f) => f.fillStyle));
        ok(styles.has('#00aa00') && styles.has('#aa0000'),
            '  and both bin colours appear among them');
        ok(!styles.has(''), '  with no fill left at the empty null-bin style');
    });
});

section('6. getCellAtPos inverts the projection', () => {
    /*
     * THE ROUND TRIP the Done-when asks for. For a cell, its centre in lattice
     * coordinates is (col + 0.5, row + 0.5); pushing that through
     * latticeMatrix then `world` gives the screen point, and getCellAtPos must
     * return the cell it started from.
     *
     * This is a PROPERTY, not a typed expectation: it composes two functions and
     * asserts they invert. Nothing here was produced by running the code and
     * writing down what it said.
     */
    const cfg = { center: { x: 100, y: 50 }, width: 200, height: 100, margin: 8 };

    /**
     * @param grid      The grid.
     * @param world     The world matrix.
     * @returns A function from (col,row) to the screen point of that cell's centre.
     */
    const project = (grid, world) => (col, row) => {
        const lat = Engine.latticeMatrix(grid.placement);
        const s = lat.transformPoint({ x: col + 0.5, y: row + 0.5 });
        return world.transformPoint(s);
    };

    /**
     * @param label   What is being exercised.
     * @param place   Placement overrides.
     * @param rad     Map rotation in radians.
     * @returns Nothing.
     */
    const roundTrip = (label, place, rad) => {
        const grid = Engine.buildGridModel({ ...PLACEMENT, ...place }, PAYLOAD, BIN_DEFS);
        const world = Engine.makeWorldMatrix(cfg, 4, rad);
        const matrices = { dprBase: 1, world, data: world, scale: 4,
            fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } };
        const at = project(grid, world);

        /* Corners and centre. Cell (0,0) is the null bin and is deliberately
         * excluded: getCellAtPos returns null there by design, which is a
         * different assertion made below. */
        const probes = [[3, 0], [0, 2], [3, 2], [1, 1], [2, 1]];
        const misses = [];
        for (const [col, row] of probes) {
            const hit = Engine.getCellAtPos(at(col, row), matrices, grid);
            if (hit === null || hit.col !== col || hit.row !== row) {
                misses.push(`(${col},${row}) -> ${hit === null ? 'null' : `(${hit.col},${hit.row})`}`);
            }
        }
        eq(misses.length, 0, `${label}: every corner and centre round-trips  ${misses[0] ?? ''}`);
    };

    roundTrip('upright', {}, 0);
    roundTrip('rotated 90 deg', {}, Math.PI / 2);
    roundTrip('rotated 180 deg', {}, Math.PI);
    roundTrip('rotated 45 deg, off-quadrant', {}, Math.PI / 4);
    roundTrip('mirrored in x', { colStepXmm: -1, originXmm: 4 }, 0);
    roundTrip('mirrored in y', { rowStepYmm: -1, originYmm: 3 }, 0);
    roundTrip('mirrored both ways, rotated', { colStepXmm: -1, originXmm: 4, rowStepYmm: -1,
        originYmm: 3 }, Math.PI / 2);

    attempt('the null bin is never hit', () => {
        const grid = makeGrid();
        const world = Engine.makeWorldMatrix(cfg, 4, 0);
        const matrices = { dprBase: 1, world, data: world, scale: 4,
            fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } };
        const at = project(grid, world);
        eq(Engine.getCellAtPos(at(0, 0), matrices, grid), null,
            'cell (0,0) holds the null bin, so its own centre reports no hit');
        ok(Engine.getCellAtPos(at(1, 0), matrices, grid) !== null,
            '  while its neighbour does');
    });

    attempt('a point outside the lattice misses', () => {
        const grid = makeGrid();
        const world = Engine.makeWorldMatrix(cfg, 4, 0);
        const matrices = { dprBase: 1, world, data: world, scale: 4,
            fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } };
        const at = project(grid, world);
        eq(Engine.getCellAtPos(at(4, 0), matrices, grid), null, 'one column past the last is null');
        eq(Engine.getCellAtPos(at(-1, 0), matrices, grid), null, 'and one before the first');
        eq(Engine.getCellAtPos(at(0, 3), matrices, grid), null, 'and one row past the last');
    });

    attempt('a cell drawn smaller than its pitch rejects the gap', () => {
        /* cellW = 0.4 of a 1 mm pitch, so halfA = 0.2: a point 0.35 of a pitch from
         * the centre is inside the CELL's row but outside the drawn extent. */
        const grid = Engine.buildGridModel({ ...PLACEMENT, cellWmm: 0.4, cellLmm: 0.4 },
            PAYLOAD, BIN_DEFS);
        const world = Engine.makeWorldMatrix(cfg, 4, 0);
        const matrices = { dprBase: 1, world, data: world, scale: 4,
            fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } };
        const lat = Engine.latticeMatrix(grid.placement);
        const centre = world.transformPoint(lat.transformPoint({ x: 1.5, y: 0.5 }));
        const edge = world.transformPoint(lat.transformPoint({ x: 1.85, y: 0.5 }));
        ok(Engine.getCellAtPos(centre, matrices, grid) !== null, 'the cell centre hits');
        eq(Engine.getCellAtPos(edge, matrices, grid), null,
            '  and the street between cells does not — the drawn extent is what is clickable');
    });

    attempt('a degenerate lattice is refused rather than dividing by zero', () => {
        const grid = Engine.buildGridModel(
            { ...PLACEMENT, rowStepXmm: 1, rowStepYmm: 0 }, PAYLOAD, BIN_DEFS);
        const world = Engine.makeWorldMatrix(cfg, 4, 0);
        const matrices = { dprBase: 1, world, data: world, scale: 4,
            fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } };
        eq(Engine.getCellAtPos({ x: 100, y: 50 }, matrices, grid), null,
            'collinear column and row steps give a zero determinant, and null rather than NaN');
    });

    attempt('a missing fitBox or a non-positive scale is refused', () => {
        const grid = makeGrid();
        const world = Engine.makeWorldMatrix(cfg, 4, 0);
        eq(Engine.getCellAtPos({ x: 100, y: 50 },
            { dprBase: 1, world, data: world, scale: 4, fitBox: null }, grid), null,
            'no fitBox means nothing has been laid out yet');
        eq(Engine.getCellAtPos({ x: 100, y: 50 },
            { dprBase: 1, world, data: world, scale: 0,
                fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } }, grid), null,
            'and a zero scale is not a map');
        eq(Engine.getCellAtPos({ x: 100, y: 50 },
            { dprBase: 1, world, data: world, scale: 4,
                fitBox: { x0: 0, y0: 0, x1: 200, y1: 100 } }, null), null,
            'and no grid is no hit');
    });
});

section('7. BinQuality: the reserved set, aliases, and the diagnosis (LOD-5)', () => {
    /*
     * E142-0225 Table 6 reserves EXACTLY TWO values:
     *   "'Pass' - Indicates a quality that has commercial value
     *    'Fail' - Indicates a quality that does not have commercial value
     *    Other values defined by an application.
     *    If not present then BinQuality is undefined."
     * Everything below follows from that sentence rather than from a guess about
     * what customers write.
     */
    deep([...Engine.BIN_QUALITY_RESERVED], ['pass', 'fail'],
        'the default token set is the standard\'s reserved list, and nothing else');

    attempt('the reserved values resolve, case-insensitively', () => {
        eq(Engine.resolveBinQuality('Pass', null), 'pass', 'Pass');
        eq(Engine.resolveBinQuality('fail', null), 'fail', 'fail');
        eq(Engine.resolveBinQuality('  FAIL  ', null), 'fail', '  FAIL  — trimmed and lowered');
    });

    attempt('an absent or empty token is UNDECLARED, not a defect', () => {
        eq(Engine.resolveBinQuality(null, null), 'undeclared', 'null');
        eq(Engine.resolveBinQuality('', null), 'undeclared', 'empty string — the XSD default');
        eq(Engine.resolveBinQuality('   ', null), 'undeclared', 'whitespace only');
    });

    attempt('an application-defined token is UNMAPPED until aliased', () => {
        eq(Engine.resolveBinQuality('Reject', null), 'unmapped', 'Reject');
        eq(Engine.resolveBinQuality('A', null), 'unmapped',
            'and "A" — which is what the standard\'s own R2-1.6.3 example uses');
        eq(Engine.resolveBinQuality('Reject', { Reject: 'fail' }), 'fail', 'aliased, it resolves');
        eq(Engine.resolveBinQuality('reject', { '  REJECT ': 'FAIL' }), 'fail',
            '  matching both sides case-insensitively and trimmed');
    });

    attempt('an alias onto a third token is refused', () => {
        eq(Engine.resolveBinQuality('Reject', { Reject: 'maybe' }), 'unmapped',
            'aliasing onto anything but pass/fail would invent a severity nothing can render');
    });

    /* Done-when 1 and 2, at the colour rather than at the token. */
    attempt('the alias changes the colour, and nothing else does', () => {
        const grid = Engine.buildGridModel(PLACEMENT, PAYLOAD,
            [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Reject' }]);
        const without = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null);
        const with_ = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), { Reject: 'fail' });

        eq(without.colors[without.groups[2]], '#888888',
            'unaliased, the Reject bin draws in the UNKNOWN colour — exactly as before this task');
        eq(with_.colors[with_.groups[2]], '#aa0000', 'aliased, it draws in binFail');
        eq(without.colors[without.groups[1]], with_.colors[with_.groups[1]],
            'and the Pass bin is untouched either way');
    });

    /* Rule 4: a document using only the reserved values must behave exactly as it
     * did before this task, including when no aliases argument is passed at all. */
    attempt('Rule 4 — the reserved values need no aliases argument', () => {
        const grid = Engine.buildGridModel(PLACEMENT, PAYLOAD, BIN_DEFS);
        deep(Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4)).colors,
            ['', '#00aa00', '#aa0000'],
            'called with the old four-argument form, pass and fail resolve as they always did');
    });

    attempt('StatusColorMapping still outranks the quality', () => {
        const grid = Engine.buildGridModel(PLACEMENT, PAYLOAD,
            [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Reject' }]);
        const paint = Engine.buildGridPaint(grid, { '9': '#0000ff' }, COLORS,
            makeContext2D(4, 4), { Reject: 'pass' });
        eq(paint.colors[paint.groups[2]], '#0000ff',
            'an explicit colour wins over an alias, as it wins over a quality');
    });
});

section('8. the severity ladder (LOD-6)', () => {
    /** @param code Bin code. @param quality BinQuality. @param pick Pick. @returns An entry. */
    const bin = (code, quality, pick = false) => ({ code, quality, pick });

    deep([Engine.SEVERITY_NULL, Engine.SEVERITY_PASS, Engine.SEVERITY_UNKNOWN, Engine.SEVERITY_FAIL],
        [0, 1, 2, 3], 'the scale is nullBin < pass < unknown < fail');

    /* Done-when 1. The important one: silence is not consent. */
    attempt('a bin with no definitions at all ranks UNKNOWN, not pass', () => {
        eq(Engine.binSeverity(bin('7', null)), Engine.SEVERITY_UNKNOWN,
            'no BinQuality and no Pick — nobody said this was good, so it is not reported as good');
        ok(Engine.SEVERITY_UNKNOWN > Engine.SEVERITY_PASS,
            '  and unknown sits ABOVE pass, so under "worst wins" an unclassified die survives '
            + 'aggregation rather than being hidden by its passing neighbours');
    });

    attempt('the reserved qualities rank as themselves', () => {
        eq(Engine.binSeverity(bin('1', 'Pass')), Engine.SEVERITY_PASS, 'Pass');
        eq(Engine.binSeverity(bin('9', 'Fail')), Engine.SEVERITY_FAIL, 'Fail');
        eq(Engine.binSeverity(bin('', '')), Engine.SEVERITY_UNKNOWN, 'an empty quality is undeclared');
    });

    attempt('an application-defined token ranks unknown until aliased', () => {
        eq(Engine.binSeverity(bin('R', 'Reject')), Engine.SEVERITY_UNKNOWN,
            'Reject is legal E142 and unreadable here, so it is unknown — not pass');
        eq(Engine.binSeverity(bin('R', 'Reject'), null, { Reject: 'fail' }), Engine.SEVERITY_FAIL,
            '  and the alias makes it a fail, matching what LOD-5 paints');
    });

    /*
     * Done-when 2, and the deviation. `Pick="false"` does NOT outrank
     * `BinQuality="Pass"`, and DEV-015 records why with the evidence. `Pick="true"`
     * is the direction that carries information.
     */
    attempt('Pick enters the ladder in the direction that carries information', () => {
        eq(Engine.binSeverity(bin('7', null, true)), Engine.SEVERITY_PASS,
            'Pick="true" on an unclassified bin means "should be processed" — evidence of value');
        eq(Engine.binSeverity(bin('9', 'Fail', true)), Engine.SEVERITY_FAIL,
            'but it never lowers a declared Fail: a failing device picked for rework still failed');
        eq(Engine.binSeverity(bin('1', 'Pass', false)), Engine.SEVERITY_PASS,
            'and Pick="false" does NOT outrank Pass — it is the XSD default, carried by 65 of the '
            + '73 BinDefinitions in the corpus without anyone typing it (DEV-015)');
    });

    attempt('a declared priority list wins outright, in order', () => {
        /* Non-pass qualities: a listed code the document calls `pass` is floored,
         * which the next block covers. */
        const pri = ['Scrap', 'Chip'];
        const scrap = Engine.binSeverity(bin('Scrap', 'Fail'), pri);
        const chip = Engine.binSeverity(bin('Chip', null), pri);
        ok(scrap > chip, 'the first entry is the most severe');
        ok(chip > Engine.SEVERITY_FAIL,
            '  and every listed code outranks an unlisted Fail — listing a code says it wins');
        eq(Engine.binSeverity(bin('Other', 'Fail'), pri), Engine.SEVERITY_FAIL,
            'an unlisted code falls through to the rest of the ladder');
        eq(Engine.binSeverity(bin('Scrap', null), pri),
            Engine.binSeverity(bin('Scrap', 'Fail'), pri),
            'and a listed code ignores its own BinQuality — except for pass, below');
    });

    /*
     * THE FLOOR. The list is most-severe-first, so an author writing out a whole
     * vocabulary — ["P", "F", "S"], meaning "here is my ordering" rather than "here
     * is what wins" — would put their PASSING code at the top of the scale. Under
     * "worst wins" a tile holding one passing and one failing die then reduces to
     * the passing bin and the failure disappears: the exact defect this feature
     * exists to prevent, reintroduced by a view setting.
     */
    attempt('the priority list cannot promote a bin the document calls pass', () => {
        const pri = ['P', 'F', 'S'];
        const p = Engine.binSeverity(bin('P', 'Pass'), pri);
        const f = Engine.binSeverity(bin('F', 'Fail'), pri);
        const u = Engine.binSeverity(bin('S', null), pri);

        eq(p, Engine.SEVERITY_PASS,
            'a listed code whose BinQuality resolves to pass keeps its pass rank');
        ok(f > p, '  so the failing bin still outranks it');
        ok(u > p, '  and so does the unclassified one');
        eq(Math.max(p, f), f,
            'a tile holding one passing and one failing die reduces to the FAILING bin — '
            + 'which it did not before the floor existed');
    });

    attempt('an alias can move a code across the floor', () => {
        const pri = ['R'];
        eq(Engine.binSeverity(bin('R', 'Reject'), pri), Engine.SEVERITY_FAIL + 1,
            'unaliased, Reject is not pass, so the list promotes it');
        eq(Engine.binSeverity(bin('R', 'Reject'), pri, { Reject: 'pass' }), Engine.SEVERITY_PASS,
            'aliased ONTO pass, the same code is no longer promoted — the floor follows the '
            + 'resolved quality, not the raw token');
    });

    attempt('binSeverityTable pins the null bin at index 0', () => {
        const grid = Engine.buildGridModel(PLACEMENT, PAYLOAD,
            [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Fail' }]);
        const t = Engine.binSeverityTable(grid.binTable);
        eq(t.length, grid.binTable.length, 'one rank per bin');
        eq(t[0], Engine.SEVERITY_NULL,
            'index 0 is the null bin by invariant and is never painted, whatever it declares');
        eq(t[1], Engine.SEVERITY_PASS, 'pass');
        eq(t[2], Engine.SEVERITY_FAIL, 'fail');
    });

    /* Done-when 3. Ranks must not depend on anything that varies between parses —
     * insertion order, object identity, a Map's iteration. */
    attempt('ranks are stable across two parses of the same document', () => {
        const defs = [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Reject' },
            { code: '7', quality: null, pick: true }];
        const aliases = { Reject: 'fail' };
        const a = Engine.binSeverityTable(
            Engine.buildGridModel(PLACEMENT, PAYLOAD, defs).binTable, ['7'], aliases);
        const b = Engine.binSeverityTable(
            Engine.buildGridModel(PLACEMENT, PAYLOAD, defs).binTable, ['7'], aliases);
        deep([...a], [...b], 'two independent builds of the same document give identical ranks');
        ok(a.length > 1, '  and there is something to compare');
    });
});

section('9. the aggregation factor, read from the matrix (LOD-8)', () => {
    /**
     * A device chain for a square control fitting a 100x100 mm extent.
     * @param px     Control side in CSS px.
     * @param margin Margin in px; 0 isolates the scaling from the fixed border.
     * @returns The device matrix.
     */
    const devFor = (px, margin = 0) => {
        const cfg = { center: { x: px / 2, y: px / 2 }, width: px, height: px, margin };
        return Engine.deviceMatrix(1, Engine.makeWorldMatrix(cfg, Engine.computeScale(cfg, 100, 100), 0));
    };

    /*
     * Done-when 1. Asserted at MARGIN 0, because `MARGIN_PX` is a fixed 8 px on
     * each side: doubling a 300 px control takes the usable width from 284 to 584,
     * a ratio of 2.056 rather than 2. The claim is about the scaling, so the margin
     * is removed rather than the claim weakened — and the margin case is asserted
     * separately below, against the ratio it actually produces.
     */
    attempt('doubling the control halves the LINEAR factor', () => {
        const small = Engine.aggregationFactorLinear(devFor(300), PLACEMENT);
        const large = Engine.aggregationFactorLinear(devFor(600), PLACEMENT);
        ok(Math.abs(small / large - 2) < 1e-12,
            `a control twice as wide fits twice as many pixels per cell: ${small} -> ${large}`);
        eq(large, small / 2, '  exactly half, not approximately');
    });

    attempt('and quarters the AREA factor, because a pixel is two-dimensional', () => {
        const small = Engine.aggregationFactor(devFor(300), PLACEMENT);
        const large = Engine.aggregationFactor(devFor(600), PLACEMENT);
        ok(Math.abs(small / large - 4) < 1e-12,
            'cells per pixel is a count over an area, so it falls with the square');
        ok(Math.abs(Engine.aggregationFactorLinear(devFor(300), PLACEMENT) ** 2 - small) < 1e-12,
            '  and the linear form is its square root — quoting one where the other is meant '
            + 'misstates the minification by its own square root');
    });

    /*
     * Done-when 2. THE POINT OF THE WHOLE TASK: the factor comes from the composed
     * matrix, so a view transform post-multiplied onto the world matrix is
     * indistinguishable from having made the control bigger. A factor derived from
     * control width over column count would see none of it.
     */
    attempt('the Phase 4 seam works before the seam exists', () => {
        const cfg = { center: { x: 150, y: 150 }, width: 300, height: 300, margin: 0 };
        const world = Engine.makeWorldMatrix(cfg, Engine.computeScale(cfg, 100, 100), 0);
        const zoomed = Engine.deviceMatrix(1, world.multiply(new DOMMatrix([2, 0, 0, 2, 0, 0])));

        eq(Engine.aggregationFactorLinear(zoomed, PLACEMENT),
            Engine.aggregationFactorLinear(devFor(600), PLACEMENT),
            'a 2x view transform on a 300 px control gives exactly the 600 px control\'s factor');
        eq(Engine.aggregationFactor(zoomed, PLACEMENT),
            Engine.aggregationFactor(devFor(600), PLACEMENT), '  in the area form too');
    });

    attempt('the fixed margin is why Done-when 1 is asserted at margin 0', () => {
        /* 300 px, 8 px each side -> 284 usable; 600 -> 584. 584/284 = 2.0563…, so
         * the factor ratio is 1/2.0563 and not 1/2. The claim is about scaling, and
         * this pins the difference rather than hiding it. */
        const small = Engine.aggregationFactorLinear(devFor(300, 8), PLACEMENT);
        const large = Engine.aggregationFactorLinear(devFor(600, 8), PLACEMENT);
        const expected = (300 - 16) / (600 - 16);
        ok(Math.abs(large / small - expected) < 1e-12,
            `with the real 8 px margin the ratio is ${expected.toFixed(6)}, not 0.5`);
    });

    attempt('it reads the PITCH, not the drawn extent', () => {
        /* Streets between cells do not change how many cells land in a pixel. */
        const dev = devFor(600);
        const streets = { ...PLACEMENT, cellWmm: 0.4, cellLmm: 0.4 };
        eq(Engine.aggregationFactor(dev, streets), Engine.aggregationFactor(dev, PLACEMENT),
            'halving the drawn cell extent changes nothing — that is renderGridLayer\'s question, '
            + 'not this one');
        const coarser = { ...PLACEMENT, colStepXmm: 2, rowStepYmm: 2 };
        ok(Engine.aggregationFactor(dev, coarser) < Engine.aggregationFactor(dev, PLACEMENT),
            '  while doubling the PITCH does: fewer, larger cells per pixel');
    });

    attempt('a degenerate lattice reports Infinity, not zero', () => {
        const dev = devFor(600);
        eq(Engine.aggregationFactor(dev, { ...PLACEMENT, rowStepXmm: 1, rowStepYmm: 0 }), Infinity,
            'collinear steps have no area, so every cell shares one pixel');
        eq(Engine.aggregationFactor(dev, { ...PLACEMENT, colStepXmm: 0, colStepYmm: 0 }), Infinity,
            'and so does a zero step');
        ok(Engine.aggregationFactor(dev, PLACEMENT) < Infinity,
            '  where 0 would have read as "no aggregation" and been exactly backwards');
    });

    attempt('rotation does not change it', () => {
        /* A rotation has determinant 1, so it moves cells without changing how many
         * fall in a pixel — which is what the reader expects and what a
         * size-derived factor would get wrong the moment the map turned. */
        const cfg = { center: { x: 300, y: 300 }, width: 600, height: 600, margin: 0 };
        const scale = Engine.computeScale(cfg, 100, 100);
        const upright = Engine.deviceMatrix(1, Engine.makeWorldMatrix(cfg, scale, 0));
        const turned = Engine.deviceMatrix(1, Engine.makeWorldMatrix(cfg, scale, Math.PI / 4));
        ok(Math.abs(Engine.aggregationFactor(upright, PLACEMENT)
            - Engine.aggregationFactor(turned, PLACEMENT)) < 1e-12,
            'a 45 degree map rotation leaves the factor alone');
    });
});

section('10. the aggregate render (LOD-16)', () => {
    const grid = makeGrid();
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
    ok(paint.aggregate !== null, 'the aggregate palette builds from the fixture theme');

    /** @param scale Device px per cell. @param reducer Which reduction. @returns The ctx. */
    const render = (scale, reducer = 'MaxSeverity', p = paint) => {
        const ctx = makeContext2D(64, 48);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([scale, 0, 0, scale, 0, 0]),
            p, 64, 48, true, reducer);
        return ctx;
    };

    /*
     * Done-when 2, at the engine. ABOVE the threshold nothing changed: cells are
     * at least three device pixels, the runs path draws them individually, and the
     * whole of Task 16 must be invisible there. Section 4 already pins the switch;
     * this pins that the aggregate branch did not steal the other side of it.
     */
    attempt('above the threshold nothing changed', () => {
        const withAgg = render(8);
        const bare = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
        const without = makeContext2D(64, 48);
        Engine.renderGridLayer(without, grid, new DOMMatrix([8, 0, 0, 8, 0, 0]),
            bare, 64, 48, true, 'MaxSeverity');
        eq(withAgg.puts.length, 0, 'the runs path still draws, and does not blit');
        deep(withAgg.fills.map((f) => f.fillStyle), without.fills.map((f) => f.fillStyle),
            'and paints exactly what it painted before an aggregate palette existed');
    });

    attempt('below the threshold the bucket pass takes over', () => {
        const ctx = render(1);
        ok(ctx.puts.length > 0, 'it blits');
        eq(ctx.fills.length, 0, '  and records no fills');
        ok(ctx.pixels.some((b) => b !== 0), '  and wrote real pixels');
    });

    attempt('the null bin is still left transparent', () => {
        /* CELLS row 0 is [0,1,1,1]: cell (0,0) is off-substrate. At one cell per
         * pixel its bucket receives nothing, and a bucket with no substrate must not
         * be painted — `total`, never the accumulator, decides. */
        const ctx = render(1);
        deep(pixelAt(ctx, 0, 0), [0, 0, 0, 0], 'no substrate under it, so nothing painted');
        ok(pixelAt(ctx, 1, 0)[3] === 255, '  while its neighbour is opaque');
    });

    attempt('the two reducers paint differently, and both from the aggregate band', () => {
        /*
         * At ONE cell per pixel every bucket holds exactly one cell, and the two
         * reducers agree by construction: a fraction of 0 or 1 lands on the ramp's
         * ends, which ARE the pass and fail swatches. The fixture has to put more
         * than one cell in a bucket for the difference to exist at all — the eighth
         * time a collapsing fixture has hidden a distinction (observation 107).
         */
        const max = render(0.5, 'MaxSeverity');
        const frac = render(0.5, 'FailFraction');
        const words = (c) => [...new Uint32Array(c.pixels.buffer)].filter((w) => w !== 0);
        ok(words(max).length > 0 && words(frac).length > 0, 'both paint something');
        ok(words(max).join() !== words(frac).join(),
            'and they disagree — a bucket of one fail among three passes is rank FAIL to one '
            + 'and a quarter to the other');
        const bandFail = paint.aggregate.bySeverity[Engine.SEVERITY_FAIL];
        ok(words(max).includes(bandFail),
            '  MaxSeverity uses the aggregate fail swatch, not the bin fail colour');
    });

    /*
     * Done-when 3. The cache key must separate two renders that differ only in the
     * reducer, or a cached MaxSeverity bitmap gets served to a FailFraction render
     * and the bug looks like the reducer not working.
     */
    attempt('the cache key covers the reducer, the priority list and the gamma', () => {
        const dev = new DOMMatrix([1, 0, 0, 1, 0, 0]);
        const keys = new Set();
        for (const reducer of ['MaxSeverity', 'FailFraction']) {
            keys.add(Engine.gridCacheKeyForTest(dev, 64, 48, 1, paint, reducer));
        }
        eq(keys.size, 2, 'two reducers give two keys');

        const withPri = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8), null, ['9']);
        const withGamma = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8), null, null, 0.7);
        ok(paint.signature !== withPri.signature,
            'a priority list changes the paint signature, and so the key');
        ok(paint.signature !== withGamma.signature, '  and so does the gamma');
    });

    /*
     * THE SCATTER BOX USES THE PITCH, not the drawn extent. `gridDeviceBox` is
     * asked for half-extents of 0.5 — the full cell — because a cell contributes
     * to a bucket whether or not its drawn rectangle is inset by streets. A box
     * sized from `cellWmm` would clip the outermost cells out of the scatter
     * entirely, and the map would lose its edge.
     */
    attempt('every non-null cell reaches a bucket', () => {
        const ctx = render(1);
        const words = new Uint32Array(ctx.pixels.buffer);
        const painted = [...words].filter((w) => w !== 0).length;
        const nonNull = [...CELLS].filter((c) => c !== 0).length;
        eq(painted, nonNull,
            `every one of the ${nonNull} non-null cells paints a pixel — the scatter box is sized `
            + 'from the PITCH, so a cell is never clipped out for sitting in a street');
    });

    /*
     * A PRIORITY RANK MUST NOT INDEX PAST THE SWATCH TABLE. `BinSeverityPriority`
     * invents ranks above `SEVERITY_FAIL`, and `bySeverity` has four entries — so
     * an unclamped index reads `undefined`, which a Uint32Array stores as 0, which
     * is transparent. The worst bin in the map would vanish.
     */
    /*
     * THE BAND BETWEEN 1 AND 3 PIXELS PER CELL KEEPS THE GATHER, and this is a
     * defect the mutation testing found rather than a design choice made up front.
     * The scatter paints one pixel per CELL: where a cell is larger than a pixel it
     * leaves the rest of that cell blank, so at 2.9 px/cell it painted 11 pixels
     * for 11 cells instead of filling them. The gather is exact in that band —
     * every pixel maps to a cell and no cell can be lost, because cells are the
     * bigger thing — so aggregation is reserved for cells SMALLER than a pixel,
     * which is the problem it exists to solve.
     */
    attempt('between 1 and 3 px per cell the gather still runs', () => {
        const ctx = render(2.9);
        ok(ctx.puts.length > 0, 'it still blits — this is the ImageData path, not runs');
        const painted = [...new Uint32Array(ctx.pixels.buffer)].filter((w) => w !== 0).length;
        const nonNull = [...CELLS].filter((c) => c !== 0).length;
        ok(painted > nonNull * 5,
            `and it FILLS the cells: ${painted} pixels for ${nonNull} cells at 2.9 px each — `
            + 'the scatter would have painted one pixel each and left the rest blank');
    });

    attempt('a bin promoted by the priority list still paints', () => {
        const g = Engine.buildGridModel(PLACEMENT, PAYLOAD,
            [{ code: '1', quality: 'Pass' }, { code: '9', quality: null }]);
        const p = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8), null, ['9']);
        p.aggregate = Agg.buildAggregatePaint(g, COLORS, ['9']);
        const promoted = Engine.binSeverity(g.binTable[2], ['9']);
        ok(promoted > Engine.SEVERITY_FAIL, `the listed bin ranks ${promoted}, above fail`);

        /* Half a pixel per cell, so the scatter is in charge: at one pixel per cell
         * the gather still runs and paints bin colours. */
        const ctx = makeContext2D(64, 48);
        Engine.renderGridLayer(ctx, g, new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), p, 64, 48, true, 'MaxSeverity');
        const words = new Uint32Array(ctx.pixels.buffer);
        ok([...words].includes(p.aggregate.bySeverity[Engine.SEVERITY_FAIL]),
            'and it paints the fail swatch rather than reading past the table into transparency');
    });

    /*
     * THE NULL BIN IS IN NEITHER NUMERATOR NOR DENOMINATOR, and only FailFraction
     * can show it: `max` is unchanged by extra zero-valued cells, so a scatter that
     * counted null cells would look identical under MaxSeverity and wrong only
     * here. The bucket below holds one null, one fail and two passes.
     */
    attempt('null cells stay out of the FailFraction denominator', () => {
        /* And the bucket WITH a null: [0,1 / 1,1] is 0 fails over THREE non-null
         * cells, not four. Both give ramp[0], so the discriminating case is a
         * bucket that has both a null and a fail — built explicitly. */
        const cells = new Uint32Array([0, 2, 1, 1]);
        const g = Engine.buildGridModel(PLACEMENT, { cols: 2, rows: 2, cells, codes: PAYLOAD.codes }, BIN_DEFS);
        const p = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8));
        p.aggregate = Agg.buildAggregatePaint(g, COLORS);
        const c2 = makeContext2D(8, 8);
        Engine.renderGridLayer(c2, g, new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), p, 8, 8, true, 'FailFraction');
        const w2 = new Uint32Array(c2.pixels.buffer);
        /* The ramp is indexed by the RAW fraction: gamma is baked into the entries
         * once per frame, so the pixel loop does no transfer at all. Applying it
         * again here was wrong by a step and a half. */
        const step = (f) => p.aggregate.ramp[Math.round(f * (Engine.AGGREGATE_RAMP_STEPS - 1))];
        const overThree = step(1 / 3);
        const overFour = step(1 / 4);
        ok(overThree !== overFour, 'one fail in three differs from one in four');
        eq(w2[0], overThree,
            'and the bucket reads 1/3 — the null cell is in neither numerator nor denominator');
    });

    attempt('a paint with no aggregate palette falls back rather than failing', () => {
        const bad = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
        bad.aggregate = Agg.buildAggregatePaint(grid, { ...COLORS, binFail: 'chartreuse' });
        eq(bad.aggregate, null, 'an unparsable theme colour disables the aggregate palette');
        const ctx = makeContext2D(64, 48);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([1, 0, 0, 1, 0, 0]), bad, 64, 48, true);
        ok(ctx.puts.length > 0 || ctx.fills.length > 0,
            'and the render still produces something — point sampling, which is worse but not nothing');
    });
});

section('11. the saturation-fed reducer choice (LOD-17)', () => {
    /* Section 10's fixture and paint, re-made here so the two sections are
     * independent — `render` there is scoped to its own section. */
    const grid17 = makeGrid();
    const paint17 = Engine.buildGridPaint(grid17, null, COLORS, makeContext2D(8, 8));
    paint17.aggregate = Agg.buildAggregatePaint(grid17, COLORS);
    /** @param scale Device px per cell. @param reducer Which. @returns The saturation. */
    const render = (scale, reducer = 'MaxSeverity') => Engine.renderGridLayer(
        makeContext2D(64, 48), grid17, new DOMMatrix([scale, 0, 0, scale, 0, 0]),
        paint17, 64, 48, true, reducer);

    deep([Engine.SATURATION_SWITCH_DOWN, Engine.SATURATION_SWITCH_UP], [0.4, 0.6],
        'two thresholds, not one');

    /*
     * Done-when 1, and the whole reason the rule is not factor-based. Both maps
     * below are rendered at the SAME factor. A factor rule reads one number and
     * must give them the same answer; measured saturation tells them apart.
     */
    attempt('at one factor, a sparse map and a saturated map choose differently', () => {
        /** @param p Fail probability. @returns The measured saturation. */
        const saturationOf = (p) => {
            const n = 48;
            const cells = new Uint32Array(n * n).fill(1);
            let seed = 7;
            const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
            for (let i = 0; i < cells.length; i++) { if (rnd() < p) { cells[i] = 2; } }
            const g = Engine.buildGridModel(PLACEMENT,
                { cols: n, rows: n, cells, codes: PAYLOAD.codes }, BIN_DEFS);
            const pt = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8));
            pt.aggregate = Agg.buildAggregatePaint(g, COLORS);
            const side = 8;                              // 6x6 cells per bucket, both maps
            const ctx = makeContext2D(side, side);
            return Engine.renderGridLayer(ctx, g, new DOMMatrix([side / n, 0, 0, side / n, 0, 0]),
                pt, side, side, true, 'MaxSeverity');
        };

        const sparse = saturationOf(0.0005);
        const busy = saturationOf(0.25);
        ok(sparse !== null && busy !== null, 'both frames measured something');
        ok(sparse < Engine.SATURATION_SWITCH_DOWN,
            `a sparse map saturates at ${sparse.toFixed(3)} — worst-wins still says something`);
        ok(busy > Engine.SATURATION_SWITCH_UP,
            `a busy map saturates at ${busy.toFixed(3)} — worst-wins has stopped saying anything`);
        eq(Engine.selectReducer('MaxSeverity', sparse), 'MaxSeverity', 'so the sparse map keeps it');
        eq(Engine.selectReducer('MaxSeverity', busy), 'FailFraction', '  and the busy map switches');
    });

    /* Done-when 3: hysteresis, from both directions. */
    attempt('a saturation between the thresholds leaves the reducer alone', () => {
        for (const sat of [0.41, 0.5, 0.59]) {
            eq(Engine.selectReducer('MaxSeverity', sat), 'MaxSeverity',
                `at ${sat} a MaxSeverity view stays`);
            eq(Engine.selectReducer('FailFraction', sat), 'FailFraction',
                `  and a FailFraction view stays`);
        }
        eq(Engine.selectReducer('FailFraction', 0.4), 'MaxSeverity', 'at the lower bound it switches back');
        eq(Engine.selectReducer('MaxSeverity', 0.6), 'FailFraction', 'and at the upper bound it switches up');
    });

    /* Done-when 4. */
    attempt('an explicit value wins in both directions', () => {
        /* `previous` must DIFFER from the override, or returning `previous` and
         * returning `override` are the same answer and the assertion tests
         * nothing — which is how the first version of this passed a mutation that
         * ignored the override entirely (observation 107's list, ninth entry). */
        eq(Engine.selectReducer('FailFraction', 0.0, 'MaxSeverity'), 'MaxSeverity',
            'a forced MaxSeverity wins over an empty frame AND over the previous choice');
        eq(Engine.selectReducer('MaxSeverity', 0.99, 'FailFraction'), 'FailFraction',
            'and a forced FailFraction wins over a saturated frame and the previous choice');
        eq(Engine.selectReducer('MaxSeverity', 0.99, 'MaxSeverity'), 'MaxSeverity',
            '  while a forced value that agrees with the previous one still holds');
        eq(Engine.selectReducer('MaxSeverity', 0.99, 'Auto'), 'FailFraction',
            "while 'Auto' applies the rule");
    });

    attempt('nothing measured leaves the previous choice standing', () => {
        eq(Engine.selectReducer('FailFraction', null), 'FailFraction',
            'a frame that did not bucket changes nothing — a cache hit re-renders nothing, so '
            + 'nothing about the picture changed either');
        eq(Engine.selectReducer('MaxSeverity', NaN), 'MaxSeverity', 'and NaN is not a measurement');
    });

    /*
     * Done-when 5, structurally. The measurement must be a pass over BUCKETS, not
     * over cells, or it is not free — a third per-cell accumulator measured 22 %
     * against 1.4 % for this. Asserted by showing the render returns it at all:
     * only the branch that already accumulated the predicate can, and the other
     * two return null rather than computing anything.
     */
    attempt('only the bucketing branch measures, the others return null', () => {
        eq(render(8), null, 'the runs path measures nothing');
        eq(render(2), null, 'the gather measures nothing — it has no buckets to count');
        ok(render(0.5) !== null, 'and only the bucket pass reports a saturation');
    });

    attempt('both reducers measure the same saturation', () => {
        /* `max >= FAIL` and `failCount > 0` are the same predicate reached two ways,
         * which is what makes the measurement free whichever reducer is running. */
        const a = render(0.5, 'MaxSeverity');
        const b = render(0.5, 'FailFraction');
        ok(Math.abs(a - b) < 1e-12,
            `MaxSeverity measured ${a} and FailFraction measured ${b} — the same predicate`);
    });
});

section('12. decoration presence under aggregation (LOD-18)', () => {
    /*
     * `renderGridDecorations` draws from `DECORATION_MIN_PX = 6`. Under aggregation
     * a cell is subpixel, so the corner wedges stop entirely and a map with three
     * overlays looks like a map with one — the same class of silent loss as the
     * point sampling this phase removed. The aggregate cannot draw the wedges;
     * there is no room. It can say they are there.
     */
    /** @param decorate Cell indices to decorate, or null. @returns The model. */
    const modelWith = (decorate) => {
        const payload = { cols: 8, rows: 8, cells: new Uint32Array(64).fill(1), codes: PAYLOAD.codes };
        if (decorate === null) { return Engine.buildGridModel(PLACEMENT, payload, BIN_DEFS); }
        const lc = new Uint32Array(64);
        for (const i of decorate) { lc[i] = 1; }
        return Engine.buildGridModel(PLACEMENT, payload, BIN_DEFS, [{
            mapName: 'L', mapVersion: '1', cells: lc,
            binTable: [{ code: '.', quality: null, pick: false }, { code: 'x', quality: null, pick: false }],
        }]);
    };
    /** @param g A model. @returns The packed words of a 4x4 aggregated render. */
    const wordsOf = (g) => {
        const p = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8));
        p.aggregate = Agg.buildAggregatePaint(g, COLORS);
        const ctx = makeContext2D(4, 4);
        Engine.renderGridLayer(ctx, g, new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), p, 4, 4, true, 'MaxSeverity');
        return [...new Uint32Array(ctx.pixels.buffer)];
    };

    attempt('the mask costs nothing on an undecorated map', () => {
        eq(modelWith(null).decorated, undefined,
            'no layers, no mask — not an allocation and not a branch in the inner loop');
        ok(modelWith([0]).decorated instanceof Uint8Array, 'and one appears as soon as a layer does');
    });

    attempt('the mask is built from the layers, in the pass that already validates them', () => {
        const g = modelWith([2, 8]);
        eq([...g.decorated].join(''), '001000001'.padEnd(64, '0'),
            'one byte per cell, non-zero where any layer names it');
    });

    /* Done-when 1 and 2: differs, and asserted by pixel. */
    attempt('an aggregated decorated fixture differs from the same fixture undecorated', () => {
        const plain = wordsOf(modelWith(null));
        const deco = wordsOf(modelWith([0, 9]));           // both fall in bucket (0,0)
        ok(plain.join() !== deco.join(), 'the two renders differ');
        ok(plain[0] !== deco[0], '  in the bucket that holds the decorated cells');
        eq(plain[5], deco[5], '  and NOWHERE else — an undecorated bucket is untouched');
    });

    attempt('the mark is alpha alone, so it cannot collide with any bin colour', () => {
        const plain = wordsOf(modelWith(null));
        const deco = wordsOf(modelWith([0]));
        eq((plain[0] & 0xffffff) >>> 0, (deco[0] & 0xffffff) >>> 0,
            'the RGB is identical — severity still reads exactly as it did');
        eq(deco[0] >>> 24, Engine.DECORATED_ALPHA,
            `only the alpha moves, to ${Engine.DECORATED_ALPHA}`);
        eq(plain[0] >>> 24, 255, '  from fully opaque');
    });

    attempt('one decorated cell marks the whole bucket', () => {
        /* A bucket holds four cells here. Marking any one of them marks the tile —
         * the flag is presence, not proportion, which is what "these overlays exist"
         * means. Asserted for each of the four, so it is not one lucky index. */
        const bad = [];
        for (const i of [0, 1, 8, 9]) {
            if (wordsOf(modelWith([i]))[0] >>> 24 !== Engine.DECORATED_ALPHA) { bad.push(i); }
        }
        eq(bad.length, 0, `any cell in the bucket marks it  ${bad[0] ?? ''}`);
    });

    attempt('the mark survives both reducers', () => {
        const g = modelWith([0]);
        const p = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8));
        p.aggregate = Agg.buildAggregatePaint(g, COLORS);
        for (const reducer of ['MaxSeverity', 'FailFraction']) {
            const ctx = makeContext2D(4, 4);
            Engine.renderGridLayer(ctx, g, new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), p, 4, 4, true, reducer);
            eq(new Uint32Array(ctx.pixels.buffer)[0] >>> 24, Engine.DECORATED_ALPHA,
                `${reducer} marks it too — the flag is orthogonal to the reduction`);
        }
    });
});

/** @returns The packed words of a small aggregated render, for a no-change check. */
function wordsOfRender() {
    const g = Engine.buildGridModel(PLACEMENT, PAYLOAD, BIN_DEFS);
    const p = Engine.buildGridPaint(g, null, COLORS, makeContext2D(8, 8));
    p.aggregate = Agg.buildAggregatePaint(g, COLORS);
    const ctx = makeContext2D(4, 4);
    Engine.renderGridLayer(ctx, g, new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), p, 4, 4, true, 'MaxSeverity');
    return [...new Uint32Array(ctx.pixels.buffer)];
}

section('13. touch targets and group size (LOD-19)', () => {
    eq(Engine.TOUCH_TARGET_MIN_PX, 24, "the floor is WCAG 2.2 SC 2.5.8's Target Size (Minimum)");
    eq(Engine.TOUCH_TARGET_DEFAULT_PX, 40, 'and the default sits between it and the 44-48 guidelines');

    /* Done-when 1. */
    attempt('a cell wider than the target is its own group', () => {
        eq(Engine.groupSizeInCells(40, 60, 1), 1,
            '60 device px per cell at dpr 1 needs no grouping — a die already bigger than a finger');
        eq(Engine.groupSizeInCells(40, 41, 1), 1, 'and so does one a pixel over');
        eq(Engine.groupSizeInCells(40, 39, 1), 2, 'while one just under needs two');
    });

    /*
     * THE UNIT ERROR THE TASK'S FORMULA WOULD HAVE SHIPPED. `ceil(target /
     * cellDevicePx)` divides CSS pixels by device pixels, which agree only at
     * dpr 1. At dpr 3 it returns 1 for a 60-device-pixel cell — a 20 CSS px target,
     * BELOW the 24 floor the same task sets (DEV-018).
     */
    attempt('the device pixel ratio is converted, not ignored', () => {
        eq(Engine.groupSizeInCells(40, 60, 1), 1, 'at dpr 1 a 60 px cell is 60 CSS px: one cell');
        eq(Engine.groupSizeInCells(40, 60, 2), 2, 'at dpr 2 it is 30 CSS px, so two are needed');
        eq(Engine.groupSizeInCells(40, 60, 3), 2, 'and at dpr 3 it is 20 CSS px — two, not one');

        const bad = [];
        for (const dpr of [1, 1.5, 2, 3]) {
            for (const cell of [1, 3, 10, 60, 200]) {
                const n = Engine.groupSizeInCells(40, cell, dpr);
                const effective = (cell / dpr) * n;
                if (effective < Engine.TOUCH_TARGET_MIN_PX) {
                    bad.push(`dpr ${dpr}, cell ${cell} -> ${effective.toFixed(1)} CSS px`);
                }
            }
        }
        eq(bad.length, 0,
            `every group reaches at least the ${Engine.TOUCH_TARGET_MIN_PX} px floor  ${bad[0] ?? ''}`);
    });

    attempt('the floor is applied to the target itself', () => {
        eq(Engine.groupSizeInCells(10, 10, 1), Engine.groupSizeInCells(24, 10, 1),
            'asking for 10 gets the same grouping as asking for 24 — the floor is not negotiable, '
            + 'and the control reports it separately');
    });

    attempt('degenerate inputs give one cell rather than nonsense', () => {
        eq(Engine.groupSizeInCells(40, 0, 1), 1, 'a zero-width cell cannot be divided by');
        eq(Engine.groupSizeInCells(40, -5, 1), 1, 'nor a negative one');
        eq(Engine.groupSizeInCells(40, 10, 0), Engine.groupSizeInCells(40, 10, 1),
            'and a zero dpr falls back to 1 rather than producing Infinity');
        eq(Engine.groupSizeInCells(40, Number.NaN, 1), 1, 'NaN is not a cell size');
        eq(Engine.groupSizeInCells(Number.POSITIVE_INFINITY, 10, 1),
            Engine.groupSizeInCells(Engine.TOUCH_TARGET_MIN_PX, 10, 1),
            'and an infinite TARGET falls back to the floor rather than propagating');
        eq(Engine.groupSizeInCells(Number.NaN, 10, 1),
            Engine.groupSizeInCells(Engine.TOUCH_TARGET_MIN_PX, 10, 1), '  as does NaN');
    });

    attempt('grouping never coarsens the paint', () => {
        /* The claim the task makes twice, asserted where it can be: `groupSizeInCells`
         * is a pure function that nothing in the render path calls. Painting stays at
         * one device pixel per bucket, which sections 10 and 12 pin directly. */
        const before = wordsOfRender();
        Engine.groupSizeInCells(200, 1, 1);
        deep(wordsOfRender(), before,
            'computing a group size changes no pixel — it is a hit-resolution question');
    });
});

section('14. group-to-lattice enumeration (LOD-20)', () => {
    /* A round-ish map, so "outside the outline" is a real case rather than a
     * rectangle with nothing excluded. */
    const N = 20;
    const cells = new Uint32Array(N * N);
    const c0 = (N - 1) / 2;
    for (let r = 0; r < N; r++) {
        for (let col = 0; col < N; col++) {
            if ((col - c0) ** 2 + (r - c0) ** 2 <= (N / 2 - 1) ** 2) { cells[r * N + col] = 1; }
        }
    }
    const grid = Engine.buildGridModel(PLACEMENT,
        { cols: N, rows: N, cells, codes: PAYLOAD.codes }, BIN_DEFS);
    const nonNull = [...cells].filter((c) => c !== 0).length;
    ok(nonNull > 250, `${nonNull} cells on the substrate, ${N * N - nonNull} off it`);

    const cfg = { center: { x: 200, y: 200 }, width: 400, height: 400, margin: Engine.MARGIN_PX };
    /** @param rad Map rotation. @returns The device matrix. */
    const devAt = (rad) => Engine.deviceMatrix(1,
        Engine.makeWorldMatrix(cfg, Engine.computeScale(cfg, N, N), rad));

    /**
     * THE REFERENCE: every cell, projected forward, tested against the rectangle.
     * Deliberately the slow, obvious implementation — it visits the whole map and
     * builds no bounds — so agreement with it means the fast path skipped only
     * cells that could not have qualified.
     * @param rect The group.
     * @param dev  The device matrix.
     * @returns Cell indices.
     */
    const bruteForce = (rect, dev) => {
        const m = dev.multiply(Engine.latticeMatrix(grid.placement));
        const out = [];
        for (let r = 0; r < N; r++) {
            for (let col = 0; col < N; col++) {
                if (cells[r * N + col] === 0) { continue; }
                const cx = col + 0.5;
                const cy = r + 0.5;
                const px = m.a * cx + m.c * cy + m.e;
                const py = m.b * cx + m.d * cy + m.f;
                if (px >= rect.x0 && px < rect.x1 && py >= rect.y0 && py < rect.y1) {
                    out.push(r * N + col);
                }
            }
        }
        return out;
    };

    /* Done-when 1, at 45 degrees and at six other angles — the rotation is the
     * whole reason a (col,row) bounding box is wrong. */
    attempt('the enumeration equals the brute-force set, at every rotation', () => {
        const bad = [];
        let totalFound = 0;
        for (const deg of [0, 30, 45, 90, 135, 180, 217]) {
            const dev = devAt((deg * Math.PI) / 180);
            for (const rect of [{ x0: 40, y0: 40, x1: 120, y1: 120 },
                { x0: 150, y0: 90, x1: 210, y1: 260 },
                { x0: 0, y0: 0, x1: 400, y1: 400 }]) {
                const got = [...Engine.cellsInGroup(rect, grid, dev)];
                const want = bruteForce(rect, dev);
                totalFound += got.length;
                if (got.join() !== want.join()) {
                    bad.push(`${deg} deg, ${JSON.stringify(rect)}: ${got.length} vs ${want.length}`);
                }
            }
        }
        ok(totalFound > 300,
            `${totalFound} cells enumerated across 21 cases — enough that agreement means something`);
        eq(bad.length, 0, `every case matches the reference exactly  ${bad[0] ?? ''}`);
    });

    attempt('and under a mirror, where the lattice flips', () => {
        const mirrored = Engine.buildGridModel({ ...PLACEMENT, colStepXmm: -1, originXmm: N },
            { cols: N, rows: N, cells, codes: PAYLOAD.codes }, BIN_DEFS);
        const dev = devAt(Math.PI / 4);
        const m = dev.multiply(Engine.latticeMatrix(mirrored.placement));
        const rect = { x0: 60, y0: 60, x1: 180, y1: 180 };
        const want = [];
        for (let r = 0; r < N; r++) {
            for (let col = 0; col < N; col++) {
                if (cells[r * N + col] === 0) { continue; }
                const px = m.a * (col + 0.5) + m.c * (r + 0.5) + m.e;
                const py = m.b * (col + 0.5) + m.d * (r + 0.5) + m.f;
                if (px >= rect.x0 && px < rect.x1 && py >= rect.y0 && py < rect.y1) { want.push(r * N + col); }
            }
        }
        deep([...Engine.cellsInGroup(rect, mirrored, dev)], want,
            'a mirrored lattice enumerates the same set as the reference');
        ok(want.length > 0, '  and the case is not vacuously empty');
    });

    /* Done-when 2. */
    attempt('cells outside the outline are excluded', () => {
        const dev = devAt(0);
        const all = { x0: -1e4, y0: -1e4, x1: 1e4, y1: 1e4 };
        const got = Engine.cellsInGroup(all, grid, dev);
        eq(got.length, nonNull,
            'a group covering everything returns every ON-substrate cell and no other');
        const offSubstrate = [...got].filter((i) => cells[i] === 0);
        eq(offSubstrate.length, 0, '  not one null-bin cell among them');
    });

    /* Done-when 3. */
    attempt('adjacent groups partition the grid: no cell in two, none in none', () => {
        for (const deg of [0, 45, 137]) {
            const dev = devAt((deg * Math.PI) / 180);
            const seen = new Map();
            const STEP = 37;                       // a size that divides nothing evenly
            for (let y = -400; y < 800; y += STEP) {
                for (let x = -400; x < 800; x += STEP) {
                    for (const i of Engine.cellsInGroup(
                        { x0: x, y0: y, x1: x + STEP, y1: y + STEP }, grid, dev)) {
                        seen.set(i, (seen.get(i) ?? 0) + 1);
                    }
                }
            }
            const twice = [...seen].filter(([, n]) => n > 1);
            eq(twice.length, 0, `${deg} deg: no cell is in two groups  ${twice[0] ?? ''}`);
            eq(seen.size, nonNull, `  and none is in none — ${seen.size} of ${nonNull}`);
        }
    });

    /*
     * THE HALF-OPEN EDGE, at a boundary a cell centre lands on EXACTLY. The sweep
     * above cannot see this: with STEP 37 and a rotated lattice no centre falls on
     * a group edge, so closed and half-open intervals agree everywhere and a
     * mutation making the test inclusive survives it. Tenth vacuous fixture
     * (observation 107's list).
     */
    attempt('a centre exactly on a shared edge belongs to one group, not two', () => {
        const dev = devAt(0);
        const m = dev.multiply(Engine.latticeMatrix(grid.placement));
        /* Cell (10,10) is on the substrate; put the shared edge exactly through its
         * centre in both axes. */
        const cx = m.a * 10.5 + m.c * 10.5 + m.e;
        const cy = m.b * 10.5 + m.d * 10.5 + m.f;
        const idx = 10 * N + 10;
        ok(cells[idx] !== 0, 'the probe cell is on the substrate');

        const left = [...Engine.cellsInGroup({ x0: cx - 30, y0: cy - 30, x1: cx, y1: cy }, grid, dev)];
        const right = [...Engine.cellsInGroup({ x0: cx, y0: cy, x1: cx + 30, y1: cy + 30 }, grid, dev)];
        const inLeft = left.includes(idx);
        const inRight = right.includes(idx);
        ok(inLeft !== inRight,
            `the cell whose centre is exactly on the shared edge is in exactly one group `
            + `(left ${inLeft}, right ${inRight}) — a closed interval would put it in both`);
        ok(inRight, '  and it is the group whose LOW edge it sits on, since the interval is [x0, x1)');
    });

    attempt('a degenerate lattice or an empty rectangle returns nothing', () => {
        const dev = devAt(0);
        eq(Engine.cellsInGroup({ x0: 10, y0: 10, x1: 10, y1: 200 }, grid, dev).length, 0,
            'a zero-width rectangle contains no centres — half-open, so x0 === x1 is empty');
        /* A collinear lattice is refused by `buildGridModel` itself, so the
         * degenerate case reaches `cellsInGroup` only through a hand-made model —
         * which is the honest way to exercise a guard the builder normally prevents. */
        const flat = { ...grid, placement: { ...PLACEMENT, rowStepXmm: 1, rowStepYmm: 0 } };
        eq(Engine.cellsInGroup({ x0: 0, y0: 0, x1: 400, y1: 400 }, flat, dev).length, 0,
            'collinear steps have no inverse, so nothing is enumerated rather than everything');
    });

    attempt('it does not visit the whole map', () => {
        /* The reason the function exists. A small group on a large grid must scan a
         * bounded neighbourhood, not 400 cells — asserted through the RESULT's
         * relationship to the bounding box rather than by instrumenting the loop. */
        const dev = devAt(45 * Math.PI / 180);
        /* Centred on the MAP, not on the canvas: `makeWorldMatrix` centres the
         * S-frame ORIGIN, which on a round map is a corner and therefore off
         * substrate. The first version of this put its box there and found nothing. */
        const m = dev.multiply(Engine.latticeMatrix(grid.placement));
        const mid = { x: m.a * (N / 2) + m.c * (N / 2) + m.e, y: m.b * (N / 2) + m.d * (N / 2) + m.f };
        const rect = { x0: mid.x - 20, y0: mid.y - 20, x1: mid.x + 20, y1: mid.y + 20 };
        const got = Engine.cellsInGroup(rect, grid, dev);
        ok(got.length > 0 && got.length < N * N / 4,
            `a 40x40 device box holds ${got.length} cells of ${N * N} — a bounding box over `
            + '(col,row) would have handed back far more');
    });
});

section('15. the group descriptor (LOD-21)', () => {
    /*
     * The scenario the task names: a 1.5 M map with more distinct codes than the
     * histogram can name, so truncation is exercised rather than assumed.
     */
    const N = 1224;
    const codes = ['.'];
    for (let i = 1; i <= 40; i++) { codes.push(String(i * 137).padStart(5, '0')); }
    const big = new Uint32Array(N * N);
    let seed = 9;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    const mid = (N - 1) / 2;
    const rad = (N / 2 - 3) ** 2;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if ((x - mid) ** 2 + (y - mid) ** 2 > rad) { continue; }
            big[y * N + x] = 1 + Math.floor(rnd() * 40);
        }
    }
    const bigGrid = Engine.buildGridModel(PLACEMENT,
        { cols: N, rows: N, codes, cells: big },
        codes.slice(1).map((c, i) => ({ code: c, quality: i % 3 === 0 ? 'Fail' : 'Pass' })));
    const unit = new DOMMatrix([1, 0, 0, 1, 0, 0]);
    const groupRect = { x0: 500, y0: 500, x1: 614, y1: 614 };     // 114 x 114
    const d = Engine.describeGroup(groupRect, bigGrid, unit);

    /* Done-when 1. */
    attempt('a 12 900-cell group serialises under 2 KB', () => {
        ok(d.cellCount > 12000, `the group really holds ${d.cellCount} cells`);
        const bytes = JSON.stringify(d).length;
        ok(bytes < 2048, `it serialises to ${bytes} bytes, under the 2048 budget`);
        /* The number that makes the budget worth having. */
        ok(d.cellCount * 120 > 1024 * 1024,
            `a ten-field entry per cell would be roughly `
            + `${Math.round(d.cellCount * 120 / 1024)} KB — three orders of magnitude more`);
    });

    /* Done-when 2, and the invariant a truncated histogram lives or dies by. */
    attempt('the remainder plus the named entries equals the cell count exactly', () => {
        const named = d.bins.reduce((a, b) => a + b.count, 0);
        eq(named + d.otherCount, d.cellCount,
            `${named} named + ${d.otherCount} other === ${d.cellCount} cells`);
        eq(d.bins.length, Engine.GROUP_HISTOGRAM_MAX, 'the histogram is truncated at the cap');
        ok(d.otherBins > 0, `and ${d.otherBins} bins fell into the remainder`);
        eq(d.bins.length + d.otherBins, 40, '  which together are every bin the group holds');
    });

    attempt('the histogram is ordered, and the order is stable', () => {
        const bad = [];
        for (let i = 1; i < d.bins.length; i++) {
            if (d.bins[i].count > d.bins[i - 1].count) { bad.push(i); }
        }
        eq(bad.length, 0, 'descending by count');
        deep(Engine.describeGroup(groupRect, bigGrid, unit).bins.map((b) => b.code),
            d.bins.map((b) => b.code),
            'and the same group describes identically twice — ties break by code, so a descriptor '
            + 'that reordered itself between taps cannot look like a change');
    });

    attempt('the corners are LATTICE coordinates, not device ones', () => {
        eq(d.corners.length, 4, 'four corners');
        /* At one device pixel per cell with an identity matrix the two spaces agree
         * numerically, so the discriminating case is a scaled matrix. */
        const scaled = Engine.describeGroup(groupRect, bigGrid, new DOMMatrix([2, 0, 0, 2, 0, 0]));
        ok(Math.abs(scaled.corners[0][0] - d.corners[0][0]) > 1,
            'doubling the device scale halves the lattice extent the same rectangle covers: '
            + `${d.corners[0][0]} -> ${scaled.corners[0][0]}`);
        ok(scaled.cellCount < d.cellCount, '  and it covers fewer cells');
    });

    attempt('severity and the decoration flag summarise the group', () => {
        ok(d.severity >= Engine.SEVERITY_PASS, `the group reports severity ${d.severity}`);
        eq(d.decorated, false, 'and no decoration, since this map has no layers');

        const lc = new Uint32Array(N * N);
        lc[505 * N + 505] = 1;                        // one decorated cell inside the group
        const withLayer = Engine.buildGridModel(PLACEMENT,
            { cols: N, rows: N, codes, cells: big },
            codes.slice(1).map((c) => ({ code: c, quality: 'Pass' })),
            [{ mapName: 'L', mapVersion: '1', cells: lc,
                binTable: [{ code: '.', quality: null, pick: false },
                    { code: 'x', quality: null, pick: false }] }]);
        eq(Engine.describeGroup(groupRect, withLayer, unit).decorated, true,
            'one decorated cell anywhere in the group sets the flag');
        eq(Engine.describeGroup({ x0: 0, y0: 0, x1: 10, y1: 10 }, withLayer, unit).decorated, false,
            '  and a group without one does not');
    });

    attempt('an empty group is described rather than refused', () => {
        const empty = Engine.describeGroup({ x0: -500, y0: -500, x1: -400, y1: -400 }, bigGrid, unit);
        eq(empty.cellCount, 0, 'no cells');
        eq(empty.bins.length, 0, '  no histogram');
        eq(empty.otherCount, 0, '  no remainder');
        eq(empty.severity, Engine.SEVERITY_NULL, '  and severity NULL, not pass');
        eq(empty.bins.reduce((a, b) => a + b.count, 0) + empty.otherCount, empty.cellCount,
            '  the invariant still holds at zero');
    });

    attempt('the null bin never reaches the histogram', () => {
        /* A group over the wafer edge holds off-substrate cells; they are excluded by
         * `cellsInGroup`, so they cannot dilute the counts. */
        const edge = Engine.describeGroup({ x0: 0, y0: 560, x1: 120, y1: 680 }, bigGrid, unit);
        ok(edge.cellCount > 0, `an edge group holds ${edge.cellCount} on-substrate cells`);
        ok(!edge.bins.some((b) => b.code === '.'), 'and the null code is not among its bins');
        eq(edge.bins.reduce((a, b) => a + b.count, 0) + edge.otherCount, edge.cellCount,
            '  with the invariant intact');
    });
});

section('16. group tile ids round-trip (LOD-22)', () => {
    /*
     * The id has to name something a rectangle can be REBUILT from, because
     * `onGroupSelected` hands one to the author and `readGroupMembers` takes it back
     * a moment later. A lattice-space origin - which the first `describeGroup` used
     * - cannot: the group is a device rectangle whose lattice image is a rotated
     * parallelogram, so an origin gives a corner and no shape (D-099).
     *
     * SINCE F-5a the tiles are a DIVISION of the map's span, not a constant width on
     * an infinite grid at device zero, so both functions take a `GroupTiling` and an
     * id names a tile INDEX within it. The assertions below are rewritten for that:
     * there is no tile -1 any more, because there is nothing left of the map to tile.
     */
    attempt('every tile id rebuilds its own rectangle, for every tile', () => {
        /*
         * Done-when 3, exhaustively rather than on samples: for every tiling, for
         * every tile in it, for nine points spread across that tile, `groupTileAt`
         * must return that tile's id and an identical rectangle.
         */
        const bad = [];
        let tilesChecked = 0;
        let pointsChecked = 0;
        for (const x0 of [0, 12, 37.4, -60]) {
            for (const span of [40, 100, 137, 400]) {
                for (const min of [8, 24, 40, 64]) {
                    const tiling = Engine.groupTiling(
                        { x0, y0: x0, x1: x0 + span, y1: x0 + span }, min);
                    if (tiling === null) { continue; }
                    for (let gy = 0; gy < tiling.ys.length; gy++) {
                        for (let gx = 0; gx < tiling.xs.length; gx++) {
                            const id = `${gx},${gy}`;
                            const rect = Engine.groupTileRect(id, tiling);
                            if (rect === null) { bad.push(`${id}: no rect`); continue; }
                            tilesChecked++;
                            for (const fx of [0, 0.5, 0.999]) {
                                for (const fy of [0, 0.5, 0.999]) {
                                    const px = rect.x0 + (rect.x1 - rect.x0) * fx;
                                    const py = rect.y0 + (rect.y1 - rect.y0) * fy;
                                    const t = Engine.groupTileAt(px, py, tiling);
                                    pointsChecked++;
                                    if (t === null || t.id !== id
                                        || JSON.stringify(t.rect) !== JSON.stringify(rect)) {
                                        bad.push(`${px},${py} -> ${t === null ? 'null' : t.id}, wanted ${id}`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        eq(bad.length, 0, `every point maps back to its own tile  ${bad[0] ?? ''}`);
        ok(tilesChecked > 200, `and it was a real sweep: ${tilesChecked} tiles, ${pointsChecked} points`);
    });

    attempt('the tiling is anchored to the map, not to the device origin', () => {
        /*
         * THE FIX, stated as the property that was false before. The same span
         * tiled at three different offsets must produce the same tile WIDTHS -
         * previously it gave 40,40,20 / 28,40,32 / 3,40,40,17 depending on where
         * the map happened to sit, so the groups changed on a window resize.
         */
        const widths = [0, 12, 37.4].map((x0) =>
            Engine.groupTiling({ x0, y0: 0, x1: x0 + 100, y1: 100 }, 40).xs.join(','));
        eq(new Set(widths).size, 1, `three offsets, one division: ${widths[0]}`);
        eq(widths[0], '50,50', '  and it is two equal tiles, not 40/40/20');
        /*
         * The widths alone do NOT prove anchoring - they are the same whatever the
         * origin is. Zeroing `x0` left this section entirely green, so the tile's
         * absolute position is asserted too: tile 0 has to start at the map's edge,
         * not at device zero (observation 369).
         */
        for (const x0 of [0, 12, 37.4, -60]) {
            const t = Engine.groupTiling({ x0, y0: x0, x1: x0 + 100, y1: x0 + 100 }, 40);
            const first = Engine.groupTileRect('0,0', t);
            eq(first.x0, Math.floor(x0), `tile 0 starts at the map's left edge, not device zero (x0=${x0})`);
            eq(first.y0, Math.floor(x0), `  and at its top edge (y0=${x0})`);
            const last = Engine.groupTileRect(`${t.xs.length - 1},0`, t);
            eq(last.x1, Math.floor(x0) + 100, '  and the last tile ends at the map\u2019s right edge');
        }
    });

    attempt('rows and columns are divided independently', () => {
        /*
         * "Rows and columns are independent; both need it." Every other tiling in
         * this section is SQUARE, so reusing the column division for the rows was
         * indistinguishable and the mutation for it came back MISSED (observation
         * 371). A wide short map is the case that can tell them apart.
         */
        const wide = Engine.groupTiling({ x0: 0, y0: 0, x1: 400, y1: 90 }, 40);
        eq(wide.xs.length, 10, 'a 400 px width at min 40 gives ten columns');
        eq(wide.ys.length, 2, '  and a 90 px height gives two rows, not ten');
        eq(wide.xs.join(','), '40,40,40,40,40,40,40,40,40,40', '  columns of forty');
        eq(wide.ys.join(','), '45,45', '  rows of forty-five - a different division entirely');
        const tall = Engine.groupTiling({ x0: 0, y0: 0, x1: 90, y1: 400 }, 40);
        eq(tall.xs.join(','), '45,45', 'and the transpose transposes');
        eq(tall.ys.length, 10, '  ten rows for the tall one');
    });

    attempt('a point outside the tiled region belongs to no tile', () => {
        const t = Engine.groupTiling({ x0: 0, y0: 0, x1: 100, y1: 100 }, 40);
        eq(Engine.groupTileAt(-1, 50, t), null, 'left of the map');
        eq(Engine.groupTileAt(50, -1, t), null, 'above it');
        eq(Engine.groupTileAt(100, 50, t), null, 'and the far edge is EXCLUSIVE');
        ok(Engine.groupTileAt(99.999, 50, t) !== null, '  while a hair inside is not');
    });

    attempt('adjacent tiles meet exactly and share no point', () => {
        const t = Engine.groupTiling({ x0: 0, y0: 0, x1: 100, y1: 100 }, 40);
        const a = Engine.groupTileRect('0,0', t);
        const b = Engine.groupTileRect('1,0', t);
        eq(a.x1, b.x0, 'they meet exactly');
        eq(Engine.groupTileAt(a.x1, 0, t).id, '1,0', 'and the shared edge is in exactly one of them');
    });

    attempt('a bad id, an expired one, or no tiling is refused rather than guessed at', () => {
        const t = Engine.groupTiling({ x0: 0, y0: 0, x1: 100, y1: 100 }, 40);
        eq(Engine.groupTileRect('nope', t), null, 'an unparseable id');
        eq(Engine.groupTileRect('1,2,3', t), null, '  and one with too many parts');
        eq(Engine.groupTileRect('1.5,2', t), null, '  and a fractional one');
        eq(Engine.groupTileRect('-1,-1', t), null, 'a negative index names no tile now');
        eq(Engine.groupTileRect('9,0', t), null, '  nor does one past the end - an id from another frame');
        eq(Engine.groupTileRect('0,0', null), null, 'and no tiling at all');
        eq(Engine.groupTileAt(0, 0, null), null, '  in either direction');
        eq(Engine.groupTiling({ x0: 0, y0: 0, x1: 100, y1: 100 }, 0), null, 'a zero minimum tiles nothing');
        eq(Engine.groupTiling({ x0: 0, y0: 0, x1: 0, y1: 100 }, 40), null, '  as does a zero-width region');
    });

    /* Done-when 1: the members match Task 20's enumeration exactly. */
    attempt('a tile\'s members are exactly cellsInGroup of its rectangle', () => {
        const N = 24;
        const cells = new Uint32Array(N * N).fill(1);
        const grid = Engine.buildGridModel(PLACEMENT,
            { cols: N, rows: N, cells, codes: PAYLOAD.codes }, BIN_DEFS);
        const dev = Engine.deviceMatrix(1, Engine.makeWorldMatrix(
            { center: { x: 100, y: 100 }, width: 200, height: 200, margin: 8 },
            Engine.computeScale({ center: { x: 100, y: 100 }, width: 200, height: 200, margin: 8 }, N, N),
            Math.PI / 6));
        const tiling = Engine.groupTiling({ x0: 0, y0: 0, x1: 200, y1: 200 }, 40);
        const bad = [];
        let total = 0;
        for (const id of ['0,0', '1,1', '2,3', '3,4']) {
            const rect = Engine.groupTileRect(id, tiling);
            if (rect === null) { continue; }
            const viaId = [...Engine.cellsInGroup(rect, grid, dev)];
            const viaRect = [...Engine.cellsInGroup(
                Engine.groupTileAt(rect.x0, rect.y0, tiling).rect, grid, dev)];
            total += viaId.length;
            if (viaId.join() !== viaRect.join()) { bad.push(id); }
        }
        eq(bad.length, 0, `going through the id gives the same set as the rectangle  ${bad[0] ?? ''}`);
        ok(total > 0, `and the tiles are not all empty (${total} cells)`);
    });
});

section('17. the value-field fill (LOD-24)', () => {
    const RAMP5 = Ok.valueRampColors(5);

    attempt('the ramp is lightness-ordered and single-hue', () => {
        const L = RAMP5.map((c) => Ok.rgbToOklch(Ok.parseRgb(c)).L);
        const bad = [];
        for (let i = 1; i < L.length; i++) { if (L[i] <= L[i - 1]) { bad.push(i); } }
        eq(bad.length, 0, `strictly increasing lightness: ${L.map((x) => x.toFixed(2)).join(' < ')}`);
        ok(Ok.deltaECss(RAMP5[0], 'rgb(213, 94, 0)') > 0.15,
            'and no level is confusable with the theme\'s fail vermillion');
    });

    attempt('one level renders one colour rather than dividing by zero', () => {
        const one = Ok.valueRampColors(1);
        eq(one.length, 1, 'one colour');
        ok(/^#[0-9a-f]{6}$/.test(one[0]), `  and it is a real colour: ${one[0]}`);
        eq(Ok.valueRampColors(0).length, 0, 'and zero levels is empty, not a crash');
    });

    /* Done-when 1: the ends are the first and last of ITS table, by pixel. */
    attempt('a value fill paints its own table\'s ends', () => {
        const grid = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 1, cells: new Uint32Array([1, 1, 1, 1]), codes: ['.', '1'] },
            [{ code: '1', quality: 'Pass' }]);
        const fill = { cells: new Uint32Array([1, 2, 3, 4]), colors: ['', ...Ok.valueRampColors(4)] };
        const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4, fill);
        const ctx = makeContext2D(16, 4);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([4, 0, 0, 4, 0, 0]), paint, 16, 4, false);
        const styles = ctx.fills.map((f) => f.fillStyle);
        eq(styles[0], fill.colors[1], 'the first cell takes the table\'s first level');
        eq(styles[styles.length - 1], fill.colors[4], '  and the last cell its last');
        ok(!styles.includes(COLORS.binPass),
            'and the base bin colour appears nowhere — the fill is REPLACED, not blended');
    });

    /* Done-when 2: base and decoration are untouched. */
    attempt('without a fill the render is byte-identical to before', () => {
        const grid = makeGrid();
        const withArg = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4, null);
        const without = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4));
        deep(withArg.colors, without.colors, 'the palette is unchanged');
        deep([...withArg.groups], [...without.groups], '  and so are the groups');
        eq(withArg.fillCells, null, '  and no fill array is carried');
        eq(withArg.signature, without.signature, '  so the cache key does not move either');

        const draw = (p) => {
            const ctx = makeContext2D(64, 48);
            Engine.renderGridLayer(ctx, grid, new DOMMatrix([8, 0, 0, 8, 0, 0]), p, 64, 48, false);
            return ctx.fills.map((f) => `${f.fillStyle}@${f.x},${f.y},${f.w},${f.h}`);
        };
        deep(draw(withArg), draw(without), 'and the frame is identical rect for rect');
    });

    /*
     * THE BASE STILL OWNS THE SUBSTRATE. A value overlay may name a cell the base
     * calls null — off the wafer — and that cell must stay unpainted. The fill says
     * what colour, the grid says whether there is anything to colour.
     */
    attempt('a cell the base calls null stays unpainted whatever the value says', () => {
        const grid = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 1, cells: new Uint32Array([0, 1, 1, 1]), codes: ['.', '1'] },
            [{ code: '1', quality: 'Pass' }]);
        const fill = { cells: new Uint32Array([3, 1, 2, 4]), colors: ['', ...Ok.valueRampColors(4)] };
        const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4, fill);
        const ctx = makeContext2D(16, 4);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([4, 0, 0, 4, 0, 0]), paint, 16, 4, false);
        eq(ctx.fills.length, 3, 'three cells painted, not four');
        ok(!ctx.fills.some((f) => f.x === 0),
            '  and the off-substrate cell is not among them, though the value field names it level 3');
    });

    attempt('a cell the value field says nothing about is unpainted too', () => {
        const grid = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 1, cells: new Uint32Array([1, 1, 1, 1]), codes: ['.', '1'] },
            [{ code: '1', quality: 'Pass' }]);
        const fill = { cells: new Uint32Array([1, 0, 2, 3]), colors: ['', ...Ok.valueRampColors(3)] };
        const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4, fill);
        const ctx = makeContext2D(16, 4);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([4, 0, 0, 4, 0, 0]), paint, 16, 4, false);
        eq(ctx.fills.length, 3, 'the null level is the overlay saying nothing, and is left alone');
    });

    attempt('the gather path honours the fill too', () => {
        const grid = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 4, cells: new Uint32Array(16).fill(1), codes: ['.', '1'] },
            [{ code: '1', quality: 'Pass' }]);
        const cells = new Uint32Array(16);
        for (let i = 0; i < 16; i++) { cells[i] = 1 + (i % 4); }
        const fill = { cells, colors: ['', ...Ok.valueRampColors(4)] };
        /* The base's OWN null cells, so the gather path's substrate mask is
         * exercised. Without one it never fires and a mutation removing it survives
         * — which it did. */
        grid.cells[0] = 0;
        grid.cells[5] = 0;
        const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4, fill);
        ok(paint.rgba !== null, 'the fill packs to RGBA, so the ImageData strategy is reachable');
        const ctx = makeContext2D(8, 8);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([2, 0, 0, 2, 0, 0]), paint, 8, 8, true);
        ok(ctx.puts.length > 0, 'and it blits');
        const px = new Uint32Array(ctx.pixels.buffer);
        const words = new Set([...px].filter((w) => w !== 0));
        eq(words.size, 4, 'four distinct level colours reach the pixels');
        /* At 2 device px per cell, cell (c,r) owns the 2x2 block at (2c, 2r). Cells
         * (0,0) and (1,1) are off substrate, so their blocks — (0,0) and (2,2) —
         * must be transparent though the value field names a level for each. Cell
         * (2,2) is kept, and owns the block at (4,4). */
        eq(px[0 * 8 + 0], 0, 'an off-substrate cell is unpainted in the gather path too');
        eq(px[1 * 8 + 1], 0, '  across its whole 2x2 block');
        eq(px[2 * 8 + 2], 0, '  and so is the second one');
        ok(px[4 * 8 + 4] !== 0, '  while a cell the base keeps is painted');
    });

    attempt('the fill changes the cache signature', () => {
        const grid = makeGrid();
        const a = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4));
        const b = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4,
            { cells: new Uint32Array(12).fill(1), colors: ['', ...Ok.valueRampColors(2)] });
        ok(a.signature !== b.signature,
            'a value field and a bin fill must not share a cached bitmap');
        /* And two DIFFERENT value fields must not share one either — comparing only
         * against the bin fill would pass with a constant signature. */
        const c = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(4, 4), null, null, 0.4,
            { cells: new Uint32Array(12).fill(1), colors: ['', ...Ok.valueRampColors(5)] });
        ok(b.signature !== c.signature,
            'two value fields with different level counts have different signatures');
    });
});

section('18. the value field under aggregation (LOD-25)', () => {
    /*
     * The BASE DECLARES NO BinQuality. That is the fixture's point: a value field
     * must reduce without consulting one, and a base that had qualities would let
     * the severity path work by accident.
     */
    const N = 64;
    const grid = Engine.buildGridModel(PLACEMENT,
        { cols: N, rows: N, cells: new Uint32Array(N * N).fill(1), codes: ['.', 'x'] },
        [{ code: 'x' }]);
    const LEVELS = 8;
    const vc = new Uint32Array(N * N).fill(1);
    vc[33 * N + 29] = LEVELS;                       // one cell at the top of the table
    const fill = { cells: vc, colors: ['', ...Ok.valueRampColors(LEVELS)] };
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8), null, null, 0.4, fill);

    attempt('a value field builds an aggregate paint at all', () => {
        ok(paint.aggregate !== null,
            'without one the dispatcher falls through to the gather and POINT SAMPLES the field — '
            + 'the defect Phase 2 removed for bins, reintroduced for the seam that carries a '
            + 'relevance map');
        ok(paint.aggregate.valueCells !== null, 'and it carries the per-cell table indices');
        ok(paint.aggregate.valueColors !== null, '  and a packed colour per index');
    });

    /* Done-when 1 and 2 together. */
    attempt('one cell at the top of the table survives a bucket of any size', () => {
        const top = paint.aggregate.valueColors[LEVELS];
        const missed = [];
        for (const factor of [2, 8, 32, 64]) {
            const scale = 1 / factor;
            const side = Math.ceil(N * scale) + 2;
            for (let k = 0; k < 8; k++) {
                const ctx = makeContext2D(side, side);
                Engine.renderGridLayer(ctx, grid,
                    new DOMMatrix([scale, 0, 0, scale, k / 8, k / 8]), paint, side, side,
                    true, 'ValueField');
                if (![...new Uint32Array(ctx.pixels.buffer)].includes(top)) {
                    missed.push(`factor ${factor}, phase ${k}/8`);
                }
            }
        }
        eq(missed.length, 0,
            `the top level reaches a bucket at all 8 phases of factors 2, 8, 32 and 64 — a bucket of `
            + `${64 * 64} cells at the largest  ${missed[0] ?? ''}`);
    });

    attempt('it reduces by table INDEX, not by severity', () => {
        /* The base has no BinQuality, so `binSeverityTable` gives every bin the same
         * rank. If the reduction consulted severity the top level would be
         * indistinguishable from the rest — which is exactly what makes this fixture
         * discriminating. */
        const sev = Engine.binSeverityTable(grid.binTable);
        eq(new Set([...sev].slice(1)).size, 1,
            'every bin of the base ranks the same, since none declares a quality');
        const ctx = makeContext2D(4, 4);
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([1 / 16, 0, 0, 1 / 16, 0, 0]),
            paint, 4, 4, true, 'ValueField');
        const words = new Set([...new Uint32Array(ctx.pixels.buffer)].filter((w) => w !== 0));
        ok(words.has(paint.aggregate.valueColors[LEVELS]),
            'and the tile holding the top level is painted with it');
        ok(words.has(paint.aggregate.valueColors[1]),
            '  while the others take level 1 — two distinct answers from one severity');
    });

    attempt('the base still masks the substrate under aggregation', () => {
        const holed = Engine.buildGridModel(PLACEMENT,
            { cols: 4, rows: 4, cells: new Uint32Array(16).fill(1), codes: ['.', 'x'] }, [{ code: 'x' }]);
        holed.cells[0] = 0;
        const f = { cells: new Uint32Array(16).fill(2), colors: ['', ...Ok.valueRampColors(2)] };
        const p = Engine.buildGridPaint(holed, null, COLORS, makeContext2D(4, 4), null, null, 0.4, f);
        const ctx = makeContext2D(4, 4);
        Engine.renderGridLayer(ctx, holed, new DOMMatrix([1 / 2, 0, 0, 1 / 2, 0, 0]), p, 4, 4, true, 'ValueField');
        const b = Agg.accumulateBuckets(holed, new DOMMatrix([1 / 2, 0, 0, 1 / 2, 0, 0]), 4, 4,
            new Uint32Array(holed.binTable.length).fill(1), 'max');
        eq([...b.total].reduce((x, y) => x + y, 0), 15,
            'the off-substrate cell is out of the denominator, as it is everywhere else');
    });

    /* Done-when 3, at the engine: the reducer is forced, not chosen. */
    attempt('ValueField sticks against the rule and against an override', () => {
        eq(Engine.selectReducer('ValueField', 0.99), 'ValueField',
            'a saturated frame does not move it — a value field has no failures to saturate on');
        eq(Engine.selectReducer('ValueField', 0.0), 'ValueField', '  and neither does an empty one');
        eq(Engine.selectReducer('ValueField', 0.5, 'FailFraction'), 'ValueField',
            '  and an explicit override does not either: FailFraction asks about a quality that is '
            + 'not there');
        eq(Engine.selectReducer('MaxSeverity', 0.5, 'FailFraction'), 'FailFraction',
            'while an override still wins when there is no value field');
    });

    attempt('a value field reports no saturation', () => {
        const ctx = makeContext2D(4, 4);
        const sat = Engine.renderGridLayer(ctx, grid, new DOMMatrix([1 / 16, 0, 0, 1 / 16, 0, 0]),
            paint, 4, 4, true, 'ValueField');
        eq(sat, 0,
            'nothing counts as a failure, so the measurement is 0 and the feed-forward rule has '
            + 'nothing to act on');
    });
});

section('group tiles are of near-equal size (F-5)', () => {
    /*
     * THE COMPLAINT: "some of the groups are huge and others small... it would be
     * better if the control tried to get groups with an almost similar size."
     *
     * Measured before the fix, tiles laid at a fixed 40 px on a grid anchored at
     * device zero and clipped by the map's extent:
     *
     *     map spans [  0, 100]  ->  40, 40, 20        2.0x  spread
     *     map spans [ 12, 112]  ->  28, 40, 32        1.4x
     *     map spans [ 37, 137]  ->   3, 40, 40, 17   13.3x
     *
     * A 3 px tile is not tappable, and which case you get depends on where the map
     * lands relative to the device origin - so it changes on a window resize.
     *
     * `groupTileSpans` replaces that with a division of the span itself. THE TASK'S
     * FORMULA IS WRONG and this section is where that is pinned down: it says
     * `n = ceil(span / minTile)` keeps every tile at or above the minimum, and
     * `ceil` does the opposite (D-229).
     */
    const SPANS = [];
    for (let span = 1; span <= 400; span++) { SPANS.push(span); }
    const MINS = [];
    for (let min = 8; min <= 64; min++) { MINS.push(min); }

    /*
     * Done-when 1, as arithmetic over the whole range rather than three examples:
     * 400 spans x 57 minimums = 22 800 cases, each checked for four properties.
     * Counted rather than asserted one at a time, so a failure names how many and
     * the first witness instead of drowning the log.
     */
    let cases = 0;
    let sumWrong = 0;
    let spreadWrong = 0;
    let belowMin = 0;
    let firstSpread = null;
    let firstBelow = null;
    for (const span of SPANS) {
        for (const min of MINS) {
            const tiles = Engine.groupTileSpans(span, min);
            cases++;
            if (tiles.reduce((a, b) => a + b, 0) !== span) { sumWrong++; }
            const lo = Math.min(...tiles);
            const hi = Math.max(...tiles);
            if (hi - lo > 1) {
                spreadWrong++;
                firstSpread ??= `span ${span}, min ${min} -> ${tiles.join(',')}`;
            }
            // A span shorter than one minimum tile is the documented exception: one
            // tile of the whole span, because the alternative is a tile wider than
            // the thing it divides.
            if (span >= min && lo < min) {
                belowMin++;
                firstBelow ??= `span ${span}, min ${min} -> ${tiles.join(',')}`;
            }
        }
    }
    eq(cases, 22800, 'the whole range was walked: 400 spans x 57 minimums');
    eq(sumWrong, 0, 'every division sums back to its span exactly - no pixel invented or lost');
    eq(spreadWrong, 0, `no two tiles differ by more than one pixel${firstSpread ? ` (first: ${firstSpread})` : ''}`);
    eq(belowMin, 0, `no tile falls below the minimum${firstBelow ? ` (first: ${firstBelow})` : ''}`);

    /*
     * The task's own rule, run over the same range, so the correction is evidence
     * rather than an assertion about it. If this ever comes out zero, `ceil` was
     * right after all and D-229 needs revisiting.
     */
    let ceilBelow = 0;
    let comparable = 0;
    for (const span of SPANS) {
        for (const min of MINS) {
            if (span < min) { continue; }
            comparable++;
            if (span / Math.ceil(span / min) < min - 1e-9) { ceilBelow++; }
        }
    }
    eq(comparable, 20805, 'excluding spans below one minimum tile, where no rule can succeed');
    eq(ceilBelow, 19968,
        "the task's ceil rule is under the minimum in 19 968 of 20 805 - which is why floor (D-229)");

    /* The task's worked examples, named. */
    eq(Engine.groupTileSpans(100, 30).join(','), '34,33,33', '100 at min 30 is the task\u2019s 33/33/34');
    eq(Engine.groupTileSpans(100, 25).join(','), '25,25,25,25', 'and 100 at min 25 is four of 25');

    /*
     * The reporter's case: a small wafer whose span used to break into four groups,
     * two large and two small. The count is named, per Done-when 2.
     */
    const REPORTED_SPAN = 137 - 37;
    const before = [3, 40, 40, 17];
    const after = Engine.groupTileSpans(REPORTED_SPAN, 40);
    eq(before.length, 4, 'the reported case was four groups');
    ok(Math.max(...before) / Math.min(...before) > 13, '  spread more than 13x, and a 3 px tile');
    eq(after.length, 2, 'it becomes TWO groups');
    eq(after.join(','), '50,50', '  of fifty pixels each');
    ok(Math.min(...after) >= 40, '  both at or above the touch minimum');

    /* Unusable arguments produce no tiles rather than a tile of nothing. */
    for (const [span, min, why] of [
        [0, 40, 'a zero span'], [-5, 40, 'a negative span'], [100, 0, 'a zero minimum'],
        [100, -1, 'a negative minimum'], [Number.NaN, 40, 'a NaN span'],
        [100, Number.NaN, 'a NaN minimum'], [Number.POSITIVE_INFINITY, 40, 'an infinite span'],
    ]) { eq(Engine.groupTileSpans(span, min).length, 0, `${why} divides into nothing`); }

    /* A span shorter than one tile: one tile, and it is the whole span. */
    eq(Engine.groupTileSpans(20, 40).join(','), '20', 'a span under one minimum tile stays one tile');
});

section('packColor refuses what it does not understand (F-7)', () => {
    /*
     * THE REVIEW'S C1/B2, and the uncovered-line report was right: nothing
     * exercised this function at all.
     *
     * Both branches were PREFIX tests. `s.charCodeAt(0) === 35 && s.length === 7`
     * handed `#12345g` to `parseInt(_, 16)`, which prefix-parses and returned
     * 0x12345 - a wrong but entirely plausible colour, silently. And
     * `s.slice(0, 3) === 'rgb'` accepted `rgbx(1,2,3)`.
     *
     * The consequence is not a crash. `null` cleanly disables the ImageData
     * strategy for the whole layer, which is the designed fallback; a
     * wrong-but-plausible word gets PAINTED. Refusing is strictly safer than
     * guessing here, which is why the forms are matched whole (D-233).
     */
    attempt('the two documented forms still parse', () => {
        for (const [s, why] of [
            ['#123456', 'lower-case hex'],
            ['#ABCDEF', 'upper-case hex'],
            ['#abcdef', 'the canvas form'],
            ['rgb(1, 2, 3)', 'rgb with spaces, as a canvas serializes it'],
            ['rgba(1, 2, 3, 0.5)', 'rgba with a fractional alpha'],
            ['rgba(0,0,0,0)', 'fully transparent'],
            ['rgb(255,255,255)', 'white'],
        ]) { ok(Engine.packColor(s) !== null, `${s} parses — ${why}`); }
        // and the value is right, not merely non-null
        eq(Engine.packColor('#000000'), Engine.packColor('rgb(0, 0, 0)'),
            'the same colour through either form packs the same word');
    });

    attempt('every malformed form the review names returns null', () => {
        for (const [s, why] of [
            ['#12345g', 'C1: parseInt prefix-parsed this to 0x12345'],
            ['#1234567', 'too long'],
            ['#12345', 'too short'],
            ['#', 'just the hash'],
            ['', 'empty'],
            ['#12 3456', 'a space inside the digits'],
            ['#12345 ', 'trailing space, still seven characters'],
            ['rgbx(1,2,3)', "B2: slice(0,3) === 'rgb' accepted this"],
            ['rgb(1,2)', 'too few components'],
            ['rgb(1,2,3,4,5)', 'too many — the extras used to be ignored'],
            ['rgba(1,2,3)', 'rgba without its alpha'],
            ['rgb(0x10,2,3)', 'Number() accepts hex; CSS does not'],
            ['rgb(Infinity,0,0)', 'Number() accepts it and it survived the NaN check'],
            ['rgb(50%,2,3)', "percentages: Number('50%') is NaN and would pack a NaN word"],
            ['color(srgb 1 0 0)', 'a wide-gamut form the doc already promised to refuse'],
            ['red', 'a keyword — normalizeColor resolves these before we get here'],
            ['rgb(1,2,3', 'unclosed'],
            ['rgb 1,2,3)', 'no open paren'],
        ]) { eq(Engine.packColor(s), null, `${JSON.stringify(s)} -> null — ${why}`); }
    });

    attempt('a property sweep: nothing outside the documented forms parses', () => {
        /*
         * Done-when's property test. Deterministic PRNG so a failure is
         * reproducible - a random seed would make this a test that fails once and
         * then cannot be made to fail again.
         */
        let seed = 0x5eed1234;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const ALPHABET = '0123456789abcdefABCDEFgxz#(),. %/rgbRGB+-eE';
        const HEX = /^#[0-9a-fA-F]{6}$/;
        const RGB = /^rgba?\([^()]*\)$/;
        let checked = 0;
        let claimed = 0;
        const wrong = [];
        /*
         * Half free-form junk, half MUTATIONS of valid colours - one character
         * substituted, inserted or dropped. Pure junk never lands on a valid form:
         * the first version of this sweep reached the parser 0 times in 20 000, so
         * its "nothing wrong parsed" was vacuous. The guard below is what caught
         * that, and it is why it is here (observation 375).
         */
        const SEEDS = ['#123456', '#abcdef', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)', 'rgb(255,0,0)'];
        for (let i = 0; i < 20000; i++) {
            let s;
            if (i % 2 === 0) {
                const n = 1 + Math.floor(rnd() * 18);
                s = '';
                for (let k = 0; k < n; k++) { s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]; }
            } else {
                const base = SEEDS[Math.floor(rnd() * SEEDS.length)];
                const at = Math.floor(rnd() * base.length);
                const ch = ALPHABET[Math.floor(rnd() * ALPHABET.length)];
                const how = Math.floor(rnd() * 4);
                s = how === 0 ? base.slice(0, at) + ch + base.slice(at + 1)   // substitute
                    : how === 1 ? base.slice(0, at) + ch + base.slice(at)     // insert
                        : how === 2 ? base.slice(0, at) + base.slice(at + 1)  // drop
                            : base;                                          // untouched
            }
            checked++;
            const packed = Engine.packColor(s);
            if (packed === null) { continue; }
            claimed++;
            // Anything that parsed MUST look like one of the two documented forms.
            if (!HEX.test(s) && !RGB.test(s)) { wrong.push(s); }
        }
        eq(checked, 20000, 'twenty thousand random strings');
        eq(wrong.length, 0,
            `nothing outside the documented forms parsed${wrong.length ? ` (first: ${JSON.stringify(wrong[0])})` : ''}`);
        /*
         * The sweep has to actually REACH the parser, or it proves nothing: a
         * generator that never produces a valid colour would pass while returning
         * null to everything. It found some, so the zero above is a real zero.
         */
        ok(claimed > 0, `and the generator did reach the parser: ${claimed} of ${checked} strings parsed`);
    });
});

section('the bounding boxes, over every shape and every path command (F-18a)', () => {
    /*
     * `geometryBBox` and the `pathCommandsBBox` family measured among Engine's
     * largest uncovered regions - 138 lines between them - while being the code that
     * decides where a die IS. `F-4` was a bounding-box defect and cost three tasks.
     *
     * These are PURE functions of their arguments, so unlike the draw paths beneath
     * them they need no canvas and can be asserted exactly. Nineteen path commands
     * and six geometry types, each at a shape whose answer can be worked out by hand.
     */
    const bb = (b) => b === null ? 'null' : `${b.minX},${b.minY},${b.maxX},${b.maxY}`;
    const geom = (o) => Engine.geometryBBox(o, 'milli');

    attempt('the four closed primitives measure what they are', () => {
        eq(bb(geom({ type: 'rectangle', center_position_x: 0, center_position_y: 0,
            width: 10, length: 20 })), '-5,-10,5,10', 'a rectangle is centred on its position');
        eq(bb(geom({ type: 'circle', center_position_x: 3, center_position_y: 4, radius: 5 })),
            '-2,-1,8,9', 'a circle is its radius either side of its centre');
        eq(bb(geom({ type: 'ellipse', center_position_x: 0, center_position_y: 0,
            radius_x: 8, radius_y: 3 })), '-8,-3,8,3', 'an ellipse uses each radius on its own axis');
        eq(bb(geom({ type: 'polygon',
            points: [{ x: -1, y: -1 }, { x: 4, y: 0 }, { x: 0, y: 6 }] })),
        '-1,-1,4,6', 'a polygon is the extent of its points');
    });

    attempt('a polyline measures its points, and one point is a degenerate box', () => {
        eq(bb(geom({ type: 'polyline', stroke_width: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] })),
            '0,0,5,0', 'a horizontal line has no height, and that is the honest answer');
        eq(bb(geom({ type: 'polyline', stroke_width: 1, points: [{ x: 2, y: 3 }] })),
            '2,3,2,3', 'a single point is a box of nothing at that point');
    });

    attempt('an empty point list has no box, rather than a box at the origin', () => {
        /*
         * The difference matters: a box at the origin would drag the fit box to
         * include (0,0) and move every other item on the substrate.
         */
        for (const type of ['polyline', 'polygon']) {
            eq(geom({ type, stroke_width: 1, points: [] }), null,
                `an empty ${type} contributes nothing`);
        }
    });

    attempt('the prefix scales the box, and is applied once', () => {
        const milli = geom({ type: 'rectangle', center_position_x: 0, center_position_y: 0,
            width: 10, length: 10 });
        const micro = Engine.geometryBBox({ type: 'rectangle', center_position_x: 0,
            center_position_y: 0, width: 10000, length: 10000 }, 'micro');
        eq(bb(micro), bb(milli), '10 000 micrometres is 10 millimetres, and measures the same');
    });

    attempt('every absolute path command moves the pen where it says', () => {
        const path = (commands) => bb(geom({ type: 'path', stroke_width: 1, commands }));
        eq(path([{ type: 'move_to_absolute', x: 1, y: 2 },
            { type: 'line_to_absolute', x: 5, y: 8 }]), '1,2,5,8', 'move then line');
        eq(path([{ type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'horizontal_line_to_absolute', x: 7 }]), '0,0,7,0', 'horizontal holds y');
        eq(path([{ type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'vertical_line_to_absolute', y: -4 }]), '0,-4,0,0', 'vertical holds x');
    });

    attempt('every relative command is measured from where the pen is', () => {
        const path = (commands) => bb(geom({ type: 'path', stroke_width: 1, commands }));
        eq(path([{ type: 'move_to_absolute', x: 10, y: 10 },
            { type: 'line_to_relative', x: 5, y: 5 }]), '10,10,15,15',
        'a relative line adds to the current point, it does not replace it');
        eq(path([{ type: 'move_to_absolute', x: 10, y: 10 },
            { type: 'horizontal_line_to_relative', x: -3 }]), '7,10,10,10', 'and can go backwards');
        eq(path([{ type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'move_to_relative', x: 2, y: 2 },
            { type: 'line_to_relative', x: 1, y: 1 }]), '0,0,3,3',
        'a relative MOVE also advances the pen');
    });

    attempt('a bezier is bounded by its curve, not by its control points', () => {
        /*
         * The whole reason `pathCommandsBBox` is 60 lines rather than 6. A cubic with
         * a control point far outside the curve must not report that point: the die
         * would be drawn correctly and hit-tested over empty substrate.
         */
        const b = geom({ type: 'path', stroke_width: 1, commands: [
            { type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'cubic_bezier_absolute', control_1_x: 0, control_1_y: 100,
                control_2_x: 10, control_2_y: 100, x: 10, y: 0 },
        ] });
        ok(b !== null, 'the curve has a box');
        /*
         * THE CONVEX HULL, not the tight box - measured, and deliberate: the cubic
         * case accumulates both control points. A Bezier always lies inside the hull
         * of its control points, so the box is GUARANTEED to contain the curve while
         * being larger than it needs to be. This cubic really peaks at y = 75 and the
         * box says 100.
         *
         * Conservative in the safe direction: a box too large fits the substrate
         * slightly small, where a box too small would clip a die that is drawn.
         * Asserted as the contract it is, so that tightening it later is a visible
         * change rather than a surprise (observation 396).
         */
        eq(b.maxY, 100, 'the hull bound includes the control points');
        ok(b.maxY >= 75, '  which is at or above the curve\u2019s true peak of 75 - it cannot clip');
        eq(b.minX, 0, 'x starts at the start point');
        eq(b.maxX, 10, 'and ends at the end point');
    });

    attempt('a quadratic is bounded by its control point too', () => {
        const b = geom({ type: 'path', stroke_width: 1, commands: [
            { type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'quadratic_bezier_absolute', control_x: 5, control_y: 50, x: 10, y: 0 },
        ] });
        eq(b.maxY, 50, 'a quadratic is bounded the same conservative way, by its control point');
    });

    attempt('an elliptical arc is bounded by the arc it sweeps', () => {
        const b = geom({ type: 'path', stroke_width: 1, commands: [
            { type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'elliptical_arc_absolute', rx: 10, ry: 5, x_axis_rotation: 0,
                large_arc: false, sweep: true, x: 20, y: 0 },
        ] });
        ok(b !== null, 'an arc has a box');
        ok(Math.abs(b.maxX - 20) < 1e-6 && Math.abs(b.minX) < 1e-6,
            `x spans the two endpoints (${b.minX}..${b.maxX})`);
        ok(b.maxY - b.minY > 0, 'and the sweep gives it height');
    });

    attempt('close_path returns to the subpath start and adds nothing new', () => {
        const open = geom({ type: 'path', stroke_width: 1, commands: [
            { type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'line_to_absolute', x: 4, y: 4 },
        ] });
        const closed = geom({ type: 'path', stroke_width: 1, commands: [
            { type: 'move_to_absolute', x: 0, y: 0 },
            { type: 'line_to_absolute', x: 4, y: 4 },
            { type: 'close_path' },
        ] });
        eq(bb(closed), bb(open), 'closing a path cannot make it bigger');
    });

    attempt('a path with no drawing commands has no box', () => {
        eq(geom({ type: 'path', stroke_width: 1, commands: [] }), null, 'no commands, no box');
        eq(bb(geom({ type: 'path', stroke_width: 1,
            commands: [{ type: 'move_to_absolute', x: 5, y: 5 }] })), '5,5,5,5',
        'a lone move is a box of nothing where the pen landed');
    });
});

finish();
