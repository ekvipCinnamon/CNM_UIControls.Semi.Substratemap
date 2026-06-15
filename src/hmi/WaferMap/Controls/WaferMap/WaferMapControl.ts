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

// ---------------------------------------------------------------------------
//  Wafer geometry types
// ---------------------------------------------------------------------------
export type SecDir = 'cw' | 'ccw';

export interface FlatWaferSpec {
    type: string;
    inch: number;
    dia: number;
    shape: '1flat' | '2flats';
    secAngle: number | null;
    primary: number;
    secondary: number | null;
}

export interface NotchWaferSpec {
    type: string;
    inch: number;
    dia: number;
    shape: 'notch';
    notchDepth: number;
}

export type WaferSpec = FlatWaferSpec | NotchWaferSpec;

export interface Point { x: number; y: number; }
export interface Flat { center: number; half: number; }

// ---------------------------------------------------------------------------
//  Chip / die data types  (1:1 with the JSON schemas registered in Description.json)
// ---------------------------------------------------------------------------
export type ChipStatus = 'READY' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type MetricPrefix =
    'yocto' | 'zepto' | 'atto' | 'femto' | 'pico' | 'nano' |
    'micro' | 'milli' | 'centi' | 'deci' | 'none';

export interface ChipEntry {
    chips_id?: number;
    device_substrates_id: number;
    name?: string;
    center_position_x: number;
    center_position_y: number;
    width: number;
    length: number;
    unit: 'meter';
    prefix: MetricPrefix;
    status?: ChipStatus;
}
export type ChipEntryList = ChipEntry[];

export interface ChipStatusAssignment {
    chips_id: number;
    status: ChipStatus;
}
export type ChipStatusAssignmentList = ChipStatusAssignment[];

// Internal, render-ready die: coordinates already converted to a common space.
interface Die {
    id: number | null;
    x: number;   // center, wafer-centric (mm for real data; arbitrary for demo)
    y: number;
    w: number;
    h: number;
    status: ChipStatus | null;
}

export interface MapConfig {
    center: Point;
    width: number;
    height: number;
    margin: number;
}

export interface WaferColors {
    bg: string;        // '' = leave transparent
    wafer: string;
    edge: string;
    selection: string;
    status: Record<ChipStatus | 'UNKNOWN', string>;
}

// ---------------------------------------------------------------------------
//  SEMI standard specifications
//  primary/secondary: flat length in mm; secAngle: angle secondary->primary (deg)
//  notchDepth: midpoint of 1.00-1.25 mm
// ---------------------------------------------------------------------------
export const WAFER_SPECS: WaferSpec[] = [
    { type: 'P-111', inch: 2,  dia: 50.8,  shape: '1flat',  secAngle: null, primary: 15.88, secondary: null },
    { type: 'N-111', inch: 2,  dia: 50.8,  shape: '2flats', secAngle: 45,   primary: 15.88, secondary: 8.00 },
    { type: 'P-100', inch: 2,  dia: 50.8,  shape: '2flats', secAngle: 90,   primary: 15.88, secondary: 8.00 },
    { type: 'N-100', inch: 2,  dia: 50.8,  shape: '2flats', secAngle: 180,  primary: 15.88, secondary: 8.00 },
    { type: 'P-111', inch: 3,  dia: 76.2,  shape: '1flat',  secAngle: null, primary: 22.22, secondary: null },
    { type: 'N-111', inch: 3,  dia: 76.2,  shape: '2flats', secAngle: 45,   primary: 22.22, secondary: 11.18 },
    { type: 'P-100', inch: 3,  dia: 76.2,  shape: '2flats', secAngle: 90,   primary: 22.22, secondary: 11.18 },
    { type: 'N-100', inch: 3,  dia: 76.2,  shape: '2flats', secAngle: 180,  primary: 22.22, secondary: 11.18 },
    { type: 'P-111', inch: 4,  dia: 100.0, shape: '1flat',  secAngle: null, primary: 32.50, secondary: null },
    { type: 'N-111', inch: 4,  dia: 100.0, shape: '2flats', secAngle: 45,   primary: 32.50, secondary: 18.00 },
    { type: 'P-100', inch: 4,  dia: 100.0, shape: '2flats', secAngle: 90,   primary: 32.50, secondary: 18.00 },
    { type: 'N-100', inch: 4,  dia: 100.0, shape: '2flats', secAngle: 180,  primary: 32.50, secondary: 18.00 },
    { type: 'P-111', inch: 5,  dia: 125.0, shape: '1flat',  secAngle: null, primary: 42.50, secondary: null },
    { type: 'N-111', inch: 5,  dia: 125.0, shape: '2flats', secAngle: 45,   primary: 42.50, secondary: 27.50 },
    { type: 'P-100', inch: 5,  dia: 125.0, shape: '2flats', secAngle: 90,   primary: 42.50, secondary: 27.50 },
    { type: 'N-100', inch: 5,  dia: 125.0, shape: '2flats', secAngle: 180,  primary: 42.50, secondary: 27.50 },
    { type: 'P-111', inch: 6,  dia: 150.0, shape: '1flat',  secAngle: null, primary: 57.50, secondary: null },
    { type: 'N-111', inch: 6,  dia: 150.0, shape: '2flats', secAngle: 45,   primary: 57.50, secondary: 37.50 },
    { type: 'P-100', inch: 6,  dia: 150.0, shape: '2flats', secAngle: 90,   primary: 57.50, secondary: 37.50 },
    { type: 'N-100', inch: 6,  dia: 150.0, shape: '2flats', secAngle: 180,  primary: 57.50, secondary: 37.50 },
    { type: 'All types', inch: 8,  dia: 200.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 12, dia: 300.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 18, dia: 450.0, shape: 'notch', notchDepth: 1.125 },
];

