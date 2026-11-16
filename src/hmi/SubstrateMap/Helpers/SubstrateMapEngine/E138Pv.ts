/**
 * E138 `PVSet` value model - the payload a `DeviceDataMap` carries.
 *
 * SEMI E138 defines a small, self-describing value grammar that E142 embeds by
 * reference: `DeviceDataType` declares `<xs:element ref="ccs:PVSet" minOccurs="1"/>`,
 * which is why `DeviceDataMap` has been skipped until now - the map is trivial,
 * the payload is the work.
 *
 * The grammar is one `xsd:choice` of SIXTEEN alternatives, declared by group
 * `PVType` in `E138-1-V0709-Schema.xsd`, two of them recursive:
 *
 * ```
 *   F8  xsd:double        S    xsd:string          Su   StructureValueType
 *   F4  xsd:float         D    xsd:dateTime        Arr  ArrayValueType
 *   I8  xsd:long          B    xsd:boolean
 *   I4  xsd:int           URI  xsd:anyURI          NoValue  NoValueType
 *   I2  xsd:short         B64  xsd:base64Binary
 *   I1  xsd:byte          EI   xsd:int
 *                         ES   xsd:string
 * ```
 *
 * The element NAME is the type - there is no `type=` attribute to read - so the
 * discriminant of the union below is exactly the element name, and a parser can
 * switch on `localName` directly.
 *
 * NILLABLE. Every scalar alternative is `nillable="true"`, so `<F8 xsi:nil="true"/>`
 * is legal and means "this value is absent" - distinct from `NoValue`, which
 * says WHY it is absent. That is the `| null` on each scalar `value` below, and
 * the two must not be collapsed: `null` is "the document declined to give one",
 * `NoValue` is "the document explains that it cannot".
 *
 * The types come first; the parser that produces them is {@link parsePvSet}.
 */

/**
 * Why a `NoValue` element carries no value.
 *
 * `NoValueReasonEnumType` restricts `@reasonCode` to exactly these three, and
 * the attribute is `use="required"`.
 */
export const PV_NO_VALUE_REASONS = ['ValueNotAvailable', 'NoSuchSource', 'NoSuchParameter'] as const;

/** One of {@link PV_NO_VALUE_REASONS}. */
export type PvNoValueReason = (typeof PV_NO_VALUE_REASONS)[number];

/**
 * A numeric alternative. All seven are `nillable`, hence `number | null`.
 *
 * `I8` IS LOSSY AT THE EXTREMES and the model cannot hide it. `xsd:long` is a
 * signed 64-bit integer, ±9.22e18; `Number.MAX_SAFE_INTEGER` is 9.01e15, some
 * three orders of magnitude smaller. A device id or a cumulative counter can
 * reach that range, and JavaScript would silently round it. Typing it
 * `number | string` would push the problem onto every consumer of every numeric
 * value for the sake of one alternative, so it stays `number` - and the PARSER
 * owes a warning when an `I8` falls outside the safe range, exactly as
 * `intAttr()` already does for `xs:integer` ("xs:integer is unbounded, this
 * engine's grids are not"). Recorded here so that obligation is not lost.
 *
 * `F4` is `xsd:float`, a 32-bit binary float: a JavaScript number holds every
 * one of them exactly, so nothing is lost there. `F8` is `xsd:double`, which IS
 * a JavaScript number. `I4`, `I2`, `I1` and `EI` are all within the safe range
 * by construction.
 */
export interface PvNumber {
    kind: 'F8' | 'F4' | 'I8' | 'I4' | 'I2' | 'I1' | 'EI';
    /** The value, or `null` for `xsi:nil="true"`. */
    value: number | null;
}

/**
 * A textual alternative.
 *
 * `URI` is `xsd:anyURI` and `B64` is `xsd:base64Binary`, but both are carried as
 * the lexical string the document wrote. Neither is resolved, fetched or decoded
 * here: `anyURI` places almost no constraint on its content, and decoding base64
 * eagerly would turn a diagnostic model into a binary buffer nobody asked for.
 * A consumer that wants the bytes can decode the string it is given.
 *
 * `ES` is the enumerated-string alternative. Its permitted values live in a
 * `TypeDefinition`, not in the value itself, so nothing can be validated from
 * the value alone - it is a plain string here.
 */
export interface PvString {
    kind: 'S' | 'ES' | 'URI' | 'B64';
    /** The value, or `null` for `xsi:nil="true"`. */
    value: string | null;
}

