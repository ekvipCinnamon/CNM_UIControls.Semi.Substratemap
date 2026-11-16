/**
 * @fileoverview
 * SubstrateMapEngine - shared, framework-free rendering/model library of the
 * WaferMap package.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete controls):
 *  - Engine (this file): a framework-free ES module that will own all
 *    data->model builders, the transform chain, the render strategies and the
 *    hit-test index; it never touches DOM layout, attributes, events or themes
 *    (colors/fonts arrive as a resolved parameter object).
 *  - SubstrateMapBase: the abstract, non-placeable shell that owns the template
 *    root, canvas, devicePixelRatio bitmap sizing, ResizeObserver, theme
 *    reading, pointer wiring and one engine instance.
 *  - Concrete controls (SubstrateMap and the legacy facades): they own the
 *    attributes, schemas, events and demo data, mapping their data model onto
 *    the engine's scene calls.
 *
 * S1 mechanism (frozen by spike S1): the engine is authored as an ES module and
 * shared through the module graph exactly like dist/TcHmiCharting/* in the
 * attached Beckhoff.TwinCAT.HMI.Controls package, so single-evaluation and
 * load-before-consumer are language guarantees; the global bridge at the end of
 * this file additionally exposes the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine with first-wins (??=) assignments.
 *
 * NOTE: the data model below (types, the metric-prefix constants and the pure
 * data transforms) is the first slice of the real engine; the EngineHello class
 * is still the S1 render probe that tasks M1+ replace with the real render /
 * hit-test strategies, while this module's shape, the bridge and the emitted
 * Engine.js / Engine.d.ts pair stay unchanged.
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
 * Number of times this module file has been evaluated in the current page.
 * The ES module cache guarantees exactly one evaluation per resolved URL, so
 * this must read 1 no matter how many controls import the engine. Logged by
 * {@link EngineHello.render} so the single-load property is observable on the
 * canvas itself during the designer session.
 */
export const MODULE_EVALUATIONS = (() => {
    const host = globalThis;
    host.__substrateMapEngineEvaluations = (host.__substrateMapEngineEvaluations ?? 0) + 1;
    return host.__substrateMapEngineEvaluations;
})();
/**
 * Minimal render probe standing in for the real SubstrateMapEngine.
 * Framework-free by contract: it touches neither DOM layout, attributes,
 * events nor themes; it only paints into the context handed to it.
 */
export class EngineHello {
    /** Total number of probe instances created since the module was evaluated. */
    static instanceCount = 0;
    /** 1-based sequence number of this instance, for the on-canvas diagnostics. */
    instanceNumber;
    /** Creates a new probe instance. One instance per owning control. */
    constructor() {
        this.instanceNumber = ++EngineHello.instanceCount;
    }
    /**
     * Paints the probe output: a letterboxed disc with a 6 o'clock notch (a
     * nod at the substrate to come) and the identity text of the owning
     * control, plus the module/instance counters that make the load-once
     * mechanism visible.
     *
     * The caller owns the bitmap size and has set the devicePixelRatio base
     * transform (`setTransform(dpr, 0, 0, dpr, 0, 0)`); this method derives
     * the CSS-pixel drawing size from that transform and never resizes the
     * canvas.
     *
     * @param ctx Target 2D context of the owning control's canvas.
     * @param text Identity text to stamp onto the probe output.
     */
    render(ctx, text) {
        const dpr = ctx.getTransform().a || 1;
        const width = ctx.canvas.width / dpr;
        const height = ctx.canvas.height / dpr;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#1c2733';
        ctx.fillRect(0, 0, width, height);
        const radius = Math.max(4, Math.min(width, height) / 2 - 8);
        const centerX = width / 2;
        const centerY = height / 2;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.fillStyle = '#3d5a73';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(centerX, centerY + radius, radius * 0.12, 0, 2 * Math.PI);
        ctx.fillStyle = '#1c2733';
        ctx.fill();
        ctx.fillStyle = '#e8eef4';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, centerX, centerY - 8);
        ctx.fillText('module evaluations: ' + MODULE_EVALUATIONS + ' | engine instance #' + this.instanceNumber, centerX, centerY + 10);
    }
    /**
     * Releases per-instance resources. The probe holds none; the method exists
     * so the spike exercises the full create/render/dispose path the real
     * engine will rely on.
     */
    dispose() {
        // Intentionally empty in the probe.
    }
}
// ===================================================================
//  Constants
// ===================================================================
/** Decimal exponent for each {@link MetricPrefix} relative to its base unit. */
const PREFIX_EXP = {
    yocto: -24, zepto: -21, atto: -18, femto: -15, pico: -12, nano: -9,
    micro: -6, milli: -3, centi: -2, deci: -1, none: 0,
};
/** All valid metric prefixes (used to validate the prefix fields on bound data). */
export const PREFIXES = Object.keys(PREFIX_EXP);
// ===================================================================
//  Data transforms (pure functions)
//
//  ComponentMap's ORIENT_SIGN is deliberately NOT ported: in the
//  substrate-map transform chain the single axis flip lives in the
//  canvas CTM, so a CCW-positive source angle renders CCW on screen
//  with no per-angle sign correction anywhere (see the CONTEXT angle
//  sign rule).
// ===================================================================
/**
 * Normalizes a status value: trims a string and returns it if non-empty,
 * otherwise `null`. Status is free-form, so there is no validation against a
 * fixed set.
 * @param s Candidate value of unknown type.
 * @returns The trimmed status string, or `null` when absent/empty.
 */
export function normStatus(s) {
    const t = (typeof s === 'string') ? s.trim() : '';
    return t !== '' ? t : null;
}
/**
 * Converts a value in `prefix`-scaled meters to millimeters. (The `+ 3`
 * accounts for the meter-to-millimeter factor of `1e3`.) An unknown prefix is
 * treated as `none` (exponent 0).
 * @param value  Numeric value in the prefixed unit.
 * @param prefix Metric prefix applied to the meter base unit.
 * @returns The value in millimeters.
 */
export function toMillimeters(value, prefix) {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, (exp === undefined ? 0 : exp) + 3);
}
/**
 * Converts a value in `prefix`-scaled degrees to degrees. Unlike
 * {@link toMillimeters} the base unit is already `degree`, so there is no
 * `+ 3`: micro-degrees (`prefix = 'micro'`) scale by `1e-6`, e.g. `90000000`
 * micro-degrees -> `90` degrees.
 * @param value  Numeric value in the prefixed unit.
 * @param prefix Metric prefix applied to the degree base unit.
 * @returns The value in degrees.
 */
export function toDegrees(value, prefix) {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, exp === undefined ? 0 : exp);
}
/**
 * Resolves an item's orientation in radians from the raw orientation fields. A
 * missing orientation is treated as 0; a missing `orientation_prefix` is
 * treated as `'none'` (literal degrees). The angle is returned CCW-positive in
 * the +y-up frame and carries NO sign correction (the substrate-map transform
 * chain applies its single axis flip in the canvas CTM, so this angle is passed
 * unchanged to the rotation matrix; see the CONTEXT angle sign rule).
 * @param orientation Raw orientation magnitude (CCW-positive), or `undefined`.
 * @param prefix      Raw orientation prefix, or `undefined`.
 * @returns The source angle in radians (CCW-positive).
 */
export function orientationToRad(orientation, prefix) {
    if (orientation === undefined || orientation === null) {
        return 0;
    }
    const deg = toDegrees(orientation, prefix === undefined ? 'none' : prefix);
    return deg * Math.PI / 180;
}
/**
 * Builds an `item_id -> status` lookup from a status-assignment list, skipping
 * entries whose status is invalid.
 * @param list Status assignments, or `null`.
 * @returns A map from item id to status (empty if `list` is `null`).
 */
export function buildStatusMap(list) {
    const m = new Map();
    if (list) {
        for (const a of list) {
            const s = normStatus(a.status);
            if (s !== null) {
                m.set(a.item_id, s);
            }
        }
    }
    return m;
}
/**
 * Resolves an item's fill color: the mapped color for its status if present and
 * non-empty, otherwise the unknown fallback. A `null` status (absent/empty)
 * also yields the unknown color.
 * @param status  Effective status, or `null`.
 * @param mapping Status-string -> CSS color map, or `null`.
 * @param unknown Fallback color for unmapped/absent status.
 * @returns The CSS color string to fill/stroke with.
 */
export function resolveStatusColor(status, mapping, unknown) {
    if (status === null) {
        return unknown;
    }
    const c = mapping ? mapping[status] : undefined;
    return (typeof c === 'string' && c.trim() !== '') ? c : unknown;
}
/**
 * Maps the schema-shaped label list to internal render-ready labels, converting
 * each box to millimeters and skipping non-object entries.
 * @param list Labels as delivered by the data source, or `null`.
 * @returns Internal {@link LabelModel} array (empty if `list` is `null`).
 */
export function labelsToModels(list) {
    const out = [];
    if (list) {
        for (const label of list) {
            if (!label || typeof label !== 'object') {
                continue;
            }
            out.push({
                x: toMillimeters(label.center_position_x, label.prefix),
                y: toMillimeters(label.center_position_y, label.prefix),
                w: toMillimeters(label.width, label.prefix),
                l: toMillimeters(label.length, label.prefix),
                text: typeof label.text === 'string' ? label.text : '',
            });
        }
    }
    return out;
}
/** Geometry `type` discriminators understood by the item renderer. */
export const KNOWN_GEOMETRY_TYPES = ['rectangle', 'circle', 'ellipse', 'polyline', 'polygon', 'path'];
/** Closed-shape `type` discriminators allowed for the substrate outline (the open `polyline` is excluded). */
const KNOWN_OUTLINE_GEOMETRY_TYPES = ['rectangle', 'circle', 'ellipse', 'polygon', 'path'];
/**
 * Serializes one path command to its SVG fragment, converting every length
 * field to millimeters (abs and rel scale identically, so deltas convert the
 * same way). Absolute commands use the uppercase SVG letter, relative ones the
 * lowercase; arc `large_arc`/`sweep` booleans become `1`/`0`; `x_axis_rotation`
 * is an angle and is NOT scaled. The result is fed to `new Path2D(d)`, so arcs
 * are parsed by the browser for free.
 * @param cmd    The path command.
 * @param prefix The parent item's (or outline's) metric prefix.
 * @returns The SVG path fragment (millimeter coordinates).
 */