export const FLAT_TYPES: string[] = ['P-111', 'N-111', 'P-100', 'N-100'];
export const SIZES: number[] = [...new Set(WAFER_SPECS.map(s => s.inch))];
const STATUSES: ChipStatus[] = ['READY', 'PROCESSING', 'COMPLETED', 'FAILED'];

// Decimal exponent of each metric prefix.
const PREFIX_EXP: Record<MetricPrefix, number> = {
    yocto: -24, zepto: -21, atto: -18, femto: -15, pico: -12, nano: -9,
    micro: -6, milli: -3, centi: -2, deci: -1, none: 0,
};

const DEFAULTS = {
    waferType: 'N-100',
    sizeInch: 4,
    secDir: 'cw' as SecDir,
    notchScale: 12,
    showDemoChips: true,
};

// ---------------------------------------------------------------------------
//  Geometry (pure functions)
// ---------------------------------------------------------------------------
function waferMapRadius(cfg: MapConfig): number {
    return Math.min(cfg.width, cfg.height) / 2 - cfg.margin;
}
function norm(a: number): number { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }

function getSpec(inch: number, type: string): WaferSpec {
    // For notch sizes (>=8") the type is irrelevant to the geometry.
    const spec = WAFER_SPECS.find(s => s.inch === inch && s.type === type)
              ?? WAFER_SPECS.find(s => s.inch === inch);
    if (!spec) {
        throw new Error('No wafer spec for ' + inch + '" ' + type);
    }
    return spec;
}

function nearestSize(inch: number): number {
    let best = SIZES[0];
    let bestDelta = Math.abs(inch - best);
    for (const s of SIZES) {
        const d = Math.abs(inch - s);
        if (d < bestDelta) { best = s; bestDelta = d; }
    }
    return best;
}

// Flats as {center, half} in canvas radians (y points down => CW positive).
function computeFlats(spec: WaferSpec, secDir: SecDir): Flat[] {
    if (spec.shape === 'notch') {
        return [];
    }
    const aP = Math.asin(Math.min(1, spec.primary / spec.dia)); // half-angle of the chord
    const flats: Flat[] = [{ center: Math.PI / 2, half: aP }];
    if (spec.shape === '2flats' && spec.secondary != null && spec.secAngle != null) {
        const aS = Math.asin(Math.min(1, spec.secondary / spec.dia));
        const theta = spec.secAngle * Math.PI / 180;
        const center = secDir === 'cw' ? (Math.PI / 2 + theta) : (Math.PI / 2 - theta);
        flats.push({ center, half: aS });
    }
    return flats;
}

