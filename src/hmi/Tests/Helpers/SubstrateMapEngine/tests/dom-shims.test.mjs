/*
 * dom-shims.test.mjs - the geometry shim, asserted against arithmetic done by hand.
 *
 * THE RULE FOR THIS FILE: no expectation may be produced by the code under test,
 * and none may be produced by another matrix library either. Every number below is
 * either an exact small integer, or written out from the multiplication it stands
 * for. A shim verified against itself is a tautology, and this one sits underneath
 * every render assertion the rest of Phase 0 will write - if its composition order
 * is backwards, every later failure gets blamed on the renderer.
 */

import {
    DOMMatrix, DOMPoint, installDomShims, makeContext2D, pixelAt,
} from './lib/dom-shims.mjs';
import { makeHarness, onCrash } from './lib/harness.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

/* Hoisted: `section` takes a synchronous callback, and top-level await is the only
 * place an ESM import can go. Installing the shims BEFORE the import is the point —
 * Engine.js touches DOMMatrix at module scope. */
installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(new URL('../Engine.js', import.meta.url).href);

/** @param m A matrix. @returns Its six components, in `a b c d e f` order. */
const six = (m) => [m.a, m.b, m.c, m.d, m.e, m.f];
/** @param a Actual. @param b Expected. @returns Whether every component is within 1e-12. */
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-12);

section('1. construction', () => {
    deep(six(new DOMMatrix()), [1, 0, 0, 1, 0, 0], 'the empty constructor is the identity');
    deep(six(new DOMMatrix([2, 3, 5, 7, 11, 13])), [2, 3, 5, 7, 11, 13],
        'the six-array constructor stores a b c d e f in that order');

    attempt('unimplemented forms are refused, not guessed at', () => {
        let code = null;
        try { new DOMMatrix('translate(10px)'); } catch (e) { code = e.name; }
        eq(code, 'TypeError',
            'a CSS transform string throws — the browser accepts it and this shim does not, '
            + 'and saying so beats silently producing an identity');
    });
});

section('2. the point transform, from the definition', () => {
    /* x' = a·x + c·y + e     y' = b·x + d·y + f
     * With [2,3,5,7,11,13] and (1,1):  x' = 2+5+11 = 18,  y' = 3+7+13 = 23. */
    const p = new DOMMatrix([2, 3, 5, 7, 11, 13]).transformPoint({ x: 1, y: 1 });
    eq(p.x, 18, 'x = a·x + c·y + e = 2 + 5 + 11');
    eq(p.y, 23, 'y = b·x + d·y + f = 3 + 7 + 13');
    eq(p.z, 0, 'z is 0 for a 2D point');
    eq(p.w, 1, 'and w is 1');
    ok(new DOMPoint(4, 5) instanceof DOMPoint, 'DOMPoint constructs from x, y');
});

section('3. rotation', () => {
    /* Positive rotation turns +x toward +y. At 90°: (1,0) -> (0,1).
     * cos(90°) is 6.12e-17 in IEEE754, never exactly 0, which is why this is a
     * tolerance and not an equality. */
    const r90 = new DOMMatrix().rotateSelf(90);
    const p = r90.transformPoint({ x: 1, y: 0 });
    ok(Math.abs(p.x - 0) < 1e-12, 'rotateSelf(90) sends (1,0) to x = 0');
    ok(Math.abs(p.y - 1) < 1e-12, '  and to y = 1');

    const q = r90.transformPoint({ x: 0, y: 1 });
    ok(Math.abs(q.x + 1) < 1e-12, '  and (0,1) to x = -1 — the quarter turn continues');
    ok(Math.abs(q.y - 0) < 1e-12, '  with y = 0');

    ok(near(six(new DOMMatrix().rotateSelf(180)), [-1, 0, 0, -1, 0, 0]),
        'rotateSelf(180) is the exact negation of the identity basis');
    ok(near(six(new DOMMatrix().rotateSelf(360)), [1, 0, 0, 1, 0, 0]),
        'and 360 returns to the identity');
    ok(near(six(new DOMMatrix().rotateSelf(-90)), six(new DOMMatrix().rotateSelf(270))),
        'a negative angle equals its positive complement');
});

