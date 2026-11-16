/**
 * @fileoverview
 * E142 domain model and coordinate normalization - the pure, DOM-free slice of
 * the SubstrateMapEngine that turns a decoded SEMI E142 SubstrateMap into a
 * concrete, node-testable grid placement in the substrate frame S.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete
 * controls): this module belongs to the ENGINE layer. It is a framework-free ES
 * module - no DOM, no Path2D/DOMMatrix, no TcHmi, no theme reads, no attributes,
 * no events. Colors/fonts and any host state arrive as resolved parameters
 * elsewhere; here everything is plain numbers so the placement math stays
 * portable and testable under node.
 *
 * SCOPE (task O1). This file owns the E142 TYPE model (mirroring the newest
 * V0125 XSD = E142-0225), UNIT resolution, LAYOUT-specifier resolution and the
 * geometric PLACEMENT of a rectangular cell grid. Out of scope by contract:
 * XML/JSON parsing, token decoding, rendering, attributes.
 *
 * EPISTEMIC PROVENANCE. The geometric rules come from two authorities:
 *  - REKON3 = SEMI_E142_Spezifikation_v3.md chapter 6, whose statements carry
 *    per-statement tags [XSD-normativ] / [Primaerquellen-Zitat] /
 *    [Sekundaerquelle] / [Inferenz]; and
 *  - E142-ASSUME-A-COORD.md ("ASSUME-A"), the authoritative supplement that
 *    OVERRIDES/SUPPLEMENTS REKON3 chapter 6 wherever it speaks, grading every
 *    rule [A]/[B]/[C].
 * Every function that encodes such a rule mirrors the tag and/or ASSUME grade
 * into its JSDoc so the deferred PDF-verification pass (task F1-V) can locate
 * and settle each one. Search token for that pass: "PDF-VERIFY".
 *
 * ---- F1-V VERIFICATION PASS: COMPLETED (licensed SEMI PDFs now in hand) ----
 * The PDF-VERIFY markers below were walked against SEMI E142-0225 and
 * SEMI E142.4-1022. Outcome, with the clause that settles each (full record,
 * including the two corrections, in OPEN-ISSUES.md sections 2-4):
 *  - A2 serialization order  -> [A] MapType='Array' is "row major format starting
 *    at the top left"; BinCode/@Y "starting with the top row".
 *  - A3.1 90/270 transpose   -> [A] MapType='2DArray' dimensions "rotated to the
 *    coordinate system of the SubstrateMap"; Figure R2-11.
 *  - A3.2 non-quadrant       -> settled: Table A4-1 has NO Orientation column, so
 *    the logical frame is orientation-independent (rotation is physical only).
 *  - A4.1 axis signs, A4.2 zero cell (incl. Center/even + truncation) -> [A]
 *    Table A4-1; verified exhaustively (Tests/e142-normative.test.mjs N1).
 *  - A5 Row/Column           -> [A] worked example A1-2.3 (the "no official
 *    example exists" premise of the [C+] grade was simply wrong).
 *  - A6.2 Number             -> [A] "derived from the length of the Values
 *    attribute"; A6.3 LID -> [A] "an alternative to x and y coordinates", opaque.
 *  - A7 LowerLeft            -> [A] parent-relative; absent means (0,0).
 *  - A8 units                -> DefaultUnits is normatively restricted to
 *    {um, mm}; everything this module additionally accepts is deliberate
 *    schema-evolution tolerance, NOT a claim about the standard.
 *  - A1.2 orientation datum -> [A] direction "increases in the right (clockwise)
 *    direction from 0", and Figure A1-2 puts the notch at 6/9/12/3 o'clock for
 *    Orientation 0/90/180/270. With the preset outline's notch pinned at 6
 *    o'clock, that is exactly the CCW map rotation by Orientation implemented
 *    here (Tests/e142-normative.test.mjs N6).
 * Reference-device registration and the no-anchor centring fallback were CHANGED
 * by this pass; see registerPlacementToReferenceDevices and computeGridPlacement.
 *
 * S1 mechanism (frozen by spike S1): authored as an ES module and shared
 * through the module graph exactly like Engine.ts; the global bridge at the end
 * of this file additionally exposes the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142 with first-wins (??=)
 * assignments.
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
/**
 * Application-level default MapType when the XML omits the attribute.
 * The V0125 XSD has no schema default for MapType [XSD-normativ]; REKON3 6.5.2
 * documents that an omitted MapType is interpreted as '2DArray' by prose
 * convention, confirmed by the official BinCodeMap-Example.xml which omits the
 * attribute [Primaerquellen-Zitat]. We encode that divergence here explicitly.
 * PDF-VERIFY: none needed - documented XSD/prose divergence, not an assumption.
 */
export const E142_DEFAULT_MAP_TYPE = '2DArray';
/**
 * A typed error returned (never thrown) by the pure functions, so callers can
 * branch without try/catch and the module stays exception-free by contract.
 */
