/*
 * dom-shims.mjs - the browser geometry surface, for Node.
 *
 * WHY THIS EXISTS. Every render function in `Engine.ts` is unreachable from a test
 * today, not because it is untestable but because Node has no `DOMMatrix`, no
 * `DOMPoint`, no `ImageData` and no canvas context. `latticeMatrix`,
 * `makeWorldMatrix`, `deviceMatrix`, `buildGridPaint`, `renderGridLayer` and
 * `getCellAtPos` are consequently verified by looking at screenshots. That is the
 * whole blocker, and it is about 200 lines wide.
 *
 * SCOPE IS MEASURED, NOT GUESSED. Grepped from the shipped code, the entire
 * geometry surface it depends on is:
 *
 *   new DOMMatrix()            new DOMMatrix([a, b, c, d, e, f])
 *   multiply  multiplySelf  translateSelf  scaleSelf  rotateSelf  transformPoint
 *   new DOMPoint(x, y)
 *   inverse                                                       (W-3a)
 *   new Path2D()  moveTo lineTo closePath rect arc ellipse addPath (W-3a)
 *   new Path2D(d) for `M L C Z` and their implicit repeats            (W-3b)
 *
 * Nothing else is implemented. `flipX`, `skewXSelf` and the rest are absent on
 * purpose: a shim that implements more than the code uses is a second
 * implementation of a browser, and the untested parts of it will be wrong exactly
 * when someone starts relying on them.
 *
 * `inverse` and `Path2D` were added by `W-3a`, because `getItemAtPos` needs both
 * and until then no test in this repository could observe an item hit at all:
 * `isPointInPath` and `isPointInStroke` returned `false` unconditionally, which is
 * byte-identical to *the pointer missed*, so every assertion written against them
 * passed vacuously (observation 160).
 *
 * WHAT STILL REFUSES matters more than what works, and WHERE it refuses is the
 * part that took a try to get right. `W-3a`'s first attempt threw in the Path2D
 * CONSTRUCTOR and took eleven suites down with it: every outline preset is a
 * `type: 'path'` geometry, so `buildOutlineModel` builds a `d` string on almost
 * every bind, and none of those paths is ever hit-tested.
 *
 * Building a path and answering a question about one are different acts. A `d`
 * string that cannot be parsed is therefore RECORDED and costs nothing until
 * something probes it, at which point both predicates throw and name the command
 * that stopped them. The rule is not "throw early"; it is **never answer a
 * question you cannot answer** - a hit tester that says "no" for a shape it never
 * parsed is observation 160 one level in, which is why this file grew at all.
 *
 * `W-3b` parses `M L C Z`, which is the whole of `SWEEP_UNIT` - the demo die - and
 * flattens its cubics. Everything else keeps the `W-3a` treatment: `A` in
 * particular is what every disc-flats outline preset emits, it is built on nearly
 * every bind, and it is never hit-tested, so parsing it would be a branch nothing
 * exercises. It is recorded and refused on probe, by name.
 *
 * THE ONE THING THAT MATTERS MOST is composition order, because it is the thing a
 * hand-rolled matrix class gets backwards and the thing every render bug would
 * then be blamed on instead. `A.multiply(B)` returns A·B, which applied to a point
 * applies **B first**. The `*Self` methods POST-multiply, so
 * `m.translateSelf(2, 0).scaleSelf(3, 3)` scales before it translates - the
 * opposite of how it reads. Both are asserted against hand-computed literals in
 * `dom-shims.test.mjs`, never against this file's own output.
 *
 * NOT SHIPPED. This file lives under `tests/` and nothing outside `tests/` may
 * import it; `check-hmiextproj.mjs` would notice if it moved.
 */

/** 2D affine matrix, `a c e / b d f / 0 0 1`, matching the browser's `DOMMatrix`. */
export class DOMMatrix {
    /**
     * @param init Omitted for the identity, or `[a, b, c, d, e, f]`.
     */
    constructor(init) {
        if (init === undefined) {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        } else if (Array.isArray(init) && init.length === 6) {
            [this.a, this.b, this.c, this.d, this.e, this.f] = init.map(Number);
        } else {
            // Deliberately loud. The browser also accepts a 16-element array, a
            // CSS transform string and another matrix; the shipped code uses
            // neither, so accepting them here would be implementing a browser
            // rather than covering the code.
            throw new TypeError(
                'DOMMatrix shim: only new DOMMatrix() and new DOMMatrix([a,b,c,d,e,f]) are '
                + 'implemented, because they are the only forms the shipped code uses.');
        }
    }

    /**
     * Multiplies this by `other`, mutating this. Post-multiply: `this = this · other`.
     * @param other The right-hand matrix.
     * @returns This, for chaining.
     */
    multiplySelf(other) {
        const { a, b, c, d, e, f } = this;
        this.a = a * other.a + c * other.b;
        this.b = b * other.a + d * other.b;
        this.c = a * other.c + c * other.d;
        this.d = b * other.c + d * other.d;
        this.e = a * other.e + c * other.f + e;
        this.f = b * other.e + d * other.f + f;
        return this;
    }

    /**
     * `this · other` as a NEW matrix; neither operand is modified.
     *
     * Applied to a point, `other` acts first. That is the browser's order and the
     * reason `deviceMatrix().multiply(latticeMatrix(p))` means "lattice, then
     * device" rather than the reverse.
     * @param other The right-hand matrix.
     * @returns A new matrix.
     */
    multiply(other) {
        return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(other);
    }