/**
 * `xsd:dateTime`, KEPT LEXICAL.
 *
 * Deliberately NOT parsed to a `Date`. Three reasons, in order of how much they
 * would cost:
 *
 * 1. **A round trip must be byte-faithful.** `xsd:dateTime` admits forms a
 *    `Date` cannot round-trip: an explicit `+02:00` offset (which `Date`
 *    normalizes to UTC), arbitrary fractional-second precision (which `Date`
 *    truncates to milliseconds), a leap second `:60`, and year `0000` or
 *    negative years. Re-emitting a parsed `Date` would rewrite the document.
 * 2. **`Date` cannot represent "no timezone".** `xsd:dateTime` makes the offset
 *    optional, and an unqualified local time is a different assertion from a
 *    zoned one. `new Date('2026-07-29T12:00:00')` invents the host's zone.
 * 3. Nothing in this engine does arithmetic on it.
 *
 * A consumer that needs a `Date` can construct one, having seen the string it
 * came from; a consumer that needs the original cannot recover it from a `Date`.
 */
export interface PvDateTime {
    kind: 'D';
    /** The lexical `xsd:dateTime`, or `null` for `xsi:nil="true"`. */
    value: string | null;
}

/** `xsd:boolean`. `nillable`, hence `boolean | null`. */
export interface PvBoolean {
    kind: 'B';
    /**
     * The value, or `null` for `xsi:nil="true"`.
     *
     * `xsd:boolean` has FOUR lexical forms - `true`, `false`, `1`, `0` - and this
     * field keeps only the meaning. That is a deliberate exception to the
     * byte-faithful rule that governs {@link PvDateTime}: a boolean has exactly
     * two values however it is spelled, so nothing is lost that a reader could
     * act on, whereas a timestamp's offset and precision are information.
     */
    value: boolean | null;
}

/**
 * `Su` - a structure. Its children are the ordered field values.
 *
 * POSITIONAL, NOT NAMED, because the schema is: `StructureValueType` restricts
 * `PVSetType` to `<xsd:group ref="PVType" minOccurs="1" maxOccurs="unbounded"/>`.
 * The children are bare value elements with no name attribute of
 * their own - the field NAMES live in a separate `TypeDefinition`/`Structure`
 * declaration, reachable only through a `TypeDefinitionRef` this payload does
 * not carry. So a value document is positional by construction, and inventing
 * names here would be inventing the type definition too.
 *
 * `minOccurs="1"`: a structure has at least one field.
 */
export interface PvStructure {
    kind: 'Su';
    /** The field values, in document order. At least one. */
    fields: PvValue[];
}

/**
 * `Arr` - an array. Its children are the ordered elements.
 *
 * `ArrayValueType` restricts `PVSetType` to `minOccurs="0"`, so unlike `Su` an
 * array may legitimately be EMPTY - `<Arr/>` is a valid, meaningful value.
 *
 * The schema does not require the items to share a kind, and this model does not
 * either. A heterogeneous array is unusual but not malformed, and rejecting one
 * would be stricter than the schema.
 */
export interface PvArray {
    kind: 'Arr';
    /** The element values, in document order. May be empty. */
    items: PvValue[];
}

/**
 * `NoValue` - the document says explicitly that there is no value, and why.
 *
 * NOT THE SAME AS `xsi:nil`. A nil scalar declines to give a value; `NoValue`
 * states a reason. A consumer showing "-" for both would lose the difference
 * between "the equipment did not report this" and "no such parameter exists".
 */
export interface PvNoValue {
    kind: 'NoValue';
    /**
     * `@reasonCode` - `use="required"` in the XSD, restricted to
     * {@link PV_NO_VALUE_REASONS}.
     *
     * Typed `string`, not the narrow union, for the same reason
     * `E142TransferMap.fromSubstrateType` is: this package tolerates an
     * unrecognized enum token with a warning rather than rejecting the document,
     * and the model has to be able to hold what the parser accepts. Compare
     * against {@link PV_NO_VALUE_REASONS} to test for a known one.
     */
    reasonCode: string;
    /**
     * `Description` - a required child element in the XSD (`nillable="false"`,
     * and `minOccurs` defaults to 1), so a conforming document always
     * carries one.
     *
     * OPTIONAL HERE ANYWAY. The parser is deliberately looser than the schema on
     * required leaf content elsewhere (see `parseTransferMap` on the `From*`
     * attributes): a `NoValue` missing its description still tells a reader the
     * reason code, which is the part that carries meaning, and refusing the whole
     * document would deny them that. `undefined` means the document omitted it.
     */
    description?: string;
}

/**
 * Any E138 parameter value: the sixteen alternatives of the `PVType` choice.
 *
 * A discriminated union on `kind`, which is the ELEMENT NAME - so a parser
 * switches on `localName` with no lookup table, and an exhaustive `switch` in a
 * consumer is checked by the compiler.
 */
export type PvValue =
    | PvNumber
    | PvString
    | PvDateTime
    | PvBoolean
    | PvStructure
    | PvArray
    | PvNoValue;