export function serializeCommand(cmd, prefix) {
    const M = (v) => toMillimeters(v, prefix);
    switch (cmd.type) {
        case 'move_to_absolute': return 'M ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'move_to_relative': return 'm ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'line_to_absolute': return 'L ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'line_to_relative': return 'l ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_quadratic_bezier_absolute': return 'T ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_quadratic_bezier_relative': return 't ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'horizontal_line_to_absolute': return 'H ' + M(cmd.x);
        case 'horizontal_line_to_relative': return 'h ' + M(cmd.x);
        case 'vertical_line_to_absolute': return 'V ' + M(cmd.y);
        case 'vertical_line_to_relative': return 'v ' + M(cmd.y);
        case 'quadratic_bezier_absolute': return 'Q ' + M(cmd.control_x) + ' ' + M(cmd.control_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'quadratic_bezier_relative': return 'q ' + M(cmd.control_x) + ' ' + M(cmd.control_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_cubic_bezier_absolute': return 'S ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_cubic_bezier_relative': return 's ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'cubic_bezier_absolute': return 'C ' + M(cmd.control_1_x) + ' ' + M(cmd.control_1_y) + ' ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'cubic_bezier_relative': return 'c ' + M(cmd.control_1_x) + ' ' + M(cmd.control_1_y) + ' ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'elliptical_arc_absolute': return 'A ' + M(cmd.rx) + ' ' + M(cmd.ry) + ' ' + cmd.x_axis_rotation + ' ' + (cmd.large_arc ? 1 : 0) + ' ' + (cmd.sweep ? 1 : 0) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'elliptical_arc_relative': return 'a ' + M(cmd.rx) + ' ' + M(cmd.ry) + ' ' + cmd.x_axis_rotation + ' ' + (cmd.large_arc ? 1 : 0) + ' ' + (cmd.sweep ? 1 : 0) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'close_path': return 'Z';
        default: {
            const _never = cmd;
            return _never;
        }
    }
}
/**
 * Builds a geometry's outline as a {@link Path2D} in millimeters (+y up).
 * Closed shapes are added with the native canvas primitives; a `path` is
 * reassembled into an SVG `d` string (see {@link serializeCommand}) and parsed
 * by `new Path2D(d)`. The Y-flip, scale, centering and rotation are applied
 * later by the CTM, not here. The authoring frame is the caller's: the data
 * frame D for item geometries, the substrate frame S for the outline (the
 * function itself is frame-agnostic).
 * @param geom   The geometry (an item geometry or the outline's closed shape).
 * @param prefix The parent item's (or outline's) metric prefix.
 * @returns A {@link Path2D} in millimeters.
 */
export function geometryToPath2D(geom, prefix) {
    const M = (v) => toMillimeters(v, prefix);
    const p = new Path2D();
    switch (geom.type) {
        case 'rectangle': {
            const w = M(geom.width), l = M(geom.length);
            p.rect(M(geom.center_position_x) - w / 2, M(geom.center_position_y) - l / 2, w, l);
            break;
        }
        case 'circle':
            p.arc(M(geom.center_position_x), M(geom.center_position_y), M(geom.radius), 0, 2 * Math.PI);
            break;
        case 'ellipse':
            p.ellipse(M(geom.center_position_x), M(geom.center_position_y), M(geom.radius_x), M(geom.radius_y), 0, 0, 2 * Math.PI);
            break;
        case 'polyline':
        case 'polygon': {
            const pts = geom.points;
            if (pts && pts.length > 0) {
                p.moveTo(M(pts[0].x), M(pts[0].y));
                for (let i = 1; i < pts.length; i++) {
                    p.lineTo(M(pts[i].x), M(pts[i].y));
                }
                if (geom.type === 'polygon') {
                    p.closePath();
                }
            }
            break;
        }
        case 'path':
            return new Path2D(geom.commands.map((c) => serializeCommand(c, prefix)).join(' '));
        default: {
            const _never = geom;
            return _never;
        }
    }
    return p;
}
/** Whether a geometry is painted as an outline (`stroke_width`, or any `polyline`) vs. filled. */
export function geometryIsStroked(geom) {
    return geom.type === 'polyline' || typeof geom.stroke_width === 'number';
}
/** A geometry's stroke thickness in millimeters (0 when filled / unset). */
export function geometryStrokeWidthMm(geom, prefix) {
    return typeof geom.stroke_width === 'number' ? toMillimeters(geom.stroke_width, prefix) : 0;
}
/**
 * Accumulates the axis-aligned bounds of ONE elliptical-arc segment into the
 * `accX`/`accY` sinks: both endpoints plus every axis extreme of the ellipse
 * whose parameter angle lies on the swept range. The ellipse center - which the
 * endpoint-parameterized command does not carry - is derived exactly as the
 * browser derives it to draw the arc: the SVG endpoint->center conversion
 * (SVG 1.1 F.6.5), including the F.6.6 radii correction, degenerate radii
 * (straight line per spec) and coincident endpoints (arc omitted per spec).
 * The candidate extreme angles solve dx/dt = 0 / dy/dt = 0 of the rotated
 * ellipse parameterization, so a non-zero `x_axis_rotation` is bounded exactly
 * too. Pure algebra over the raw coordinates - frame-agnostic, so it holds in
 * the +y-up authoring frames unchanged.
 * @param x0       Arc start point x (the current point), millimeters.
 * @param y0       Arc start point y (the current point), millimeters.
 * @param rx       Arc radius x, millimeters (absolute value is used).
 * @param ry       Arc radius y, millimeters (absolute value is used).
 * @param phiDeg   Ellipse x-axis rotation in DEGREES (SVG semantics, as serialized).
 * @param largeArc SVG large-arc flag.
 * @param sweep    SVG sweep flag.
 * @param x1       Arc end point x, millimeters.
 * @param y1       Arc end point y, millimeters.
 * @param accX     X accumulator sink.
 * @param accY     Y accumulator sink.
 */
function accumulateArcBBox(x0, y0, rx, ry, phiDeg, largeArc, sweep, x1, y1, accX, accY) {
    accX(x0);
    accY(y0);
    accX(x1);
    accY(y1);
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) {
        return;
    } // degenerate radii: a straight line (SVG spec)
    const phi = phiDeg * Math.PI / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    // F.6.5.1: midpoint-relative start point in the ellipse-aligned frame.
    const hx = (x0 - x1) / 2, hy = (y0 - y1) / 2;
    const x1p = cosP * hx + sinP * hy;
    const y1p = -sinP * hx + cosP * hy;
    if (x1p === 0 && y1p === 0) {
        return;
    } // coincident endpoints: arc omitted (SVG spec)
    // F.6.6: scale the radii up when they cannot span the endpoints.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const k = Math.sqrt(lambda);
        rx *= k;
        ry *= k;
    }
    // F.6.5.2/3: ellipse center, first in the aligned frame, then unrotated back.
    const sign = largeArc !== sweep ? 1 : -1;
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = co * rx * y1p / ry;
    const cyp = -co * ry * x1p / rx;
    const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
    const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;
    // F.6.5.5/6: start angle and signed sweep extent (sweep flag <=> positive extent).
    const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
    const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
    let dTheta = theta2 - theta1;
    if (!sweep && dTheta > 0) {
        dTheta -= 2 * Math.PI;
    }
    if (sweep && dTheta < 0) {
        dTheta += 2 * Math.PI;
    }
    // Whether parameter angle `t` lies on the swept range [theta1, theta1 + dTheta].
    const EPS = 1e-9;
    const inSweep = (t) => {
        const d = normAngle(t - theta1);
        return dTheta >= 0 ? d <= dTheta + EPS : (d <= EPS || d >= 2 * Math.PI + dTheta - EPS);
    };
    // Axis extremes of the rotated ellipse: dx/dt = 0 at tX (+pi), dy/dt = 0 at tY (+pi).
    const tX = Math.atan2(-ry * sinP, rx * cosP);
    const tY = Math.atan2(ry * cosP, rx * sinP);
    for (const t of [tX, tX + Math.PI, tY, tY + Math.PI]) {
        if (inSweep(t)) {
            accX(cx + rx * cosP * Math.cos(t) - ry * sinP * Math.sin(t));
            accY(cy + rx * sinP * Math.cos(t) + ry * cosP * Math.sin(t));
        }
    }
}
/**
 * Bounding box of a command path in millimeters, shared by {@link geometryBBox}
 * (item paths) and the outline's box (see {@link buildOutlineModel}) so items,
 * outline anchoring, letterbox fit and hit-testing all bound one and the same
 * way. The walker tracks the current point, the subpath start (`close_path`
 * returns to it) and the previous control point (SVG smooth-command
 * reflection), so relative commands and smooth beziers resolve to their true
 * absolute coordinates.
 *
 * Exact for moves, lines, H/V and elliptical arcs (true analytic arc bounds via
 * {@link accumulateArcBBox}); conservative for beziers, which are bounded by
 * their control-point hull (curve is contained in it; reflected smooth control
 * points are included in the hull).
 *
 * DEVIATION FROM ComponentMap: ComponentMap's port accumulated the literal
 * command fields - relative deltas taken as absolute positions, arcs by their
 * endpoint only (items) or endpoint padded by the radii (outline). Those boxes
 * are wrong-centered for arcs and for any relative command; since BBOX_S
 * anchors the data frame (OriginLocation) and the fit, the literal port is
 * replaced by this correct walker for items and outline alike.
 * @param commands The path commands.
 * @param M        Unit conversion: authored value -> millimeters (the caller's prefix closure).
 * @returns The bounding box, or `null` when the path bounds nothing.
 */
function pathCommandsBBox(commands, M) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const accX = (x) => { if (x < minX) {
        minX = x;
    } if (x > maxX) {
        maxX = x;
    } };
    const accY = (y) => { if (y < minY) {
        minY = y;
    } if (y > maxY) {
        maxY = y;
    } };
    let curX = 0, curY = 0; // current point (mm)
    let startX = 0, startY = 0; // current subpath start (mm)
    let prevC2 = null; // last cubic control_2 (smooth-cubic reflection)
    let prevQC = null; // last quadratic control (smooth-quadratic reflection)
    for (const c of commands) {
        switch (c.type) {
            case 'move_to_absolute':
            case 'move_to_relative': {
                curX = c.type === 'move_to_absolute' ? M(c.x) : curX + M(c.x);
                curY = c.type === 'move_to_absolute' ? M(c.y) : curY + M(c.y);
                startX = curX;
                startY = curY;
                accX(curX);
                accY(curY);
                prevC2 = null;
                prevQC = null;
                break;
            }
            case 'line_to_absolute':
            case 'line_to_relative': {
                curX = c.type === 'line_to_absolute' ? M(c.x) : curX + M(c.x);
                curY = c.type === 'line_to_absolute' ? M(c.y) : curY + M(c.y);
                accX(curX);
                accY(curY);
                prevC2 = null;
                prevQC = null;
                break;
            }
            case 'horizontal_line_to_absolute':
            case 'horizontal_line_to_relative': {
                curX = c.type === 'horizontal_line_to_absolute' ? M(c.x) : curX + M(c.x);
                accX(curX);
                accY(curY);
                prevC2 = null;
                prevQC = null;
                break;
            }
            case 'vertical_line_to_absolute':
            case 'vertical_line_to_relative': {
                curY = c.type === 'vertical_line_to_absolute' ? M(c.y) : curY + M(c.y);
                accX(curX);
                accY(curY);
                prevC2 = null;
                prevQC = null;
                break;
            }
            case 'quadratic_bezier_absolute':
            case 'quadratic_bezier_relative': {
                const rel = c.type === 'quadratic_bezier_relative';
                const qx = rel ? curX + M(c.control_x) : M(c.control_x);
                const qy = rel ? curY + M(c.control_y) : M(c.control_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(qx);
                accY(qy);
                accX(curX);
                accY(curY);
                prevQC = { x: qx, y: qy };
                prevC2 = null;
                break;
            }
            case 'smooth_quadratic_bezier_absolute':
            case 'smooth_quadratic_bezier_relative': {
                const rel = c.type === 'smooth_quadratic_bezier_relative';
                const qx = prevQC ? 2 * curX - prevQC.x : curX; // reflected control (SVG smooth rule)
                const qy = prevQC ? 2 * curY - prevQC.y : curY;
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(qx);
                accY(qy);
                accX(curX);
                accY(curY);
                prevQC = { x: qx, y: qy };
                prevC2 = null;
                break;
            }
            case 'cubic_bezier_absolute':
            case 'cubic_bezier_relative': {
                const rel = c.type === 'cubic_bezier_relative';
                const c1x = rel ? curX + M(c.control_1_x) : M(c.control_1_x);
                const c1y = rel ? curY + M(c.control_1_y) : M(c.control_1_y);
                const c2x = rel ? curX + M(c.control_2_x) : M(c.control_2_x);
                const c2y = rel ? curY + M(c.control_2_y) : M(c.control_2_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(c1x);
                accY(c1y);
                accX(c2x);
                accY(c2y);
                accX(curX);
                accY(curY);
                prevC2 = { x: c2x, y: c2y };
                prevQC = null;
                break;
            }
            case 'smooth_cubic_bezier_absolute':
            case 'smooth_cubic_bezier_relative': {
                const rel = c.type === 'smooth_cubic_bezier_relative';
                const c1x = prevC2 ? 2 * curX - prevC2.x : curX; // reflected control (SVG smooth rule)
                const c1y = prevC2 ? 2 * curY - prevC2.y : curY;
                const c2x = rel ? curX + M(c.control_2_x) : M(c.control_2_x);
                const c2y = rel ? curY + M(c.control_2_y) : M(c.control_2_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(c1x);
                accY(c1y);
                accX(c2x);
                accY(c2y);
                accX(curX);
                accY(curY);
                prevC2 = { x: c2x, y: c2y };
                prevQC = null;
                break;
            }
            case 'elliptical_arc_absolute':
            case 'elliptical_arc_relative': {
                const rel = c.type === 'elliptical_arc_relative';
                const ex = rel ? curX + M(c.x) : M(c.x);
                const ey = rel ? curY + M(c.y) : M(c.y);
                accumulateArcBBox(curX, curY, M(c.rx), M(c.ry), c.x_axis_rotation, c.large_arc, c.sweep, ex, ey, accX, accY);
                curX = ex;
                curY = ey;
                prevC2 = null;
                prevQC = null;
                break;
            }
            case 'close_path': {
                curX = startX;
                curY = startY;
                prevC2 = null;
                prevQC = null;
                break;
            }
            default: {
                const _never = c;
                break;
            }
        }
    }
    return (minX <= maxX && minY <= maxY) ? { minX, minY, maxX, maxY } : null;
}
/**
 * Computes an item geometry's bounding box in data-frame millimeters, or `null`
 * when it cannot be bounded on both axes. For a `path` this is the shared
 * {@link pathCommandsBBox} walker: exact for lines, H/V and elliptical arcs,
 * control-point hull for beziers, with relative commands and smooth
 * reflections resolved against the tracked current point (see the walker's
 * DEVIATION note versus ComponentMap's literal-field port).
 * @param geom   The geometry.
 * @param prefix The parent item's metric prefix.
 * @returns The bounding box, or `null`.
 */
export function geometryBBox(geom, prefix) {
    const M = (v) => toMillimeters(v, prefix);
    switch (geom.type) {
        case 'rectangle': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const hw = M(geom.width) / 2, hl = M(geom.length) / 2;
            return { minX: cx - hw, minY: cy - hl, maxX: cx + hw, maxY: cy + hl };
        }
        case 'circle': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y), r = M(geom.radius);
            return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
        }
        case 'ellipse': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const rx = M(geom.radius_x), ry = M(geom.radius_y);
            return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
        }
        case 'polyline':
        case 'polygon': {
            const pts = geom.points;
            if (!pts || pts.length === 0) {
                return null;
            }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of pts) {
                const x = M(pt.x), y = M(pt.y);
                if (x < minX) {
                    minX = x;
                }
                if (y < minY) {
                    minY = y;
                }
                if (x > maxX) {
                    maxX = x;
                }
                if (y > maxY) {
                    maxY = y;
                }
            }
            return { minX, minY, maxX, maxY };
        }
        case 'path':
            return pathCommandsBBox(geom.commands, M);
        default: {
            const _never = geom;
            return _never;
        }
    }
}
/**
 * Combines geometry bounding boxes into an item's rotation center (the
 * combined-bbox midpoint). Falls back to the origin when there is nothing to
 * bound.
 * @param boxes Per-geometry bounding boxes.
 * @returns The rotation center in data-frame millimeters.
 */