section('4. composition order — the assertion this file exists for', () => {
    /*
     * A.multiply(B) applies B FIRST. Demonstrated with two operations whose order
     * is observable: translate by (10,0), and scale by 2.
     *
     *   T·S applied to (1,0):  scale first -> (2,0),  then translate -> (12,0)
     *   S·T applied to (1,0):  translate first -> (11,0), then scale -> (22,0)
     *
     * 12 and 22 are different, so a shim with the order backwards cannot pass both.
     */
    const T = new DOMMatrix([1, 0, 0, 1, 10, 0]);
    const S = new DOMMatrix([2, 0, 0, 2, 0, 0]);

    eq(T.multiply(S).transformPoint({ x: 1, y: 0 }).x, 12,
        'T.multiply(S) scales first, then translates: 1 → 2 → 12');
    eq(S.multiply(T).transformPoint({ x: 1, y: 0 }).x, 22,
        'S.multiply(T) translates first, then scales: 1 → 11 → 22');

    attempt('multiply does not modify either operand', () => {
        const a = new DOMMatrix([1, 0, 0, 1, 10, 0]);
        const b = new DOMMatrix([2, 0, 0, 2, 0, 0]);
        a.multiply(b);
        deep(six(a), [1, 0, 0, 1, 10, 0], 'the left operand is unchanged');
        deep(six(b), [2, 0, 0, 2, 0, 0], 'and the right operand is unchanged');
    });

    attempt('multiplySelf mutates and returns the same object', () => {
        const m = new DOMMatrix([1, 0, 0, 1, 10, 0]);
        const returned = m.multiplySelf(new DOMMatrix([2, 0, 0, 2, 0, 0]));
        ok(returned === m, 'multiplySelf returns this, so chaining works');
        deep(six(m), [2, 0, 0, 2, 10, 0], '  and the result is T·S, computed by hand');
    });
});

section('5. the *Self helpers post-multiply, which reads backwards', () => {
    /*
     * m.translateSelf(10,0).scaleSelf(2) is T·S, so the SCALE happens first - the
     * opposite of the reading order. This is the browser's behaviour and the trap
     * worth pinning: the chain reads "translate then scale" and means the reverse.
     */
    const chained = new DOMMatrix().translateSelf(10, 0).scaleSelf(2);
    deep(six(chained), [2, 0, 0, 2, 10, 0], 'translateSelf then scaleSelf gives T·S');
    eq(chained.transformPoint({ x: 1, y: 0 }).x, 12,
        '  so the point is scaled first — 1 → 2 → 12, not 1 → 11 → 22');

    const other = new DOMMatrix().scaleSelf(2).translateSelf(10, 0);
    deep(six(other), [2, 0, 0, 2, 20, 0], 'and the reverse chain gives S·T');
    eq(other.transformPoint({ x: 1, y: 0 }).x, 22, '  which translates first: 1 → 11 → 22');

    attempt('the defaults match the browser', () => {
        deep(six(new DOMMatrix().scaleSelf(3)), [3, 0, 0, 3, 0, 0],
            'scaleSelf(sx) with no sy scales both axes by sx');
        deep(six(new DOMMatrix().translateSelf(5)), [1, 0, 0, 1, 5, 0],
            'translateSelf(tx) with no ty leaves y alone');
    });
});