    /**
     * Post-multiplies a translation.
     * @param tx X offset.
     * @param ty Y offset, default 0.
     * @returns This.
     */
    translateSelf(tx, ty = 0) {
        return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: Number(tx), f: Number(ty) });
    }

    /**
     * Post-multiplies a scale.
     * @param sx X factor.
     * @param sy Y factor; defaults to `sx`, as the browser does.
     * @returns This.
     */
    scaleSelf(sx, sy = sx) {
        return this.multiplySelf({ a: Number(sx), b: 0, c: 0, d: Number(sy), e: 0, f: 0 });
    }

    /**
     * Post-multiplies a rotation, in DEGREES.
     *
     * Degrees, not radians, because that is what `DOMMatrix` takes and what the
     * shipped code passes. Positive angles turn +x toward +y, which on a canvas
     * (y down) reads as clockwise.
     * @param deg Angle in degrees.
     * @returns This.
     */
    rotateSelf(deg) {
        const r = (Number(deg) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        return this.multiplySelf({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    }

    /**
     * Transforms a point.
     * @param p Anything with `x` and `y`.
     * @returns A new {@link DOMPoint}.
     */
    transformPoint(p) {
        const x = Number(p.x);
        const y = Number(p.y);
        return new DOMPoint(this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f);
    }

    /**
     * The inverse of this matrix, as a new matrix. This one is unchanged.
     *
     * Needed by `isPointInPath` / `isPointInStroke`: the pointer arrives in canvas
     * pixels and the path is in user space, so exactly one of the two has to move,
     * and the browser moves the pointer.
     *
     * THROWS on a singular matrix rather than returning the identity. A degenerate
     * CTM means nothing was painted; an identity here would quietly test the
     * pointer against an untransformed path, so every probe would answer about the
     * wrong place with nothing to show for it.
     * @returns A new inverted matrix.
     */
    inverse() {
        const det = this.a * this.d - this.b * this.c;
        if (!Number.isFinite(det) || det === 0) {
            throw new RangeError(
                `DOMMatrix shim: [${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f}] `
                + `is singular (determinant ${det}) and cannot be inverted.`);
        }
        return new DOMMatrix([
            this.d / det,
            -this.b / det,
            -this.c / det,
            this.a / det,
            (this.c * this.f - this.d * this.e) / det,
            (this.b * this.e - this.a * this.f) / det,
        ]);
    }
}

/* ======================================================================== *
 *  Path2D (W-3a)
 *
 *  Every subpath is kept as a FLATTENED POLYLINE. Curves are approximated once,
 *  at record time, and both predicates then work on line segments only - which is
 *  what keeps them short enough to check by hand.
 *
 *  The flattening error is bounded and stated rather than hoped for: an arc is
 *  cut into `ARC_SEGMENTS_PER_TURN` chords per full turn, so a chord sits at most
 *  `r * (1 - cos(pi / N))` inside the true curve. At N = 128 that is 3.0e-4 * r,
 *  which for the reference page's 5 mm circle is 1.5 micrometres. An assertion
 *  has to stay further from a curved boundary than that, and the suite says so
 *  where it matters.
 * ======================================================================== */

/** Chords per full turn when flattening an arc or an ellipse. */
const ARC_SEGMENTS_PER_TURN = 128;

const TAU = Math.PI * 2;

/**
 * The signed sweep of a canvas arc, in radians.
 *
 * The rule is the canvas spec's rather than the obvious one: a clockwise arc
 * whose end is more than a full turn past its start is CLAMPED to one turn, and
 * otherwise the difference is taken modulo a turn. Getting it wrong turns a full
 * circle into a zero-length arc, which then answers "missed" everywhere inside
 * the circle it was supposed to be.
 * @param start Start angle. @param end End angle. @param ccw Counter-clockwise.
 * @returns The sweep; negative when counter-clockwise.
 */
function sweepOf(start, end, ccw) {
    const raw = end - start;
    if (!ccw) {
        return raw >= TAU ? TAU : ((raw % TAU) + TAU) % TAU;
    }
    return raw <= -TAU ? -TAU : -((((-raw) % TAU) + TAU) % TAU);
}

/** Raised by {@link parseD} for a command this shim does not implement. */
class UnsupportedPathCommand extends Error {
    /** @param command The offending letter. */
    constructor(command) {
        super(`SVG path command "${command}" is not implemented by the Path2D shim.`);
        this.command = command;
    }
}

/**
 * Segments per cubic is DERIVED, not chosen: enough that the flattened polyline
 * stays within `CUBIC_TOLERANCE_RATIO` of the true curve, relative to the curve's
 * own size.
 *
 * THE BOUND, written out because the first version of it was wrong by a factor of
 * six and the suite caught it. A chord spanning a parameter step `dt` deviates
 * from the curve by at most `max|B''| * dt^2 / 8`, and for a cubic
 * `B''(t) = 6(1-t)(P0 - 2 P1 + P2) + 6 t (P1 - 2 P2 + P3)`, so `max|B''| = 6 D`
 * with `D` the larger of those two second differences. With `dt = 1/n` that is
 * `3 D / (4 n^2)`, and requiring it under `tol` gives the count below. The
 * omitted 6 made every count too small by a factor of two and a half.
 *
 * Relative rather than absolute because user space here is millimetres for a
 * 1 mm die and millimetres for a 300 mm wafer, and one absolute constant cannot
 * serve both. At 1e-3 of a curve's own extent, a demo die's rounding cubics are
 * flattened to well under a nanometre of the substrate frame - four orders below
 * a device pixel at any zoom this control reaches.
 */
const CUBIC_TOLERANCE_RATIO = 1e-3;

/** Hard bounds on that count, so a degenerate control polygon cannot run away. */
const CUBIC_MIN_SEGMENTS = 4;
const CUBIC_MAX_SEGMENTS = 128;

/**
 * Parses the `M L C Z` subset of an SVG `d` string into `target`.
 *
 * That subset is not arbitrary: it is exactly what `SWEEP_UNIT` - the demo die -
 * is made of, and the demo is what `ShowDemoItems` puts on screen by default.
 * Implicit repetition is honoured because the SVG grammar has it (a second
 * coordinate pair after `M` is an `L`), even though `serializeCommand` always
 * writes the letter.
 * @param d      The path data.
 * @param target The Path2D being built.
 * @returns Nothing.
 * @throws {UnsupportedPathCommand} On any other command letter.
 */
function parseD(d, target) {
    const tokens = String(d).match(/[MLCZmlczHhVvSsTtQqAa]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
    let i = 0;
    let cmd = null;
    /** @returns The next number. */
    const num = () => {
        const t = tokens[i++];
        const v = Number(t);
        if (t === undefined || Number.isNaN(v)) {
            throw new SyntaxError(`Path2D shim: malformed \`d\` near token ${i} of ${tokens.length}.`);
        }
        return v;
    };
    while (i < tokens.length) {
        if (/^[A-Za-z]$/.test(tokens[i])) {
            cmd = tokens[i++];
        } else if (cmd === 'M') {
            cmd = 'L';                      // implicit lineto after a moveto
        } else if (cmd === null) {
            throw new SyntaxError('Path2D shim: `d` starts with a number rather than a command.');
        }
        switch (cmd) {
            case 'M': target.moveTo(num(), num()); break;
            case 'L': target.lineTo(num(), num()); break;
            case 'C': cubicTo(target, num(), num(), num(), num(), num(), num()); break;
            case 'Z':
            case 'z': target.closePath(); break;
            default: throw new UnsupportedPathCommand(cmd);
        }
    }
}

/**
 * Appends a cubic Bezier as chords, from the path's current point.
 * @param target Path being built. @param x1 Control 1 x. @param y1 Control 1 y.
 * @param x2 Control 2 x. @param y2 Control 2 y. @param x Endpoint x. @param y Endpoint y.
 * @returns Nothing.
 */
function cubicTo(target, x1, y1, x2, y2, x, y) {
    if (target.__cur === null) { target.moveTo(x1, y1); }
    const [x0, y0] = target.__cur.points[target.__cur.points.length - 1];
    // The two second differences of the control polygon; the deviation bound is
    // stated on CUBIC_TOLERANCE_RATIO above.
    const dev = Math.max(
        Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
        Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y));
    const extent = Math.max(
        Math.max(x0, x1, x2, x) - Math.min(x0, x1, x2, x),
        Math.max(y0, y1, y2, y) - Math.min(y0, y1, y2, y),
        Number.MIN_VALUE);
    const tol = CUBIC_TOLERANCE_RATIO * extent;
    // n >= sqrt(3 D / (4 tol)); see CUBIC_TOLERANCE_RATIO for where the 3/4 is from.
    const n = Math.min(CUBIC_MAX_SEGMENTS,
        Math.max(CUBIC_MIN_SEGMENTS, Math.ceil(Math.sqrt((3 * dev) / (4 * tol)))));
    for (let k = 1; k <= n; k++) {
        const [px, py] = cubicAt(t0(k, n), [x0, y0], [x1, y1], [x2, y2], [x, y]);
        target.lineTo(px, py);
    }
}

/** @param k Step. @param n Steps. @returns The parameter. */
const t0 = (k, n) => k / n;

/**
 * A cubic Bezier evaluated from its definition, used both to flatten and - in the
 * suite - to measure how far the flattening strayed. Bernstein form, written out.
 * @param t  Parameter in `[0, 1]`.
 * @param p0 Start. @param p1 Control 1. @param p2 Control 2. @param p3 End.
 * @returns `[x, y]`.
 */
export function cubicAt(t, p0, p1, p2, p3) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    return [
        a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
    ];
}

/**
 * A recorded path, matching the browser's `Path2D` for what the shipped code
 * builds. Subpaths are flattened polylines: `{ points: [[x, y], ...], closed }`.
 */
export class Path2D {
    /**
     * @param init Omitted, or an SVG `d` string.
     */
    constructor(init) {
        /** @type {Array<{ points: number[][], closed: boolean }>} */
        this.subpaths = [];
        this.__cur = null;
        this.__start = null;
        /** The `d` string, when one could not be parsed. Both predicates refuse it. */
        this.unparsed = null;
        /** The command that stopped the parse, for the refusal message. */
        this.unsupported = null;
        if (init === undefined) { return; }
        if (typeof init !== 'string') {
            throw new TypeError('Path2D shim: only new Path2D() and new Path2D(d) exist here.');
        }
        try {
            parseD(init, this);
        } catch (err) {
            // NOT an error yet. Outline presets build an `A`-carrying `d` string on
            // nearly every bind and none of them is hit-tested; refusing here would
            // take eleven suites down for paths nobody asks about. The refusal
            // belongs where an ANSWER would be invented - see the header.
            if (!(err instanceof UnsupportedPathCommand)) { throw err; }
            this.subpaths = [];
            this.__cur = null;
            this.__start = null;
            this.unparsed = init;
            this.unsupported = err.command;
        }
    }

    /** @param x X. @param y Y. @returns Nothing. */
    moveTo(x, y) {
        this.__start = [Number(x), Number(y)];
        this.__cur = { points: [this.__start.slice()], closed: false };
        this.subpaths.push(this.__cur);
    }

    /** @param x X. @param y Y. @returns Nothing. */
    lineTo(x, y) {
        // With no current subpath the browser treats the first lineTo as a moveTo,
        // and after closePath a new segment opens at the closed subpath's origin.
        if (this.__cur === null) {
            this.moveTo(...(this.__start ?? [Number(x), Number(y)]));
        }
        this.__cur.points.push([Number(x), Number(y)]);
    }

    /** @returns Nothing. */
    closePath() {
        if (this.__cur === null || this.__cur.points.length === 0) { return; }
        this.__cur.closed = true;
        this.__start = this.__cur.points[0].slice();
        this.__cur = null;
    }

    /**
     * @param x Corner x. @param y Corner y. @param w Width. @param h Height.
     * @returns Nothing.
     */
    rect(x, y, w, h) {
        const X = Number(x), Y = Number(y), W = Number(w), H = Number(h);
        this.subpaths.push({ points: [[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]], closed: true });
        // Per spec `rect` adds a CLOSED subpath and leaves the current point at the
        // corner; it does not stay open for further segments.
        this.__cur = null;
        this.__start = [X, Y];
    }

    /**
     * @param cx Centre x. @param cy Centre y. @param r Radius.
     * @param start Start angle, radians. @param end End angle. @param ccw Counter-clockwise.
     * @returns Nothing.
     */
    arc(cx, cy, r, start, end, ccw = false) {
        this.ellipse(cx, cy, r, r, 0, start, end, ccw);
    }

    /**
     * @param cx Centre x. @param cy Centre y. @param rx X radius. @param ry Y radius.
     * @param rot Rotation of the x axis, radians.
     * @param start Start angle. @param end End angle. @param ccw Counter-clockwise.
     * @returns Nothing.
     */
    ellipse(cx, cy, rx, ry, rot, start, end, ccw = false) {
        const CX = Number(cx), CY = Number(cy), RX = Number(rx), RY = Number(ry);
        const ROT = Number(rot), A0 = Number(start);
        const delta = sweepOf(A0, Number(end), Boolean(ccw));
        const n = Math.max(2, Math.ceil((Math.abs(delta) / TAU) * ARC_SEGMENTS_PER_TURN));
        const cosR = Math.cos(ROT), sinR = Math.sin(ROT);
        /** @param t Angle. @returns The point on the ellipse. */
        const at = (t) => {
            const px = RX * Math.cos(t), py = RY * Math.sin(t);
            return [CX + px * cosR - py * sinR, CY + px * sinR + py * cosR];
        };
        // An arc reached with a current point is JOINED to it by a straight segment,
        // as in the browser. Dropping that edge would change the winding of every
        // path that draws into an arc.
        if (this.__cur === null) { this.moveTo(...at(A0)); } else { this.lineTo(...at(A0)); }
        for (let i = 1; i <= n; i++) {
            this.lineTo(...at(A0 + (delta * i) / n));
        }
    }

    /**
     * Appends another path's subpaths to this one.
     * @param other The path to append.
     * @param m     Optional transform applied to its points.
     * @returns Nothing.
     */
    addPath(other, m) {
        if (!(other instanceof Path2D)) {
            throw new TypeError('Path2D shim: addPath takes a Path2D.');
        }
        if (other.unparsed !== null && this.unparsed === null) {
            this.unparsed = other.unparsed;
            this.unsupported = other.unsupported;
        }
        for (const sp of other.subpaths) {
            const points = m === undefined
                ? sp.points.map((p) => p.slice())
                : sp.points.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
            this.subpaths.push({ points, closed: sp.closed });
        }
        this.__cur = null;
    }
}

/*
 * How an `Image` shim resolves a load. `'ready'` fires `onload`, `'error'` fires
 * `onerror`, `'pending'` does neither until a test says so.
 *
 * SYNCHRONOUS, and that is a deliberate departure from the browser: a real
 * `Image` resolves on a later task, and a suite that had to await one would be
 * asserting about a scheduler. What is under test is what the control DOES with
 * a load result, not when the result arrives - and the control's own code path
 * is identical either way, because it goes through the same callback.
 */
let imageOutcome = 'ready';

/**
 * Decides how the next {@link Image} loads. Test-only.
 *
 * A FUNCTION OF THE SOURCE is accepted as well as a bare outcome, and the
 * fallback path is why: a control whose custom image fails loads the shipped one
 * next, and a global outcome fails that too - so the assertion can only ever see
 * "nothing drawn", never "the shipped image drawn instead". Per-source control
 * is what makes the difference between the two visible.
 * @param outcome `'ready'`, `'error'`, `'pending'`, or `(src) => one of those`.
 * @returns Nothing.
 */
export function setImageOutcome(outcome) {
    imageOutcome = outcome;
}

/** @param src The source being loaded. @returns The outcome for it. */
function outcomeFor(src) {
    return typeof imageOutcome === 'function' ? imageOutcome(src) : imageOutcome;
}

/** Natural size the next successful load reports. */
let imageNatural = { width: 252, height: 213 };

/**
 * Sets the natural size the next successful {@link Image} load reports.
 * @param width Natural width. @param height Natural height.
 * @returns Nothing.
 */
export function setImageNatural(width, height) {
    imageNatural = { width, height };
}

/**
 * The browser's `Image`, for the members the empty state uses (W-15b).
 *
 * `src` is a setter: assigning it starts the load, exactly as in the browser,
 * which is the behaviour a control relies on and the one a naive shim gets
 * wrong by making `src` a plain field.
 */
export class Image {
    /** @param width Optional width. @param height Optional height. */
    constructor(width, height) {
        this.__src = '';
        this.naturalWidth = width ?? 0;
        this.naturalHeight = height ?? 0;
        this.complete = false;
        this.onload = null;
        this.onerror = null;
    }

    /** @returns The source. */
    get src() { return this.__src; }

    /** @param value A URL. Assigning it starts the load. */
    set src(value) {
        this.__src = String(value);
        const outcome = outcomeFor(this.__src);
        if (outcome === 'pending') { return; }
        if (outcome === 'error') {
            this.complete = false;
            if (typeof this.onerror === 'function') { this.onerror(new Error('shim: load failed')); }
            return;
        }
        this.naturalWidth = imageNatural.width;
        this.naturalHeight = imageNatural.height;
        this.complete = true;
        if (typeof this.onload === 'function') { this.onload(); }
    }
}

/**
 * Every observation currently live, across all {@link ResizeObserver} instances.
 *
 * A LEAK IS A COUNT, not an object graph. `W-26`'s second Done-when asks that
 * teardown leave no observer attached, and the only way to see that is to keep
 * the ledger outside the observers - an observer that is dropped without being
 * disconnected has nobody left to ask.
 */
export const liveObservations = new Set();

/**
 * The browser's `ResizeObserver`, for the three methods the base uses (W-26).
 *
 * It never fires. What is under test is the LIFECYCLE - that `__attach` starts
 * an observation and `__detach` ends it - and a shim that invented resize events
 * would be testing a scheduler.
 */
export class ResizeObserver {
    /** @param callback Ignored: this shim never fires. */
    constructor(callback) {
        this.callback = callback;
        /** Targets this instance is watching. */
        this.targets = new Set();
    }

    /** @param target The element to watch. @returns Nothing. */
    observe(target) {
        this.targets.add(target);
        liveObservations.add(this);
    }

    /** @param target The element to stop watching. @returns Nothing. */
    unobserve(target) {
        this.targets.delete(target);
        if (this.targets.size === 0) { liveObservations.delete(this); }
    }

    /** @returns Nothing. */
    disconnect() {
        this.targets.clear();
        liveObservations.delete(this);
    }
}

/** A 2D point, matching the browser's `DOMPoint` for the fields this code reads. */
export class DOMPoint {
    /**
     * @param x X.
     * @param y Y.
     */
    constructor(x = 0, y = 0) {
        this.x = Number(x);
        this.y = Number(y);
        this.z = 0;
        this.w = 1;
    }
}

/**
 * Installs the shims as globals, if they are not already there.
 *
 * Individually, never as one object: a suite may already have defined part of the
 * environment, and a whole-object `??=` would silently skip the rest — the defect
 * that broke `attach-harness.mjs` on its first reuse (observation 54).
 * @returns Nothing.
 */
export function installDomShims() {
    globalThis.DOMMatrix ??= DOMMatrix;
    globalThis.DOMPoint ??= DOMPoint;
    globalThis.Path2D ??= Path2D;
    globalThis.Image ??= Image;
    globalThis.ResizeObserver ??= ResizeObserver;
}

/* ======================================================================== *
 *  ImageData and a recording Context2D (LOD-2)
 *
 *  SCOPE, measured the same way the matrix surface was. `renderGridLayer` and
 *  the two renderers it dispatches to touch exactly seven members:
 *
 *    createImageData  putImageData  fillRect  fillStyle  setTransform  save  restore
 *
 *  plus `clearRect`, which the control uses around them. Nothing else is here.
 *  `Path2D`, `fillText`, `arc` and `stroke` are outline and label work and stay
 *  out (D-067: a shim that implements more than the code uses is a second
 *  implementation of a browser, wrong exactly where someone first relies on it).
 *
 *  ---- THE ONE THING THAT DECIDES THE DESIGN ----
 *
 *  The two render strategies write through DIFFERENT mechanisms, and the shim
 *  keeps them separate on purpose:
 *
 *    renderGridRuns       save -> setTransform(lattice) -> fillStyle -> fillRect
 *                         Rects are in LATTICE coordinates and the CTM maps them.
 *    renderGridImageData  createImageData -> ... -> putImageData(img, x0, y0)
 *                         `putImageData` IGNORES the CTM - Engine.ts says so - and
 *                         writes raw DEVICE pixels.
 *
 *  So `putImageData` blits into a device-space buffer that `pixelAt` reads, and
 *  `fillRect` is RECORDED rather than rasterised into that same buffer. Not
 *  laziness: `GRID_RUN_STRATEGY_PX` chooses between the two, and LOD-3 has to
 *  assert that switch from both sides. If both strategies deposited pixels in one
 *  buffer, a test could not tell which one ran - it would pass on either, which is
 *  the vacuous-assertion failure this project has already shipped twice.
 *
 *  A test wanting device rects from the runs path can compute them: every recorded
 *  fill carries the CTM that was in effect.
 * ======================================================================== */

/** A pixel buffer, matching the browser's `ImageData` for what this code reads. */
export class ImageData {
    /**
     * @param width  Width in pixels.
     * @param height Height in pixels.
     */
    constructor(width, height) {
        this.width = Number(width);
        this.height = Number(height);
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
}

/**
 * A recording 2D context over a device-space pixel buffer.
 *
 * Records what it is told and stores what is blitted; it does not rasterise. See
 * the block comment above for why those are different things here.
 */
export class RecordingContext2D {
    /**
     * @param width  Device width.
     * @param height Device height.
     */
    constructor(width, height) {
        this.width = Number(width);
        this.height = Number(height);
        /** Device-space pixels, written only by {@link putImageData}. */
        this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
        /** Current transform. `setTransform` replaces it; it never accumulates. */
        this.transform = new DOMMatrix();
        this.__fillStyle = '';
        /** Every `fillRect`, in call order, each with the style and CTM in effect. */
        this.fills = [];
        /*
         * Every `strokeRect`, with the dash in force when it ran (W-30).
         *
         * A RECORD rather than a counter, because the thing under test is that the
         * stale marking is a BORDER: its geometry and its dash are the claim, and a
         * count would pass for a filled rectangle over the whole tile. The fifth
         * surface this shim could not see, after isPointInPath, drawImage, fillText
         * and ResizeObserver.
         */
        this.strokeRects = [];
        /** How many `stroke()` calls, separate from the combined counter. */
        this.strokeCount = 0;
        /** Every filled arc: centre, radius, angles and colour (W-36). */
        this.arcFills = [];
        /** The arc awaiting a `fill`, if any. */
        this.__pendingArc = null;
        /** The current dash pattern; `[]` is solid, as in the browser. */
        this.lineDash = [];
        /** Every `clearRect`, in call order. */
        this.clears = [];
        /** Every `putImageData`, in call order. */
        this.puts = [];
        /** Path-building and text counters, so a caller can tell a frame happened. */
        this.paths = 0;
        this.strokesAndFills = 0;
        this.texts = 0;
        this.images = 0;
        /** Every text draw: `{ text, x, y, font, fillStyle, align }` (W-17). */
        this.textDraws = [];
        /**
         * Every image draw, with its destination rect: `{ src, natural, dest }`.
         * A counter cannot answer a question about geometry (W-15b).
         */
        this.imageDraws = [];
        /* Stroke and text state the engine sets; recorded, never interpreted. */
        this.strokeStyle = '';
        this.__lineWidth = 1;
        this.lineJoin = 'miter';
        this.lineCap = 'butt';
        this.font = '';
        this.textAlign = 'start';
        this.textBaseline = 'alphabetic';
        this.globalAlpha = 1;
        this.__stack = [];
    }

    /**
     * The current fill style.
     *
     * NORMALISED ON WRITE, because a real canvas does and `Engine.ts` depends on
     * it. `normalizeColor` sets `fillStyle` to a colour against two different
     * backgrounds and compares what comes back; `packColor` then requires exactly
     * `#rrggbb` or `rgb()/rgba()`. A stub that stored `'#0a0'` verbatim round-trips
     * fine and then fails `packColor`, which sets `paint.rgba` to null, which makes
     * `renderGridLayer` take the RUNS path for ever. The ImageData strategy - the
     * one this whole feature exists to fix - would have been unreachable from a
     * test, and the failure would have looked like the dispatcher's fault.
     *
     * `#rgb` expands and everything else passes through: the browser lowercases and
     * canonicalises far more (named colours, `hsl()`), and none of it is on this
     * code's path.
     */
    /**
     * Stroke width in user units.
     *
     * IGNORES an assignment that is zero, negative, infinite or NaN, leaving the
     * previous value in place. That is the canvas specification, and it is not a
     * curiosity: the browser capture in `fixtures/hit-oracle.json` probes width 0
     * and Chrome answered with whatever width was set before it. Without this the
     * shim answered about a zero-width stroke and disagreed with the capture 1 089
     * times - all of them this one rule.
     * @returns The current width.
     */
    /** @param segments The dash pattern. @returns Nothing. */
    setLineDash(segments) { this.lineDash = Array.isArray(segments) ? [...segments] : []; }

    /** @returns A copy of the dash pattern, as the browser returns. */
    getLineDash() { return [...this.lineDash]; }

    /**
     * @param x Left. @param y Top. @param w Width. @param h Height.
     * @returns Nothing.
     */
    strokeRect(x, y, w, h) {
        this.strokeRects.push({
            x, y, w, h,
            lineWidth: this.__lineWidth,
            strokeStyle: String(this.strokeStyle),
            dash: [...this.lineDash],
            /* the CTM, so a stroked rect can be compared in the same space as a
             * fill - which is what `F-28a` needed and could not do. */
            transform: [this.transform.a, this.transform.b, this.transform.c,
                this.transform.d, this.transform.e, this.transform.f],
        });
    }

    get lineWidth() { return this.__lineWidth; }

    /** @param v The requested width. */
    set lineWidth(v) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) { this.__lineWidth = n; }
    }

    get fillStyle() { return this.__fillStyle; }

    set fillStyle(v) {
        const s = String(v);
        this.__fillStyle = /^#[0-9a-fA-F]{3}$/.test(s)
            ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase()
            : (/^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : s);
    }

    /**
     * @param w Width.
     * @param h Height.
     * @returns A zero-filled {@link ImageData}.
     */
    createImageData(w, h) { return new ImageData(w, h); }

    /**
     * Reads a rectangle back out of the device buffer.
     *
     * Added at W-5, because the bucket pass composites by reading the destination,
     * blending and writing the same rect. A shim that could only be written to
     * would have made the composite path untestable - and the whole point of W-5
     * is a pixel assertion that the substrate body survives underneath.
     *
     * Out-of-bounds pixels read as transparent black, as in the browser.
     * @param x0 Left in device pixels. @param y0 Top.
     * @param w  Width. @param h Height.
     * @returns The pixels.
     */
    getImageData(x0, y0, w, h) {
        const out = new ImageData(w, h);
        const X = Math.round(x0);
        const Y = Math.round(y0);
        for (let y = 0; y < h; y++) {
            const ty = Y + y;
            if (ty < 0 || ty >= this.height) { continue; }
            for (let x = 0; x < w; x++) {
                const tx = X + x;
                if (tx < 0 || tx >= this.width) { continue; }
                const from = (ty * this.width + tx) * 4;
                const to = (y * w + x) * 4;
                out.data[to] = this.pixels[from];
                out.data[to + 1] = this.pixels[from + 1];
                out.data[to + 2] = this.pixels[from + 2];
                out.data[to + 3] = this.pixels[from + 3];
            }
        }
        return out;
    }

    /**
     * Blits an {@link ImageData} at raw device coordinates, ignoring the CTM.
     *
     * Clipped at the buffer edges rather than throwing: the browser does the same,
     * and a renderer that computes a box one pixel too large should be caught by an
     * assertion about the pixels, not by an exception from the harness.
     * @param img ImageData to write.
     * @param dx  Device x.
     * @param dy  Device y.
     * @returns Nothing.
     */
    putImageData(img, dx, dy) {
        const x0 = Math.round(Number(dx));
        const y0 = Math.round(Number(dy));
        this.puts.push({ x: x0, y: y0, width: img.width, height: img.height });
        for (let y = 0; y < img.height; y++) {
            const ty = y0 + y;
            if (ty < 0 || ty >= this.height) { continue; }
            for (let x = 0; x < img.width; x++) {
                const tx = x0 + x;
                if (tx < 0 || tx >= this.width) { continue; }
                const s = (y * img.width + x) * 4;
                const d = (ty * this.width + tx) * 4;
                this.pixels[d] = img.data[s];
                this.pixels[d + 1] = img.data[s + 1];
                this.pixels[d + 2] = img.data[s + 2];
                this.pixels[d + 3] = img.data[s + 3];
            }
        }
    }

    /**
     * Records a fill. The rect is stored AS GIVEN — in whatever space the CTM
     * implies — together with that CTM, so a caller can map it to device space
     * without this shim guessing which space it wanted.
     * @param x Rect x.
     * @param y Rect y.
     * @param w Rect width.
     * @param h Rect height.
     * @returns Nothing.
     */
    fillRect(x, y, w, h) {
        const t = this.transform;
        this.fills.push({
            x: Number(x), y: Number(y), w: Number(w), h: Number(h),
            fillStyle: this.fillStyle,
            transform: [t.a, t.b, t.c, t.d, t.e, t.f],
        });
    }

    /**
     * Records a clear, and zeroes the affected pixels.
     *
     * Unlike `fillRect` this DOES touch the buffer, because clearing is what
     * `putImageData` composes against and a test asking "is this pixel background"
     * after a clear should get the answer the browser would give.
     * @param x Rect x.
     * @param y Rect y.
     * @param w Rect width.
     * @param h Rect height.
     * @returns Nothing.
     */
    clearRect(x, y, w, h) {
        this.clears.push({ x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
        for (let ty = Math.max(0, Math.floor(y)); ty < Math.min(this.height, y + h); ty++) {
            for (let tx = Math.max(0, Math.floor(x)); tx < Math.min(this.width, x + w); tx++) {
                this.pixels.fill(0, (ty * this.width + tx) * 4, (ty * this.width + tx) * 4 + 4);
            }
        }
    }

    /**
     * Replaces the transform. Does NOT multiply — the browser's `setTransform`
     * replaces, and every call site in `Engine.ts` relies on that.
     * @param a Component a.
     * @param b Component b.
     * @param c Component c.
     * @param d Component d.
     * @param e Component e.
     * @param f Component f.
     * @returns Nothing.
     */
    setTransform(a, b, c, d, e, f) { this.transform = new DOMMatrix([a, b, c, d, e, f]); }

    /* ---------------------------------------------------------------- *
     * The outline and label surface, as SINKS.
     *
     * Task 16 needed a whole scene drawn, not just the grid layer: the reference
     * panels have substrate outlines and labels, and `drawSubstrateMap` strokes
     * and fills paths through them. These record that they were called and draw
     * nothing.
     *
     * D-067's rule still holds - a shim that implements more than the code uses is
     * a second implementation of a browser, wrong exactly where someone first
     * relies on it. What changed is the MEASURED surface: `renderOnce` drives the
     * full scene now, so the full scene's members are what the code uses. They are
     * sinks rather than implementations because geometry that only reaches a path
     * is not verifiable here and pretending otherwise would be worse than the gap.
     * ---------------------------------------------------------------- */

    /** @returns Nothing. */ beginPath() { this.paths++; this.__pendingArc = null; }
    /** @returns Nothing. */ closePath() { }
    /** @returns Nothing. */ moveTo() { }
    /** @returns Nothing. */ lineTo() { }

    /*
     * ---- ARCS ARE RECORDED, BECAUSE W-36 DRAWS WITH THEM (sixth surface) ----
     *
     * The note above says path geometry is not verifiable here, and that was true
     * while nothing drew with a path. A pie segment IS its geometry: its start
     * angle, its sweep and the order the sweeps run in are the claim - that they
     * go clockwise from twelve, in the same order as the bars - and none of that
     * survives a counter.
     *
     * Only the LAST arc before a `fill` is kept, which is exactly the shape a
     * wedge takes: `beginPath`, `moveTo` the centre, one `arc`, `fill`. A path
     * with several arcs records none of them rather than guessing which mattered.
     */
    /**
     * @param cx Centre x. @param cy Centre y. @param r Radius.
     * @param start Start angle. @param end End angle. @param ccw Anticlockwise.
     * @returns Nothing.
     */
    arc(cx, cy, r, start, end, ccw = false) {
        this.__pendingArc = { cx, cy, r, start, end, ccw };
    }
    /** @returns Nothing. */ ellipse() { }
    /** @returns Nothing. */ rect() { }
    /** @returns Nothing. */ clip() { }
    /** @returns Nothing. */
    fill() {
        this.strokesAndFills++;
        if (this.__pendingArc !== null && this.__pendingArc !== undefined) {
            this.arcFills.push({ ...this.__pendingArc, fillStyle: String(this.fillStyle) });
            this.__pendingArc = null;
        }
    }
    /**
     * @returns Nothing.
     *
     * `strokeCount` is separate from `strokesAndFills` (`W-38a`). The combined
     * counter cannot tell a stroke from a fill, so an assertion that eight wedges
     * each got a separator passed on the eight FILLS alone when the strokes were
     * removed. The sixth counting stub to conflate two things - after
     * `isPointInPath`, `drawImage`, `fillText`, `ResizeObserver` and `setLineDash`.
     */
    stroke() { this.strokesAndFills++; this.strokeCount++; }
    /**
     * Records a text draw, WITH THE STRING AND WHERE IT WENT (W-17).
     *
     * It used to be `this.texts++`. A counter says a label was drawn and nothing
     * about which, so "no code path draws demo content without the word DEMO in
     * the same frame" was unanswerable — the third time a counting stub has been
     * the thing standing between an assertion and the property it names, after
     * `isPointInPath` at `W-3a` and `drawImage` at `W-15b`.
     * @param text The string. @param x Position. @param y Position.
     * @returns Nothing.
     */
    fillText(text, x, y) {
        this.texts++;
        const t = this.transform;
        this.textDraws.push({
            text: String(text), x: Number(x), y: Number(y),
            font: this.font, fillStyle: this.fillStyle, align: this.textAlign,
            transform: [t.a, t.b, t.c, t.d, t.e, t.f],
        });
    }

    /** @param text The string. @param x Position. @param y Position. @returns Nothing. */
    strokeText(text, x, y) {
        this.texts++;
        this.textDraws.push({ text: String(text), x: Number(x), y: Number(y), stroked: true });
    }
    /**
     * Records an image draw, WITH ITS DESTINATION RECTANGLE (W-15b).
     *
     * It used to be `this.images++`. A counter says an image was drawn and nothing
     * about where or how big, so "a 4:1 image is letterboxed rather than stretched"
     * — the thing an empty state can most easily get wrong — was unanswerable. Same
     * class as `isPointInPath` returning false at `W-3a`: a stub that answers
     * uselessly is worse than one that refuses, because assertions written against
     * it pass.
     *
     * All three canvas overloads, because the caller chooses and a shim that only
     * understands one would silently mis-record the others:
     *   drawImage(img, dx, dy)
     *   drawImage(img, dx, dy, dw, dh)
     *   drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
     * @param img The image. @param a Second argument. @param b Third.
     * @param c Fourth. @param d Fifth. @param e Sixth. @param f Seventh.
     * @param g Eighth. @param h Ninth.
     * @returns Nothing.
     */
    drawImage(img, a, b, c, d, e, f, g, h) {
        this.images++;
        const src = img && typeof img === 'object' ? (img.src ?? null) : null;
        const nw = img && typeof img === 'object' ? (img.naturalWidth ?? img.width ?? 0) : 0;
        const nh = img && typeof img === 'object' ? (img.naturalHeight ?? img.height ?? 0) : 0;
        let dest;
        if (e === undefined) {
            dest = c === undefined
                ? { x: a, y: b, w: nw, h: nh }        // (img, dx, dy)
                : { x: a, y: b, w: c, h: d };          // (img, dx, dy, dw, dh)
        } else {
            dest = { x: e, y: f, w: g, h: h };         // the nine-argument form
        }
        this.imageDraws.push({ src, natural: { w: nw, h: nh }, dest });
    }
    /** @returns `{ width }`, the only member the engine reads. */
    measureText(t) { return { width: String(t).length * 7 }; }
    /** @returns The current transform. */
    getTransform() { return new DOMMatrix([
        this.transform.a, this.transform.b, this.transform.c,
        this.transform.d, this.transform.e, this.transform.f]); }
    /** @returns Whether a point is in the path. Always false: paths are sinks. */
    isPointInPath(path, x, y, fillRule) {
        const [ux, uy] = this.__toUserSpace('isPointInPath', path, x, y);
        if (fillRule !== undefined && fillRule !== 'nonzero') {
            throw new RangeError(
                `RecordingContext2D shim: fillRule "${fillRule}" is not implemented. The shipped `
                + 'code never passes one, so only the "nonzero" default exists here.');
        }
        // EVERY subpath is treated as closed, open or not. That is the canvas rule
        // for filling and hit-testing a fill: `isPointInPath` answers about the
        // region a `fill()` would paint, and `fill()` closes what it is given.
        for (const sp of path.subpaths) {
            if (windingNumber(ux, uy, sp.points) !== 0) { return true; }
        }
        return false;
    }
    /** @returns Whether a point is on the stroke. Always false: paths are sinks. */
    isPointInStroke(path, x, y) {
        const [ux, uy] = this.__toUserSpace('isPointInStroke', path, x, y);
        /*
         * ROUND CAPS AND ROUND JOINS ONLY, which is what `getItemAtPos` sets, and
         * the reason this is four lines rather than a stroker. With both round, the
         * stroked region is exactly the Minkowski sum of the path with a disc of
         * radius lineWidth/2 - so "on the stroke" is "within lineWidth/2 of some
         * segment", joins and caps included, with no join geometry to reconstruct.
         *
         * The width is compared in USER space, where `lineWidth` already lives. That
         * is exact for a uniformly-scaled CTM and approximate under shear - the same
         * assumption the shipped code makes when it takes the CTM's scale to be
         * `hypot(a, b)`.
         */
        if (this.lineCap !== 'round' || this.lineJoin !== 'round') {
            throw new RangeError(
                `RecordingContext2D shim: isPointInStroke is implemented for round caps and joins `
                + `only, and this context has cap "${this.lineCap}", join "${this.lineJoin}". `
                + 'Butt caps and miter joins need a real stroker.');
        }
        const half = this.lineWidth / 2;
        for (const sp of path.subpaths) {
            const pts = sp.points;
            if (pts.length === 1) {
                // A degenerate subpath is a round cap on its own, as in the browser.
                if (Math.hypot(ux - pts[0][0], uy - pts[0][1]) <= half) { return true; }
                continue;
            }
            // Unlike a fill, a stroke does NOT close an open subpath: the closing
            // edge of `FRAME` is painted because `rect` closed it, and the origin
            // marker's separate strokes are not joined into a loop.
            const last = sp.closed ? pts.length : pts.length - 1;
            for (let i = 0; i < last; i++) {
                if (distanceToSegment(ux, uy, pts[i], pts[(i + 1) % pts.length]) <= half) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Maps a canvas-space point into the current user space.
     * @param who  The caller, for the error message.
     * @param path The path argument, which must be a `Path2D`.
     * @param x    Canvas x. @param y Canvas y.
     * @returns `[x, y]` in user space.
     */
    __toUserSpace(who, path, x, y) {
        // The browser also has the two-argument form, testing the context's own
        // current path. The shipped code always passes a Path2D, and a context here
        // has no current path to test, so the other overload would have to invent
        // one - loudly absent instead.
        if (!(path instanceof Path2D)) {
            throw new TypeError(
                `RecordingContext2D shim: ${who}(path, x, y) needs a Path2D. The `
                + `${who}(x, y) overload tests the context's own current path, which this `
                + 'recording context does not keep.');
        }
        if (path.unparsed !== null) {
            throw new RangeError(
                `RecordingContext2D shim: ${who} was asked about a path whose \`d\` string uses `
                + `"${path.unsupported}", which this shim records but does not parse. Refusing `
                + 'rather than answering false, which would read as a miss. The path was: '
                + `${path.unparsed.slice(0, 80)}`);
        }
        const inv = this.transform.inverse();
        return [
            inv.a * Number(x) + inv.c * Number(y) + inv.e,
            inv.b * Number(x) + inv.d * Number(y) + inv.f,
        ];
    }

    /** Pushes transform and fill style. @returns Nothing. */
    save() {
        const t = this.transform;
        this.__stack.push({ transform: [t.a, t.b, t.c, t.d, t.e, t.f], fillStyle: this.fillStyle });
    }

    /** Pops them. A restore with an empty stack is a no-op, as in the browser. @returns Nothing. */
    restore() {
        const s = this.__stack.pop();
        if (s === undefined) { return; }
        this.transform = new DOMMatrix(s.transform);
        this.fillStyle = s.fillStyle;
    }
}

/**
 * The RGBA at one device pixel.
 * @param ctx A {@link RecordingContext2D}.
 * @param x   Device x.
 * @param y   Device y.
 * @returns `[r, g, b, a]`, or `null` when outside the buffer.
 */
/**
 * The winding number of a closed polygon about a point.
 *
 * The crossing formulation rather than the angle-sum one: it is integer
 * arithmetic on the sign of a cross product, so a point exactly on a horizontal
 * edge does not fall into a `0/0`. Half-open in y (`<=` on one side, `<` on the
 * other) so a vertex on the ray is counted once and not twice.
 * @param px  Point x. @param py Point y.
 * @param pts The polygon's points; the closing edge is implicit.
 * @returns The winding number, zero when outside.
 */
function windingNumber(px, py, pts) {
    let w = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % n];
        const side = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
        if (y0 <= py) {
            if (y1 > py && side > 0) { w++; }
        } else if (y1 <= py && side < 0) { w--; }
    }
    return w;
}

/**
 * Distance from a point to a line segment.
 * @param px Point x. @param py Point y. @param a Segment start. @param b Segment end.
 * @returns The distance.
 */
function distanceToSegment(px, py, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    // A zero-length segment is its own endpoint; without this the projection is 0/0
    // and every probe against a repeated vertex answers NaN, which compares false.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

export function pixelAt(ctx, x, y) {
    if (x < 0 || y < 0 || x >= ctx.width || y >= ctx.height) { return null; }
    const i = (y * ctx.width + x) * 4;
    return [ctx.pixels[i], ctx.pixels[i + 1], ctx.pixels[i + 2], ctx.pixels[i + 3]];
}

/**
 * A recording context, and the globals `Engine.js` needs, in one call.
 * @param width  Device width.
 * @param height Device height.
 * @returns The context.
 */
export function makeContext2D(width, height) {
    installDomShims();
    return new RecordingContext2D(width, height);
}