export function combinedCenter(boxes) {
    if (boxes.length === 0) {
        return { cx: 0, cy: 0 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
        if (b.minX < minX) {
            minX = b.minX;
        }
        if (b.minY < minY) {
            minY = b.minY;
        }
        if (b.maxX > maxX) {
            maxX = b.maxX;
        }
        if (b.maxY > maxY) {
            maxY = b.maxY;
        }
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
/**
 * Unions a set of bounding boxes (skipping `null` entries) into their combined
 * axis-aligned box, or `null` when none are present. Used for an item's combined
 * bbox (over its geometry boxes) and for the items' fit box (over the item
 * boxes, see {@link fitBBox}).
 * @param boxes Bounding boxes, some possibly `null`.
 * @returns The combined box, or `null` when there is nothing to bound.
 */
export function unionBoxes(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const b of boxes) {
        if (!b) {
            continue;
        }
        any = true;
        if (b.minX < minX) {
            minX = b.minX;
        }
        if (b.minY < minY) {
            minY = b.minY;
        }
        if (b.maxX > maxX) {
            maxX = b.maxX;
        }
        if (b.maxY > maxY) {
            maxY = b.maxY;
        }
    }
    return any ? { minX, minY, maxX, maxY } : null;
}
/**
 * Maps the schema-shaped item list to internal render-ready items: builds each
 * geometry's {@link Path2D} (in data-frame millimeters) and paint mode,
 * resolves the draw angle and the combined-bbox rotation center, and normalizes
 * optional fields to `null`. Geometries with an unknown `type` are skipped (not
 * thrown). The direct analogue of ComponentMap's `structuresToModels`.
 *
 * DEVIATION FROM ComponentMap: `angle = orientationToRad(...)` with NO
 * `ORIENT_SIGN` factor - the CCW-positive source angle is passed through
 * unchanged because the single axis flip lives in the canvas CTM, not in the
 * coordinate mapping (see {@link ItemModel.angle} and the CONTEXT angle sign
 * rule). `cx`/`cy` remain the combined-geometry bbox center, now expressed in
 * DATA-frame millimeters (frame D), not ComponentMap's component-centric frame.
 * @param list Item layout as delivered by the data source (authored in frame D).
 * @returns Internal {@link ItemModel} array.
 */
export function itemsToModels(list) {
    const out = [];
    for (const s of list) {
        if (!s || typeof s !== 'object' || !Array.isArray(s.geometries)) {
            continue;
        }
        const prefix = s.prefix;
        const geometries = [];
        const boxes = [];
        for (const geom of s.geometries) {
            if (!geom || typeof geom.type !== 'string' || KNOWN_GEOMETRY_TYPES.indexOf(geom.type) === -1) {
                continue;
            }
            geometries.push({
                path: geometryToPath2D(geom, prefix),
                stroked: geometryIsStroked(geom),
                strokeWidthMm: geometryStrokeWidthMm(geom, prefix),
            });
            const bb = geometryBBox(geom, prefix);
            if (bb) {
                boxes.push(bb);
            }
        }
        const center = combinedCenter(boxes);
        out.push({
            id: typeof s.item_id === 'number' ? s.item_id : null,
            name: typeof s.name === 'string' ? s.name : null,
            // Opaque: only string/number pass through; anything else is null.
            userData: (typeof s.user_data === 'string' || typeof s.user_data === 'number') ? s.user_data : null,
            status: normStatus(s.status),
            layer: typeof s.layer === 'number' ? s.layer : null,
            // NO ORIENT_SIGN: the CCW-positive source angle is passed through
            // unchanged (the axis flip lives in the canvas CTM). See CONTEXT.
            angle: orientationToRad(s.orientation, s.orientation_prefix),
            cx: center.cx,
            cy: center.cy,
            bbox: unionBoxes(boxes),
            geometries,
        });
    }
    return out;
}
/**
 * Computes the substrate outline's bounding box in substrate-frame millimeters,
 * or `null` for an empty / degenerate shape. Exact for `rectangle`/`circle`/
 * `ellipse`/`polygon`; a `path` is bounded by the SAME shared
 * {@link pathCommandsBBox} walker the items use - exact for lines, H/V and
 * elliptical arcs (the endpoint-parameterized arc's center is derived via the
 * SVG endpoint->center conversion, exactly as the browser derives it to draw),
 * control-point hull for beziers. This box IS BBOX_S: it anchors the data
 * frame (OriginLocation) and the letterbox fit, so it must be positionally
 * exact for the preset contours (lines + arcs) - the former endpoint-padded
 * approximation was wrong-centered and shifted every D2S consumer.
 * Degenerate shapes are rejected: a `polygon` with fewer than 3 points, any
 * non-positive extent (zero/negative width, length or radius), and a `path`
 * that bounds nothing.
 * @param geom   The outline's closed geometry (authored in frame S).
 * @param prefix The outline's metric prefix.
 * @returns The bounding box, or `null` when empty/degenerate.
 */
function outlineBBox(geom, prefix) {
    const M = (v) => toMillimeters(v, prefix);
    switch (geom.type) {
        case 'rectangle': {
            const w = M(geom.width), l = M(geom.length);
            if (!(w > 0) || !(l > 0)) {
                return null;
            }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const hw = w / 2, hl = l / 2;
            return { minX: cx - hw, minY: cy - hl, maxX: cx + hw, maxY: cy + hl };
        }
        case 'circle': {
            const r = M(geom.radius);
            if (!(r > 0)) {
                return null;
            }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
        }
        case 'ellipse': {
            const rx = M(geom.radius_x), ry = M(geom.radius_y);
            if (!(rx > 0) || !(ry > 0)) {
                return null;
            }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
        }
        case 'polygon': {
            const pts = geom.points;
            if (!pts || pts.length < 3) {
                return null;
            }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of pts) {
                const x = M(pt.x), y = M(pt.y);
                if (x < minX) {
                    minX = x;
                }
                if (y < minY) {
                    minY = y;
                }
                if (x > maxX) {
                    maxX = x;
                }
                if (y > maxY) {
                    maxY = y;
                }
            }
            return { minX, minY, maxX, maxY };
        }
        case 'path':
            return pathCommandsBBox(geom.commands, M);
        default: {
            const _never = geom;
            return _never;
        }
    }
}
/**
 * Builds the render-ready substrate outline from the bound outline, or `null`
 * when it is absent, malformed or degenerate. Validates defensively (in the
 * spirit of {@link itemsToModels}): the `unit` must be `'meter'`, the `prefix`
 * a known metric prefix, and the geometry a known closed outline type. The
 * single closed geometry is converted to a {@link Path2D} in substrate-frame
 * millimeters (+y up) by the shared {@link geometryToPath2D} (which reuses
 * {@link serializeCommand} for a `path`), and its bounding box is computed by
 * {@link outlineBBox}. Stays silent on rejection (ComponentMap does not log for
 * invalid data, so neither do we).
 * @param outline The bound outline (authored in frame S), or `null`.
 * @returns The {@link OutlineModel}, or `null` when there is nothing drawable.
 */
export function buildOutlineModel(outline) {
    if (!outline || typeof outline !== 'object') {
        return null;
    }
    if (outline.unit !== 'meter') {
        return null;
    }
    if (PREFIXES.indexOf(outline.prefix) === -1) {
        return null;
    }
    const prefix = outline.prefix;
    const geom = outline.geometry;
    if (!geom || typeof geom.type !== 'string' || KNOWN_OUTLINE_GEOMETRY_TYPES.indexOf(geom.type) === -1) {
        return null;
    }
    const bbox = outlineBBox(geom, prefix);
    if (!bbox) {
        return null;
    }
    return { path: geometryToPath2D(geom, prefix), bbox };
}
/**
 * The normative preset table, built EXACTLY from Annex A. Keyed by every
 * spec-bearing preset - that is {@link PresetKey} minus the `'none'` sentinel,
 * which carries no geometry. Typing it `Record<Exclude<PresetKey, 'none'>,
 * OutlineSpec>` makes the key set exhaustive and closed: a missing or misspelled
 * key is a compile error. All numbers are millimeters / degrees, verbatim from
 * Annex A - do NOT re-derive.
 */
export const OUTLINE_SPECS = {
    'si-2in-p111': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: null, secAngle: null },
    'si-2in-n111': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 45 },
    'si-2in-p100': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 90 },
    'si-2in-n100': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 180 },
    'si-3in-p111': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: null, secAngle: null },
    'si-3in-n111': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 45 },
    'si-3in-p100': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 90 },
    'si-3in-n100': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 180 },
    'si-4in-p111': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: null, secAngle: null },
    'si-4in-n111': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 45 },
    'si-4in-p100': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 90 },
    'si-4in-n100': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 180 },
    'si-5in-p111': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: null, secAngle: null },
    'si-5in-n111': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 45 },
    'si-5in-p100': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 90 },
    'si-5in-n100': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 180 },
    'si-6in-p111': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: null, secAngle: null },
    'si-6in-n111': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 45 },
    'si-6in-p100': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 90 },
    'si-6in-n100': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 180 },
    'si-8in': { kind: 'disc-notch', dia: 200.0, notchDepth: 1.125 },
    'si-12in': { kind: 'disc-notch', dia: 300.0, notchDepth: 1.125 },
    'si-18in': { kind: 'disc-notch', dia: 450.0, notchDepth: 1.125 },
    'sic-4in': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 90 },
    'sic-6in-flat': { kind: 'disc-flats', dia: 150.0, primary: 47.50, secondary: null, secAngle: null },
    'sic-6in-notch': { kind: 'disc-notch', dia: 150.0, notchDepth: 1.125 },
    'gaas-4in': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 16.00, secAngle: 90 },
    'sapphire-2in': { kind: 'disc-flats', dia: 50.8, primary: 16.00, secondary: null, secAngle: null },
    'sapphire-4in': { kind: 'disc-flats', dia: 100.0, primary: 30.00, secondary: null, secAngle: null },
    'solar-m0': { kind: 'pseudo-square', side: 156.0, ingotDia: 200.0 },
    'solar-m2': { kind: 'pseudo-square', side: 156.75, ingotDia: 210.0 },
    'solar-g1': { kind: 'pseudo-square', side: 158.75, ingotDia: 223.0 },
    'solar-m6': { kind: 'pseudo-square', side: 166.0, ingotDia: 223.0 },
    'solar-m10': { kind: 'pseudo-square', side: 182.0, ingotDia: 247.0 },
    'solar-g12': { kind: 'pseudo-square', side: 210.0, ingotDia: 295.0 },
    'glass-gen2.5': { kind: 'rectangle', width: 370.0, height: 470.0 },
    'glass-gen4': { kind: 'rectangle', width: 550.0, height: 650.0 },
    'ceramic-100x100': { kind: 'rectangle', width: 100.0, height: 100.0 },
};
/**
 * Every {@link PresetKey} as a runtime array (the `'none'` sentinel first, then
 * the Annex A keys in table order), for validating the OutlinePreset attribute.
 */
export const PRESET_KEYS = ['none', ...Object.keys(OUTLINE_SPECS)];
/** Normalizes an angle to `[0, 2*PI)`. Ported UNCHANGED from ComponentMap / WaferMap `norm`. */
function normAngle(a) { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }
/**
 * Computes the chord flats of a disc-flats preset IN THE SUBSTRATE FRAME S
 * (+y up). The primary flat is centered at `-PI/2` (6 o'clock, `-y`) with
 * half-angle `asin(primary / dia)`; a secondary flat (when both `secondary` and
 * `secAngle` are present) is offset by `secAngle` from the primary, `secDir`
 * choosing the on-screen side. This is WaferMap's `computeFlats` with its
 * canonical +y-DOWN canvas angles negated into the +y-up S frame
 * (`a = -a_canvas`), so the painted flat layout - and the exact `secDir` cw/ccw
 * semantics - survive the transform chain's single axis flip unchanged.
 * @param spec   The disc-flats preset spec.
 * @param secDir Secondary-flat direction relative to the primary.
 * @returns The flats as S-frame angle/half-angle pairs (primary first).
 */
function computeFlatsS(spec, secDir) {
    const aP = Math.asin(Math.min(1, spec.primary / spec.dia));
    const flats = [{ center: -Math.PI / 2, half: aP }];
    if (spec.secondary != null && spec.secAngle != null) {
        const aS = Math.asin(Math.min(1, spec.secondary / spec.dia));
        const theta = spec.secAngle * Math.PI / 180;
        const center = secDir === 'cw' ? (-Math.PI / 2 - theta) : (-Math.PI / 2 + theta);
        flats.push({ center, half: aS });
    }
    return flats;
}
/**
 * Builds the disc-with-flats contour as an SVG-command list in frame S: the port
 * of WaferMap's `pathDiscWithFlats`. Flats are normalized and sorted by center
 * angle; the contour is walked COUNTER-CLOCKWISE (increasing angle) as an
 * alternation of a rim arc (from one flat's trailing edge to the next flat's
 * leading edge) and the next flat's chord. Each arc is emitted with
 * `sweep = true` and `large_arc` iff its central angle exceeds `PI`; the closing
 * segment is the last chord (`close_path`). Assumes at least one flat (a
 * disc-flats preset always has a primary).
 * @param R     Disc radius in millimeters.
 * @param flats Chord flats in frame S (from {@link computeFlatsS}).
 * @returns The `path` commands (substrate-frame millimeters, +y up).
 */
function discFlatsCommands(R, flats) {
    const sorted = flats.map((f) => ({ center: normAngle(f.center), half: f.half }))
        .sort((a, b) => a.center - b.center);
    const pt = (a) => ({ x: R * Math.cos(a), y: R * Math.sin(a) });
    const cmds = [];
    const p0 = pt(sorted[0].center + sorted[0].half);
    cmds.push({ type: 'move_to_absolute', x: p0.x, y: p0.y });
    for (let k = 1; k <= sorted.length; k++) {
        const prev = sorted[k - 1];
        const cur = sorted[k % sorted.length];
        const arcStart = prev.center + prev.half;
        let arcEnd = cur.center - cur.half;
        while (arcEnd < arcStart) {
            arcEnd += 2 * Math.PI;
        }
        const end = pt(arcEnd);
        cmds.push({ type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: (arcEnd - arcStart) > Math.PI, sweep: true, x: end.x, y: end.y });
        const trailing = pt(cur.center + cur.half);
        cmds.push({ type: 'line_to_absolute', x: trailing.x, y: trailing.y });
    }
    cmds.push({ type: 'close_path' });
    return cmds;
}
/**
 * Generates a disc-with-flats substrate {@link Outline}: a circle of diameter
 * `spec.dia` interrupted by its primary flat at 6 o'clock and (when present) a
 * secondary flat placed per `secDir`. Emitted as a single closed `path`
 * (elliptical-arc rim segments + chord `line_to`s) authored in the substrate
 * frame S (+y up, mm). Ports WaferMap's `computeFlats` + `pathDiscWithFlats`
 * math; see the section header for the arc-flag convention.
 * @param spec   The disc-flats preset spec (Annex A).
 * @param secDir Secondary-flat direction relative to the primary flat.
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateDiscWithFlats(spec, secDir) {
    const R = spec.dia / 2;
    const commands = discFlatsCommands(R, computeFlatsS(spec, secDir));
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}
/**
 * Generates a disc-with-notch substrate {@link Outline}: a circle of diameter
 * `spec.dia` with a V-notch cut into 6 o'clock. Ports WaferMap's
 * `pathDiscWithNotch`: the true notch depth in millimeters equals
 * `spec.notchDepth` (WaferMap's `(notchDepth / (dia/2)) * R` collapses to
 * `notchDepth` when `R = dia/2`), magnified by `exaggeration` exactly like
 * WaferMap's `notchScale`, with the notch half-width derived as `depth / R`. The
 * contour is the major rim arc over 12 o'clock (`large_arc`, `sweep = true`) plus
 * the two flanks meeting at the inward apex. An explicitly bound Outline is never
 * scaled; only presets pass through here.
 * @param spec         The disc-notch preset spec (Annex A).
 * @param exaggeration Visual magnification of the notch depth (`1` = to scale).
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateDiscWithNotch(spec, exaggeration) {
    const R = spec.dia / 2;
    const depth = spec.notchDepth * exaggeration; // true depth (mm) * magnification
    const hw = depth / R; // notch half-width (rad), per WaferMap
    const rimBx = R * Math.sin(hw); // +x rim point of the notch mouth
    const rimY = -R * Math.cos(hw); // rim y (both mouth points share it)
    const commands = [
        { type: 'move_to_absolute', x: rimBx, y: rimY },
        // Major rim arc over 12 o'clock (CCW) from the +x mouth to the -x mouth.
        { type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: true, sweep: true, x: -rimBx, y: rimY },
        { type: 'line_to_absolute', x: 0, y: -(R - depth) }, // inward V apex at 6 o'clock
        { type: 'line_to_absolute', x: rimBx, y: rimY }, // back out to the +x mouth
        { type: 'close_path' },
    ];
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}
/**
 * Generates a pseudo-square (chamfered) substrate {@link Outline} from the square
 * edge length `side` and the ingot diameter `ingotDia` that rounds its corners
 * (frame S, +y up, mm). Three regimes: when `ingotDia >= side*sqrt(2)` the ingot
 * contains the whole square, so the outline is the plain square (`rectangle`);
 * when `ingotDia <= side` the ingot is no wider than an edge, so the outline is
 * the bare disc (`circle`); otherwise the four corners are chamfered by circular
 * arcs of radius `R = ingotDia/2` and the outline is a closed `path` with
 * `k = sqrt(R*R - h*h)` (h = side/2) as the chamfer inset, walked one full CCW
 * traversal (each corner arc minor, `sweep = true`).
 * @param side     Square edge length in millimeters.
 * @param ingotDia Ingot diameter in millimeters.
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generatePseudoSquare(side, ingotDia) {
    const h = side / 2;
    const R = ingotDia / 2;
    if (ingotDia >= side * Math.SQRT2) {
        return { unit: 'meter', prefix: 'milli', geometry: { type: 'rectangle', center_position_x: 0, center_position_y: 0, width: side, length: side } };
    }
    if (ingotDia <= side) {
        return { unit: 'meter', prefix: 'milli', geometry: { type: 'circle', center_position_x: 0, center_position_y: 0, radius: R } };
    }
    const k = Math.sqrt(R * R - h * h);
    const corner = (x, y) => ({ type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: false, sweep: true, x, y });
    const commands = [
        { type: 'move_to_absolute', x: h, y: -k }, // right edge, lower
        { type: 'line_to_absolute', x: h, y: k }, // up the right edge
        corner(k, h), // top-right chamfer
        { type: 'line_to_absolute', x: -k, y: h }, // across the top edge
        corner(-h, k), // top-left chamfer
        { type: 'line_to_absolute', x: -h, y: -k }, // down the left edge
        corner(-k, -h), // bottom-left chamfer
        { type: 'line_to_absolute', x: k, y: -h }, // across the bottom edge
        corner(h, -k), // bottom-right chamfer
        { type: 'close_path' },
    ];
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}
/**
 * Generates a plain rectangle substrate {@link Outline} centered at the origin,
 * with edges aligned to the S axes (frame S, +y up, mm).
 * @param w Rectangle width in millimeters (X extent).
 * @param h Rectangle height in millimeters (Y extent, the outline `length`).
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateRectangle(w, h) {
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'rectangle', center_position_x: 0, center_position_y: 0, width: w, length: h } };
}
/**
 * Generates the substrate {@link Outline} for a spec-bearing preset key by
 * dispatching on its Annex A `kind`. `secDir` steers disc-flats secondary
 * placement; `notchExaggeration` magnifies disc-notch depth; each is ignored by
 * the kinds it does not apply to. The `'none'` sentinel carries no geometry and
 * is excluded at the type level.
 * @param key               A spec-bearing preset key (not `'none'`).
 * @param secDir            Secondary-flat direction (disc-flats only).
 * @param notchExaggeration Notch magnification (disc-notch only).
 * @returns The generated substrate outline.
 */