section('6. the shape the shipped code actually builds', () => {
    /*
     * Engine.ts constructs exactly two non-identity matrices:
     *   deviceMatrix  -> new DOMMatrix([dpr, 0, 0, dpr, 0, 0])
     *   latticeMatrix -> new DOMMatrix([colStepX, colStepY, rowStepX, rowStepY, originX, originY])
     * and composes them as dev.multiply(lat). Hand-computed here so the composition
     * the renderer relies on is pinned before any renderer test uses it.
     */
    const dpr = 2;
    const dev = new DOMMatrix([dpr, 0, 0, dpr, 0, 0]);
    const lat = new DOMMatrix([1, 0, 0, 1, 5, 7]);          // 1 mm cells, origin (5,7)
    const chain = dev.multiply(lat);
    deep(six(chain), [2, 0, 0, 2, 10, 14],
        'dev·lat scales the lattice origin as well as its steps');

    /* Cell (0,0) sits at the lattice origin, so at dpr 2 it lands at (10,14). */
    const at00 = chain.transformPoint({ x: 0, y: 0 });
    deep([at00.x, at00.y], [10, 14], 'cell (0,0) lands on the scaled origin');
    /* Cell (3,2): (5+3, 7+2) = (8,9) mm, doubled = (16,18). */
    const at32 = chain.transformPoint({ x: 3, y: 2 });
    deep([at32.x, at32.y], [16, 18], 'and cell (3,2) at (8,9) mm lands at (16,18) device px');
});

section('7. installation does not clobber', () => {
    const sentinel = function PreExisting() { };
    const savedM = globalThis.DOMMatrix;
    const savedP = globalThis.DOMPoint;
    try {
        globalThis.DOMMatrix = sentinel;
        delete globalThis.DOMPoint;
        installDomShims();
        ok(globalThis.DOMMatrix === sentinel,
            'an already-present DOMMatrix is left alone — a real browser wins over the shim');
        ok(globalThis.DOMPoint === DOMPoint, '  while the missing one is filled in');
    } finally {
        if (savedM === undefined) { delete globalThis.DOMMatrix; } else { globalThis.DOMMatrix = savedM; }
        if (savedP === undefined) { delete globalThis.DOMPoint; } else { globalThis.DOMPoint = savedP; }
    }
});

section('8. the shim drives the REAL Engine.ts, not just itself', () => {
    /*
     * The acceptance criterion for the shim as a tool. Sections 1-7 prove it is a
     * correct matrix class; this proves it is the RIGHT one — that `Engine.js`
     * loads under it and its geometry produces the numbers section 6 worked out by
     * hand. Without this the shim could be internally perfect and still not fit
     * the code it exists to unblock.
     *
     * Deliberately small. Covering the render path is Task 3's job; this is one
     * assertion that the door is open.
     */
    const p = {
        colStepXmm: 1, colStepYmm: 0, rowStepXmm: 0, rowStepYmm: 1,
        originXmm: 5, originYmm: 7, cellWmm: 1, cellLmm: 1, cols: 4, rows: 3,
    };
    deep(six(Engine.latticeMatrix(p)), [1, 0, 0, 1, 5, 7],
        'Engine.latticeMatrix builds [colStepX, colStepY, rowStepX, rowStepY, originX, originY]');

    const dev = Engine.deviceMatrix(2, new DOMMatrix());
    deep(six(dev), [2, 0, 0, 2, 0, 0], 'Engine.deviceMatrix(2, I) is a uniform doubling');

    /* The composition the renderer relies on, and the same numbers section 6
     * derived by hand before Engine.js was involved at all. */
    const chain = dev.multiply(Engine.latticeMatrix(p));
    deep(six(chain), [2, 0, 0, 2, 10, 14],
        'dev.multiply(lat) matches the hand-computed value in section 6');
    const at = chain.transformPoint({ x: 3, y: 2 });
    deep([at.x, at.y], [16, 18], '  and cell (3,2) lands where the arithmetic says');
});