/**
 * Every `kind` a {@link PvValue} may carry - the sixteen element names of the
 * `PVType` choice, in the schema's own declaration order.
 *
 * Exported so a parser can recognize a value element without hard-coding the
 * list a second time, and so a test can assert the model covers the grammar.
 */
export const PV_KINDS = [
    'F8', 'F4', 'I8', 'I4', 'I2', 'I1',
    'S', 'D', 'B', 'URI', 'B64', 'EI', 'ES',
    'Su', 'Arr', 'NoValue',
] as const;

/** One of {@link PV_KINDS}. */
export type PvKind = (typeof PV_KINDS)[number];

/* ========================================================================== *
 *  Parsing
 * ========================================================================== */

/** The E138 target namespace, declared by `E138-1-V0709-Schema.xsd`. */
export const E138_NS = 'urn:semi-org:xsd.E138.V0709.ccs';

/**
 * The minimal element shape `parsePvSet` reads.
 *
 * Structurally identical to `E142XmlElement`, and deliberately re-declared here
 * rather than imported: E138 is a SEPARATE STANDARD that E142 embeds by
 * reference, and this module should not depend on the E142 parser to be usable
 * or testable. TypeScript is structural, so an `E142XmlElement` satisfies this
 * without a cast, and the injectable stub parser keeps working unchanged.
 */
export interface PvElement {
    readonly localName: string;
    readonly namespaceUri: string;
    readonly children: readonly PvElement[];
    readonly text: string;
    attribute(localName: string, namespaceUri?: string): string | null;
}

/**
 * How `parsePvSet` reports a non-fatal problem.
 *
 * A callback rather than the E142 `ParseContext`, for the same reason
 * {@link PvElement} is re-declared: E138 does not depend on E142. The E142
 * parser passes `(code, path, message) => warnAt(ctx, code, path, message)`.
 */
export type PvWarn = (code: string, path: string, message: string) => void;

/**
 * How deep `Su` / `Arr` nesting may go before {@link parsePvSet} refuses.
 *
 * E138 places NO limit on the recursion - `StructureValueType` and
 * `ArrayValueType` both restrict `PVSetType`, which contains the `PVType` group,
 * which contains them. A document nested a million deep is therefore VALID, and
 * a naive recursive parser meets it with a `RangeError: Maximum call stack size
 * exceeded` - an untyped host error, thrown from somewhere unrelated, that a
 * caller cannot distinguish from a bug in the engine.
 *
 * So the limit is this engine's, not the standard's, and it is announced as
 * such. 64 is far past anything a real parameter set uses (the standard's own
 * worked example reaches 2) and far short of any stack.
 */
export const PV_MAX_DEPTH = 64;

/**
 * A fatal problem in an E138 `PVSet`.
 *
 * E138 has its own error type for the same reason it has its own module: it does
 * not depend on E142, so it cannot throw `E142ParseError`. A caller that bridges
 * the two translates at the boundary, exactly as `parseBinCodeMap` already
 * translates `E142DecodeError`.
 */
export class E138PvError extends Error {
    /** A stable `E138_PV_*` code. */
    public readonly code: string;

    /** The structural path of the offending element. */
    public readonly path: string;

    /**
     * @param code    A stable `E138_PV_*` code.
     * @param path    The offending element's structural path.
     * @param message What went wrong, and what a producer should do about it.
     */
    public constructor(code: string, path: string, message: string) {
        super(`${message} (at ${path})`);
        this.name = 'E138PvError';
        this.code = code;
        this.path = path;
    }
}

/** `xsi` namespace, for `@xsi:nil`. */
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/**
 * Range of each sized integer alternative, as the XSD declares. `I8` is `xsd:long`,
 * whose bounds JavaScript cannot represent exactly - see {@link PvNumber} - so
 * it is checked against the SAFE range instead and a wider value warns.
 */
const INT_RANGE: Record<string, { min: number; max: number; type: string }> = {
    I1: { min: -128, max: 127, type: 'xsd:byte' },
    I2: { min: -32768, max: 32767, type: 'xsd:short' },
    I4: { min: -2147483648, max: 2147483647, type: 'xsd:int' },
    EI: { min: -2147483648, max: 2147483647, type: 'xsd:int' },
    I8: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, type: 'xsd:long' },
};

/** `true` when the element carries `xsi:nil="true"` (or `"1"`, its other lexical form). */
function isNil(el: PvElement): boolean {
    const raw = el.attribute('nil', XSI_NS);
    if (raw === null) { return false; }
    const t = raw.trim();
    return t === 'true' || t === '1';
}