export function generatePresetOutline(key, secDir, notchExaggeration) {
    const spec = OUTLINE_SPECS[key];
    switch (spec.kind) {
        case 'disc-flats': return generateDiscWithFlats(spec, secDir);
        case 'disc-notch': return generateDiscWithNotch(spec, notchExaggeration);
        case 'pseudo-square': return generatePseudoSquare(spec.side, spec.ingotDia);
        case 'rectangle': return generateRectangle(spec.width, spec.height);
        default: {
            const _never = spec;
            return _never;
        }
    }
}
/**
 * Computes the item draw order (two-tier z-order): unlayered items first in
 * array order (bottom), then layered items by ascending layer, stable within
 * equal layers, on top. The whole layered tier sits above the whole unlayered
 * tier regardless of layer sign. Draw walks this order; the hit-test walks its
 * reverse, so it is computed once and shared. Ported UNCHANGED from
 * ComponentMap's `computeDrawOrder`.
 * @param items Render-ready items.
 * @returns The items in bottom-to-top draw order.
 */
export function computeDrawOrder(items) {
    const unlayered = items.filter((st) => st.layer === null);
    const layered = items
        .map((st, i) => ({ st, i }))
        .filter((x) => x.st.layer !== null)
        .sort((a, b) => (a.st.layer - b.st.layer) || (a.i - b.i));
    return unlayered.concat(layered.map((x) => x.st));
}
/** Margin in CSS pixels kept clear between the drawn construct and the canvas box (ComponentMap's value). */
export const MARGIN_PX = 8;
/**
 * Screen-constant width in CSS pixels of the substrate body edge. Applied under
 * the world CTM as {@link EDGE_PX} / s millimeters, which the scaled CTM turns
 * back into a fixed {@link EDGE_PX} CSS px independent of the letterbox scale and
 * the device pixel ratio. ComponentMap's value.
 */
export const EDGE_PX = 2;
/**
 * Screen-constant width in CSS pixels of the selection ring drawn on top of the
 * selected item. Applied as {@link SEL_PX} / s millimeters under the item CTM
 * (screen-constant, like {@link EDGE_PX}). Equals the width ComponentMap used for
 * its selection outline (ComponentMap reused its EDGE_PX there).
 */
export const SEL_PX = 2;
/**
 * Minimum hittable band for stroked/outline geometries, in CSS pixels. Very thin
 * (or zero-width) lines are otherwise almost impossible to click, so
 * {@link getItemAtPos} clamps a stroke's hit width up to this. Applied as
 * {@link HIT_MIN_PX} / s' millimeters under the per-item hit CTM (s' = that CTM's
 * uniform scale; see {@link getItemAtPos}), it is a screen-constant tolerance -
 * independent of the letterbox scale, the map/origin rotation and the device
 * pixel ratio. It only widens the hit band, never the painted stroke, so the hit
 * area still follows paint (an outline is never hit through its hollow interior).
 * Ported from ComponentMap's `HIT_MIN_PX`.
 */
export const HIT_MIN_PX = 4;
/**
 * Screen-constant length in CSS pixels of each origin-marker axis stub (the +x and
 * +y arms drawn from the data origin). Authored under the W * D2S CTM as
 * {@link ORIGIN_MARKER_STUB_PX} / s millimeters, so the scaled CTM turns it back
 * into a fixed CSS-pixel length independent of the letterbox scale and the device
 * pixel ratio - the same screen-constant idiom as {@link EDGE_PX}.
 */
export const ORIGIN_MARKER_STUB_PX = 18;
/** Screen-constant half-length in CSS pixels of the origin-marker centre crosshair arms (a small `+` on the data origin). */
export const ORIGIN_MARKER_CROSS_PX = 5;
/** Screen-constant arrowhead barb length in CSS pixels for the origin-marker axis heads. */
export const ORIGIN_MARKER_HEAD_PX = 6;
/** Screen-constant spacing in CSS pixels between the two chevrons of the +y (double) arrowhead. */
export const ORIGIN_MARKER_DOUBLE_GAP_PX = 4;
/** Screen-constant stroke width in CSS pixels of the whole origin marker (matches {@link EDGE_PX}). */
export const ORIGIN_MARKER_WIDTH_PX = 2;
/**
 * Assembles a {@link MapConfig} from a canvas client size using the shared
 * {@link MARGIN_PX}. Pure: the shell reads the canvas and calls this. The
 * analogue of ComponentMap's `__makeConfig` body.
 * @param width  Canvas client width in CSS pixels.
 * @param height Canvas client height in CSS pixels.
 * @returns The drawing configuration.
 */
export function makeConfig(width, height) {
    return { center: { x: width / 2, y: height / 2 }, width, height, margin: MARGIN_PX };
}
/**
 * Uniform, letterboxed CSS-pixels-per-millimeter scale that fits a box of the
 * given size into the drawing box minus the margin on both axes. No per-axis
 * stretch (which keeps circles circular and arcs un-distorted). Ported UNCHANGED
 * from ComponentMap's `computeScale`; the caller passes the extent of the fit
 * box (BBOX_S, or the items' combined bbox).
 * @param cfg    Drawing configuration.
 * @param width  Fit-box width in millimeters.
 * @param height Fit-box height in millimeters.
 * @returns The scale (`<= 0` for a degenerate box or fit size).
 */
export function computeScale(cfg, width, height) {
    if (width <= 0 || height <= 0) {
        return 0;
    }
    const sx = (cfg.width - 2 * cfg.margin) / width;
    const sy = (cfg.height - 2 * cfg.margin) / height;
    return Math.min(sx, sy);
}
/**
 * Axis-aligned extent of `bbox` after rotating it by `rad` (CCW-positive): the
 * width and height of the smallest upright box that still contains the rotated
 * rectangle. Feeds {@link computeScale} so the letterbox fit grows with the
 * {@link makeWorldMatrix} view rotation (VIEW) and the turning construct is
 * never clipped.
 *
 * CONSERVATIVE BY DESIGN (documented decision): the four CORNERS of `bbox` are
 * rotated, NOT the outline contour, so a shape that does not fill its bounding
 * box (a disc, a wafer with a flat) is over-boxed - a 45deg-rotated square is
 * fitted as its ~sqrt(2)-larger diagonal box and thus gets extra margin. This
 * buys a fit that never depends on sampling the geometry, at the cost of a
 * little screen area. The result is invariant to the rotation CENTRE (a rigid
 * rotation only translates the corner set, and an extent is translation-
 * invariant) and to the SIGN of `rad` (+rad and -rad give mirror-image boxes of
 * equal size), so at `rad = 0` it returns the box's own width/height unchanged -
 * the neutral case that keeps the unrotated fit bit-identical to before.
 * @param bbox The box to rotate (any +y direction; only its extent is used).
 * @param rad  View rotation in radians (CCW-positive; the sign does not affect the result).
 * @returns The rotated box's axis-aligned width `w` and height `h` (both `>= 0`).
 */
export function rotatedExtent(bbox, rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners = [
        [bbox.minX, bbox.minY],
        [bbox.maxX, bbox.minY],
        [bbox.maxX, bbox.maxY],
        [bbox.minX, bbox.maxY],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of corners) {
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        if (rx < minX) {
            minX = rx;
        }
        if (rx > maxX) {
            maxX = rx;
        }
        if (ry < minY) {
            minY = ry;
        }
        if (ry > maxY) {
            maxY = ry;
        }
    }
    return { w: maxX - minX, h: maxY - minY };
}
/**
 * Selects the canvas fit box: the outline's bounding box when an outline is
 * bound, otherwise the combined bounding box of the items' geometries AND of a
 * present cell grid's drawn extent, otherwise `null`. FALLBACK (CONTEXT
 * precedence): when no outline is bound but items / a grid exist the map fits
 * those alone and {@link drawSubstrateMap} draws no substrate body; when none is
 * present the caller draws nothing.
 *
 * GRID PARTICIPATION (documented decision, task O2 "a present grid's S-frame
 * extent participates alongside outline/items"): the grid is a PEER OF THE ITEMS
 * in the existing two-tier precedence, not a third tier that overrides the
 * outline. A bound outline therefore still fits BBOX_S exactly, which is what
 * keeps the CONTEXT sentence "[the outline's] bbox defines the fit box and the
 * origin anchors" literally true - {@link makeDataMatrix} anchors the data frame
 * on this very box, so letting a grid widen it would silently move every Item the
 * moment a grid appears. In the physical case (a die grid lies inside its
 * substrate) a union with the outline box is a no-op anyway; the only behavioural
 * difference is that a grid extending BEYOND a bound outline is clipped rather
 * than zoomed away from, which is the same treatment out-of-substrate items
 * already get. The bullet's minimum - a grid-only scene must fit and paint -
 * is met by the fallback tier.
 *
 * FRAME NOTE: the grid extent is a true substrate-frame (S) box, while the item
 * boxes are data-frame (D) boxes. Mixing them in the fallback continues the
 * simplification the items-only fallback already makes (it feeds the same box to
 * the scale AND to the anchor, so a default placement still centres correctly);
 * with a bound outline - the case that matters - only the exact BBOX_S is used.
 * @param outline The built outline model, or `null`.
 * @param items   The render-ready items.
 * @param grid    The render-ready cell grid, or `null`. Optional so that callers
 *                predating the grid layer stay source-compatible.
 * @returns The fit box in the common millimeter frame, or `null`.
 */
export function fitBBox(outline, items, grid = null) {
    if (outline) {
        return outline.bbox;
    }
    const boxes = items.map((it) => it.bbox);
    boxes.push(gridBBox(grid));
    return unionBoxes(boxes);
}
/**
 * Builds the world matrix W = T(center) * Sc(s, -s) * VIEW in CSS pixels. The
 * single axis flip Sc(s, -s) lives here, which is exactly why source angles are
 * passed unchanged to the rotation matrices and still render CCW on screen (see
 * the CONTEXT angle sign rule).
 *
 * VIEW = R(mapRotation): the caller passes the resolved `MapRotation` (radians)
 * and the whole construct - outline, items, labels and origin marker, all drawn
 * under `W` or `W * D2S` - turns with it about the substrate frame origin. `0`
 * leaves VIEW the identity (the neutral, unrotated view), which is why the
 * default keeps every pre-rotation caller unchanged. The fit must grow to match
 * (the caller scales with {@link rotatedExtent}) or a non-zero rotation clips.
 * @param cfg            Drawing configuration.
 * @param s              Uniform letterbox scale in CSS px per mm.
 * @param mapRotationRad View rotation in radians, CCW-positive on screen (0 = unrotated).
 * @returns The world matrix (CSS pixels; no device-pixel-ratio factor).
 */
export function makeWorldMatrix(cfg, s, mapRotationRad = 0) {
    const m = new DOMMatrix();
    m.translateSelf(cfg.center.x, cfg.center.y); // T(center)
    m.scaleSelf(s, -s); // * Sc(s, -s)  (the one axis flip)
    m.rotateSelf(mapRotationRad * 180 / Math.PI); // * VIEW = R(mapRotation); 0 => identity
    return m;
}
/**
 * Selects the anchor point A on a bounding box for a given {@link OriginAnchor},
 * in the frame the box is expressed in. The box is the substrate frame S bbox
 * (BBOX_S) when an outline is bound, or the items' combined bbox in the items-only
 * fallback - both are +y-up millimeter frames, so `'top'` is the +y (max) edge and
 * `'left'` the -x (min) edge. `'center'` is the box centre; the four corners take
 * the matching min/max edges. Pure; the analogue of picking the origin anchor in
 * the CONTEXT transform chain.
 * @param bbox     The bounding box the anchor is selected on (+y up).
 * @param location Which anchor point to take.
 * @returns The anchor point in the box's frame (millimeters).
 */
export function anchor(bbox, location) {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    switch (location) {
        case 'center': return { x: cx, y: cy };
        case 'top-left': return { x: bbox.minX, y: bbox.maxY }; // left = -x edge, top = +y edge
        case 'bottom-left': return { x: bbox.minX, y: bbox.minY };
        case 'top-right': return { x: bbox.maxX, y: bbox.maxY };
        case 'bottom-right': return { x: bbox.maxX, y: bbox.minY };
        default: {
            const _never = location;
            return _never;
        }
    }
}
/**
 * Builds the data->substrate matrix D2S in millimeters (CONTEXT "Coordinate
 * frames"):
 *   D2S = T(A + offset) * R(originRotation) * Sc(1, ydir)
 * where A is the {@link anchor} point for `location` on `anchorBBox`, `offset` is
 * (offsetX, offsetY) in millimeters expressed along the SUBSTRATE axes (+y up,
 * independent of `ydir`), `originRotation` is `rotationRad` (CCW-positive in S)
 * and `ydir` mirrors the D y axis (`'down'` => Sc(1, -1)).
 *
 * `anchorBBox` is the fit box the shell selected: the outline's BBOX_S when an
 * outline is bound, else the items' combined bbox in the items-only fallback, so
 * the anchor tracks whatever the map fits. `null` means there is nothing to draw
 * (neither an outline nor items); the anchor collapses to the origin, which is
 * irrelevant because the draw/hit guards skip an empty scene.
 *
 * The matrix is authored in +y-up space and its rotation angle is passed
 * unchanged (no ORIENT_SIGN): the chain's single axis flip lives in W
 * ({@link makeWorldMatrix}), so a CCW-positive `rotationRad` renders CCW on
 * screen. With `ydir === 'down'` the D handedness flips, so a CCW-positive item
 * orientation authored in that y-down frame then appears clockwise on screen -
 * the intended physical behaviour (CONTEXT angle sign rule).
 * @param anchorBBox  The bbox the anchor is selected on (outline BBOX_S or the items' bbox), or `null`.
 * @param location    Anchor point on the bbox (default 'center').
 * @param offsetX     Extra translation along S +x in millimeters (default 0).
 * @param offsetY     Extra translation along S +y in millimeters (default 0).
 * @param rotationRad Data-axes rotation about the origin, CCW-positive in S (default 0).
 * @param ydir        Data Y-axis direction (default 'up').
 * @returns The data->substrate matrix (identity for the neutral 'center'/0/0/'up' inputs on a centred bbox).
 */
