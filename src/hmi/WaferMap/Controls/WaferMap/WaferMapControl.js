"use strict";
// ============================================================================
//  WaferMap - TwinCAT HMI framework control
//
//  Renders a SEMI-standard wafer (primary/secondary flats or notch) plus the
//  individual dies. Wafer identity AND die data are exposed as bindable
//  attributes so the wafer can be filled from MES / a recipe database via
//  server-symbol bindings.
//
//  Two data attributes, mirroring the JSON schemas:
//    - Chips             : ChipEntryList            (full die layout, optional per-die status)
//    - StatusAssignments : ChipStatusAssignmentList (chips_id -> status, for status-only updates)
//  StatusAssignments overrides the status embedded in a ChipEntry (live status wins).
//
//  Die colors per status live in the theme CSS as custom properties
//  (--wafermap-status-*), so they are themeable.
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaferMap = exports.SIZES = exports.FLAT_TYPES = exports.WAFER_SPECS = void 0;
// ---------------------------------------------------------------------------
//  SEMI standard specifications
//  primary/secondary: flat length in mm; secAngle: angle secondary->primary (deg)
//  notchDepth: midpoint of 1.00-1.25 mm
// ---------------------------------------------------------------------------
exports.WAFER_SPECS = [
    { type: 'P-111', inch: 2, dia: 50.8, shape: '1flat', secAngle: null, primary: 15.88, secondary: null },
    { type: 'N-111', inch: 2, dia: 50.8, shape: '2flats', secAngle: 45, primary: 15.88, secondary: 8.00 },
    { type: 'P-100', inch: 2, dia: 50.8, shape: '2flats', secAngle: 90, primary: 15.88, secondary: 8.00 },
    { type: 'N-100', inch: 2, dia: 50.8, shape: '2flats', secAngle: 180, primary: 15.88, secondary: 8.00 },
    { type: 'P-111', inch: 3, dia: 76.2, shape: '1flat', secAngle: null, primary: 22.22, secondary: null },
    { type: 'N-111', inch: 3, dia: 76.2, shape: '2flats', secAngle: 45, primary: 22.22, secondary: 11.18 },
    { type: 'P-100', inch: 3, dia: 76.2, shape: '2flats', secAngle: 90, primary: 22.22, secondary: 11.18 },
    { type: 'N-100', inch: 3, dia: 76.2, shape: '2flats', secAngle: 180, primary: 22.22, secondary: 11.18 },
    { type: 'P-111', inch: 4, dia: 100.0, shape: '1flat', secAngle: null, primary: 32.50, secondary: null },
    { type: 'N-111', inch: 4, dia: 100.0, shape: '2flats', secAngle: 45, primary: 32.50, secondary: 18.00 },
    { type: 'P-100', inch: 4, dia: 100.0, shape: '2flats', secAngle: 90, primary: 32.50, secondary: 18.00 },
    { type: 'N-100', inch: 4, dia: 100.0, shape: '2flats', secAngle: 180, primary: 32.50, secondary: 18.00 },
    { type: 'P-111', inch: 5, dia: 125.0, shape: '1flat', secAngle: null, primary: 42.50, secondary: null },
    { type: 'N-111', inch: 5, dia: 125.0, shape: '2flats', secAngle: 45, primary: 42.50, secondary: 27.50 },
    { type: 'P-100', inch: 5, dia: 125.0, shape: '2flats', secAngle: 90, primary: 42.50, secondary: 27.50 },
    { type: 'N-100', inch: 5, dia: 125.0, shape: '2flats', secAngle: 180, primary: 42.50, secondary: 27.50 },
    { type: 'P-111', inch: 6, dia: 150.0, shape: '1flat', secAngle: null, primary: 57.50, secondary: null },
    { type: 'N-111', inch: 6, dia: 150.0, shape: '2flats', secAngle: 45, primary: 57.50, secondary: 37.50 },
    { type: 'P-100', inch: 6, dia: 150.0, shape: '2flats', secAngle: 90, primary: 57.50, secondary: 37.50 },
    { type: 'N-100', inch: 6, dia: 150.0, shape: '2flats', secAngle: 180, primary: 57.50, secondary: 37.50 },
    { type: 'All types', inch: 8, dia: 200.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 12, dia: 300.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 18, dia: 450.0, shape: 'notch', notchDepth: 1.125 },
];
exports.FLAT_TYPES = ['P-111', 'N-111', 'P-100', 'N-100'];
exports.SIZES = [...new Set(exports.WAFER_SPECS.map(s => s.inch))];
const STATUSES = ['READY', 'PROCESSING', 'COMPLETED', 'FAILED'];
// Decimal exponent of each metric prefix.
const PREFIX_EXP = {
    yocto: -24, zepto: -21, atto: -18, femto: -15, pico: -12, nano: -9,
    micro: -6, milli: -3, centi: -2, deci: -1, none: 0,
};
const DEFAULTS = {
    waferType: 'N-100',
    sizeInch: 4,
    secDir: 'cw',
    notchScale: 12,
    showDemoChips: true,
};
// ---------------------------------------------------------------------------
//  Geometry (pure functions)
// ---------------------------------------------------------------------------
function waferMapRadius(cfg) {
    return Math.min(cfg.width, cfg.height) / 2 - cfg.margin;
}
function norm(a) { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }
function getSpec(inch, type) {
    // For notch sizes (>=8") the type is irrelevant to the geometry.
    const spec = exports.WAFER_SPECS.find(s => s.inch === inch && s.type === type)
        ?? exports.WAFER_SPECS.find(s => s.inch === inch);
    if (!spec) {
        throw new Error('No wafer spec for ' + inch + '" ' + type);
    }
    return spec;
}
function nearestSize(inch) {
    let best = exports.SIZES[0];
    let bestDelta = Math.abs(inch - best);
    for (const s of exports.SIZES) {
        const d = Math.abs(inch - s);
        if (d < bestDelta) {
            best = s;
            bestDelta = d;
        }
    }
    return best;
}
// Flats as {center, half} in canvas radians (y points down => CW positive).
function computeFlats(spec, secDir) {
    if (spec.shape === 'notch') {
        return [];
    }
    const aP = Math.asin(Math.min(1, spec.primary / spec.dia)); // half-angle of the chord
    const flats = [{ center: Math.PI / 2, half: aP }];
    if (spec.shape === '2flats' && spec.secondary != null && spec.secAngle != null) {
        const aS = Math.asin(Math.min(1, spec.secondary / spec.dia));
        const theta = spec.secAngle * Math.PI / 180;
        const center = secDir === 'cw' ? (Math.PI / 2 + theta) : (Math.PI / 2 - theta);
        flats.push({ center, half: aS });
    }
    return flats;
}
function pathDiscWithFlats(c, cx, cy, R, flats) {
    c.beginPath();
    if (flats.length === 0) {
        c.arc(cx, cy, R, 0, 2 * Math.PI);
        c.closePath();
        return;
    }
    const sorted = flats.map(f => ({ center: norm(f.center), half: f.half }))
        .sort((a, b) => a.center - b.center);
    const pt = (a) => ({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    const p0 = pt(sorted[0].center + sorted[0].half);
    c.moveTo(p0.x, p0.y);
    for (let k = 1; k <= sorted.length; k++) {
        const prev = sorted[k - 1];
        const cur = sorted[k % sorted.length];
        const arcStart = prev.center + prev.half;
        let arcEnd = cur.center - cur.half;
        while (arcEnd < arcStart) {
            arcEnd += 2 * Math.PI;
        }
        c.arc(cx, cy, R, arcStart, arcEnd, false);
        const trailing = pt(cur.center + cur.half);
        c.lineTo(trailing.x, trailing.y);
    }
    c.closePath();
}
function pathDiscWithNotch(c, cx, cy, R, depth, halfWidth) {
    const a0 = Math.PI / 2 - halfWidth;
    const a1 = Math.PI / 2 + halfWidth;
    c.beginPath();
    c.arc(cx, cy, R, a1, a0 + 2 * Math.PI, false);
    c.lineTo(cx, cy + (R - depth));
    c.lineTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
    c.closePath();
}
function buildWaferPath(c, cx, cy, R, spec, secDir, notchScale) {
    if (spec.shape === 'notch') {
        const trueDepth = (spec.notchDepth / (spec.dia / 2)) * R;
        const depth = trueDepth * notchScale;
        pathDiscWithNotch(c, cx, cy, R, depth, depth / R);
    }
    else {
        pathDiscWithFlats(c, cx, cy, R, computeFlats(spec, secDir));
    }
}
// coordinate space (wafer-centric, y up) <-> canvas/map space (y down)
function coordToMap(pos, coordRadius, cfg) {
    const s = waferMapRadius(cfg) / coordRadius;
    return { x: cfg.center.x + pos.x * s, y: cfg.center.y - pos.y * s };
}
function mapToCoord(pos, coordRadius, cfg) {
    const s = coordRadius / waferMapRadius(cfg);
    return { x: (pos.x - cfg.center.x) * s, y: (cfg.center.y - pos.y) * s };
}
// ---------------------------------------------------------------------------
//  Data transforms (pure)
// ---------------------------------------------------------------------------
function normStatus(s) {
    return (typeof s === 'string' && STATUSES.indexOf(s) !== -1) ? s : null;
}
// value [unit=meter, prefix] -> millimeters (to match WaferSpec.dia which is in mm)
function toMillimeters(value, prefix) {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, (exp === undefined ? 0 : exp) + 3);
}
function chipsToDies(chips) {
    const dies = [];
    for (const e of chips) {
        dies.push({
            id: e.chips_id === undefined ? null : e.chips_id,
            x: toMillimeters(e.center_position_x, e.prefix),
            y: toMillimeters(e.center_position_y, e.prefix),
            w: toMillimeters(e.width, e.prefix),
            h: toMillimeters(e.length, e.prefix),
            status: normStatus(e.status),
        });
    }
    return dies;
}
function buildStatusMap(list) {
    const m = new Map();
    if (list) {
        for (const a of list) {
            const s = normStatus(a.status);
            if (s !== null) {
                m.set(a.chips_id, s);
            }
        }
    }
    return m;
}
// Random placeholder grid for design time (no real data bound).
function buildDemo() {
    const cell = 30 + 10 * Math.floor(Math.random() * 7);
    const size = cell * 0.9;
    const radius = cell * (3 + Math.floor(Math.random() * 4));
    const numRows = (radius * 2) / cell;
    const step = (radius * 2) / numRows;
    const inR = (x, y) => (x * x + y * y) <= radius * radius;
    const dies = [];
    for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numRows; j++) {
            if (Math.random() < 0.4) {
                continue;
            }
            const cx = -radius + (i + 0.5) * step;
            const cy = -radius + (j + 0.5) * step;
            const hw = size / 2;
            if (inR(cx - hw, cy - hw) && inR(cx - hw, cy + hw) && inR(cx + hw, cy - hw) && inR(cx + hw, cy + hw)) {
                dies.push({ id: null, x: cx, y: cy, w: size, h: size, status: STATUSES[Math.floor(Math.random() * STATUSES.length)] });
            }
        }
    }
    return { radius, dies };
}
function getDieAtPos(p, dies, coordRadius, cfg) {
    const w = mapToCoord(p, coordRadius, cfg);
    for (const d of dies) {
        if (w.x >= d.x - d.w / 2 && w.x <= d.x + d.w / 2 && w.y >= d.y - d.h / 2 && w.y <= d.y + d.h / 2) {
            return d;
        }
    }
    return null;
}
function drawWaferMap(c, cfg, dies, coordRadius, spec, secDir, notchScale, colors, resolve, selected) {
    const R = waferMapRadius(cfg);
    const cx = cfg.center.x;
    const cy = cfg.center.y;
    c.clearRect(0, 0, cfg.width, cfg.height);
    if (colors.bg !== '') {
        c.fillStyle = colors.bg;
        c.fillRect(0, 0, cfg.width, cfg.height);
    }
    if (R <= 0) {
        return;
    }
    // wafer disc (shape depends on type) - always drawn to full radius (= 100%)
    buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
    c.fillStyle = colors.wafer;
    c.fill();
    // dies, clipped to the wafer outline so flats/notch cut the grid
    if (dies && coordRadius > 0) {
        const scale = R / coordRadius;
        c.save();
        buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
        c.clip();
        for (const d of dies) {
            const st = resolve(d);
            c.fillStyle = colors.status[st === null ? 'UNKNOWN' : st];
            const tl = coordToMap({ x: d.x - d.w / 2, y: d.y + d.h / 2 }, coordRadius, cfg);
            c.fillRect(tl.x, tl.y, d.w * scale, d.h * scale);
        }
        if (selected) {
            c.strokeStyle = colors.selection;
            c.lineWidth = 2;
            const tl = coordToMap({ x: selected.x - selected.w / 2, y: selected.y + selected.h / 2 }, coordRadius, cfg);
            c.strokeRect(tl.x - 2, tl.y - 2, selected.w * scale + 4, selected.h * scale + 4);
        }
        c.restore();
    }
    // wafer edge
    buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
    c.strokeStyle = colors.edge;
    c.lineWidth = 2;
    c.stroke();
}
// ===========================================================================
//  The framework control
// ===========================================================================
class WaferMap extends TcHmi.Controls.System.TcHmiControl {
    __elementTemplateRoot;
    // ---- runtime ----
    __canvas = null;
    __ctx = null;
    __resizeObserver = null;
    __onPointerUp = null;
    // ---- derived render state ----
    __realDies = null; // from Chips
    __statusMap = new Map(); // from StatusAssignments
    __demo = null;
    __selected = null;
    // ---- attribute backing fields (defaults mirror Description.json) ----
    __waferType = DEFAULTS.waferType;
    __sizeInch = DEFAULTS.sizeInch;
    __secDir = DEFAULTS.secDir;
    __notchScale = DEFAULTS.notchScale;
    __showDemoChips = DEFAULTS.showDemoChips;
    __chips = null;
    __statusAssignments = null;
    constructor(element, pcElement, attrs) {
        super(element, pcElement, attrs);
    }
    __previnit() {
        this.__elementTemplateRoot = this.__element.find('.TcHmi_Controls_WaferMap_WaferMap-Template');
        if (this.__elementTemplateRoot.length === 0) {
            throw new Error('Invalid Template.html');
        }
        super.__previnit();
    }
    __init() {
        super.__init();
    }
    __attach() {
        super.__attach();
        const root = this.__elementTemplateRoot[0];
        const canvas = document.createElement('canvas');
        canvas.className = 'TcHmi_Controls_WaferMap_WaferMap-Canvas';
        canvas.style.display = 'block';
        root.appendChild(canvas);
        this.__canvas = canvas;
        this.__ctx = canvas.getContext('2d');
        this.__rebuildDemo();
        this.__rebuildDies();
        this.__rebuildStatusMap();
        this.__resizeObserver = new ResizeObserver(() => this.__render());
        this.__resizeObserver.observe(root);
        this.__onPointerUp = (ev) => this.__handlePointerUp(ev);
        canvas.addEventListener('pointerup', this.__onPointerUp);
        this.__render();
    }
    __detach() {
        if (this.__resizeObserver) {
            this.__resizeObserver.disconnect();
            this.__resizeObserver = null;
        }
        if (this.__canvas && this.__onPointerUp) {
            this.__canvas.removeEventListener('pointerup', this.__onPointerUp);
        }
        if (this.__canvas && this.__canvas.parentNode) {
            this.__canvas.parentNode.removeChild(this.__canvas);
        }
        this.__canvas = null;
        this.__ctx = null;
        this.__onPointerUp = null;
        super.__detach();
    }
    destroy() {
        if (this.__keepAlive) {
            return;
        }
        super.destroy();
    }
    // -----------------------------------------------------------------------
    //  Attributes  (convert -> default fallback -> change-detect -> notify -> process)
    // -----------------------------------------------------------------------
    setWaferType(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || exports.FLAT_TYPES.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('WaferType');
        }
        if (tchmi_equal(v, this.__waferType)) {
            return;
        }
        this.__waferType = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferType' });
        this.__render();
    }
    getWaferType() { return this.__waferType; }
    setWaferSizeInch(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('WaferSizeInch');
        }
        n = nearestSize(n);
        if (tchmi_equal(n, this.__sizeInch)) {
            return;
        }
        this.__sizeInch = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferSizeInch' });
        this.__render();
    }
    getWaferSizeInch() { return this.__sizeInch; }
    setSecondaryFlatDirection(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v !== 'cw' && v !== 'ccw') {
            v = this.getAttributeDefaultValueInternal('SecondaryFlatDirection');
        }
        if (tchmi_equal(v, this.__secDir)) {
            return;
        }
        this.__secDir = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SecondaryFlatDirection' });
        this.__render();
    }
    getSecondaryFlatDirection() { return this.__secDir; }
    setNotchExaggeration(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('NotchExaggeration');
        }
        if (n < 1) {
            n = 1;
        }
        if (tchmi_equal(n, this.__notchScale)) {
            return;
        }
        this.__notchScale = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NotchExaggeration' });
        this.__render();
    }
    getNotchExaggeration() { return this.__notchScale; }
    setShowDemoChips(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowDemoChips');
        }
        if (tchmi_equal(b, this.__showDemoChips)) {
            return;
        }
        this.__showDemoChips = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowDemoChips' });
        this.__rebuildDemo();
        this.__render();
    }
    getShowDemoChips() { return this.__showDemoChips; }
    // Full die layout (ChipEntryList). Replaces the demo grid when non-empty.
    setChips(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Chips');
        }
        if (tchmi_equal(v, this.__chips)) {
            return;
        }
        this.__chips = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Chips' });
        this.__rebuildDies();
        this.__render();
    }
    getChips() { return this.__chips; }
    // Status-only updates (ChipStatusAssignmentList), keyed by chips_id.
    setStatusAssignments(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('StatusAssignments');
        }
        if (tchmi_equal(v, this.__statusAssignments)) {
            return;
        }
        this.__statusAssignments = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'StatusAssignments' });
        this.__rebuildStatusMap();
        this.__render();
    }
    getStatusAssignments() { return this.__statusAssignments; }
    // -----------------------------------------------------------------------
    //  Rendering
    // -----------------------------------------------------------------------
    __rebuildDies() {
        this.__realDies = this.__chips ? chipsToDies(this.__chips) : null;
        this.__selected = null; // a new layout invalidates the previous selection
    }
    __rebuildStatusMap() {
        this.__statusMap = buildStatusMap(this.__statusAssignments);
    }
    __rebuildDemo() {
        this.__demo = this.__showDemoChips ? buildDemo() : null;
    }
    __effectiveStatus(d) {
        if (d.id !== null) {
            const s = this.__statusMap.get(d.id);
            if (s !== undefined) {
                return s;
            }
        }
        return d.status;
    }
    // Which dies to draw + the coordinate-space radius + a status resolver.
    __activeModel() {
        if (this.__realDies && this.__realDies.length > 0) {
            const spec = getSpec(this.__sizeInch, this.__waferType);
            return { dies: this.__realDies, coordRadius: spec.dia / 2, resolve: (d) => this.__effectiveStatus(d) };
        }
        if (this.__showDemoChips && this.__demo) {
            return { dies: this.__demo.dies, coordRadius: this.__demo.radius, resolve: (d) => d.status };
        }
        return null;
    }
    __readColors() {
        const cs = window.getComputedStyle(this.__element[0]);
        const read = (name, fallback) => {
            const value = cs.getPropertyValue(name).trim();
            return value !== '' ? value : fallback;
        };
        return {
            bg: read('--wafermap-background', ''),
            wafer: read('--wafermap-wafer-color', 'rgb(220, 220, 220)'),
            edge: read('--wafermap-edge-color', 'rgb(110, 110, 110)'),
            selection: read('--wafermap-selection-color', 'rgb(0, 90, 200)'),
            status: {
                READY: read('--wafermap-status-ready', 'rgb(150, 150, 150)'),
                PROCESSING: read('--wafermap-status-processing', 'rgb(230, 170, 0)'),
                COMPLETED: read('--wafermap-status-completed', 'rgb(0, 160, 70)'),
                FAILED: read('--wafermap-status-failed', 'rgb(200, 40, 40)'),
                UNKNOWN: read('--wafermap-status-unknown', 'rgb(110, 110, 110)'),
            },
        };
    }
    __makeConfig() {
        const root = this.__elementTemplateRoot[0];
        const w = root.clientWidth;
        const h = root.clientHeight;
        if (w <= 0 || h <= 0) {
            return null;
        }
        return { center: { x: w / 2, y: h / 2 }, width: w, height: h, margin: 8 };
    }
    __render() {
        if (!this.__canvas || !this.__ctx) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const pxW = Math.round(cfg.width * dpr);
        const pxH = Math.round(cfg.height * dpr);
        if (this.__canvas.width !== pxW || this.__canvas.height !== pxH) {
            this.__canvas.width = pxW;
            this.__canvas.height = pxH;
            this.__canvas.style.width = cfg.width + 'px';
            this.__canvas.style.height = cfg.height + 'px';
        }
        this.__ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const spec = getSpec(this.__sizeInch, this.__waferType);
        const colors = this.__readColors();
        const model = this.__activeModel();
        drawWaferMap(this.__ctx, cfg, model ? model.dies : null, model ? model.coordRadius : 1, spec, this.__secDir, this.__notchScale, colors, model ? model.resolve : () => null, this.__selected);
    }
    __handlePointerUp(ev) {
        if (!this.__canvas) {
            return;
        }
        const model = this.__activeModel();
        if (!model) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const rect = this.__canvas.getBoundingClientRect();
        const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const die = getDieAtPos(p, model.dies, model.coordRadius, cfg);
        if (die) {
            this.__selected = die;
            this.__render();
        }
    }
}
exports.WaferMap = WaferMap;
/*
 * Register Control class object for control
 */
TcHmi.Controls.registerEx('WaferMap', 'TcHmi.Controls.WaferMap', WaferMap);
//# sourceMappingURL=WaferMapControl.js.map