export class E142Error extends Error {
    /** Stable machine code for the error. */
    code;
    /**
     * @param code    Stable machine code.
     * @param message Human-readable message.
     */
    constructor(code, message) {
        super(message);
        this.name = 'E142Error';
        this.code = code;
    }
}
// ===================================================================
//  Units (task O1 step 2; ASSUME-A A8)
// ===================================================================
/** Millimeters per micrometer. */
const MM_PER_UM = 0.001;
/** Millimeters per mil (thousandth of an inch): 25.4 / 1000. */
const MM_PER_MIL = 25.4 / 1000;
/**
 * Resolves a units string to a multiplicative factor to millimeters (ASSUME-A A8).
 *
 * Normative [A quote]: 'mm' -> 1, 'um' -> 0.001.
 * Tolerated WITH WARNING [B for 'microns' (observed in SEMI's own appendix
 * example); C for the /(\d+)Microns/ multiplier pattern and 'mil']:
 *   'microns' -> um; /^(\d+)Microns$/ -> n x um; 'mil' -> 25.4/1000 mm.
 * Anything else -> a typed {@link E142Error} (never thrown; returned).
 *
 * Used by layout resolution and shared with the GridData task at merge.
 * PDF-VERIFY: A8 - grades B ('microns') and C (multiplier pattern, 'mil').
 *
 * @param units The raw units token (already trimmed by the caller if desired).
 * @returns A {@link ToMmFactorResult}, or an {@link E142Error} for an unknown unit.
 */
export function toMmFactor(units) {
    switch (units) {
        case 'mm':
            return { factorMm: 1 };
        case 'um':
            return { factorMm: MM_PER_UM };
        case 'microns':
            return {
                factorMm: MM_PER_UM,
                warning: {
                    code: 'E142_UNIT_TOLERATED',
                    message: "Non-normative unit 'microns' accepted as 'um' (ASSUME-A A8 [B]).",
                },
            };
        case 'mil':
            return {
                factorMm: MM_PER_MIL,
                warning: {
                    code: 'E142_UNIT_TOLERATED',
                    message: "Non-normative unit 'mil' accepted as 25.4/1000 mm (ASSUME-A A8 [C]).",
                },
            };
        default: {
            const m = /^(\d+)Microns$/.exec(units);
            if (m) {
                const n = Number(m[1]);
                return {
                    factorMm: n * MM_PER_UM,
                    warning: {
                        code: 'E142_UNIT_TOLERATED',
                        message: `Non-normative unit '${units}' accepted as ${n} x um (ASSUME-A A8 [C]).`,
                    },
                };
            }
            return new E142Error('E142_UNIT_UNKNOWN', `Unknown units '${units}'; normative units are 'mm' and 'um' (ASSUME-A A8).`);
        }
    }
}
/**
 * Derives grid dimensions from a decoded payload alone. Used for the LAYOUTLESS
 * case where no layout tree exists to walk (the official SEMI example). The
 * payload's cols/rows are the SERIALIZED extents (visual map view); no pitch is
 * available, so physical scale falls to the fit heuristic (E-9 stage 3).
 * @param payload The decoded payload.
 * @returns A layoutless {@link ResolvedLayout} carrying cols/rows only.
 */
export function dimsFromPayload(payload) {
    return {
        flavor: 'layoutless',
        cols: payload.cols,
        rows: payload.rows,
        warnings: [],
    };
}
/**
 * Resolves a physical coordinate pair to millimeters, honoring an explicit
 * `units` on the pair, else the layout's DefaultUnits (REKON3 6.4.4).
 * Collects a warning for tolerated spellings; on an unknown unit returns the
 * error so the caller can decide.
 */
function physToMm(p, defaultUnits, warnings) {
    const units = (p.units !== undefined && p.units !== '') ? p.units : defaultUnits;
    const f = toMmFactor(units);
    if (f instanceof E142Error) {
        return f;
    }
    if (f.warning) {
        warnings.push(f.warning);
    }
    return { x: p.x * f.factorMm, y: p.y * f.factorMm };
}
/**
 * Resolves a LayoutSpecifier by walking the 'Top/Child' path through the
 * document's layouts (REKON3 5.2 / 16.x), accumulating child-layout LowerLeft
 * offsets in the PARENT layout's frame (ASSUME-A A7 / REKON3 6.4.3 [C]:
 * parent-relative accumulation - quarantined here behind this function).
 *
 * The resolved dims/pitch/cell come from the DEEPEST (target) layout on the
 * path. StepSize gives the full pitch; DeviceSize (when present) gives the
 * drawn cell extent; if DeviceSize is absent it is left undefined here and the
 * placement uses stepSize as the cell extent (deviceSize fallback = stepSize, E-9).
 *
 * CRITICAL (task O1 step 3): a DANGLING or ABSENT LayoutSpecifier is NOT an
 * error - the official SEMI BinCodeMap-Example.xml is layoutless (no keyref for
 * LayoutSpecifier exists). In that case the caller should fall back to
 * {@link dimsFromPayload}. This function signals that by returning `null` (no
 * error, no throw) when the head segment cannot be found, so the caller can
 * choose the layoutless path with the payload in hand.
 *
 * PDF-VERIFY: A7 grade C - LowerLeft parent-relative accumulation and the
 * top-level centering convention.
 *
 * @param doc       The decoded document.
 * @param specifier The LayoutSpecifier path, e.g. "WaferLayout/Devices".
 * @returns A resolved {@link ResolvedLayout}; an {@link E142Error} for a
 *          broken path / bad units; or `null` when the specifier is absent or
 *          its head layout does not exist (=> caller uses the layoutless path).
 */