export function makeDataMatrix(anchorBBox, location = 'center', offsetX = 0, offsetY = 0, rotationRad = 0, ydir = 'up') {
    const a = anchorBBox ? anchor(anchorBBox, location) : { x: 0, y: 0 };
    const m = new DOMMatrix();
    m.translateSelf(a.x + offsetX, a.y + offsetY); // T(A + offset)
    m.rotateSelf(rotationRad * 180 / Math.PI); // * R(originRotation)  (CCW-positive; no ORIENT_SIGN)
    m.scaleSelf(1, ydir === 'down' ? -1 : 1); // * Sc(1, ydir)  (the D-frame y mirror)
    return m;
}
/**
 * Builds the device-pixel product `Sc(dprBase) * m`: the device-pixel-ratio
 * factor as the leftmost factor on top of the CSS-pixel matrix `m` (a world or
 * world*data*item product). This is the ONE place the dpr enters the chain;
 * {@link applyMatrix} pushes the product onto a context, and the grid layer needs
 * the product itself (to derive its device-space extent and its inverse), so the
 * two cannot drift apart.
 * @param dprBase Device pixel ratio (leftmost scale factor).
 * @param m       CSS-pixel transform to scale into device pixels.
 * @returns The device-pixel matrix `Sc(dprBase) * m`.
 */
export function deviceMatrix(dprBase, m) {
    return new DOMMatrix([dprBase, 0, 0, dprBase, 0, 0]).multiplySelf(m);
}
/**
 * Sets the context CTM to `dprBase * m` (see {@link deviceMatrix}): the
 * device-pixel-ratio factor enters ONLY here, as the leftmost factor, on top of
 * the CSS-pixel matrix `m` (a world or world*data*item product). Draw sets `m`;
 * the hit-test uses the SAME `m` with `dprBase = 1` ({@link getItemAtPos}) or
 * inverts it analytically ({@link getCellAtPos}), keeping the painted shape and
 * the hit region identical.
 * @param ctx     2D context (on-screen or offscreen; see {@link Context2D}).
 * @param dprBase Device pixel ratio (leftmost scale factor).
 * @param m       CSS-pixel transform to apply under the dpr base.
 */
export function applyMatrix(ctx, dprBase, m) {
    const t = deviceMatrix(dprBase, m);
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
}
/**
 * Builds an item's own-orientation matrix T(c) * R(theta) * T(-c) in the data
 * frame (millimeters): rotate the item's combined geometry about its bbox center
 * by its source angle. CCW-positive and un-corrected - the axis flip is in W.
 * @param item The item model.
 * @returns The item matrix (millimeters).
 */
function itemMatrix(item) {
    const m = new DOMMatrix();
    m.translateSelf(item.cx, item.cy); // T(c)
    m.rotateSelf(item.angle * 180 / Math.PI); // * R(theta)  (CCW-positive; no ORIENT_SIGN)
    m.translateSelf(-item.cx, -item.cy); // * T(-c)
    return m;
}
/**
 * Draws one label upright and clipped to its box. The box CENTER is mapped from
 * data-frame millimeters to CSS pixels through `cssMatrix` (= W * D2S, which
 * carries the y-flip and the view rotation), then the glyphs are drawn in upright
 * CSS-pixel space under the dpr base - so the box rides the map's flip, scale and
 * rotation while the text itself never inherits any of them and stays upright and
 * readable. The box is an axis-aligned `w*s` x `l*s` rectangle, matching
 * ComponentMap's upright labels.
 * @param ctx       2D context.
 * @param label     Render-ready label (box + text, data-frame millimeters).
 * @param cssMatrix World*data CSS-pixel matrix used to place the box center.
 * @param dprBase   Device pixel ratio (upright glyph space is `Sc(dprBase)`).
 * @param s         Uniform letterbox scale (CSS px per mm) for the box size.
 * @param colors    Resolved colors (label font + color).
 */
function drawLabel(ctx, label, cssMatrix, dprBase, s, colors) {
    const boxW = label.w * s;
    const boxH = label.l * s;
    if (boxW <= 0 || boxH <= 0 || label.text === '') {
        return;
    }
    const c = cssMatrix.transformPoint(new DOMPoint(label.x, label.y));
    ctx.save();
    ctx.setTransform(dprBase, 0, 0, dprBase, 0, 0); // upright CSS-pixel space
    ctx.beginPath();
    ctx.rect(c.x - boxW / 2, c.y - boxH / 2, boxW, boxH);
    ctx.clip();
    ctx.fillStyle = colors.labelColor;
    ctx.font = colors.labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.text, c.x, c.y);
    ctx.restore();
}
/**
 * Builds the origin marker as ONE {@link Path2D} authored in the data frame D
 * (millimeters, +y up before the D2S y-flip), sized so that under the W * D2S CTM
 * every feature renders at a fixed CSS-pixel size: a small centre crosshair (a `+`
 * on the exact data origin) plus a +x and a +y axis stub, each with an arrowhead.
 * The two axes are told apart by arrowhead COUNT, not colour - +x carries a single
 * chevron, +y a double one - so the marker stays legible for colour-blind viewers
 * and in a single ink (no red/green pairing anywhere). All lengths are the
 * `ORIGIN_MARKER_*_PX / s` millimeters that {@link EDGE_PX} uses (s = uniform
 * letterbox scale, CSS px per mm), so the scaled CTM maps them back to their
 * CSS-pixel constants regardless of zoom or device pixel ratio.
 *
 * Authoring the stubs in D (rather than pre-rotated in screen space) is exactly
 * what makes the marker report the data placement for free: stroked under W * D2S
 * it inherits the origin's position and {@link makeDataMatrix}'s R(originRotation)
 * and Sc(1, ydir), so OriginRotation turns the whole marker and YAxisDirection
 * 'down' flips the +y stub (and its double head) to point downward on screen - the
 * true direction of the authored y axis. The +x stub is unaffected by the y flip.
 * @param s Uniform letterbox scale in CSS pixels per millimeter (must be `> 0`).
 * @returns The marker path in data-frame millimeters, ready to stroke under W * D2S.
 */
export function buildOriginMarkerPath(s) {
    const mm = (px) => px / s; // CSS px -> data-frame mm under W * D2S
    const stub = mm(ORIGIN_MARKER_STUB_PX);
    const cross = mm(ORIGIN_MARKER_CROSS_PX);
    const head = mm(ORIGIN_MARKER_HEAD_PX);
    const gap = mm(ORIGIN_MARKER_DOUBLE_GAP_PX);
    const barb = head * 0.55; // perpendicular half-spread of a chevron
    const path = new Path2D();
    // Centre crosshair: a small `+` on both axes, marking the exact data origin.
    path.moveTo(-cross, 0);
    path.lineTo(cross, 0);
    path.moveTo(0, -cross);
    path.lineTo(0, cross);
    // +x axis stub (from the crosshair edge to the tip) with a SINGLE chevron head.
    path.moveTo(cross, 0);
    path.lineTo(stub, 0);
    path.moveTo(stub, 0);
    path.lineTo(stub - head, barb);
    path.moveTo(stub, 0);
    path.lineTo(stub - head, -barb);
    // +y axis stub with a DOUBLE chevron head (two stacked chevrons => "+y", the
    // colour-free distinction from +x). Authored along +y in D; the D2S y-flip and
    // W turn YAxisDirection 'down' into a downward stub on screen automatically.
    path.moveTo(0, cross);
    path.lineTo(0, stub);
    path.moveTo(0, stub);
    path.lineTo(barb, stub - head);
    path.moveTo(0, stub);
    path.lineTo(-barb, stub - head);
    path.moveTo(0, stub - gap);
    path.lineTo(barb, stub - gap - head);
    path.moveTo(0, stub - gap);
    path.lineTo(-barb, stub - gap - head);
    return path;
}
/**
 * Draws the origin marker on top of the scene, under the world*data CTM
 * `cssMatrix` (= W * D2S) so it sits at, turns with and mirrors with the data
 * frame (see {@link buildOriginMarkerPath}). Stroked once in the selection colour
 * with a screen-constant width ({@link ORIGIN_MARKER_WIDTH_PX} / s mm, the
 * {@link EDGE_PX} idiom). Purely diagnostic: the marker is never added to the hit
 * index, so it is not selectable and never intercepts pointer input.
 * @param ctx       2D context (its CTM is overwritten).
 * @param cssMatrix World*data CSS-pixel matrix (W * D2S).
 * @param dprBase   Device pixel ratio (leftmost factor in {@link applyMatrix}).
 * @param s         Uniform letterbox scale (CSS px per mm); the stub/head/width scale.
 * @param color     Stroke colour (the resolved selection colour).
 */
function drawOriginMarker(ctx, cssMatrix, dprBase, s, color) {
    applyMatrix(ctx, dprBase, cssMatrix);
    ctx.strokeStyle = color;
    ctx.lineWidth = ORIGIN_MARKER_WIDTH_PX / s; // screen-constant under W * D2S
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(buildOriginMarkerPath(s));
}
/**
 * Device pixels per cell at or above which the grid layer uses the batched
 * `fillRect` run strategy, and below which it uses direct {@link ImageData}
 * writes (see {@link renderGridLayer}).
 *
 * WHERE THE NUMBER COMES FROM: a run of same-colored cells costs one `fillRect`
 * (call overhead plus rasterization), i.e. roughly a constant `C_rect` per cell
 * once runs are short; a pixel write costs a constant `C_px`. A cell covers
 * `k^2` pixels at `k` pixels per cell, so per-cell work wins while
 * `C_rect < k^2 * C_px`, i.e. below `k = sqrt(C_rect / C_px)`. With the usual
 * order of magnitude for a 2D canvas (`C_rect` ~ 1e2 ns of call + setup,
 * `C_px` ~ 1e1 ns of arithmetic + store) that crossover sits at `k ~ 3`. Below
 * it the per-pixel path is additionally BOUNDED BY THE SCREEN rather than by the
 * cell count - many cells collapse onto one pixel - which is exactly the regime
 * the 1e6-cell design driver lives in.
 */
export const GRID_RUN_STRATEGY_PX = 3;
/**
 * Relative tolerance for "the drawn cell fills its pitch cell along the column
 * axis", i.e. for merging a run of same-colored cells into ONE `fillRect`. Only
 * a street-free lattice (`cellWmm === |colStep|`) may merge; anything narrower
 * leaves gaps that must stay unpainted.
 */
const GRID_MERGE_EPS = 1e-9;
/**
 * Half-extent of a drawn cell along the COLUMN axis in lattice units (see the
 * section header): `cellWmm / (2 * |colStep|)`, clamped to `[0, 0.5]`.
 *
 * The clamp enforces the contract's `cellWmm <= pitch` rather than trusting it:
 * a wider cell would overlap its neighbours, and since the hit-test resolves a
 * point to exactly one cell via `floor(a)`, an overlap would make the painted
 * region and the hit region disagree - the one thing the CONTEXT invariant
 * forbids. Clamped, cells tile at worst and never overlap.
 * @param p The lattice placement.
 * @returns The half-extent in lattice units, `0` for a degenerate column step.
 */
export function gridHalfA(p) {
    const len = Math.hypot(p.colStepXmm, p.colStepYmm);
    return len > 0 ? Math.min(0.5, Math.max(0, p.cellWmm / (2 * len))) : 0;
}
/**
 * Half-extent of a drawn cell along the ROW axis in lattice units:
 * `cellLmm / (2 * |rowStep|)`, clamped to `[0, 0.5]`. The row-axis twin of
 * {@link gridHalfA}; see there for the reasoning behind the clamp.
 * @param p The lattice placement.
 * @returns The half-extent in lattice units, `0` for a degenerate row step.
 */
export function gridHalfB(p) {
    const len = Math.hypot(p.rowStepXmm, p.rowStepYmm);
    return len > 0 ? Math.min(0.5, Math.max(0, p.cellLmm / (2 * len))) : 0;
}
/**
 * Builds the matrix of the lattice basis: `(a, b) -> S` in millimeters, i.e.
 * `[colStep rowStep | origin]`. Pushed onto the CTM (pre-multiplied by `W`, and
 * by the dpr base) it turns every drawn cell into an axis-aligned unit-ish box,
 * so the renderer can use plain `fillRect` and still inherit MapRotation, the
 * axis flip and all four AxisDirection sign combinations for free.
 * @param p The lattice placement.
 * @returns The lattice matrix (millimeters).
 */
export function latticeMatrix(p) {
    return new DOMMatrix([p.colStepXmm, p.colStepYmm, p.rowStepXmm, p.rowStepYmm, p.originXmm, p.originYmm]);
}
/**
 * Joins a decoded bin payload with its bin definitions into a render-ready
 * {@link GridModel}, or returns `null` when the payload cannot describe a
 * lattice. Returning `null` (rather than throwing) mirrors
 * {@link buildOutlineModel}'s "null when there is nothing drawable" and drops
 * straight into the shell's `__updateGrid(grid: GridModel | null)`.
 *
 * NO PER-CELL WORK BEYOND ONE VALIDATION SCAN: the join is over
 * `payload.codes` (one row per DISTINCT bin, typically a handful), never over
 * the cells; no per-cell object and no per-cell string is materialized, and
 * `payload.cells` is ADOPTED BY REFERENCE - a 1e6-cell `Uint32Array` is never
 * copied. The single `O(cols * rows)` pass is the index-range check, which buys
 * the {@link GridModel} invariant that both hot loops index `binTable` without a
 * bounds branch; it reads one typed-array element per cell and costs well under
 * a millisecond at the design-driver size (reported by the timing section of
 * Tests/grid-core.test.mjs).
 *
 * Rejected as "not a lattice": non-integral / non-positive `cols` or `rows`, a
 * `cells` array shorter than `cols * rows` (longer is accepted, the tail is
 * ignored), an empty `codes` array (index 0 must exist - it is the reserved
 * NullBin token), a singular step basis (parallel or zero step vectors have no
 * 2x2 inverse, so nothing could be hit-tested), and any cell index outside
 * `codes`.
 *
 * The null bin (index 0) is joined like any other row so that `binTable` is a
 * 1:1 image of `codes`; it is simply never painted and never hit. Duplicate
 * definitions for one code are resolved first-wins.
 * @param placement The lattice placement in the substrate frame S.
 * @param payload   The decoded bin payload (its `cells` is adopted by reference).
 * @param binDefs   Per-code definitions to join, or `null` for none.
 * @returns The render-ready grid model, or `null` when there is nothing drawable.
 */