/**
 * Parses one numeric alternative.
 *
 * LEXICAL VALIDATION MATCHES THE ATTRIBUTE VALIDATORS: an `xs:integer`-family
 * value is `[+-]?\d+` and nothing else, so `1.0`, `true` and `0x10` are type
 * errors rather than values `Number()` would silently coerce.
 *
 * `xsd:double` and `xsd:float` additionally admit `INF`, `-INF` and `NaN` -
 * case-sensitive, and NOT `Infinity`, which is the JavaScript
 * spelling and not a legal lexical form.
 *
 * @returns The value, or `null` when the lexical form is wrong (already warned).
 */
function parseNumeric(kind: string, text: string, path: string, warn: PvWarn): number | null {
    const t = text.trim();
    if (kind === 'F8' || kind === 'F4') {
        if (t === 'INF') { return Infinity; }
        if (t === '-INF') { return -Infinity; }
        if (t === 'NaN') { return NaN; }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
            warn('E138_PV_LEXICAL', path,
                `<${kind}>${JSON.stringify(text)}</${kind}> is not a valid `
                + `${kind === 'F8' ? 'xsd:double' : 'xsd:float'}. Legal forms are a decimal number with an `
                + 'optional exponent, or INF, -INF, NaN (case-sensitive; "Infinity" is the JavaScript '
                + 'spelling, not the XSD one). The value is reported as null.');
            return null;
        }
        return Number(t);
    }
    const range = INT_RANGE[kind];
    if (!/^[+-]?\d+$/.test(t)) {
        warn('E138_PV_LEXICAL', path,
            `<${kind}>${JSON.stringify(text)}</${kind}> is not a valid ${range.type}: the lexical space is `
            + 'an optionally signed run of digits, with no decimal point, exponent or radix prefix. '
            + 'The value is reported as null.');
        return null;
    }
    const value = Number(t);
    if (value < range.min || value > range.max) {
        // I8 is the interesting case: this is not the type's range but the range
        // a JavaScript number can carry exactly. xsd:long reaches +-9.22e18 and
        // Number.MAX_SAFE_INTEGER is 9.01e15, so a legal document can hold a
        // value this engine would round. Reported rather than silently rounded.
        warn('E138_PV_RANGE', path,
            `<${kind}>${t}</${kind}> is outside `
            + (kind === 'I8'
                ? 'the range a JavaScript number represents exactly (+-9007199254740991). xsd:long is a '
                    + '64-bit integer, so this document is valid and this engine cannot hold the value '
                    + 'without rounding it. The rounded value is reported.'
                : `the range of ${range.type} (${range.min}..${range.max}). The value is reported as given.`));
    }
    return value;
}

/**
 * Parses the value children of a `PVSet`-shaped element into {@link PvValue}s.
 *
 * Handles ALL SIXTEEN alternatives of the `PVType` choice.
 *
 * `NoValue` AND `xsi:nil` STAY DISTINCT. A nil scalar keeps its kind and reports
 * `value: null`; a `NoValue` has kind `'NoValue'`, carries a reason, and has no
 * `value` field at all. Collapsing them would lose the difference between "there
 * is no reading" and "there is no such parameter".
 *
 * FOREIGN NAMESPACES WARN, they do not throw. A `PVSet` is an extension point by
 * design and E138 says nothing about what a foreign element means, so refusing
 * the document would make this engine stricter than the standard for content it
 * merely does not understand. The same policy the E142 parser applies to
 * `E142_XML_FOREIGN_NAMESPACE_SKIPPED`.
 *
 * ORDER IS PRESERVED. A `PVSet`'s children are positional - the names of the
 * parameters live in a separate `TypeDefinition` - so the returned array's
 * indices are the only thing tying a value to its meaning.
 *
 * RECURSION IS BOUNDED. `Su` and `Arr` nest without limit in the schema, so the
 * depth is guarded at {@link PV_MAX_DEPTH} and a deeper document raises
 * {@link E138PvError} rather than a `RangeError` from the host - see
 * {@link PV_MAX_DEPTH} on why that distinction matters to a caller.
 *
 * @param el    The element whose children are values (`PVSet`, `Su` or `Arr`).
 * @param path  The element's structural path, for messages.
 * @param warn  Where to report non-fatal problems.
 * @param depth Current nesting depth; callers leave it at 0.
 * @returns The values, in document order.
 * @throws {E138PvError} `E138_PV_DEPTH` beyond {@link PV_MAX_DEPTH}.
 */