export function resolveLayoutSpecifier(doc, specifier) {
    const warnings = [];
    const path = specifier.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
    if (path.length === 0) {
        return null; // absent specifier -> layoutless
    }
    const byId = new Map();
    for (const l of doc.layouts) {
        byId.set(l.layoutId, l);
    }
    const head = byId.get(path[0]);
    if (head === undefined) {
        return null; // dangling head -> layoutless (official example)
    }
    let current = head;
    // The top-level layout's own LowerLeft anchors it relative to the substrate
    // center (A7.2 [C]); child LowerLeft offsets are parent-relative and
    // accumulate down the path (A7.1 [C]).
    let anchor;
    if (current.lowerLeft) {
        const mm = physToMm(current.lowerLeft, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        anchor = mm;
    }
    for (let i = 1; i < path.length; i++) {
        const nextId = path[i];
        if (!current.childLayouts.includes(nextId)) {
            return new E142Error('E142_LAYOUT_PATH_BROKEN', `LayoutSpecifier segment '${nextId}' is not a child of '${current.layoutId}'.`);
        }
        const child = byId.get(nextId);
        if (child === undefined) {
            return new E142Error('E142_LAYOUT_MISSING', `LayoutSpecifier references layout '${nextId}' which is not defined.`);
        }
        if (child.lowerLeft) {
            const mm = physToMm(child.lowerLeft, child.defaultUnits, warnings);
            if (mm instanceof E142Error) {
                return mm;
            }
            anchor = { x: (anchor?.x ?? 0) + mm.x, y: (anchor?.y ?? 0) + mm.y };
        }
        current = child;
    }
    const out = {
        flavor: 'resolved',
        cols: current.dimension.x,
        rows: current.dimension.y,
        warnings,
    };
    // Expose the target layout's DefaultUnits factor for callers that must resolve
    // a physical value carrying no `Units` of its own (reference-device Position).
    const uf = toMmFactor(current.defaultUnits);
    if (!(uf instanceof E142Error)) {
        out.unitsToMm = uf.factorMm;
    }
    if (anchor) {
        out.anchorLowerLeftMm = anchor;
    }
    if (current.stepSize) {
        const mm = physToMm(current.stepSize, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        out.stepXmm = mm.x;
        out.stepYmm = mm.y;
    }
    if (current.deviceSize) {
        const mm = physToMm(current.deviceSize, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        out.cellWmm = mm.x;
        out.cellLmm = mm.y;
    }
    return out;
}
/**
 * Applies the ASSUME-A A3 dimension/pitch swap for the map view.
 *
 * For orientation mod 180 == 90 the MAP view swaps the layout's X/Y: serialized
 * cols = layout Dimension.Y (rows), rows = layout Dimension.X (cols), and the
 * physical column pitch = layout StepSize.Y (row pitch = StepSize.X). For
 * orientation mod 180 == 0, no swap. [A3.1 - REKON3 2DArray prose "rotated to
 * the coordinate system of the SubstrateMap" [A quote], reading [B].]
 *
 * Non-quadrant orientation (e.g. 45): NO swap - dims/pitch stay layout-aligned
 * and the angle only rotates the physical placement. [A3.2 grade C - undefined
 * territory; document, do NOT error.]
 * PDF-VERIFY: A3.1 [B] (quadrant swap) and A3.2 [C] (no swap off-quadrant).
 *
 * @param layoutDims  The resolved layout dims/pitch/cell (layout-aligned).
 * @param orientationDeg Total orientation in degrees (already incl. offset).
 * @returns The map-frame dims/pitch after the swap decision.
 */
export function dimsInMapFrame(layoutDims, orientationDeg) {
    const q = ((Math.round(orientationDeg) % 180) + 180) % 180;
    const swap = q === 90;
    if (swap) {
        return {
            cols: layoutDims.rows,
            rows: layoutDims.cols,
            colPitchMm: layoutDims.stepYmm,
            rowPitchMm: layoutDims.stepXmm,
            cellWmm: layoutDims.cellLmm,
            cellLmm: layoutDims.cellWmm,
        };
    }
    return {
        cols: layoutDims.cols,
        rows: layoutDims.rows,
        colPitchMm: layoutDims.stepXmm,
        rowPitchMm: layoutDims.stepYmm,
        cellWmm: layoutDims.cellWmm,
        cellLmm: layoutDims.cellLmm,
    };
}
/**
 * The visual cell carrying logical coordinate (0,0), per ASSUME-A A4.2.
 *   LowerLeft  (0, 0);  UpperLeft (0, R-1);  LowerRight (C-1, 0);
 *   UpperRight (C-1, R-1); Center ((C-1)//2, (R-1)//2).
 * Center is PHYSICALLY FIXED, independent of AxisDirection; integer division
 * truncates toward zero (standard footnote #1 [A quote]). [A4.2: A for the four
 * corners, B for Center.]
 * PDF-VERIFY: A4.2 Center grade B (full Table A4-1).
 */
function zeroCell(origin, C, R) {
    switch (origin) {
        case 'LowerLeft': return { fromLeft: 0, fromBottom: 0 };
        case 'UpperLeft': return { fromLeft: 0, fromBottom: R - 1 };
        case 'LowerRight': return { fromLeft: C - 1, fromBottom: 0 };
        case 'UpperRight': return { fromLeft: C - 1, fromBottom: R - 1 };
        case 'Center': return {
            fromLeft: Math.trunc((C - 1) / 2),
            fromBottom: Math.trunc((R - 1) / 2),
        };
        default: {
            const _never = origin;
            return _never;
        }
    }
}
/**
 * The axis sign pair (sx, sy) from an AxisDirection, per ASSUME-A A4.1: the
 * FIRST token is the Y direction (Up=+1 / Down=-1), the SECOND the X direction
 * (Right=+1 / Left=-1). [A4.1 grade B; mirrors REKON3 6.3.3 [Inferenz] - the
 * component-wise decomposition is nowhere quoted verbatim by SEMI.]
 * PDF-VERIFY: A4.1 grade B / REKON3 6.3.3 [Inferenz] (Figure A2-1).
 */
function axisSigns(dir) {
    switch (dir) {
        case 'UpRight': return { sx: 1, sy: 1 };
        case 'DownRight': return { sx: 1, sy: -1 };
        case 'UpLeft': return { sx: -1, sy: 1 };
        case 'DownLeft': return { sx: -1, sy: -1 };
        default: {
            const _never = dir;
            return _never;
        }
    }
}
/**
 * The serialization-column step of the LOGICAL +X direction: +1 when
 * AxisDirection's X token is Right, -1 when it is Left.
 *
 * This is {@link axisSigns}' `sx` under the A4.3 / A2.3 bridge: A4.3 gives
 * X = sx * (from_left - zero.from_left), so from_left = zero.from_left + sx * X
 * (sx is +/-1, hence *sx == /sx), and A2.3 gives from_left = serCol. Walking one
 * cell in logical +X therefore walks `sx` serialization columns.
 *
 * Exported because it is the ONE bit of the logical frame the Row/Column decoder
 * seam cannot do without (E142Bins' `E142BinMeta.xStep`): A5.2 fixes a run's
 * fill direction in LOGICAL terms, and converting the run's start POINT through
 * {@link mapCoordToIndex} does not carry a DIRECTION. Input paths must derive it
 * HERE rather than re-deriving "endsWith('Right')" locally, so the A4.1 token
 * decomposition [B] lives in exactly one place and cannot drift from
 * {@link indexToMapCoord}.
 * PDF-VERIFY: A4.1 grade B / REKON3 6.3.3 [Inferenz] (Figure A2-1).
 *
 * @param dir AxisDirection.
 * @returns +1 for a Right X axis, -1 for a Left X axis.
 */
export function logicalXStep(dir) {
    return axisSigns(dir).sx === 1 ? 1 : -1;
}
/**
 * Converts a SERIALIZATION-ORDER array index (serCol, serRow) to the LOGICAL
 * E142 map coordinate (X, Y), per ASSUME-A A2.3 + A4.3 (closed form).
 *
 * Serialization is VISUAL (A2): serRow 0 = TOP row, serCol 0 = LEFT; this is
 * INDEPENDENT of OriginLocation/AxisDirection [A2.1/2 grade B, Array prose
 * [Primaerquellen-Zitat] + [B] independence proof]. The logical frame only
 * LABELS the visual grid. Bridge to visual coordinates (A4.3):
 *   from_left = serCol,  from_bottom = R - 1 - serRow.
 * Then (A4.3):
 *   X = sx * (from_left  - zero.fromLeft)
 *   Y = sy * (from_bottom - zero.fromBottom)
 * Negative logical coordinates are legal and expected (A4.4). [A4.3 grade B.]
 * PDF-VERIFY: A2.1/2 (Figure A1-1b, 2DArray clause), A4.3 (Table A4-1).
 *
 * @param serCol Serialized column index, 0..C-1 (C = map-frame cols).
 * @param serRow Serialized row index, 0..R-1 (R = map-frame rows).
 * @param origin OriginLocation.
 * @param dir    AxisDirection.
 * @param C      Map-frame columns (post-A3 swap).
 * @param R      Map-frame rows (post-A3 swap).
 * @returns The logical (x, y).
 */
export function indexToMapCoord(serCol, serRow, origin, dir, C, R) {
    const zero = zeroCell(origin, C, R);
    const { sx, sy } = axisSigns(dir);
    const fromLeft = serCol;
    const fromBottom = R - 1 - serRow;
    return {
        x: sx * (fromLeft - zero.fromLeft),
        y: sy * (fromBottom - zero.fromBottom),
    };
}
/**
 * The inverse of {@link indexToMapCoord}: converts a LOGICAL map coordinate
 * (x, y) back to the SERIALIZATION index (serCol, serRow), per ASSUME-A A4.3
 * solved for from_left/from_bottom, then A2.3 for the serialization bridge.
 *   from_left  = zero.fromLeft   + sx * x     (sx = +/-1, so *sx == /sx)
 *   from_bottom = zero.fromBottom + sy * y
 *   serCol = from_left;  serRow = R - 1 - from_bottom.
 * PDF-VERIFY: same falsifiers as {@link indexToMapCoord}.
 *
 * @returns The serialization (serCol, serRow). Values outside 0..C-1 / 0..R-1
 *          mean the logical coordinate lies off the serialized grid.
 */
export function mapCoordToIndex(x, y, origin, dir, C, R) {
    const zero = zeroCell(origin, C, R);
    const { sx, sy } = axisSigns(dir);
    const fromLeft = zero.fromLeft + sx * x;
    const fromBottom = zero.fromBottom + sy * y;
    return { serCol: fromLeft, serRow: R - 1 - fromBottom };
}
/** Rotates a plain vector by `deg` degrees CCW (+y up). Pure geometry, sign-neutral. */
function rotCcw(x, y, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
}
/**
 * ===================================================================
 * THE SINGLE CW->CCW CONVERSION of the whole engine.
 * ===================================================================
 * Converts the E142 source Orientation (rotation of the SUBSTRATE relative to
 * the map data, CLOCKWISE-positive [Primaerquellen-Zitat, REKON3 6.1.2]) plus
 * the E142OrientationOffset (decision E-8) into the CCW-positive total angle the
 * engine's +y-up frames use. A substrate rotated CW by th relative to the map is
 * the map rotated CCW by th relative to the substrate (ASSUME-A A1.4), so the
 * conversion is the IDENTITY on the numeric value: the source degrees are simply
 * ADOPTED as a positive (CCW) angle. This single adoption is the one and only
 * source-semantic sign conversion in the engine; it is NOT the banned
 * render-side per-angle ORIENT_SIGN correction (CONTEXT angle-sign rule). The
 * downstream render chain keeps its single axis flip (Sc(s,-s) inside the world
 * matrix W) and carries no per-angle sign correction anywhere. Zero reference:
 * notch/flat at 6 o'clock at Orientation=0 (decision E-8; ASSUME-A A1.2 grade B;
 * matches the outline presets).
 *
 * {@link rotCcw} downstream is sign-NEUTRAL geometry (it rotates a vector by the
 * angle handed to it); {@link fitPlacementToBox} recovers the ALREADY-CONVERTED
 * angle from the placement's step vectors and never re-reads the source
 * Orientation, so no second conversion exists.
 * PDF-VERIFY: A1.2 grade B (Figures A1-2/A1-3), A1.4 [B, forced by frames].
 *
 * @param orientationDeg       E142 Orientation, CW-positive, 0-359.
 * @param orientationOffsetDeg E142OrientationOffset in degrees (E-8), default 0.
 * @returns The CCW-positive total angle in degrees for the +y-up engine frames.
 */
function cwOrientationToCcwDeg(orientationDeg, orientationOffsetDeg) {
    return orientationDeg + orientationOffsetDeg;
}
/**
 * Computes the placement of a rectangular cell grid in the substrate frame S.
 *
 * ---- Serialization indexing (ASSUME-A A2) ----
 * ARRAY cell (0,0) = the first token of the first serialized BinCode row = the
 * TOP-LEFT visual cell; colStep walks serCol +1 (rightward on the map view),
 * rowStep walks serRow +1 (downward on the map view). Array/2DArray serialize
 * top-left first, in visual order, independent of OriginLocation/AxisDirection
 * (A2 [Primaerquellen-Zitat] for Array, [B] for the independence proof).
 *
 * ---- Map-view construction (before orientation) ----
 * In an intermediate map-view frame M (+x right, +y up) the grid is laid out so
 * the TOP-LEFT cell (0,0) has its lower-left corner at (0, (R-1)*rowPitch),
 * colStepM = (+colPitch, 0), rowStepM = (0, -rowPitch). The grid bounding box in
 * M is x in [0, C*colPitch], y in [0, R*rowPitch].
 *
 * ---- Anchoring (ASSUME-A A7) ----
 * If `resolved.anchorLowerLeftMm` is present, the grid bbox lower-left corner is
 * placed at that S-frame coordinate (A7 [C], parent-relative accumulation done
 * during layout resolution). Otherwise the bbox is CENTERED on the S origin
 * (A7.2 [C]).
 *
 * ---- Orientation (ASSUME-A A1) ----
 * Orientation is the rotation of the SUBSTRATE relative to the map data,
 * CLOCKWISE-positive [Primaerquellen-Zitat, REKON3 6.1.2]. Our engine's frames
 * are CCW-positive; a substrate rotated CW by th relative to the map is the map
 * rotated CCW by th relative to the substrate (A1.4). Therefore the grid,
 * expressed in S, carries a rotation of +(orientation + orientationOffsetDeg)
 * CCW about the substrate origin.
 *
 * The single CW->CCW source-semantic conversion is factored into
 * {@link cwOrientationToCcwDeg} and applied here EXACTLY ONCE to produce the
 * total CCW angle; every {@link rotCcw} call below is sign-neutral geometry on
 * that one angle. This is NOT the banned render-side per-angle ORIENT_SIGN
 * correction: the downstream render chain still contains exactly ONE axis flip
 * (Sc(s,-s) inside the world matrix W, see CONTEXT). PDF-VERIFY: A1.2 grade B.
 *
 * ---- Physical scale (decision E-9) ----
 *   (1) stepSize from the resolved layout (deviceSize fallback = stepSize) -> use it;
 *   (2) else, if `fallbackStep` is provided -> use its values as the pitch;
 *   (3) else return the placement WITHOUT physical scale (unit pitch) and set
 *       `scaled=false`; the caller must run {@link fitPlacementToBox}.
 *
 * @param header               The SubstrateMap header (orientation, origin, axes).
 * @param resolved             The resolved (or layoutless) layout.
 * @param orientationOffsetDeg E142OrientationOffset in degrees (decision E-8), default 0.
 * @param fallbackStep         Optional pitch fallback (E-9 stage 2).
 * @returns A {@link GridPlacementResult}.
 */
export function computeGridPlacement(header, resolved, orientationOffsetDeg = 0, fallbackStep) {
    const warnings = [...resolved.warnings];
    // THE single CW->CCW conversion (see {@link cwOrientationToCcwDeg}). Every
    // downstream rotCcw call is sign-neutral geometry using this one angle.
    const totalDeg = cwOrientationToCcwDeg(header.orientation, orientationOffsetDeg);
    // A3 dim/pitch swap for the map view.
    const mf = dimsInMapFrame(resolved, totalDeg);
    const C = mf.cols;
    const R = mf.rows;
    // E-9 physical-scale resolution order.
    let colPitch;
    let rowPitch;
    let scaled;
    if (mf.colPitchMm !== undefined && mf.rowPitchMm !== undefined) {
        // Stage 1: pitch from the resolved layout.
        colPitch = mf.colPitchMm;
        rowPitch = mf.rowPitchMm;
        scaled = true;
    }
    else if (fallbackStep !== undefined) {
        // Stage 2: caller-supplied fallback pitch (E-9 stage 2). The fallback is
        // supplied in LAYOUT axes; apply the same A3 swap as the layout pitch.
        const q = ((Math.round(totalDeg) % 180) + 180) % 180;
        if (q === 90) {
            colPitch = fallbackStep.yMm;
            rowPitch = fallbackStep.xMm;
        }
        else {
            colPitch = fallbackStep.xMm;
            rowPitch = fallbackStep.yMm;
        }
        scaled = true;
    }
    else {
        // Stage 3: no physical scale; unit pitch, caller must fit-to-box.
        colPitch = 1;
        rowPitch = 1;
        scaled = false;
        warnings.push({
            code: 'E142_NO_PHYSICAL_SCALE',
            message: 'No StepSize and no fallbackStep; placement carries nominal unit pitch '
                + '(run fitPlacementToBox for a fit; v1 heuristic renders nominal, not physical, sizes).',
        });
    }
    // Drawn cell extent: DeviceSize when present, else full pitch (deviceSize
    // fallback = stepSize, E-9). When unscaled, cell == unit pitch.
    const cellW = (scaled && mf.cellWmm !== undefined) ? mf.cellWmm : colPitch;
    const cellL = (scaled && mf.cellLmm !== undefined) ? mf.cellLmm : rowPitch;
    // Map-view (pre-orientation) lattice, cell (0,0) = top-left.
    const originMx0 = 0;
    const originMy0 = (R - 1) * rowPitch;
    const colStepMx = colPitch;
    const colStepMy = 0;
    const rowStepMx = 0;
    const rowStepMy = -rowPitch;
    // Anchoring: translate the map-view lattice so either the bbox lower-left
    // sits at anchorLowerLeftMm (A7), or the bbox center sits at S origin (A7.2).
    let tx;
    let ty;
    if (resolved.anchorLowerLeftMm !== undefined) {
        // bbox lower-left in M is (0,0); move it to the anchor.
        tx = resolved.anchorLowerLeftMm.x;
        ty = resolved.anchorLowerLeftMm.y;
    }
    else {
        // No anchor anywhere along the path. NOTE the normative default is
        // LowerLeft = (0,0) relative to the PARENT's lower-left corner (E142-0225
        // Layout/LowerLeft [A]: "If not present, then LowerLeft.X = 0 and
        // LowerLeft.Y = 0"), which the anchored branch above already realises by
        // accumulating 0 for absent segments. Reaching HERE means no layout tree
        // with a physical frame exists at all (the layoutless / scale-less E-9
        // NOMINAL path), so there is no parent corner to sit on and the grid is
        // centred on the substrate origin instead - a rendering fallback outside
        // the standard's coordinate model, not a coordinate claim.
        //
        // Centre the DRAWN extent. In map view the cell corner of (0,0) is the
        // cell's ORIGIN corner and each cell extends +x and -y from it, so the
        // drawn box is x in [0, C*colPitch] but y in [-rowPitch, (R-1)*rowPitch]
        // - NOT [0, R*rowPitch]. Centring the latter is what put the drawn grid
        // one row pitch low (O8 finding 4.3).
        tx = -(C * colPitch) / 2;
        ty = -((R - 2) * rowPitch) / 2;
    }
    const originMx = originMx0 + tx;
    const originMy = originMy0 + ty;
    // Orientation: rotate origin point and step vectors by +totalDeg CCW about
    // the substrate origin (THE single CW->CCW conversion, see banner above).
    const o = rotCcw(originMx, originMy, totalDeg);
    const cs = rotCcw(colStepMx, colStepMy, totalDeg);
    const rs = rotCcw(rowStepMx, rowStepMy, totalDeg);
    return {
        placement: {
            originXmm: o.x,
            originYmm: o.y,
            colStepXmm: cs.x,
            colStepYmm: cs.y,
            rowStepXmm: rs.x,
            rowStepYmm: rs.y,
            cellWmm: cellW,
            cellLmm: cellL,
        },
        scaled,
        warnings,
    };
}
/**
 * The fit-to-box heuristic of decision E-9 stage 3 (v1). Given an UNSCALED
 * placement (unit pitch, from {@link computeGridPlacement} with scaled=false)
 * and a target bounding box in mm (e.g. the outline bbox), scales the lattice to
 * SQUARE cells via min(bboxW/cols, bboxH/rows) and centers the grid extent on
 * the box center. The result renders NOMINAL, not physical, dimensions - it is a
 * cosmetic v1 fit, not a measurement.
 *
 * Implementation note: the unscaled placement already has unit pitch and is
 * centered on the S origin (or anchored). We rescale the step vectors and the
 * origin about the CURRENT grid-extent center, then recenter on the box center.
 * PDF-VERIFY: none - engineering heuristic (E-9 stage 3), not a SEMI assumption.
 *
 * @param placement An UNSCALED placement (unit pitch).
 * @param cols      Serialized columns C (post-A3 swap).
 * @param rows      Serialized rows R (post-A3 swap).
 * @param bbox      Target box in mm.
 * @returns A new, scaled {@link GridPlacement} with square cells, centered on bbox.
 */
export function fitPlacementToBox(placement, cols, rows, bbox) {
    const bboxW = bbox.maxX - bbox.minX;
    const bboxH = bbox.maxY - bbox.minY;
    const cell = Math.min(bboxW / cols, bboxH / rows);
    // Square cells: the fit ignores orientation cross-terms by construction of
    // the unit placement (unit pitch, axis-aligned in the map view). We rebuild
    // the placement directly from cell size, centered on the box center, at the
    // placement's own orientation (encoded in its step-vector direction).
    // Recover the orientation from the (unit) colStep direction.
    const deg = Math.atan2(placement.colStepYmm, placement.colStepXmm) * 180 / Math.PI;
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    // Map-view lattice at square pitch `cell`, top-left cell (0,0). The cell CORNER
    // of (0,0) is its origin corner and cells extend +x/-y from it, so the drawn
    // extent is x in [0, cols*cell] but y in [-cell, (rows-1)*cell] - NOT
    // [0, rows*cell]. Centre the DRAWN extent on the box centre (same one-row-pitch
    // correction as computeGridPlacement; centring [0, rows*cell] put the grid one
    // pitch low and hung it below the box).
    const originMx0 = 0;
    const originMy0 = (rows - 1) * cell;
    const tx = -(cols * cell) / 2;
    const ty = -((rows - 2) * cell) / 2;
    const o = rotCcw(originMx0 + tx, originMy0 + ty, deg);
    const cs = rotCcw(cell, 0, deg);
    const rs = rotCcw(0, -cell, deg);
    return {
        originXmm: o.x + cx,
        originYmm: o.y + cy,
        colStepXmm: cs.x,
        colStepYmm: cs.y,
        rowStepXmm: rs.x,
        rowStepYmm: rs.y,
        cellWmm: cell,
        cellLmm: cell,
    };
}
/**
 * OPT-IN reference-device registration (decision E-7 was "carry, do not
 * compute"; this adds the compute path, gated by the control's
 * `E142AlignToReferenceDevices` attribute and OFF by default so existing
 * behaviour is unchanged).
 *
 * It TRANSLATES the placement so that the reference devices' MODEL cell-centres
 * land, on average (least-squares translation), on their stated physical
 * `Position`s. For each `ReferenceDevice` that carries a `Position`, the model
 * point is the centre of the cell its logical `Coordinates` address (via
 * {@link mapCoordToIndex} in the current frame); the target is the `Position`
 * converted to millimetres. The applied shift is the mean of (target - model)
 * over all contributing devices; with a single anchor it places that device
 * exactly, which is the one registration every source agrees on.
 *
 * VERIFIED against SEMI E142-0225 (task F1-V):
 *  - Table 10, ReferenceDevice [A]: `Coordinates` are "X and Y coordinate of the
 *    reference device to align device matrix on physical substrate with the map
 *    data" (so reference devices ARE the alignment mechanism), and `Position` is
 *    the "Offset of the CENTER of a reference device in the X and Y directions
 *    from the CENTER of substrate" - hence the cell-CENTRE target below and the
 *    substrate-centre (S) origin.
 *  - Table 4, XYDimensions [A]: the X/Y axes are "according to the values of
 *    SubstrateMap coordinate attributes; SubstrateSide, Orientation,
 *    OriginLocation, and AxisDirection", and "If omitted then the Layout,
 *    DefaultUnits is used" - hence the basis conversion and `defaultUnitsToMm`.
 * STILL ASSUMED [B]: that the intended transform is a TRANSLATION rather than a
 * similarity. The standard names no rotation/scale attribute for reference devices
 * and gives only point correspondences, so translation is the only fit it
 * determines; with >= 2 anchors a similarity is not excluded by the text either.
 * If a future revision mandates one, replace the mean-translation with a Procrustes
 * solve - callers, the attribute and this signature are unaffected.
 *
 * A `Position` without a `Units` attribute is resolved with `defaultUnitsToMm`
 * (the resolved layout's DefaultUnits factor); when that too is absent (the
 * layoutless path) the position is taken as already-millimetres with a warning.
 *
 * @param placement        The placement to register (from {@link computeGridPlacement} / {@link fitPlacementToBox}).
 * @param referenceDevices The overlay's reference devices.
 * @param origin           OriginLocation of the current frame.
 * @param dir              AxisDirection of the current frame.
 * @param cols             Grid columns (serialization frame).
 * @param rows             Grid rows.
 * @param defaultUnitsToMm Millimetres per DefaultUnits unit, or `undefined` (layoutless).
 * @returns A {@link ReferenceRegistrationResult}.
 */
export function registerPlacementToReferenceDevices(placement, referenceDevices, origin, dir, cols, rows, defaultUnitsToMm) {
    const warnings = [];
    let sumDx = 0;
    let sumDy = 0;
    let used = 0;
    let offGrid = 0;
    let unitless = 0;
    for (const rd of referenceDevices) {
        if (!rd.position) {
            continue; // no target to register against
        }
        // Resolve the Position to millimetres.
        let factorMm;
        if (rd.position.units !== undefined && rd.position.units !== '') {
            const r = toMmFactor(rd.position.units);
            if (r instanceof E142Error) {
                warnings.push({
                    code: 'E142_REGISTER_UNIT_UNKNOWN',
                    message: `Reference-device Position units '${rd.position.units}' are not resolvable; this device was skipped for registration.`,
                });
                continue;
            }
            if (r.warning) {
                warnings.push(r.warning);
            }
            factorMm = r.factorMm;
        }
        else if (defaultUnitsToMm !== undefined) {
            factorMm = defaultUnitsToMm;
        }
        else {
            unitless++;
            factorMm = 1; // layoutless + no per-Position units: assume mm
        }
        // Position is a PHYSICAL offset expressed along the SubstrateMap's OWN X and Y
        // axes ("according to the values of SubstrateMap coordinate attributes;
        // SubstrateSide, Orientation, OriginLocation, and AxisDirection" - E142-0225
        // Table 4, XYDimensions [A]), measured from the substrate centre (the S origin;
        // "Offset of the center of a reference device in the X and Y directions from the
        // center of substrate", Table 10 [A]). It is therefore NOT plain S-frame mm: for a
        // rotated or mirrored frame the axes differ. Convert it through the placement's own
        // basis, which already encodes Orientation (step directions) and AxisDirection
        // (via the signs): one unit of logical +X moves by sx*colStep, one unit of logical
        // +Y by -sy*rowStep (from mapCoordToIndex: d(serCol)/dx = sx, d(serRow)/dy = -sy).
        const { sx, sy } = axisSigns(dir);
        const colLen = Math.hypot(placement.colStepXmm, placement.colStepYmm);
        const rowLen = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
        if (!(colLen > 0) || !(rowLen > 0)) {
            continue; // degenerate lattice: no basis to express the offset in
        }
        const uXx = sx * placement.colStepXmm / colLen;
        const uXy = sx * placement.colStepYmm / colLen;
        const uYx = -sy * placement.rowStepXmm / rowLen;
        const uYy = -sy * placement.rowStepYmm / rowLen;
        const px = rd.position.x * factorMm;
        const py = rd.position.y * factorMm;
        const targetX = px * uXx + py * uYx;
        const targetY = px * uXy + py * uYy;
        // Model cell-centre for the device's logical Coordinates, in the current frame.
        const { serCol, serRow } = mapCoordToIndex(rd.coordinates.x, rd.coordinates.y, origin, dir, cols, rows);
        if (!(serCol >= 0 && serCol < cols && serRow >= 0 && serRow < rows)) {
            offGrid++;
            continue;
        }
        const modelX = placement.originXmm + (serCol + 0.5) * placement.colStepXmm + (serRow + 0.5) * placement.rowStepXmm;
        const modelY = placement.originYmm + (serCol + 0.5) * placement.colStepYmm + (serRow + 0.5) * placement.rowStepYmm;
        sumDx += targetX - modelX;
        sumDy += targetY - modelY;
        used++;
    }
    if (unitless > 0) {
        warnings.push({
            code: 'E142_REGISTER_UNITLESS_POSITION',
            message: `${unitless} reference-device Position(s) carried no Units and no layout DefaultUnits was available; they were taken as millimetres.`,
        });
    }
    if (offGrid > 0) {
        warnings.push({
            code: 'E142_REGISTER_ANCHOR_OFF_GRID',
            message: `${offGrid} reference-device Coordinates addressed no cell of this ${cols}x${rows} grid and were ignored for registration.`,
        });
    }
    if (used === 0) {
        warnings.push({
            code: 'E142_REGISTER_NO_ANCHOR',
            message: 'Reference-device registration was requested but no reference device carried both a Position and an on-grid Coordinates; the placement is unchanged.',
        });
        return { placement, anchorsUsed: 0, warnings };
    }
    const dx = sumDx / used;
    const dy = sumDy / used;
    const shifted = {
        originXmm: placement.originXmm + dx,
        originYmm: placement.originYmm + dy,
        colStepXmm: placement.colStepXmm,
        colStepYmm: placement.colStepYmm,
        rowStepXmm: placement.rowStepXmm,
        rowStepYmm: placement.rowStepYmm,
        cellWmm: placement.cellWmm,
        cellLmm: placement.cellLmm,
    };
    return { placement: shifted, anchorsUsed: used, warnings };
}
/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
 */
function ensureNamespace(root, ...segments) {
    let current = root;
    for (const segment of segments) {
        current = (current[segment] ??= {});
    }
    return current;
}
// Idempotent registration guard: `??=` keeps the first definition if this file
// is ever evaluated twice (cannot happen through the module cache, but required
// for the classic fallback variant and free of cost here).
const e142Namespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142');
e142Namespace['E142Error'] ??= E142Error;
e142Namespace['E142_DEFAULT_MAP_TYPE'] ??= E142_DEFAULT_MAP_TYPE;
//# sourceMappingURL=E142.js.map