export function buildGridModel(placement, payload, binDefs) {
    if (!placement || typeof placement !== 'object' || !payload || typeof payload !== 'object') {
        return null;
    }
    const cols = payload.cols;
    const rows = payload.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        return null;
    }
    const n = cols * rows;
    const cells = payload.cells;
    // Duck-typed (not `instanceof`): realm-safe, and the hot loops only need
    // indexed reads - the same defensive spirit as `itemsToModels`.
    if (!cells || typeof cells.length !== 'number' || cells.length < n) {
        return null;
    }
    const codes = payload.codes;
    if (!Array.isArray(codes) || codes.length === 0) {
        return null;
    }
    // Singular basis => no 2x2 inverse => no hit-test and no drawable cell.
    const det = placement.colStepXmm * placement.rowStepYmm - placement.colStepYmm * placement.rowStepXmm;
    if (!(Math.abs(det) > 0)) {
        return null;
    }
    // Join over the DISTINCT codes, never over the cells.
    const defs = new Map();
    if (binDefs) {
        for (const d of binDefs) {
            if (d && typeof d.code === 'string' && !defs.has(d.code)) {
                defs.set(d.code, d); // first-wins on duplicate definitions
            }
        }
    }
    const binTable = new Array(codes.length);
    for (let i = 0; i < codes.length; i++) {
        const code = typeof codes[i] === 'string' ? codes[i] : '';
        const d = defs.get(code);
        binTable[i] = {
            code,
            quality: d ? normStatus(d.quality) : null, // trimmed; empty/absent => null
            pick: d ? d.pick === true : false,
        };
    }
    // The one O(cells) pass: establish the "every index addresses binTable"
    // invariant so neither hot loop needs a per-cell bounds branch.
    const limit = binTable.length;
    for (let i = 0; i < n; i++) {
        if (cells[i] >= limit) {
            return null;
        }
    }
    return { placement, cols, rows, cells, binTable };
}
/**
 * Axis-aligned bounding box of a grid's DRAWN extent in substrate-frame
 * millimeters, or `null` when there is no grid. Feeds {@link fitBBox}.
 *
 * The box spans the four corners of the drawn lattice - `a` from `0.5 - halfA`
 * to `cols - 0.5 + halfA`, `b` likewise - transformed through the step basis, so
 * it is exact under any rotation and any AxisDirection sign combination. The
 * DRAWN extent (not the pitch extent) is used because it is precisely the
 * painted area: nothing painted is ever clipped, and the outer half-streets that
 * carry no ink do not steal margin.
 * @param grid The render-ready grid, or `null`.
 * @returns The bounding box in frame S, or `null`.
 */
export function gridBBox(grid) {
    if (!grid) {
        return null;
    }
    const p = grid.placement;
    const ha = gridHalfA(p);
    const hb = gridHalfB(p);
    const a0 = 0.5 - ha;
    const a1 = grid.cols - 0.5 + ha;
    const b0 = 0.5 - hb;
    const b1 = grid.rows - 0.5 + hb;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const a = (i === 1 || i === 2) ? a1 : a0;
        const b = (i >= 2) ? b1 : b0;
        const x = p.originXmm + a * p.colStepXmm + b * p.rowStepXmm;
        const y = p.originYmm + a * p.colStepYmm + b * p.rowStepYmm;
        if (x < minX) {
            minX = x;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (y > maxY) {
            maxY = y;
        }
    }
    return (minX <= maxX && minY <= maxY) ? { minX, minY, maxX, maxY } : null;
}
/**
 * Resolves a bin's fill color. Precedence (task O2):
 *  1. the status-color mapping keyed by the bin CODE string - the same mapping
 *     and the same lookup rule items use ({@link resolveStatusColor}), so one
 *     StatusColorMapping colors items and cells alike;
 *  2. the per-quality default for the CONVENTIONAL quality strings `pass` /
 *     `fail`, matched case-insensitively on the trimmed value;
 *  3. the unknown fallback.
 *
 * `pass` / `fail` are a CONVENTION, not an enumeration: the bin quality is a free
 * string, and every other value (`edge`, `skip`, `reference`, ...) resolves to
 * the unknown color unless the mapping names its code.
 * @param entry   The bin table row.
 * @param mapping Status/code -> CSS color map, or `null`.
 * @param colors  Resolved colors (supplies `binPass` / `binFail` / `unknown`).
 * @returns The CSS color string to fill the cell with.
 */
export function resolveBinColor(entry, mapping, colors) {
    const mapped = mapping ? mapping[entry.code] : undefined;
    if (typeof mapped === 'string' && mapped.trim() !== '') {
        return mapped;
    }
    if (entry.quality !== null) {
        const q = entry.quality.toLowerCase();
        if (q === 'pass') {
            return colors.binPass;
        }
        if (q === 'fail') {
            return colors.binFail;
        }
    }
    return colors.unknown;
}
/** Whether this platform stores {@link Uint32Array} words little-endian; decided once. */
const LITTLE_ENDIAN = (() => {
    const probe = new Uint8Array([1, 0, 0, 0]);
    return new Uint32Array(probe.buffer)[0] === 1;
})();
/**
 * Packs 8-bit RGBA into one word laid out exactly as {@link ImageData} bytes, so
 * a `Uint32Array` view over `ImageData.data.buffer` can be written one word per
 * pixel instead of four bytes. Honors the platform byte order rather than
 * assuming little-endian.
 * @param r Red 0..255.
 * @param g Green 0..255.
 * @param b Blue 0..255.
 * @param a Alpha 0..255.
 * @returns The packed word.
 */
function packRgba(r, g, b, a) {
    return LITTLE_ENDIAN
        ? (((a << 24) | (b << 16) | (g << 8) | r) >>> 0)
        : (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}
/**
 * Resolves an arbitrary CSS color string to its canvas SERIALIZATION, or `null`
 * when the browser cannot parse it.
 *
 * This is the only DOM-free way to understand a color the engine did not author:
 * `StatusColorMapping` is user data and may hold anything CSS accepts
 * (`hsl(...)`, `red`, `#abc`), and the engine must not own a CSS color parser.
 * Assigning to `fillStyle` makes the CONTEXT parse it, and reading `fillStyle`
 * back yields the serialization; an unparsable value leaves the property
 * untouched, which the two differing sentinels detect. No pixels are read, so
 * this costs a property round-trip, not a `getImageData`.
 * @param ctx   A 2D context used purely as a parser; its `fillStyle` is restored.
 * @param color The candidate CSS color.
 * @returns The serialized color, or `null` when unparsable.
 */
function normalizeColor(ctx, color) {
    const prev = ctx.fillStyle;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = color;
    const a = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = color;
    const b = ctx.fillStyle;
    ctx.fillStyle = prev;
    // Parsed => both probes serialize identically; ignored => each keeps its sentinel.
    return (typeof a === 'string' && typeof b === 'string' && a === b) ? a : null;
}
/**
 * Parses a canvas-SERIALIZED color into a packed {@link ImageData} word, or
 * `null` when the form is not one this function understands.
 *
 * Only the two forms the HTML canvas serialization produces are handled:
 * `#rrggbb` (opaque) and `rgba(r, g, b, a)` / `rgb(r, g, b)`. Anything else - a
 * wide-gamut `color(...)` form, for instance - returns `null`, which cleanly
 * disables the ImageData strategy for the whole layer instead of guessing a
 * color. Deliberately NOT a general CSS color parser: {@link normalizeColor} has
 * already made the browser do that work.
 * @param s A canvas-serialized color string.
 * @returns The packed word, or `null`.
 */
function packColor(s) {
    if (s.charCodeAt(0) === 35 /* '#' */ && s.length === 7) {
        const v = parseInt(s.slice(1), 16);
        return Number.isNaN(v) ? null : packRgba((v >>> 16) & 255, (v >>> 8) & 255, v & 255, 255);
    }
    if (s.slice(0, 4) === 'rgba' || s.slice(0, 3) === 'rgb') {
        const open = s.indexOf('(');
        const close = s.lastIndexOf(')');
        if (open < 0 || close <= open) {
            return null;
        }
        const parts = s.slice(open + 1, close).split(/[\s,/]+/).filter((t) => t !== '');
        if (parts.length < 3) {
            return null;
        }
        const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
        const a = parts.length > 3 ? Number(parts[3]) : 1;
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
            return null;
        }
        return packRgba(Math.max(0, Math.min(255, Math.round(r))), Math.max(0, Math.min(255, Math.round(g))), Math.max(0, Math.min(255, Math.round(b))), Math.max(0, Math.min(255, Math.round(a * 255))));
    }
    return null;
}
/**
 * Resolves a grid's per-bin colors into the per-GROUP lookups the render
 * strategies use, plus the exact signature the layer cache keys on.
 *
 * Grouping by resolved color (not by bin index) is what makes "batched
 * same-color row runs" literal: two different bin codes mapped to one color form
 * ONE run. The work is `O(binTable.length)` - typically a handful of rows - and
 * is repeated every draw, because the mapping and the theme can change at any
 * time and the signature must track them.
 * @param grid    The grid whose bins are colored.
 * @param mapping Status/code -> CSS color map, or `null`.
 * @param colors  Resolved colors (`binPass` / `binFail` / `unknown`).
 * @param ctx     A context to resolve colors numerically with, or `null` to skip
 *                the numeric packing (leaving {@link GridPaint.rgba} `null`) when
 *                the caller knows the ImageData strategy will not be used.
 * @returns The resolved paint.
 */
export function buildGridPaint(grid, mapping, colors, ctx) {
    const n = grid.binTable.length;
    const groups = new Uint32Array(n); // groups[0] stays 0: the null bin is never painted
    const byColor = new Map();
    const colorsByGroup = ['']; // slot 0 unused (never painted)
    for (let i = 1; i < n; i++) {
        const color = resolveBinColor(grid.binTable[i], mapping, colors);
        let g = byColor.get(color);
        if (g === undefined) {
            g = colorsByGroup.length;
            colorsByGroup.push(color);
            byColor.set(color, g);
        }
        groups[i] = g;
    }
    let rgba = null;
    if (ctx) {
        rgba = new Uint32Array(colorsByGroup.length);
        for (let g = 1; g < colorsByGroup.length; g++) {
            const norm = normalizeColor(ctx, colorsByGroup[g]);
            const packed = norm !== null ? packColor(norm) : null;
            if (packed === null) {
                rgba = null; // one unparsable color disables the whole strategy
                break;
            }
            rgba[g] = packed;
        }
    }
    // The layer is a pure function of (cells, placement, groups, colorsByGroup);
    // the first two are covered by the cache key's data version, these two by this.
    return { groups, colors: colorsByGroup, rgba, signature: colorsByGroup.join('\u0001') + '\u0002' + groups.join(',') };
}
/**
 * Device-pixel bounding box of the drawn lattice, clamped to the bitmap, or
 * `null` when the grid falls entirely outside it. Used by the ImageData strategy
 * to size and place its buffer so the per-pixel loop visits only pixels the grid
 * can actually reach.
 * @param grid  The grid.
 * @param lat   The lattice->device matrix (`Sc(dpr) * W * lattice`).
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 * @param bw    Bitmap width in device pixels.
 * @param bh    Bitmap height in device pixels.
 * @returns The clamped integer box, or `null` when empty.
 */