section('9. ImageData and the recording context (LOD-2)', () => {
    attempt('createImageData returns a real, zeroed buffer', () => {
        const ctx = makeContext2D(20, 10);
        const img = ctx.createImageData(4, 3);
        eq(img.width, 4, 'width');
        eq(img.height, 3, 'height');
        eq(img.data.length, 4 * 3 * 4, 'the buffer is w x h x 4 bytes');
        ok(img.data instanceof Uint8ClampedArray, '  and is a Uint8ClampedArray, as the browser gives');
        ok([...img.data].every((b) => b === 0), '  zero-filled');
    });

    /* Done-when 1: pixelAt returns the exact RGBA a putImageData call wrote. */
    attempt('pixelAt returns exactly what putImageData wrote', () => {
        const ctx = makeContext2D(20, 10);
        const img = ctx.createImageData(2, 2);
        //            R    G    B    A
        img.data.set([10, 20, 30, 40], 0);      // (0,0)
        img.data.set([50, 60, 70, 80], 4);      // (1,0)
        img.data.set([90, 100, 110, 120], 8);   // (0,1)
        img.data.set([130, 140, 150, 160], 12); // (1,1)
        ctx.putImageData(img, 5, 3);

        deep(pixelAt(ctx, 5, 3), [10, 20, 30, 40], 'the block lands at the given device offset');
        deep(pixelAt(ctx, 6, 3), [50, 60, 70, 80], '  and its second column');
        deep(pixelAt(ctx, 5, 4), [90, 100, 110, 120], '  and its second row');
        deep(pixelAt(ctx, 6, 4), [130, 140, 150, 160], '  and its far corner');
        deep(pixelAt(ctx, 4, 3), [0, 0, 0, 0], 'the pixel left of it is untouched');
        deep(pixelAt(ctx, 7, 3), [0, 0, 0, 0], '  and the pixel right of it');
        eq(pixelAt(ctx, 99, 0), null, 'and outside the buffer is null, not a wrong number');
    });

    /* putImageData ignores the CTM. Engine.ts states this and the ImageData
     * strategy depends on it: the box it computes is already device space. */
    attempt('putImageData ignores the transform', () => {
        const ctx = makeContext2D(20, 10);
        ctx.setTransform(3, 0, 0, 3, 7, 7);        // would move things if it applied
        const img = ctx.createImageData(1, 1);
        img.data.set([1, 2, 3, 4], 0);
        ctx.putImageData(img, 2, 2);
        deep(pixelAt(ctx, 2, 2), [1, 2, 3, 4], 'the pixel lands at 2,2 — raw device coordinates');
        deep(pixelAt(ctx, 13, 9), [0, 0, 0, 0], '  and not where the CTM would put it');
    });

    /* Done-when 2: the runs path's fillRect calls are recoverable, in order,
     * with their styles. */
    attempt('fillRect calls are recoverable in order, with styles and CTM', () => {
        const ctx = makeContext2D(20, 10);
        ctx.save();
        ctx.setTransform(2, 0, 0, 2, 1, 1);
        ctx.fillStyle = '#aabbcc';
        ctx.fillRect(0, 0, 3, 1);
        ctx.fillRect(5, 2, 1, 1);
        ctx.fillStyle = '#112233';
        ctx.fillRect(9, 4, 2, 2);
        ctx.restore();

        eq(ctx.fills.length, 3, 'three fills recorded');
        deep(ctx.fills.map((f) => f.fillStyle), ['#aabbcc', '#aabbcc', '#112233'],
            'each carries the style in effect at the time, in call order');
        deep([ctx.fills[0].x, ctx.fills[0].y, ctx.fills[0].w, ctx.fills[0].h], [0, 0, 3, 1],
            'the rect is stored as given — lattice space, which is what the runs path passes');
        deep(ctx.fills[2].transform, [2, 0, 0, 2, 1, 1],
            '  with the CTM in effect, so a caller can map it to device space itself');

        /* And the shim does NOT rasterise them: pixelAt sees only putImageData.
         * That separation is what lets a test tell which strategy ran. */
        deep(pixelAt(ctx, 1, 1), [0, 0, 0, 0],
            'fillRect leaves the pixel buffer alone — the two strategies stay distinguishable');
    });

    /*
     * setTransform REPLACES; it does not multiply. Every call site in Engine.ts
     * relies on that — renderGridRuns does save() then setTransform(lattice), and
     * if that composed with whatever was already there the grid would be drawn
     * through the device matrix twice.
     *
     * Two NON-IDENTITY transforms in sequence, because starting from the identity
     * makes replace and multiply indistinguishable — which is why the first version
     * of this section let a "multiplies instead of replacing" mutation survive.
     */
    attempt('setTransform replaces, it does not compose', () => {
        const ctx = makeContext2D(4, 4);
        ctx.setTransform(2, 0, 0, 2, 5, 5);
        ctx.setTransform(3, 0, 0, 3, 1, 1);
        const t = ctx.transform;
        deep([t.a, t.b, t.c, t.d, t.e, t.f], [3, 0, 0, 3, 1, 1],
            'the second call replaces the first outright');
        ok(!(t.a === 6 && t.e === 11),
            '  and is not 2x3 = 6 with a composed offset, which is what multiplying would give');
    });

    attempt('save and restore cover transform and fillStyle', () => {
        const ctx = makeContext2D(4, 4);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'outer';
        ctx.save();
        ctx.setTransform(9, 0, 0, 9, 9, 9);
        ctx.fillStyle = 'inner';
        ctx.restore();
        eq(ctx.fillStyle, 'outer', 'restore brings back the fill style');
        deep([ctx.transform.a, ctx.transform.e], [1, 0], '  and the transform');
        ctx.restore();
        eq(ctx.fillStyle, 'outer', 'an over-popped restore is a no-op, as in the browser');
    });

    attempt('clearRect zeroes pixels and is recorded', () => {
        const ctx = makeContext2D(6, 6);
        const img = ctx.createImageData(3, 3);
        img.data.fill(255);
        ctx.putImageData(img, 1, 1);
        deep(pixelAt(ctx, 2, 2), [255, 255, 255, 255], 'painted');
        ctx.clearRect(0, 0, 6, 6);
        deep(pixelAt(ctx, 2, 2), [0, 0, 0, 0], 'and cleared — clearRect DOES touch the buffer, '
            + 'because putImageData composes against what a clear left behind');
        eq(ctx.clears.length, 1, 'the clear is recorded too');
    });
});