export function parsePvSet(el: PvElement, path: string, warn: PvWarn, depth = 0): PvValue[] {
    const out: PvValue[] = [];
    const counts: Record<string, number> = {};
    let foreign = 0;
    for (const child of el.children) {
        if (child.namespaceUri !== E138_NS && child.namespaceUri !== '') { foreign++; continue; }
        const kind = child.localName;
        const n = (counts[kind] = (counts[kind] ?? 0) + 1);
        const p = `${path}/${kind}[${n}]`;
        const nil = isNil(child);
        switch (kind) {
            case 'F8': case 'F4': case 'I8': case 'I4': case 'I2': case 'I1': case 'EI':
                out.push({ kind, value: nil ? null : parseNumeric(kind, child.text, p, warn) });
                break;
            case 'S': case 'ES': case 'URI': case 'B64':
                // Carried lexically. URI is not resolved and B64 is not decoded:
                // xsd:anyURI constrains almost nothing, and decoding eagerly
                // would turn a diagnostic model into a binary buffer.
                out.push({ kind, value: nil ? null : child.text });
                break;
            case 'D':
                // Lexical on purpose - see PvDateTime. Not even trimmed: leading
                // or trailing whitespace is a lexical fact of the document, and
                // xsd:dateTime's own whiteSpace facet is `collapse`, which a
                // conforming producer has already applied.
                out.push({ kind, value: nil ? null : child.text });
                break;
            case 'B': {
                if (nil) { out.push({ kind, value: null }); break; }
                const t = child.text.trim();
                if (t === 'true' || t === '1') { out.push({ kind, value: true }); break; }
                if (t === 'false' || t === '0') { out.push({ kind, value: false }); break; }
                warn('E138_PV_LEXICAL', p,
                    `<B>${JSON.stringify(child.text)}</B> is not an xsd:boolean; the four legal forms are `
                    + 'true, false, 1 and 0. The value is reported as null.');
                out.push({ kind, value: null });
                break;
            }
            case 'Su': case 'Arr': {
                if (depth + 1 > PV_MAX_DEPTH) {
                    throw new E138PvError(
                        'E138_PV_DEPTH', p,
                        `Su / Arr nesting exceeds this engine's limit of ${PV_MAX_DEPTH}. E138 itself `
                        + 'places no limit on the recursion, so the document may well be valid - but a '
                        + 'parser that followed it without a bound would fail with a host stack overflow '
                        + 'instead of a diagnosable error. Flatten the structure, or raise PV_MAX_DEPTH '
                        + 'if a real payload genuinely nests this deep.',
                    );
                }
                const inner = parsePvSet(child, p, warn, depth + 1);
                if (kind === 'Su') {
                    // StructureValueType restricts PVSetType to minOccurs="1",
                    // so an empty Su is schema-INVALID. Warned, not refused: the
                    // surrounding values are still readable, and this parser is
                    // not stricter than the schema - only louder.
                    if (inner.length === 0) {
                        warn('E138_PV_EMPTY_STRUCTURE', p,
                            'this <Su> has no field values. StructureValueType restricts PVSetType to '
                            + 'minOccurs="1", so a structure has at least one field and '
                            + 'this document is invalid. Reported as a structure with no fields; the '
                            + 'values around it are unaffected.');
                    }
                    out.push({ kind: 'Su', fields: inner });
                } else {
                    // ArrayValueType restricts to minOccurs="0": <Arr/> is a
                    // legal, meaningful value and must NOT warn.
                    out.push({ kind: 'Arr', items: inner });
                }
                break;
            }
            case 'NoValue': {
                /*
                 * NoValue and xsi:nil are DIFFERENT CLAIMS and this parser keeps
                 * them apart at every step. A nil scalar keeps its kind and
                 * reports `value: null` - "the type is F8, there is no number".
                 * A NoValue has kind 'NoValue' and NO `value` field at all - "no
                 * number, and here is why". A consumer that renders "-" for both
                 * has thrown away the difference between "the equipment did not
                 * report this" and "no such parameter exists".
                 */
                const raw = child.attribute('reasonCode');
                let reasonCode = '';
                if (raw === null) {
                    warn('E138_PV_NOVALUE_REASON_MISSING', p,
                        '<NoValue> has no @reasonCode. The XSD declares it use="required", '
                        + 'so this document is invalid - but the element still says '
                        + 'that there is no value, which is the part a reader can act on, so it is '
                        + 'reported with an empty reason rather than refused.');
                } else {
                    reasonCode = raw.trim();
                    if (!(PV_NO_VALUE_REASONS as readonly string[]).includes(reasonCode)) {
                        // Carried verbatim: the field is `string`, not the narrow
                        // union, precisely so an unrecognized token survives to a
                        // reader instead of being erased by the parser.
                        warn('E138_PV_NOVALUE_REASON_UNKNOWN', p,
                            `<NoValue reasonCode=${JSON.stringify(raw)}> is not one of the three values `
                            + `NoValueReasonEnumType permits (${PV_NO_VALUE_REASONS.join(', ')}). `
                            + 'It is carried through unchanged so a reader can see what '
                            + 'the producer wrote.');
                    }
                }
                const entry: PvNoValue = { kind: 'NoValue', reasonCode };
                // <Description> is a required child (nillable="false", minOccurs
                // defaults to 1). Looked up by name, not by position: nothing in
                // the schema forbids a foreign-namespace sibling, and taking
                // children[0] blindly would read one of those as the description.
                const desc = child.children.find(
                    (k) => k.localName === 'Description' && (k.namespaceUri === E138_NS || k.namespaceUri === ''),
                );
                if (desc === undefined) {
                    warn('E138_PV_NOVALUE_DESCRIPTION_MISSING', p,
                        '<NoValue> has no <Description>. The XSD requires one (minOccurs defaults to 1, '
                        + 'nillable="false"). The reason code is the part that carries '
                        + 'meaning, so the value is reported without a description rather than refused.');
                } else {
                    entry.description = desc.text;
                }
                out.push(entry);
                break;
            }
            default:
                warn('E138_PV_UNKNOWN', p,
                    `<${kind}> is not one of the sixteen E138 PVType alternatives `
                    + `(${PV_KINDS.join(', ')}). It is skipped; the surrounding values are still read.`);
                break;
        }
    }
    if (foreign > 0) {
        warn('E138_PV_FOREIGN_NAMESPACE', path,
            `${foreign} child element${foreign === 1 ? '' : 's'} of this PVSet ${foreign === 1 ? 'is' : 'are'} `
            + 'in a foreign namespace and were skipped. A PVSet is an extension point and E138 does not '
            + 'define what foreign content means, so this is not an error - but the skipped elements are '
            + 'NOT in the returned values, and the positions of the values that follow them are unaffected.');
    }
    return out;
}