function gridDeviceBox(grid, lat, halfA, halfB, bw, bh) {
    const a0 = 0.5 - halfA;
    const a1 = grid.cols - 0.5 + halfA;
    const b0 = 0.5 - halfB;
    const b1 = grid.rows - 0.5 + halfB;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const a = (i === 1 || i === 2) ? a1 : a0;
        const b = (i >= 2) ? b1 : b0;
        const x = lat.a * a + lat.c * b + lat.e;
        const y = lat.b * a + lat.d * b + lat.f;
        if (x < minX) {
            minX = x;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (y > maxY) {
            maxY = y;
        }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(bw, Math.ceil(maxX));
    const y1 = Math.min(bh, Math.ceil(maxY));
    // `!(x1 > x0)` rather than `x1 <= x0` so a NaN extent rejects rather than passes.
    return (!(x1 > x0) || !(y1 > y0)) ? null : { x0, y0, w: x1 - x0, h: y1 - y0 };
}
/**
 * RUN STRATEGY (>= {@link GRID_RUN_STRATEGY_PX} device pixels per cell): pushes
 * the lattice basis onto the CTM once and fills batched same-color row runs with
 * `fillRect`.
 *
 * Under `Sc(dpr) * W * lattice` a drawn cell is the axis-aligned lattice box of
 * the section header, so ONE `setTransform` buys the rotation, the axis flip and
 * every AxisDirection sign combination, and `fillRect` needs no `Path2D`. Per
 * row, maximal spans of one color group are found and the `fillStyle` is set once
 * per span. A street-free lattice (`cellWmm === |colStep|`) additionally collapses
 * the whole span into a SINGLE `fillRect`; with a street the span still costs one
 * `fillRect` per cell, because the gaps must stay unpainted, but only one
 * `fillStyle` assignment. No per-cell object, no per-cell `Path2D`, no per-cell
 * `save`/`restore`.
 *
 * Cell edges are left to canvas antialiasing rather than snapped to device
 * pixels: snapping would displace the painted cell from the mathematical one by
 * up to half a pixel and break the "hit region == painted shape" invariant, and
 * with a street - the normal die-map case - adjacent cells do not touch, so there
 * is nothing to seam.
 * @param ctx   Target context (layer bitmap, or the canvas itself when uncached).
 * @param grid  The grid.
 * @param lat   The lattice->device matrix.
 * @param paint The resolved paint.
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 */
function renderGridRuns(ctx, grid, lat, paint, halfA, halfB) {
    const cells = grid.cells;
    const cols = grid.cols;
    const rows = grid.rows;
    const groups = paint.groups;
    const colorsByGroup = paint.colors;
    const w = 2 * halfA;
    const h = 2 * halfB;
    const merge = w >= 1 - GRID_MERGE_EPS; // street-free along the column axis
    const dx = 0.5 - halfA;
    const dy = 0.5 - halfB;
    ctx.save();
    ctx.setTransform(lat.a, lat.b, lat.c, lat.d, lat.e, lat.f);
    for (let r = 0; r < rows; r++) {
        const base = r * cols;
        const y = r + dy;
        let c = 0;
        while (c < cols) {
            const g = groups[cells[base + c]];
            if (g === 0) { // null bin: never painted
                c++;
                continue;
            }
            let end = c + 1;
            while (end < cols && groups[cells[base + end]] === g) {
                end++;
            }
            ctx.fillStyle = colorsByGroup[g]; // once per run
            if (merge) {
                ctx.fillRect(c + dx, y, (end - c - 1) + w, h);
            }
            else {
                for (let k = c; k < end; k++) {
                    ctx.fillRect(k + dx, y, w, h);
                }
            }
            c = end;
        }
    }
    ctx.restore();
}
/**
 * IMAGEDATA STRATEGY (< {@link GRID_RUN_STRATEGY_PX} device pixels per cell):
 * writes the layer pixel by pixel through the INVERSE of the lattice matrix.
 *
 * Below the switch point many cells collapse onto one pixel, so per-cell work is
 * wasted; walking the pixels instead bounds the cost by the SCREEN. Each pixel
 * centre is mapped back to lattice coordinates - the same inversion
 * {@link getCellAtPos} performs, so a pixel is colored exactly when a click on it
 * would hit that cell - and the bin's packed color is stored with one word write.
 * The inverse is applied incrementally (a constant delta per pixel and per row),
 * so the inner loop is two adds, two `Math.floor`s, four compares and one store.
 *
 * REPLACES rather than composites: `putImageData` ignores the CTM and the
 * compositing state, so this strategy is only valid on a bitmap the grid owns
 * exclusively - i.e. the layer cache. The uncached path must use
 * {@link renderGridRuns} or it would erase the substrate body underneath; the
 * `allowImageData` gate in {@link renderGridLayer} enforces that.
 * @param ctx   Target context - MUST own the destination rect exclusively.
 * @param grid  The grid.
 * @param lat   The lattice->device matrix.
 * @param rgba  Packed color per group (from {@link GridPaint.rgba}).
 * @param paint The resolved paint.
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 * @param bw    Bitmap width in device pixels.
 * @param bh    Bitmap height in device pixels.
 */
function renderGridImageData(ctx, grid, lat, rgba, paint, halfA, halfB, bw, bh) {
    const det = lat.a * lat.d - lat.b * lat.c;
    if (!(Math.abs(det) > 0)) {
        return;
    }
    const box = gridDeviceBox(grid, lat, halfA, halfB, bw, bh);
    if (!box) {
        return;
    }
    const img = ctx.createImageData(box.w, box.h);
    const buf = new Uint32Array(img.data.buffer);
    // Inverse of `lat` as per-pixel / per-row deltas: a(x,y) and b(x,y) are affine,
    // so stepping one device pixel adds a constant.
    const dadx = lat.d / det;
    const dbdx = -lat.b / det;
    const dady = -lat.c / det;
    const dbdy = lat.a / det;
    const px0 = box.x0 + 0.5 - lat.e; // first pixel CENTRE, lattice-relative
    const py0 = box.y0 + 0.5 - lat.f;
    let aRow = dadx * px0 + dady * py0;
    let bRow = dbdx * px0 + dbdy * py0;
    const groups = paint.groups;
    const cells = grid.cells;
    const cols = grid.cols;
    const rows = grid.rows;
    let o = 0;
    for (let yy = 0; yy < box.h; yy++) {
        let a = aRow;
        let b = bRow;
        for (let xx = 0; xx < box.w; xx++, o++) {
            // `c >= 0 && c < cols` (not `c < 0 || c >= cols`) so a NaN rejects.
            const c = Math.floor(a);
            if (c >= 0 && c < cols) {
                const r = Math.floor(b);
                if (r >= 0 && r < rows) {
                    const fa = a - c - 0.5; // street test: identical to getCellAtPos
                    if (fa >= -halfA && fa <= halfA) {
                        const fb = b - r - 0.5;
                        if (fb >= -halfB && fb <= halfB) {
                            const g = groups[cells[r * cols + c]];
                            if (g !== 0) { // null bin: left transparent
                                buf[o] = rgba[g];
                            }
                        }
                    }
                }
            }
            a += dadx;
            b += dbdx;
        }
        aRow += dady;
        bRow += dbdy;
    }
    ctx.putImageData(img, box.x0, box.y0);
}
/**
 * Renders the grid layer with the strategy the current zoom calls for. The
 * public entry point of the two strategies; called by {@link drawSubstrateMap}
 * through the layer cache (and directly, on the uncached fallback path).
 *
 * STRATEGY SWITCH: the drawn cell's smaller device extent decides. At or above
 * {@link GRID_RUN_STRATEGY_PX} device pixels per cell the batched-`fillRect`
 * {@link renderGridRuns} wins; below it the per-pixel {@link renderGridImageData}
 * does - see {@link GRID_RUN_STRATEGY_PX} for where the number comes from. The
 * per-pixel path additionally requires numerically resolved colors
 * ({@link GridPaint.rgba}) and a bitmap the grid owns exclusively
 * (`allowImageData`); when either is missing the run strategy is used at any zoom,
 * which is slower but always correct.
 * @param ctx             Target context (layer bitmap, or the canvas when uncached).
 * @param grid            The grid.
 * @param dev             The device matrix `Sc(dpr) * W` (frame S -> device pixels).
 * @param paint           The resolved paint.
 * @param bitmapWidth     Target bitmap width in device pixels.
 * @param bitmapHeight    Target bitmap height in device pixels.
 * @param allowImageData  Whether the target rect is exclusively the grid's (only
 *                        then may `putImageData` replace it).
 */
export function renderGridLayer(ctx, grid, dev, paint, bitmapWidth, bitmapHeight, allowImageData) {
    const p = grid.placement;
    const halfA = gridHalfA(p);
    const halfB = gridHalfB(p);
    if (!(halfA > 0) || !(halfB > 0)) {
        return; // degenerate cells: nothing to paint
    }
    const lat = dev.multiply(latticeMatrix(p)); // (a, b) -> device px
    // Uniform scale of the device chain = its a-vector length (as getItemAtPos
    // computes it), so this stays right once rotations are in the chain.
    const pxPerCell = Math.min(p.cellWmm, p.cellLmm) * Math.hypot(dev.a, dev.b);
    if (allowImageData && paint.rgba && pxPerCell < GRID_RUN_STRATEGY_PX) {
        renderGridImageData(ctx, grid, lat, paint.rgba, paint, halfA, halfB, bitmapWidth, bitmapHeight);
    }
    else {
        renderGridRuns(ctx, grid, lat, paint, halfA, halfB);
    }
}
/**
 * The grid layer's offscreen bitmap cache: one bitmap per owning control, reused
 * across redraws and re-rendered only when its key changes.
 *
 * WHY: a 750k-cell layer costs a rasterization the control must not repeat when
 * something ELSE on the canvas changes (an item is selected, a label moves, the
 * origin marker toggles). The cache turns those redraws into a 1:1 `drawImage`.
 *
 * KEY: the task states "(scale, rotation, selection version, data version)"; this
 * implementation keys on the exact generalization of the first two plus the terms
 * this design actually needs -
 *  - the six components of the device matrix `Sc(dpr) * W`, which subsume scale,
 *    rotation, the axis flip, the device-pixel ratio AND the canvas centre (a
 *    resize can move the centre while leaving the scale untouched, and the bitmap
 *    is canvas-sized, so the centre must invalidate it);
 *  - the bitmap size;
 *  - the caller's DATA VERSION (a new lattice / new cells);
 *  - the paint signature ({@link GridPaint.signature}), so a theme switch or a
 *    StatusColorMapping edit invalidates the bitmap even though the data did not
 *    change - the stated key has no term for that and would go stale.
 * The SELECTION version is deliberately absent: selection rings are drawn live on
 * top of the blit, never baked in (see {@link drawSubstrateMap}), so a click must
 * not - and does not - cost a re-render of the layer.
 *
 * The bitmap is canvas-sized and rendered with the FULL device transform, so the
 * blit is `drawImage(bitmap, 0, 0)` under an identity CTM: integer-aligned, 1:1,
 * no resampling and bit-identical to an uncached render, which is what keeps the
 * blitted pixels and the hit region exact inverses. Sizing the bitmap to the
 * layer's own device extent instead would save memory but would put a fractional
 * translation between the two, at which point the blit either resamples or shifts.
 *
 * Requires `OffscreenCanvas`; where it is missing {@link acquire} returns `null`
 * and the caller renders live. Using `OffscreenCanvas` rather than a detached
 * `<canvas>` keeps the engine's "no DOM" contract literal: it allocates a bitmap
 * and touches no `document`, no layout, no attribute and no theme.
 */
export class GridLayerCache {
    /** The layer bitmap, or `null` before the first {@link acquire} / after {@link dispose}. */
    __canvas = null;
    /** 2D context of {@link __canvas}; lifetime identical to the bitmap. */
    __ctx = null;
    /** Key the current bitmap contents were rendered for, or `null` when unrendered. */
    __key = null;
    /**
     * Whether this platform can back the cache at all. `false` disables caching
     * (every draw renders live) but never disables the grid.
     * @returns Whether `OffscreenCanvas` exists.
     */
    static isSupported() {
        return typeof OffscreenCanvas !== 'undefined';
    }
    /**
     * Returns the layer bitmap for `key`, rendering it through `render` on a miss
     * and returning the untouched bitmap on a hit.
     * @param width  Required bitmap width in device pixels.
     * @param height Required bitmap height in device pixels.
     * @param key    The cache key (see the class doc).
     * @param render Renders the layer into the cleared bitmap; called only on a miss.
     * @returns The bitmap to blit, or `null` when the cache is unavailable.
     */
    acquire(width, height, key, render) {
        if (!(width > 0) || !(height > 0) || typeof OffscreenCanvas === 'undefined') {
            return null;
        }
        let canvas = this.__canvas;
        if (!canvas) {
            canvas = new OffscreenCanvas(width, height);
            this.__canvas = canvas;
            this.__ctx = canvas.getContext('2d');
            this.__key = null;
        }
        const ctx = this.__ctx;
        if (!ctx) {
            this.dispose();
            return null;
        }
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width; // resizing also clears the bitmap
            canvas.height = height;
            this.__key = null;
        }
        if (this.__key === key) {
            return canvas;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        render(ctx);
        this.__key = key;
        return canvas;
    }
    /** Drops the rendered contents, forcing the next {@link acquire} to re-render. */
    invalidate() {
        this.__key = null;
    }
    /** Releases the bitmap. Called from the owning control's `__detach`. */
    dispose() {
        if (this.__canvas) {
            this.__canvas.width = 1; // release the backing store eagerly
            this.__canvas.height = 1;
        }
        this.__canvas = null;
        this.__ctx = null;
        this.__key = null;
    }
}
/**
 * Builds the layer cache key. See {@link GridLayerCache} for why each term is
 * there - and why the selection version is not.
 * @param dev         The device matrix `Sc(dpr) * W`.
 * @param bw          Bitmap width in device pixels.
 * @param bh          Bitmap height in device pixels.
 * @param dataVersion The shell's grid data version.
 * @param paint       The resolved paint (contributes its signature).
 * @returns The cache key.
 */
function gridCacheKey(dev, bw, bh, dataVersion, paint) {
    return dev.a + ',' + dev.b + ',' + dev.c + ',' + dev.d + ',' + dev.e + ',' + dev.f +
        '|' + bw + 'x' + bh + '|' + dataVersion + '|' + paint.signature;
}
/**
 * Strokes the selection rings of the selected cells: ONE {@link Path2D} holding
 * every selected cell's drawn quad, stroked once under `W` with a
 * screen-constant width - the exact treatment {@link drawSubstrateMap} gives
 * selected items ({@link SEL_PX} / s millimeters), and for the same reasons.
 *
 * Under `W` (uniform scale, the one axis flip) the ring width is honest; the
 * lattice CTM the cells are FILLED under is deliberately not reused here, because
 * its column and row axes have different lengths and would stroke a ring thicker
 * on one axis than the other. The quads are therefore built in substrate-frame
 * millimeters straight from the step vectors.
 *
 * The per-cell ban does not apply here: this walks the SELECTION (typically one
 * cell), not the lattice.
 * @param ctx      2D context (its CTM is overwritten).
 * @param grid     The grid.
 * @param selected Selected cells as row-major linear indices.
 * @param matrices The transform chain that drove the draw.
 * @param colors   Resolved colors (supplies the selection color).
 */
function drawCellSelection(ctx, grid, selected, matrices, colors) {
    const p = grid.placement;
    const halfA = gridHalfA(p);
    const halfB = gridHalfB(p);
    if (!(halfA > 0) || !(halfB > 0)) {
        return;
    }
    const cols = grid.cols;
    const n = cols * grid.rows;
    const ring = new Path2D();
    let any = false;
    for (const index of selected) {
        if (!(index >= 0 && index < n)) {
            continue; // stale index: ignore rather than throw
        }
        const col = index % cols;
        const row = (index - col) / cols;
        const a0 = col + 0.5 - halfA;
        const a1 = col + 0.5 + halfA;
        const b0 = row + 0.5 - halfB;
        const b1 = row + 0.5 + halfB;
        // The drawn quad's four corners through the step basis (frame S, mm).
        for (let i = 0; i < 4; i++) {
            const a = (i === 1 || i === 2) ? a1 : a0;
            const b = (i >= 2) ? b1 : b0;
            const x = p.originXmm + a * p.colStepXmm + b * p.rowStepXmm;
            const y = p.originYmm + a * p.colStepYmm + b * p.rowStepYmm;
            if (i === 0) {
                ring.moveTo(x, y);
            }
            else {
                ring.lineTo(x, y);
            }
        }
        ring.closePath();
        any = true;
    }
    if (!any) {
        return;
    }
    applyMatrix(ctx, matrices.dprBase, matrices.world);
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = SEL_PX / matrices.scale; // screen-constant under W
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(ring);
}
/**
 * Draws the grid layer: the cached (or live) cell raster, then the live selection
 * rings. Called by {@link drawSubstrateMap} between the substrate body and the
 * items.
 * @param ctx      2D context (its CTM is overwritten).
 * @param cfg      Drawing configuration in CSS pixels.
 * @param layer    The grid layer.
 * @param colors   Resolved colors.
 * @param mapping  Status/code -> CSS color map, or `null`.
 * @param matrices The resolved transform chain.
 */
function drawGridLayer(ctx, cfg, layer, colors, mapping, matrices) {
    const grid = layer.model;
    const p = grid.placement;
    const dev = deviceMatrix(matrices.dprBase, matrices.world); // frame S -> device px
    // Decide the strategy BEFORE resolving colors numerically: the color packing
    // is only needed by the ImageData path, so the run path never pays for it.
    const wantImageData = Math.min(p.cellWmm, p.cellLmm) * Math.hypot(dev.a, dev.b) < GRID_RUN_STRATEGY_PX;
    const paint = buildGridPaint(grid, mapping, colors, wantImageData ? ctx : null);
    const bw = Math.max(1, Math.round(cfg.width * matrices.dprBase));
    const bh = Math.max(1, Math.round(cfg.height * matrices.dprBase));
    const cache = layer.cache;
    const bitmap = cache
        ? cache.acquire(bw, bh, gridCacheKey(dev, bw, bh, layer.dataVersion, paint), (lctx) => renderGridLayer(lctx, grid, dev, paint, bw, bh, true))
        : null;
    if (bitmap) {
        // 1:1 device-pixel blit: identity CTM, integer offset, no resampling.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(bitmap, 0, 0);
    }
    else {
        // Uncached: the ImageData strategy would REPLACE the substrate body under
        // the grid, so the run strategy is used at any zoom (see renderGridLayer).
        renderGridLayer(ctx, grid, dev, paint, bw, bh, false);
    }
    if (layer.selected && layer.selected.size > 0) {
        drawCellSelection(ctx, grid, layer.selected, matrices, colors);
    }
}
/**
 * Hit-tests a CSS-pixel pointer against the cell grid, returning the cell under
 * it or `null`. The grid's counterpart to {@link getItemAtPos}, and like it, it
 * consumes the SAME `matrices` object the draw consumed.
 *
 * O(1) and allocation-free on the hot path: two 2x2 inversions and a typed-array
 * read, with no {@link DOMMatrix} / {@link DOMPoint} temporaries (both inverses
 * are done in scalars). The only allocation is the returned {@link CellHit}, once
 * per pointer event.
 *
 * HOW IT STAYS AN EXACT INVERSE OF THE DRAW. The pointer is un-transformed CSS
 * pixels; the chain is inverted analytically instead:
 *  1. `W^-1` maps it to substrate-frame millimeters. `W` is taken verbatim from
 *     `matrices`, and `W` carries no device-pixel factor by construction (that
 *     enters only in {@link applyMatrix} / {@link deviceMatrix}), so this is the
 *     draw CTM minus the dpr base - the CONTEXT invariant, reached by inverting
 *     rather than by rebuilding.
 *  2. The 2x2 inverse of the step basis maps that to lattice coordinates (a, b) -
 *     the same coordinates the renderer PUSHES ONTO THE CTM to paint in, so the
 *     painted cell and the tested cell are the same set by construction, under
 *     MapRotation, under any AxisDirection sign combination and under an
 *     out-of-contract skewed basis alike.
 *  3. `floor` selects the pitch cell and the {@link gridHalfA} / {@link gridHalfB}
 *     band selects the DRAWN cell inside it - so a click on a street misses,
 *     exactly as a street is unpainted.
 *
 * A null cell ({@link GridModel.binTable} index 0) is never painted and is
 * therefore never hit.
 * @param p        Pointer position in canvas CSS pixels.
 * @param matrices The transform chain that drove the draw; `world` is inverted,
 *                 `fitBox`/`scale` gate the test, `dprBase` is irrelevant.
 * @param grid     The grid, or `null`.
 * @returns The hit cell, or `null` when the pointer is on a street, outside the
 *          lattice, on a null cell, or when nothing is drawable.
 */
export function getCellAtPos(p, matrices, grid) {
    // Nothing fitted / a degenerate scale => nothing painted => nothing hittable
    // (mirrors the draw guard in drawSubstrateMap and getItemAtPos).
    if (!grid || !matrices.fitBox || matrices.scale <= 0) {
        return null;
    }
    const w = matrices.world;
    const detW = w.a * w.d - w.b * w.c;
    if (!(Math.abs(detW) > 0)) {
        return null;
    }
    // W^-1: CSS px -> frame S millimeters (W is affine 2D; solved by Cramer).
    const wx = p.x - w.e;
    const wy = p.y - w.f;
    const sx = (w.d * wx - w.c * wy) / detW;
    const sy = (w.a * wy - w.b * wx) / detW;
    // Step basis^-1: frame S -> lattice coordinates (a, b).
    const pl = grid.placement;
    const ex = sx - pl.originXmm;
    const ey = sy - pl.originYmm;
    const detL = pl.colStepXmm * pl.rowStepYmm - pl.colStepYmm * pl.rowStepXmm;
    if (!(Math.abs(detL) > 0)) {
        return null;
    }
    const a = (pl.rowStepYmm * ex - pl.rowStepXmm * ey) / detL;
    const b = (pl.colStepXmm * ey - pl.colStepYmm * ex) / detL;
    // `col >= 0 && col < cols` (not the negation) so a NaN rejects rather than passes.
    const col = Math.floor(a);
    if (!(col >= 0 && col < grid.cols)) {
        return null;
    }
    const row = Math.floor(b);
    if (!(row >= 0 && row < grid.rows)) {
        return null;
    }
    // Inside the PITCH cell, but is it inside the DRAWN cell? A street click misses.
    if (Math.abs(a - col - 0.5) > gridHalfA(pl) || Math.abs(b - row - 0.5) > gridHalfB(pl)) {
        return null;
    }
    const index = row * grid.cols + col;
    if (grid.cells[index] === 0) {
        return null; // null bin: never painted, never hit
    }
    return { col, row, index };
}
/**
 * Draws the whole substrate map in one pass, in z-order: background, the
 * substrate body (filled and edged Outline, when bound), the CELL GRID (the die
 * layer, with its own selection rings), every item (grouped, colored, rotated,
 * z-ordered), the item selection rings, the upright labels and the origin
 * marker. The transform chain (W, D2S and the per-item matrix) is applied via
 * {@link applyMatrix}, so the device-pixel-ratio factor enters exactly once, as
 * the leftmost factor.
 *
 * The grid sits below the items because it is the SUBSTRATE's own subdivision -
 * items are placed on top of dies, never under them - and it is drawn under `W`
 * alone (frame S, like the outline), whereas items ride `W * D2S`.
 *
 * Fit / body fallback (CONTEXT precedence): `matrices.fitBox` is the outline
 * bbox when an outline is bound, else the combined bbox of the items and the grid;
 * when it is `null` (nothing bound) the canvas is only cleared. When no outline is
 * bound but items / a grid exist, the map is fitted to those and NO body is drawn.
 *
 * DEVIATION FROM ComponentMap: a filled item geometry is filled only (no
 * per-geometry edge stroke); ComponentMap additionally strokes each filled
 * geometry with the edge color. Here the edge color is reserved for the
 * substrate outline, per the task's item rule ("fill or stroke ... with the
 * status color").
 * @param ctx           2D context (its CTM is overwritten per stage).
 * @param cfg           Drawing configuration in CSS pixels.
 * @param outlineModel  The substrate outline, or `null` (no body; items-fit fallback).
 * @param grid          The cell grid layer, or `null` (no grid). Positioned right
 *                      after the outline to mirror the z-order; a caller that has
 *                      not been updated fails to compile rather than silently
 *                      binding its items to it.
 * @param items         The render-ready items (may be empty).
 * @param colors        Resolved colors and label font.
 * @param resolveStatus Effective-status resolver for an item.
 * @param mapping       Status -> CSS color map, or `null`.
 * @param selectedItems The selected items, each marked with its own ring; empty
 *                      when nothing is selected. Every selected element is marked,
 *                      not just the last interacted one.
 * @param labels        Render-ready labels.
 * @param showLabels    Whether labels are drawn.
 * @param showOriginMarker Whether the origin marker (data-origin crosshair + axis stubs) is drawn on top.
 * @param matrices      The resolved transform chain and scalars (see {@link MapMatrices}).
 */
export function drawSubstrateMap(ctx, cfg, outlineModel, grid, items, colors, resolveStatus, mapping, selectedItems, labels, showLabels, showOriginMarker, matrices) {
    // Background / clear in CSS-pixel space (dpr base). clearRect(0,0,w,h) under
    // the dpr base clears the whole bitmap; an empty background leaves it clear.
    ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);
    ctx.clearRect(0, 0, cfg.width, cfg.height);
    if (colors.bg !== '') {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, cfg.width, cfg.height);
    }
    // Nothing to fit (no outline and no boundable items) or a degenerate scale:
    // the canvas is cleared and nothing else is drawn.
    if (!matrices.fitBox || matrices.scale <= 0) {
        return;
    }
    const s = matrices.scale;
    // Substrate body: the Outline path under W, filled with the body color and
    // stroked with a screen-constant edge. Skipped entirely in the items-fit
    // fallback (no outline bound), which draws no body.
    if (outlineModel) {
        applyMatrix(ctx, matrices.dprBase, matrices.world);
        ctx.fillStyle = colors.body;
        ctx.fill(outlineModel.path);
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = EDGE_PX / s; // screen-constant under W
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(outlineModel.path);
    }
    // The cell grid (the die layer) directly above the substrate body and below
    // the items: it is authored in frame S like the outline, so it rides W ALONE -
    // the Origin* attributes place the ITEM data frame and must not move it. Its
    // own selection rings are drawn inside, keeping the layer one z-band.
    if (grid) {
        drawGridLayer(ctx, cfg, grid, colors, mapping, matrices);
    }
    // Items in z-order, each under W * D2S * T(c) R(theta) T(-c). One status color
    // per item; paint mode is per geometry. A geometry's own stroke_width is a
    // real length authored in mm, so it is set directly (it scales with the CTM);
    // no EDGE_PX/s here.
    const wd = matrices.world.multiply(matrices.data); // W * D2S (CSS px)
    if (items.length > 0) {
        const order = computeDrawOrder(items);
        for (const it of order) {
            const fill = resolveStatusColor(resolveStatus(it), mapping, colors.unknown);
            applyMatrix(ctx, matrices.dprBase, wd.multiply(itemMatrix(it)));
            for (const g of it.geometries) {
                if (g.stroked) {
                    ctx.strokeStyle = fill;
                    ctx.lineWidth = g.strokeWidthMm;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.stroke(g.path);
                }
                else {
                    ctx.fillStyle = fill;
                    ctx.fill(g.path);
                }
            }
        }
        // Selection rings above every item: for EACH selected item union its
        // geometries and stroke once under that item's own CTM, screen-constant
        // (rotation- and group-aware for free). Marking every selected element
        // (not just the last interacted one) is what a multi-selection needs.
        for (const selItem of selectedItems) {
            applyMatrix(ctx, matrices.dprBase, wd.multiply(itemMatrix(selItem)));
            const ring = new Path2D();
            for (const g of selItem.geometries) {
                ring.addPath(g.path);
            }
            ctx.strokeStyle = colors.selection;
            ctx.lineWidth = SEL_PX / s; // screen-constant under the item CTM
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke(ring);
        }
    }
    // Upright labels above the items, positioned under W * D2S.
    if (showLabels) {
        for (const lm of labels) {
            drawLabel(ctx, lm, wd, matrices.dprBase, s, colors);
        }
    }
    // Origin marker on top of everything, under W * D2S (`wd`): a crosshair marking
    // the data origin plus +x/+y data-axis stubs with arrowheads (x single head, y
    // double). Screen-constant in size and width. Riding the full data matrix, it
    // shows the origin's position, OriginRotation and YAxisDirection ('down' flips
    // the +y stub) for free. Not hit-tested (never added to the hit index).
    if (showOriginMarker) {
        drawOriginMarker(ctx, wd, matrices.dprBase, s, colors.selection);
    }
}
/**
 * Hit-tests a CSS-pixel pointer against the items (topmost first) using the SAME
 * transform chain that drew them. The draw order is walked in REVERSE (see
 * {@link computeDrawOrder}) so the topmost item wins where geometries overlap;
 * the first item with any geometry under the pointer is returned. Ported from
 * ComponentMap's `getStructureAtPos`.
 *
 * Hit CTM (CONTEXT invariant "hit CTM = draw CTM minus dpr"): the pointer stays in
 * CSS pixels and is NOT transformed - the geometry {@link Path2D} is, via the
 * per-item CTM `W * D2S * item`. That product is built from the SAME `matrices`
 * object handed to {@link drawSubstrateMap} (its `world` and `data` matrices are
 * multiplied verbatim, exactly as the draw does) but applied on a UNIT base
 * ({@link applyMatrix} with `dprBase = 1`). The hit CTM is therefore the draw CTM
 * with only the device-pixel-ratio factor removed, so the hit region and the
 * painted shape coincide to the pixel. Filled geometries test with
 * `isPointInPath`; stroked ones with `isPointInStroke`, so the hit follows the
 * painted stroke and never fires through a hollow interior.
 *
 * Thin-stroke tolerance: a stroked geometry is hit with
 * `lineWidth = max(strokeWidthMm, HIT_MIN_PX / s')`, where `s'` is the uniform
 * scale of that hit CTM. Because the chain carries only scaling, flips and
 * rotations, that scale is the length of the CTM's a-vector, `hypot(a, b)`,
 * COMPUTED from the matrix rather than assumed equal to {@link MapMatrices.scale}
 * - so it stays correct once the MapRotation / Origin seams add rotations and a
 * y-flip to the chain. Both `strokeWidthMm` and `HIT_MIN_PX / s'` are in
 * millimetres (the CTM's user space), matching the width ComponentMap hit with.
 *
 * @param p        Pointer position in canvas CSS pixels.
 * @param items    The active render-ready items (the exact list that was drawn).
 * @param matrices The transform chain that drove the draw; its `world` and `data`
 *                 matrices are reused verbatim and `scale`/`fitBox` gate the test.
 *                 `dprBase` is ignored - the hit CTM forces a unit base.
 * @param ctx      2D context used for `isPointInPath` / `isPointInStroke`; its
 *                 transform is overwritten per item and restored on return.
 * @returns The topmost hit item, or `null` if none was hit.
 */