section('10. the stubs drive the REAL renderGridLayer', () => {
    /*
     * The acceptance criterion, as in section 8 for the matrix. A correct stub that
     * `Engine.js` cannot run through is worth nothing, and LOD-3 is about to depend
     * on exactly this.
     */
    const placement = {
        colStepXmm: 1, colStepYmm: 0, rowStepXmm: 0, rowStepYmm: 1,
        originXmm: 0, originYmm: 0, cellWmm: 1, cellLmm: 1, cols: 4, rows: 3,
    };
    const grid = Engine.buildGridModel(placement, {
        cols: 4, rows: 3, cells: new Uint32Array([0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1]),
        codes: ['.', '1', '9'],
    }, null);
    ok(grid !== null && grid !== undefined, 'buildGridModel accepts a payload under the shims');

    /* renderGridLayer(ctx, grid, dev, paint, bitmapW, bitmapH, allowImageData) —
     * the fourth argument is a GridPaint from buildGridPaint, not a scale. */
    const COLORS = { pass: '#0a0', fail: '#a00', unknown: '#888', nullBin: 'transparent' };
    const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
    ok(paint !== null && paint !== undefined, 'buildGridPaint runs under the shims');

    attempt('the runs strategy records fills and does not blit', () => {
        const ctx = makeContext2D(64, 48);
        // 8 device px per cell: far above GRID_RUN_STRATEGY_PX (3), so runs wins.
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([8, 0, 0, 8, 0, 0]), paint, 64, 48, false);
        ok(ctx.fills.length > 0, `renderGridLayer took the RUNS path (${ctx.fills.length} fills)`);
        eq(ctx.puts.length, 0, '  and did not blit');
        ok(ctx.fills.every((f) => typeof f.fillStyle === 'string'),
            '  every fill carries a style string');
    });

    attempt('the ImageData strategy blits and does not fill', () => {
        const ctx = makeContext2D(64, 48);
        // 1 device px per cell: below the threshold, and allowImageData is true.
        Engine.renderGridLayer(ctx, grid, new DOMMatrix([1, 0, 0, 1, 0, 0]), paint, 64, 48, true);
        ok(ctx.puts.length > 0, `renderGridLayer took the IMAGEDATA path (${ctx.puts.length} blits)`);
        eq(ctx.fills.length, 0, '  and recorded no fills');
        ok(ctx.pixels.some((b) => b !== 0),
            '  and it wrote real pixels — pixelAt can now see what the aliasing test needs');
    });
});

finish();