function pathDiscWithFlats(c: CanvasRenderingContext2D, cx: number, cy: number, R: number, flats: Flat[]): void {
    c.beginPath();
    if (flats.length === 0) {
        c.arc(cx, cy, R, 0, 2 * Math.PI);
        c.closePath();
        return;
    }
    const sorted = flats.map(f => ({ center: norm(f.center), half: f.half }))
                        .sort((a, b) => a.center - b.center);
    const pt = (a: number): Point => ({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    const p0 = pt(sorted[0].center + sorted[0].half);
    c.moveTo(p0.x, p0.y);
    for (let k = 1; k <= sorted.length; k++) {
        const prev = sorted[k - 1];
        const cur = sorted[k % sorted.length];
        const arcStart = prev.center + prev.half;
        let arcEnd = cur.center - cur.half;
        while (arcEnd < arcStart) { arcEnd += 2 * Math.PI; }
        c.arc(cx, cy, R, arcStart, arcEnd, false);
        const trailing = pt(cur.center + cur.half);
        c.lineTo(trailing.x, trailing.y);
    }
    c.closePath();
}

function pathDiscWithNotch(c: CanvasRenderingContext2D, cx: number, cy: number, R: number, depth: number, halfWidth: number): void {
    const a0 = Math.PI / 2 - halfWidth;
    const a1 = Math.PI / 2 + halfWidth;
    c.beginPath();
    c.arc(cx, cy, R, a1, a0 + 2 * Math.PI, false);
    c.lineTo(cx, cy + (R - depth));
    c.lineTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
    c.closePath();
}

function buildWaferPath(c: CanvasRenderingContext2D, cx: number, cy: number, R: number, spec: WaferSpec, secDir: SecDir, notchScale: number): void {
    if (spec.shape === 'notch') {
        const trueDepth = (spec.notchDepth / (spec.dia / 2)) * R;
        const depth = trueDepth * notchScale;
        pathDiscWithNotch(c, cx, cy, R, depth, depth / R);
    } else {
        pathDiscWithFlats(c, cx, cy, R, computeFlats(spec, secDir));
    }
}

// coordinate space (wafer-centric, y up) <-> canvas/map space (y down)
function coordToMap(pos: Point, coordRadius: number, cfg: MapConfig): Point {
    const s = waferMapRadius(cfg) / coordRadius;
    return { x: cfg.center.x + pos.x * s, y: cfg.center.y - pos.y * s };
}
function mapToCoord(pos: Point, coordRadius: number, cfg: MapConfig): Point {
    const s = coordRadius / waferMapRadius(cfg);
    return { x: (pos.x - cfg.center.x) * s, y: (cfg.center.y - pos.y) * s };
}

// ---------------------------------------------------------------------------
//  Data transforms (pure)
// ---------------------------------------------------------------------------
function normStatus(s: unknown): ChipStatus | null {
    return (typeof s === 'string' && (STATUSES as string[]).indexOf(s) !== -1) ? s as ChipStatus : null;
}

// value [unit=meter, prefix] -> millimeters (to match WaferSpec.dia which is in mm)
function toMillimeters(value: number, prefix: MetricPrefix): number {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, (exp === undefined ? 0 : exp) + 3);
}

function chipsToDies(chips: ChipEntryList): Die[] {
    const dies: Die[] = [];
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

function buildStatusMap(list: ChipStatusAssignmentList | null): Map<number, ChipStatus> {
    const m = new Map<number, ChipStatus>();
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
function buildDemo(): { radius: number; dies: Die[] } {
    const cell = 30 + 10 * Math.floor(Math.random() * 7);
    const size = cell * 0.9;
    const radius = cell * (3 + Math.floor(Math.random() * 4));
    const numRows = (radius * 2) / cell;
    const step = (radius * 2) / numRows;
    const inR = (x: number, y: number): boolean => (x * x + y * y) <= radius * radius;
    const dies: Die[] = [];
    for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numRows; j++) {
            if (Math.random() < 0.4) { continue; }
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

function getDieAtPos(p: Point, dies: Die[], coordRadius: number, cfg: MapConfig): Die | null {
    const w = mapToCoord(p, coordRadius, cfg);
    for (const d of dies) {
        if (w.x >= d.x - d.w / 2 && w.x <= d.x + d.w / 2 && w.y >= d.y - d.h / 2 && w.y <= d.y + d.h / 2) {
            return d;
        }
    }
    return null;
}

function drawWaferMap(
    c: CanvasRenderingContext2D, cfg: MapConfig,
    dies: Die[] | null, coordRadius: number,
    spec: WaferSpec, secDir: SecDir, notchScale: number,
    colors: WaferColors, resolve: (d: Die) => ChipStatus | null, selected: Die | null,
): void {
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
export class WaferMap extends TcHmi.Controls.System.TcHmiControl {

    protected __elementTemplateRoot!: JQuery;

    // ---- runtime ----
    protected __canvas: HTMLCanvasElement | null = null;
    protected __ctx: CanvasRenderingContext2D | null = null;
    protected __resizeObserver: ResizeObserver | null = null;
    protected __onPointerUp: ((ev: PointerEvent) => void) | null = null;

    // ---- derived render state ----
    protected __realDies: Die[] | null = null;          // from Chips
    protected __statusMap: Map<number, ChipStatus> = new Map();  // from StatusAssignments
    protected __demo: { radius: number; dies: Die[] } | null = null;
    protected __selected: Die | null = null;

    // ---- attribute backing fields (defaults mirror Description.json) ----
    protected __waferType: string = DEFAULTS.waferType;
    protected __sizeInch: number = DEFAULTS.sizeInch;
    protected __secDir: SecDir = DEFAULTS.secDir;
    protected __notchScale: number = DEFAULTS.notchScale;
    protected __showDemoChips: boolean = DEFAULTS.showDemoChips;
    protected __chips: ChipEntryList | null = null;
    protected __statusAssignments: ChipStatusAssignmentList | null = null;

    constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
        super(element, pcElement, attrs);
    }

    public __previnit(): void {
        this.__elementTemplateRoot = this.__element.find('.TcHmi_Controls_WaferMap_WaferMap-Template');
        if (this.__elementTemplateRoot.length === 0) {
            throw new Error('Invalid Template.html');
        }
        super.__previnit();
    }

    public __init(): void {
        super.__init();
    }

    public __attach(): void {
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

        this.__onPointerUp = (ev: PointerEvent) => this.__handlePointerUp(ev);
        canvas.addEventListener('pointerup', this.__onPointerUp);

        this.__render();
    }

    public __detach(): void {
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

    public destroy(): void {
        if (this.__keepAlive) {
            return;
        }
        super.destroy();
    }

    // -----------------------------------------------------------------------
    //  Attributes  (convert -> default fallback -> change-detect -> notify -> process)
    // -----------------------------------------------------------------------
    public setWaferType(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || FLAT_TYPES.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('WaferType') as string;
        }
        if (tchmi_equal(v, this.__waferType)) { return; }
        this.__waferType = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferType' });
        this.__render();
    }
    public getWaferType(): string { return this.__waferType; }

    public setWaferSizeInch(valueNew: number | null): void {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('WaferSizeInch') as number;
        }
        n = nearestSize(n);
        if (tchmi_equal(n, this.__sizeInch)) { return; }
        this.__sizeInch = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferSizeInch' });
        this.__render();
    }
    public getWaferSizeInch(): number { return this.__sizeInch; }

    public setSecondaryFlatDirection(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v !== 'cw' && v !== 'ccw') {
            v = this.getAttributeDefaultValueInternal('SecondaryFlatDirection') as string;
        }
        if (tchmi_equal(v, this.__secDir)) { return; }
        this.__secDir = v as SecDir;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SecondaryFlatDirection' });
        this.__render();
    }
    public getSecondaryFlatDirection(): SecDir { return this.__secDir; }

    public setNotchExaggeration(valueNew: number | null): void {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('NotchExaggeration') as number;
        }
        if (n < 1) { n = 1; }
        if (tchmi_equal(n, this.__notchScale)) { return; }
        this.__notchScale = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NotchExaggeration' });
        this.__render();
    }
    public getNotchExaggeration(): number { return this.__notchScale; }

    public setShowDemoChips(valueNew: boolean | null): void {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowDemoChips') as boolean;
        }
        if (tchmi_equal(b, this.__showDemoChips)) { return; }
        this.__showDemoChips = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowDemoChips' });
        this.__rebuildDemo();
        this.__render();
    }
    public getShowDemoChips(): boolean { return this.__showDemoChips; }

    // Full die layout (ChipEntryList). Replaces the demo grid when non-empty.
    public setChips(valueNew: ChipEntryList | null): void {
        let v = TcHmi.ValueConverter.toObject<ChipEntryList>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Chips') as ChipEntryList | null;
        }
        if (tchmi_equal(v, this.__chips)) { return; }
        this.__chips = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Chips' });
        this.__rebuildDies();
        this.__render();
    }
    public getChips(): ChipEntryList | null { return this.__chips; }

    // Status-only updates (ChipStatusAssignmentList), keyed by chips_id.
    public setStatusAssignments(valueNew: ChipStatusAssignmentList | null): void {
        let v = TcHmi.ValueConverter.toObject<ChipStatusAssignmentList>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('StatusAssignments') as ChipStatusAssignmentList | null;
        }
        if (tchmi_equal(v, this.__statusAssignments)) { return; }
        this.__statusAssignments = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'StatusAssignments' });
        this.__rebuildStatusMap();
        this.__render();
    }
    public getStatusAssignments(): ChipStatusAssignmentList | null { return this.__statusAssignments; }

    // -----------------------------------------------------------------------
    //  Rendering
    // -----------------------------------------------------------------------
    protected __rebuildDies(): void {
        this.__realDies = this.__chips ? chipsToDies(this.__chips) : null;
        this.__selected = null; // a new layout invalidates the previous selection
    }

    protected __rebuildStatusMap(): void {
        this.__statusMap = buildStatusMap(this.__statusAssignments);
    }

    protected __rebuildDemo(): void {
        this.__demo = this.__showDemoChips ? buildDemo() : null;
    }

    protected __effectiveStatus(d: Die): ChipStatus | null {
        if (d.id !== null) {
            const s = this.__statusMap.get(d.id);
            if (s !== undefined) {
                return s;
            }
        }
        return d.status;
    }

    // Which dies to draw + the coordinate-space radius + a status resolver.
    protected __activeModel(): { dies: Die[]; coordRadius: number; resolve: (d: Die) => ChipStatus | null } | null {
        if (this.__realDies && this.__realDies.length > 0) {
            const spec = getSpec(this.__sizeInch, this.__waferType);
            return { dies: this.__realDies, coordRadius: spec.dia / 2, resolve: (d) => this.__effectiveStatus(d) };
        }
        if (this.__showDemoChips && this.__demo) {
            return { dies: this.__demo.dies, coordRadius: this.__demo.radius, resolve: (d) => d.status };
        }
        return null;
    }

    protected __readColors(): WaferColors {
        const cs = window.getComputedStyle(this.__element[0]);
        const read = (name: string, fallback: string): string => {
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

    protected __makeConfig(): MapConfig | null {
        const root = this.__elementTemplateRoot[0];
        const w = root.clientWidth;
        const h = root.clientHeight;
        if (w <= 0 || h <= 0) {
            return null;
        }
        return { center: { x: w / 2, y: h / 2 }, width: w, height: h, margin: 8 };
    }

    protected __render(): void {
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
        drawWaferMap(
            this.__ctx, cfg,
            model ? model.dies : null,
            model ? model.coordRadius : 1,
            spec, this.__secDir, this.__notchScale,
            colors,
            model ? model.resolve : () => null,
            this.__selected,
        );
    }

    protected __handlePointerUp(ev: PointerEvent): void {
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
        const p: Point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const die = getDieAtPos(p, model.dies, model.coordRadius, cfg);
        if (die) {
            this.__selected = die;
            this.__render();
        }
    }
}

/*
 * Register Control class object for control
 */
TcHmi.Controls.registerEx('WaferMap', 'TcHmi.Controls.WaferMap', WaferMap);