export function getItemAtPos(p, items, matrices, ctx) {
    // Nothing fitted / a degenerate scale => nothing painted => nothing hittable
    // (mirrors the draw guard in drawSubstrateMap).
    if (!matrices.fitBox || matrices.scale <= 0) {
        return null;
    }
    // SAME product the draw builds: W * D2S from the exact matrix objects in
    // `matrices`, then * item per item below.
    const wd = matrices.world.multiply(matrices.data);
    const order = computeDrawOrder(items);
    ctx.save();
    try {
        // Topmost first: draw order reversed.
        for (let i = order.length - 1; i >= 0; i--) {
            const it = order[i];
            // Per-item hit CTM = W * D2S * item on a UNIT base (no dpr): the pointer
            // is in CSS px and is not transformed, the path is.
            const m = wd.multiply(itemMatrix(it));
            applyMatrix(ctx, 1, m);
            // Uniform scale of THIS hit CTM = its a-vector length (see the doc
            // comment); > 0 given the fitBox/scale guard above.
            const sPrime = Math.hypot(m.a, m.b);
            for (const g of it.geometries) {
                let hit;
                if (g.stroked) {
                    // Hit follows paint: outlines are hit on the stroke only, with a
                    // screen-constant minimum band for thin/zero-width lines.
                    ctx.lineWidth = Math.max(g.strokeWidthMm, HIT_MIN_PX / sPrime);
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    hit = ctx.isPointInStroke(g.path, p.x, p.y);
                }
                else {
                    hit = ctx.isPointInPath(g.path, p.x, p.y);
                }
                if (hit) {
                    return it;
                }
            }
        }
        return null;
    }
    finally {
        ctx.restore();
    }
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
// Idempotent registration guard: `??=` keeps the first definition if this
// file is ever evaluated twice (cannot happen through the module cache, but
// required for the classic fallback variant and free of cost here).
const engineNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine');
engineNamespace['EngineHello'] ??= EngineHello;
engineNamespace['MODULE_EVALUATIONS'] = MODULE_EVALUATIONS;
//# sourceMappingURL=Engine.js.map