/* ========================================================================== *
 *  Serializing
 * ========================================================================== */

/** XML text-node escaping. `>` is escaped too: `]]>` is illegal in character data. */
function esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** XML attribute-value escaping, for a double-quoted value. */
function escAttr(text: string): string {
    return esc(text).replace(/"/g, '&quot;');
}

/**
 * Formats a number for one of the seven numeric alternatives.
 *
 * THE XSD SPELLINGS ARE NOT THE JAVASCRIPT ONES, and this is the whole reason
 * the function exists. `(Infinity).toString()` is `"Infinity"`; `xsd:double`
 * wants `INF`. Emitting the JavaScript spelling produces a document that fails
 * validation and that this package's own parser rejects - a round trip that
 * loses its payload at the last step.
 *
 * The integer alternatives have no exponent in their lexical space, so a value
 * big enough for `String()` to switch to exponent notation would be emitted
 * invalid - and `toFixed(0)` does NOT save you, because it switches at exactly
 * the same 1e21 threshold. `BigInt(...).toString()` is used above it, which
 * expands in full. A non-integral or unsafe value is reported rather than
 * quietly corrected, because a caller that built one by hand has a bug this
 * serializer should not paper over.
 */
function formatNumber(kind: string, value: number, path: string, warn: PvWarn | undefined): string {
    if (kind === 'F8' || kind === 'F4') {
        if (Number.isNaN(value)) { return 'NaN'; }
        if (value === Infinity) { return 'INF'; }
        if (value === -Infinity) { return '-INF'; }
        // Object.is distinguishes -0 from 0; String(-0) is "0", which would
        // silently change the value. xsd:double's value space has both.
        if (Object.is(value, -0)) { return '-0'; }
        return String(value);
    }
    if (!Number.isInteger(value)) {
        warn?.('E138_PV_EMIT_LEXICAL', path,
            `<${kind}> was given ${value}, which is not an integer. The xs:integer-derived types have no `
            + 'fractional lexical form, so the value is truncated toward zero to keep the document valid. '
            + 'This is a caller bug: the model should not have held it.');
        value = Math.trunc(value);
    }
    if (!Number.isSafeInteger(value)) {
        warn?.('E138_PV_EMIT_RANGE', path,
            `<${kind}> was given ${value}, outside the range a JavaScript number represents exactly. `
            + 'The emitted digits are the closest double, not necessarily the value intended.');
    }
    // Neither String() nor toFixed(0) is exponent-free: BOTH switch to `1e+21`
    // at 1e21, and the xs:integer lexical space has no exponent. BigInt does the
    // expansion exactly, and the value is known to be integral by here.
    return Math.abs(value) >= 1e21 ? BigInt(value).toString() : value.toFixed(0);
}

/**
 * Options for {@link pvSetToXml}.
 */
export interface PvSetToXmlOptions {
    /**
     * Name of the wrapper element. Defaults to `'PVSet'`.
     *
     * E142 embeds the set as `<ccs:PVSet>`; a caller emitting a fragment for some
     * other context can rename it.
     */
    rootName?: string;
    /**
     * Emit `xmlns` on the wrapper. Default `true`.
     *
     * Set `false` when the element is being placed inside a document that already
     * declares the E138 namespace on an ancestor - repeating it is legal but
     * noisy.
     */
    declareNamespace?: boolean;
    /** Indent unit. Default two spaces. Set `''` for a single line. */
    indent?: string;
    /** Where to report a non-fatal problem. See {@link PvWarn}. */
    warn?: PvWarn;
}

/** Emits one value element, recursively. */
function emitValue(v: PvValue, path: string, pad: string, unit: string, warn: PvWarn | undefined, depth: number, out: string[]): void {
    if (depth > PV_MAX_DEPTH) {
        throw new E138PvError(
            'E138_PV_DEPTH', path,
            `Su / Arr nesting exceeds this engine's limit of ${PV_MAX_DEPTH} on emit, the same bound `
            + `${'`parsePvSet`'} applies on read. A value tree this deep cannot have come from this `
            + 'parser, so it was built in memory; flatten it, or raise PV_MAX_DEPTH.',
        );
    }
    const nl = unit === '' ? '' : '\n';
    switch (v.kind) {
        case 'Su': case 'Arr': {
            const kids = v.kind === 'Su' ? v.fields : v.items;
            if (kids.length === 0) {
                // <Arr/> is legal and meaningful; <Su/> is not, but the caller was
                // already told so on parse and re-emitting it faithfully is the
                // serializer's job, not a second place to editorialize.
                out.push(`${pad}<${v.kind}/>`);
                return;
            }
            out.push(`${pad}<${v.kind}>`);
            const counts: Record<string, number> = {};
            for (const k of kids) {
                const n = (counts[k.kind] = (counts[k.kind] ?? 0) + 1);
                emitValue(k, `${path}/${k.kind}[${n}]`, pad + unit, unit, warn, depth + 1, out);
            }
            out.push(`${pad}</${v.kind}>`);
            return;
        }
        case 'NoValue': {
            const attr = ` reasonCode="${escAttr(v.reasonCode)}"`;
            if (v.description === undefined) {
                // Description is required by the XSD. Emitting <NoValue/> would
                // produce an invalid document, so an empty one is written and the
                // substitution is reported - silence would make the serializer
                // the source of a validation failure a reader cannot trace.
                warn?.('E138_PV_EMIT_DESCRIPTION_SYNTHESISED', path,
                    'this NoValue carries no description, but NoValueType requires the <Description> '
                    + 'child (minOccurs defaults to 1). An EMPTY <Description/> was '
                    + 'emitted so the document validates; the original said nothing, and neither does this.');
                out.push(`${pad}<NoValue${attr}>${nl}${pad}${unit}<Description/>${nl}${pad}</NoValue>`);
                return;
            }
            out.push(`${pad}<NoValue${attr}>${nl}${pad}${unit}<Description>${esc(v.description)}</Description>${nl}${pad}</NoValue>`);
            return;
        }
        default: {
            // Every scalar alternative. `null` is xsi:nil - NOT an empty element,
            // which would mean "the empty string" for S and a lexical error for
            // the rest. This is where the parse-time distinction is paid back.
            if (v.value === null) {
                out.push(`${pad}<${v.kind} xsi:nil="true"/>`);
                return;
            }
            let text: string;
            if (typeof v.value === 'number') { text = formatNumber(v.kind, v.value, path, warn); }
            else if (typeof v.value === 'boolean') { text = v.value ? 'true' : 'false'; }
            else { text = esc(v.value); }   // S / ES / URI / B64 / D - all lexical
            out.push(`${pad}<${v.kind}>${text}</${v.kind}>`);
        }
    }
}

/**
 * Serializes {@link PvValue}s back to an E138 `PVSet` element.
 *
 * The inverse of {@link parsePvSet}, and BYTE-FAITHFUL for everything the model
 * keeps lexically: `D` is written exactly as it was read, so an explicit UTC
 * offset, six-digit fractional seconds and a leap second all survive - which is
 * the reason {@link PvDateTime} refuses to become a `Date`. `S`, `ES`, `URI` and
 * `B64` are likewise the strings the document carried, escaped and no more.
 *
 * WHAT IS NOT BYTE-FAITHFUL, and why:
 * - **Numbers are re-formatted.** `<F8>42.90</F8>` reads as `42.9` and writes as
 *   `42.9`; the trailing zero is not in the model because it is not in the value.
 *   Canonicalizing is the only option once the lexical form is gone, and the
 *   parser deliberately converts numbers rather than keeping their text.
 * - **`B` is canonicalized** to `true` / `false`. `xsd:boolean` has four lexical
 *   forms and two values, and the model keeps the value (see {@link PvBoolean}).
 * - **`xsi:nil` is written in the canonical `"true"` spelling**, never `"1"`.
 *
 * The `xsi` prefix is declared on the wrapper whenever any value is nil, and
 * omitted otherwise - so a set with no nils carries no unused declaration.
 *
 * @param values The values, in the order they should appear.
 * @param opts   See {@link PvSetToXmlOptions}.
 * @returns The `PVSet` element as XML text, with no trailing newline.
 * @throws {E138PvError} `E138_PV_DEPTH` beyond {@link PV_MAX_DEPTH}.
 */
export function pvSetToXml(values: readonly PvValue[], opts: PvSetToXmlOptions = {}): string {
    const root = opts.rootName ?? 'PVSet';
    const unit = opts.indent ?? '  ';
    const nl = unit === '' ? '' : '\n';
    const warn = opts.warn;

    // Declare xsi only if something uses it. Walking the tree first costs one
    // pass and saves every consumer an attribute they would have to ignore.
    let usesNil = false;
    const scan = (list: readonly PvValue[]): void => {
        for (const v of list) {
            if (v.kind === 'Su') { scan(v.fields); }
            else if (v.kind === 'Arr') { scan(v.items); }
            else if (v.kind !== 'NoValue' && v.value === null) { usesNil = true; }
        }
    };
    scan(values);

    let attrs = '';
    if (opts.declareNamespace !== false) { attrs += ` xmlns="${E138_NS}"`; }
    if (usesNil) { attrs += ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'; }
    if (values.length === 0) {
        // PVSetType is minOccurs="0": an empty PVSet is legal.
        return `<${root}${attrs}/>`;
    }
    const out: string[] = [`<${root}${attrs}>`];
    const counts: Record<string, number> = {};
    for (const v of values) {
        const n = (counts[v.kind] = (counts[v.kind] ?? 0) + 1);
        emitValue(v, `/${root}/${v.kind}[${n}]`, unit, unit, warn, 1, out);
    }
    out.push(`</${root}>`);
    return out.join(nl);
}

/* ========================================================================== *
 *  Display
 * ========================================================================== */

/** How deep {@link pvToDisplayString} descends before eliding. */
const DISPLAY_MAX_DEPTH = 4;

/**
 * Renders a {@link PvValue} as a short string for a human.
 *
 * FOR READING, NOT FOR ROUND-TRIPPING. {@link pvSetToXml} is the serializer;
 * this is a tooltip. The two must not be confused, and the difference shows up
 * in exactly the places where a display has to say something a document cannot:
 *
 * - **The three absences stay visibly different.** `xsi:nil` renders `(nil)`,
 *   a `NoValue` renders its reason, and an empty string renders as nothing at
 *   all. Collapsing them to "-" would throw away the distinction the parser was
 *   careful to keep - "no reading", "no such parameter", and "the empty string".
 * - **Numbers use the XSD spellings** (`INF`, `-INF`, `NaN`), so the display
 *   agrees with the document rather than with JavaScript.
 * - **Structures and arrays are bracketed**, `(a, b)` and `[a, b]`, so a reader
 *   can see the shape without being shown a JSON dump.
 * - **Deep nesting elides.** Past {@link DISPLAY_MAX_DEPTH} the content becomes
 *   `...`; a tooltip that unrolls a 64-deep structure is not a tooltip. The raw
 *   {@link PvValue} is on `SelectedItems` for anything that needs the whole tree.
 *
 * @param v     The value.
 * @param depth Current depth; callers leave it at 0.
 * @returns A one-line string. Never `null`, never empty for a value that exists.
 */
export function pvToDisplayString(v: PvValue, depth = 0): string {
    switch (v.kind) {
        case 'NoValue':
            // The reason IS the display. A bare "(no value)" would be the same
            // text a nil deserves, and they are different claims.
            return v.description !== undefined && v.description !== ''
                ? `(${v.reasonCode || 'no reason given'}: ${v.description})`
                : `(${v.reasonCode || 'no reason given'})`;
        case 'Su': case 'Arr': {
            const kids = v.kind === 'Su' ? v.fields : v.items;
            const [open, close] = v.kind === 'Su' ? ['(', ')'] : ['[', ']'];
            if (kids.length === 0) { return `${open}${close}`; }
            if (depth >= DISPLAY_MAX_DEPTH) { return `${open}...${close}`; }
            return open + kids.map((k) => pvToDisplayString(k, depth + 1)).join(', ') + close;
        }
        default: {
            if (v.value === null) { return '(nil)'; }
            if (typeof v.value === 'number') {
                if (Number.isNaN(v.value)) { return 'NaN'; }
                if (v.value === Infinity) { return 'INF'; }
                if (v.value === -Infinity) { return '-INF'; }
                return String(v.value);
            }
            if (typeof v.value === 'boolean') { return v.value ? 'true' : 'false'; }
            return v.value;
        }
    }
}
