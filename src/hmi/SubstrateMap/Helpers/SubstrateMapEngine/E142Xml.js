/**
 * @fileoverview
 * E142Xml - the SEMI E142.1 XML input path of the SubstrateMapEngine: it turns
 * one `MapData` document into the engine's plain-data {@link E142Document} plus
 * a list of warnings, and nothing else.
 *
 * LAYERING (task O4 step 1). EXACTLY ONE thin extraction layer touches the DOM -
 * {@link domParseDocument} and the adapter behind it - and it is INJECTABLE:
 * everything downstream is coded against {@link E142XmlElement}, a four-member
 * interface offering element, attribute and text lookup and nothing more. Node
 * tests drive the whole parser through a stub implementation of that interface
 * (Tests/e142-parser.test.mjs), so the semantics are testable without a DOM and
 * a DOM quirk can never leak into the model. The interface is deliberately
 * READ-ONLY and NAMESPACE-AWARE: those are the only two DOM properties the E142
 * dialects actually need.
 *
 * DIVISION OF LABOUR with the two modules this file builds on:
 *  - E142.ts (domain) owns the LOGICAL FRAME and the layout tree: this file
 *    calls {@link resolveLayoutSpecifier}, {@link dimsInMapFrame},
 *    {@link mapCoordToIndex} and {@link logicalXStep} and re-derives none of
 *    their rules. Every X/Y this file reads out of a document is a LOGICAL
 *    coordinate (ASSUME-A A4.5 / A6.1: ReferenceDevice/Coordinates, Coordinate
 *    map X/Y and Row/Column start X/Y all live in the OriginLocation x
 *    AxisDirection frame); every X/Y it hands downstream is a SERIALIZATION
 *    index, converted in exactly one place ({@link toSerializationIndex}).
 *  - E142Bins.ts (decoder) owns the TOKEN GRAMMAR: this file extracts the raw
 *    row strings / sparse entries and calls {@link decodeBinPayload}. It
 *    contains no tokenizer - not even for the layoutless width measurement,
 *    which is {@link countRowTokens}, the decoder's own scanner.
 *
 * WHAT THIS FILE OWNS: namespace and version acceptance, the attribute-vs-child
 * dialects, the XSD identity constraints (REKON3 10), the application-level
 * MapType default, the E-6a overlay-kind skip, LID handling, and the resolution
 * of a payload's serialization lattice. Nothing else - no rendering, no
 * placement, no attributes, no events, no theme.
 *
 * ERROR CONTRACT. Like its sibling E142Bins and unlike Engine.ts's null-returning
 * builders, this module THROWS, and throws exactly one type: {@link E142ParseError},
 * carrying a machine-readable {@link E142ParseError.code} and the STRUCTURAL PATH
 * of the offending element. A wire document's defects must be reportable to an
 * operator with a location; "the map came out empty" is not a diagnosis. Decode
 * errors are wrapped, never leaked, so a caller needs to know one error type.
 *
 * PROVENANCE. Grades mirror E142-ASSUME-A-COORD.md ("ASSUME-A"), which is the
 * authoritative supplement to REKON3 chapter 6 for implementation:
 *   [A] normative or literally quoted   [B] deduced/forced   [C] thin evidence.
 * Every rule below names its source, and every graded assumption carries a
 * PDF-VERIFY marker for the deferred verification pass (task F1-V).
 *
 * S1 mechanism (frozen by spike S1): authored as an ES module, linked with `.js`
 * import specifiers, with the idempotent (`??=`) global bridge at the end of the
 * file exposing the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Xml.
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
import { E142_DEFAULT_MAP_TYPE, E142Error, dimsInMapFrame, indexToMapCoord, logicalXStep, mapCoordToIndex, resolveLayoutSpecifier, } from './E142.js';
import { countRowTokens, decodeBinPayload } from './E142Bins.js';
import { E142DecodeError } from './E142Bins.js';
/**
 * The one error this module throws. Carries a machine-readable {@link code}, the
 * STRUCTURAL PATH of the offending element (XPath-flavoured, 1-based, e.g.
 * `/MapData/SubstrateMaps/SubstrateMap[1]/Overlay[2]/BinCodeMap`) and, for a
 * wrapped decode failure, the original error in {@link cause} - so a caller that
 * wants the decoder's serialization row/column can reach it without this module
 * re-inventing the fields.
 *
 * Nothing else escapes: DOM exceptions, decode errors and domain errors are all
 * translated, so `catch (e) { if (e instanceof E142ParseError) ... }` is
 * exhaustive.
 */
export class E142ParseError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    code;
    /** Structural path of the offending element, XPath-flavoured and 1-based. */
    path;
    /** The wrapped original error, when this error translates one. */
    cause;
    /**
     * @param code    The machine-readable discriminator.
     * @param path    Structural path of the offending element.
     * @param message Human-readable detail; should name the concrete values seen.
     * @param cause   The original error, when translating one.
     */
    constructor(code, path, message, cause) {
        super(`${message} (at ${path})`);
        this.name = 'E142ParseError';
        this.code = code;
        this.path = path;
        this.cause = cause;
    }
}
// ===================================================================
//  Namespace / version vocabulary
// ===================================================================
/**
 * The E142.1 SubstrateMap namespace pattern, capturing the version token:
 * `urn:semi-org:xsd.E142-1.V####.SubstrateMap` [XSD-normativ + REKON3 8]. The
 * schema-file naming convention is the same token (`E142-1-V0125-Schema.xsd`).
 */
const E142_NAMESPACE_PATTERN = /^urn:semi-org:xsd\.E142-1\.(V\d{4})\.SubstrateMap$/;
/**
 * Every E142.1 namespace version with public evidence, in chronological order:
 * V0105 (E142.1-0305), V0805, V1005, V0211, V0921, V0224, V0125 (= E142-0225,
 * the target of this implementation). REKON3 chapter 8 tabulates the evidence
 * per entry; the last four are [XSD-normativ] (official files), the first three
 * [Sekundaerquelle] (vendor examples).
 *
 * Acceptance is by PATTERN, not by this list: a document in a well-formed E142.1
 * namespace whose version is not listed here still parses, with one warning.
 * The list only decides whether that warning fires - the data model this file
 * reads is byte-identical across every inspected revision (REKON3 9.4: "Die
 * Kern-Geometrie-Attribute sind ueber alle vier Versionen byte-identisch"), so a
 * future V#### is far more likely to be readable than not, and rejecting it
 * outright would repeat the four-year TnR/Panel/PCB lag (REKON3 9.2) in a new
 * place.
 */
export const E142_KNOWN_SCHEMA_VERSIONS = [
    'V0105', 'V0805', 'V1005', 'V0211', 'V0921', 'V0224', 'V0125',
];
/** `MaterialIdType` maxLength: SubstrateId, AliasId/@Value [XSD-normativ; REKON3 17.5]. */
const MATERIAL_ID_MAX_LENGTH = 32;
/** `LotIdType` maxLength: LotId, CarrierId [XSD-normativ; REKON3 17.5]. */
const LOT_ID_MAX_LENGTH = 80;
// ===================================================================
//  The DOM seam  (the only code in this file that knows what a DOM is)
// ===================================================================
/**
 * {@link E142XmlElement} over a live DOM `Element`. The whole DOM surface of
 * this module is the five member accesses below.
 *
 * Class rather than closure because it is IO plumbing with per-node state (the
 * memoized child list), which is exactly what the house rules reserve classes
 * for; everything downstream of it is pure functions over the interface.
 */
class DomElement {
    /** The wrapped DOM element. */
    el;
    /** Memoized wrapper list, so a re-read of `children` does not re-allocate. */
    wrapped = null;
    /** @param el The DOM element to wrap. */
    constructor(el) {
        this.el = el;
    }
    /** @inheritdoc */
    get localName() {
        return this.el.localName;
    }
    /** @inheritdoc */
    get namespaceUri() {
        return this.el.namespaceURI ?? '';
    }
    /** @inheritdoc */
    get text() {
        return this.el.textContent ?? '';
    }
    /** @inheritdoc */
    get children() {
        if (this.wrapped === null) {
            const source = this.el.children;
            const out = new Array(source.length);
            for (let i = 0; i < source.length; i++) {
                out[i] = new DomElement(source[i]);
            }
            this.wrapped = out;
        }
        return this.wrapped;
    }
    /** @inheritdoc */
    attribute(localName, namespaceUri) {
        const ns = (namespaceUri === undefined || namespaceUri === '') ? null : namespaceUri;
        return this.el.getAttributeNS(ns, localName);
    }
}
/**
 * The default {@link E142XmlDocumentParser}: the platform `DOMParser` in
 * `application/xml` mode, wrapped in {@link DomElement}.
 *
 * `DOMParser` reports a malformed document by RETURNING one - a `<parsererror>`
 * tree - instead of throwing, which is the single most dangerous DOM quirk for
 * this parser: unnoticed, a truncated file would become a short map. Both shapes
 * are checked (parsererror as the document element, as in Chromium/WebKit, and
 * nested anywhere, as in Firefox) and turned into a throw, which
 * {@link parseE142Xml} then translates into `E142_XML_MALFORMED`.
 *
 * `DOMParser` is referenced only INSIDE this function, never at module scope, so
 * importing this module in a DOM-less host (a node test) is safe as long as the
 * host injects its own provider.
 * @param xml The document text.
 * @returns The document element.
 * @throws {Error} When the text is not well-formed XML.
 */
export function domParseDocument(xml) {
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const root = dom.documentElement;
    if (root === null) {
        throw new Error('DOMParser returned a document without a document element.');
    }
    if (root.localName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
        const detail = (root.textContent ?? '').trim().replace(/\s+/g, ' ');
        throw new Error(`DOMParser reported a parser error: ${detail.slice(0, 400)}`);
    }
    return new DomElement(root);
}
/**
 * Appends a warning bound to a structural path.
 * @param ctx     The parse context.
 * @param code    Stable machine code (the message's first token).
 * @param path    Structural path of the element the warning is about.
 * @param message Human-readable detail.
 */
function warnAt(ctx, code, path, message) {
    ctx.warnings.push(`${code} at ${path}: ${message}`);
}
/**
 * Appends a document-level warning (no single element to point at).
 * @param ctx     The parse context.
 * @param code    Stable machine code (the message's first token).
 * @param message Human-readable detail.
 */
function warnGlobal(ctx, code, message) {
    ctx.warnings.push(`${code}: ${message}`);
}
/**
 * Renders a domain-module {@link E142Warning} in this module's warning format,
 * so a caller sees one shape regardless of which layer produced a diagnostic.
 * @param ctx      The parse context.
 * @param warnings The domain warnings to adopt.
 */
function adoptWarnings(ctx, warnings) {
    for (const w of warnings) {
        ctx.warnings.push(`${w.code}: ${w.message}`);
    }
}
/**
 * A child path segment, XPath-flavoured and 1-based (`.../Overlay[2]`). The
 * index is omitted for elements that occur at most once under their parent, so
 * paths stay readable.
 * @param parent Parent path.
 * @param name   Child element name.
 * @param index  0-based index among same-named siblings, or undefined for a singleton.
 * @returns The child's structural path.
 */
function childPath(parent, name, index) {
    return index === undefined ? `${parent}/${name}` : `${parent}/${name}[${index + 1}]`;
}
// ===================================================================
//  Element / attribute readers  (pure, over the injectable interface)
// ===================================================================
/**
 * The same-namespace element children of `el`, with the two tolerance rules of
 * task O4 step 2 / the extension mechanism applied:
 *
 *  - FOREIGN NAMESPACE -> skipped and counted, never an error. This is the whole
 *    of SEMI's own extension mechanism as far as a reader is concerned: the
 *    official `BinCodeMap-Extension-Example.xml` hangs an
 *    `sme:SupplierData` subtree off `Substrate` under a company namespace
 *    (`...SubstrateMap_ACMEProductsInc`) and marks the element with `xsi:type`
 *    (REKON3 7.6 [Primaerquellen-Zitat]). A reader that does not know the
 *    company schema still reads every base-schema field; one aggregated warning
 *    names the namespaces so nobody discovers the dropped subtree by accident.
 *  - UNKNOWN SAME-NAMESPACE NAME -> skipped and counted. Not an error either
 *    (a future revision may add elements, exactly as V0921 added `DeviceDataMap`),
 *    but worth an aggregated warning: in the E142 namespace an unknown name is
 *    far more often a typo than a new revision.
 *
 * `xsi:type` itself needs no handling: it names a company complexType whose only
 * observable effect is the foreign-namespace children skipped above. It is read
 * nowhere and rejected nowhere.
 * @param el    The parent element.
 * @param ctx   The parse context.
 * @param path  The parent's structural path.
 * @param known Local names this parser expects under `el`.
 * @returns The accepted children, in document order.
 */
function childrenOf(el, ctx, path, known) {
    const out = [];
    for (const child of el.children) {
        if (child.namespaceUri !== ctx.ns) {
            const key = child.namespaceUri === '' ? '(no namespace)' : child.namespaceUri;
            ctx.foreign.set(key, (ctx.foreign.get(key) ?? 0) + 1);
            continue;
        }
        if (!known.has(child.localName)) {
            const key = `${path}/${child.localName}`;
            ctx.unknown.set(key, (ctx.unknown.get(key) ?? 0) + 1);
            continue;
        }
        out.push(child);
    }
    return out;
}
/**
 * The first child with `name`, or null.
 * @param children Accepted children of one element.
 * @param name     The local name to find.
 * @returns The first match, or null.
 */
function firstNamed(children, name) {
    for (const c of children) {
        if (c.localName === name) {
            return c;
        }
    }
    return null;
}
/**
 * All children with `name`, in document order.
 * @param children Accepted children of one element.
 * @param name     The local name to collect.
 * @returns The matches.
 */
function allNamed(children, name) {
    return children.filter((c) => c.localName === name);
}
/**
 * A required attribute's raw value.
 * @param el   The element.
 * @param name The attribute's local name.
 * @param path The element's structural path.
 * @returns The raw value.
 * @throws {E142ParseError} `E142_XML_ATTR_MISSING`.
 */
function requiredAttr(el, name, path) {
    const v = el.attribute(name);
    if (v === null) {
        throw new E142ParseError('E142_XML_ATTR_MISSING', path, `Attribute @${name} is missing; every inspected XSD revision declares it use="required" on `
            + `<${el.localName}>.`);
    }
    return v;
}
/**
 * An `xs:integer` attribute, or null when absent. Strict on the lexical form:
 * `xs:integer` is an unbounded signed decimal, so 'true', '1.0', '0x10' and ''
 * are all type errors rather than silently `Number()`-coerced values.
 * @param el   The element.
 * @param name The attribute's local name.
 * @param path The element's structural path.
 * @returns The value, or null when the attribute is absent.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function intAttr(el, name, path) {
    const raw = el.attribute(name);
    if (raw === null) {
        return null;
    }
    const text = raw.trim();
    if (!/^[+-]?\d+$/.test(text)) {
        throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@${name}=${JSON.stringify(raw)} is not an xs:integer.`);
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
        throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@${name}=${JSON.stringify(raw)} is outside the safe integer range; xs:integer is unbounded, this `
            + `engine's grids are not.`);
    }
    return value;
}
/**
 * An `xs:double` attribute, or null when absent.
 *
 * ONE tolerance, and it is a real-world one: an EMPTY value is treated as an
 * ABSENT one, with a warning. `<DeviceSize X="" Y="" />` appears verbatim in the
 * GitHub reference strip map (REKON3 7.7.2), where it plainly means "no device
 * size", and `xs:double` has no lexical form for that. The dangerous reading is
 * the arithmetic one: `Number('')` is 0, and a zero DeviceSize is not "unknown",
 * it is "devices of size zero" - a map that renders empty. Treating it as absent
 * instead lets the documented fallback apply (deviceSize falls back to stepSize,
 * decision E-9). INF/NaN are rejected: the XSD admits their lexical forms, no
 * E142 quantity has a meaning for them, and they would poison the placement.
 * @param el   The element.
 * @param name The attribute's local name.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @returns The value, or null when the attribute is absent or empty.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function doubleAttr(el, name, path, ctx) {
    const raw = el.attribute(name);
    if (raw === null) {
        return null;
    }
    const text = raw.trim();
    if (text === '') {
        warnAt(ctx, 'E142_XML_EMPTY_NUMBER', path, `@${name} is empty and is read as ABSENT, not as 0 (observed in the GitHub reference strip map, `
            + `REKON3 7.7.2: <DeviceSize X="" Y="" />). xs:double has no lexical form for "unknown"; reading it `
            + `as 0 would silently produce zero-sized devices.`);
        return null;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
        throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@${name}=${JSON.stringify(raw)} is not a finite xs:double.`);
    }
    return Number(text);
}
/**
 * An `xs:boolean` attribute, defaulted when absent.
 *
 * TOLERANCE, observed: `TopLevel="True"` appears in the GitHub reference strip
 * map (REKON3 7.7.2) and in the fixture derived from it, although `xs:boolean`
 * admits exactly `true`/`false`/`1`/`0` - a capitalized value is schema-invalid.
 * It is accepted case-insensitively with a warning, because the alternative
 * (rejecting a real, otherwise-valid document over the case of one letter) is
 * indefensible, and because the intent is not ambiguous in the slightest.
 * @param el   The element.
 * @param name The attribute's local name.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @param dflt The XSD's declared default.
 * @returns The boolean value.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function boolAttr(el, name, path, ctx, dflt) {
    const raw = el.attribute(name);
    if (raw === null) {
        return dflt;
    }
    const text = raw.trim();
    if (text === 'true' || text === '1') {
        return true;
    }
    if (text === 'false' || text === '0') {
        return false;
    }
    const lower = text.toLowerCase();
    if (lower === 'true' || lower === 'false') {
        warnAt(ctx, 'E142_XML_BOOLEAN_DIALECT', path, `@${name}=${JSON.stringify(raw)} is not an xs:boolean literal (true/false/1/0) but its intent is `
            + `unambiguous; accepted as ${lower}. Observed in the wild, REKON3 7.7.2.`);
        return lower === 'true';
    }
    throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@${name}=${JSON.stringify(raw)} is not an xs:boolean (true/false/1/0).`);
}
/**
 * Checks a raw value against an XSD enumeration.
 * @param raw     The raw attribute value.
 * @param allowed The enumeration's members.
 * @param name    The attribute's local name, for the message.
 * @param path    The element's structural path.
 * @returns The value, typed.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function enumValue(raw, allowed, name, path) {
    if (allowed.indexOf(raw) === -1) {
        throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@${name}=${JSON.stringify(raw)} is not a member of {${allowed.join(', ')}}.`);
    }
    return raw;
}
/**
 * Trims an id and warns that it did so.
 *
 * Task O4 step 3 requires whitespace-padded ids to be trimmed. Note this is a
 * deliberate, warned DEVIATION from the letter of the schema: every id type
 * derives from `xs:string`, whose `whiteSpace` facet is `preserve`, so
 * `"  PADDED01  "` is schema-legal AND schema-distinct from `"PADDED01"`. The
 * warning exists because trimming silently would leave an operator unable to
 * explain why the id in the map no longer matches the id in the MES. The
 * identity constraints of REKON3 10 are checked on the RAW values regardless -
 * see {@link parseE142Xml} - so trimming cannot invent or hide a key collision.
 * @param raw  The raw attribute value.
 * @param what The attribute's name, for the message.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @returns The trimmed id.
 */
function trimId(raw, what, path, ctx) {
    const trimmed = raw.trim();
    if (trimmed !== raw) {
        warnAt(ctx, 'E142_XML_ID_TRIMMED', path, `@${what}=${JSON.stringify(raw)} carries surrounding whitespace; the model carries `
            + `${JSON.stringify(trimmed)}. The XSD preserves it (xs:string, whiteSpace="preserve"), so the `
            + `identity constraints are still checked on the raw value.`);
    }
    return trimmed;
}
/**
 * Warns when an id exceeds its XSD `maxLength` - as a warning and not an error,
 * per task O4 step 3, because real files violate these limits and a length facet
 * is the one XSD constraint whose breach costs a reader nothing. The RAW value
 * is measured: the facet applies to the schema's value, not to this parser's
 * trimmed carry-along.
 * @param raw  The raw attribute value.
 * @param max  The XSD maxLength.
 * @param what The attribute's name, for the message.
 * @param type The XSD simple type's name, for the message.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 */
function checkIdLength(raw, max, what, type, path, ctx) {
    if (raw.length > max) {
        warnAt(ctx, 'E142_XML_ID_TOO_LONG', path, `@${what} is ${raw.length} characters; ${type} declares maxLength ${max} [XSD-normativ, `
            + `REKON3 17.5]. Carried through unchanged.`);
    }
}
/**
 * Reads one datum that may arrive as an ATTRIBUTE or as a CHILD ELEMENT, per the
 * dialect tolerance of task O4 step 3.
 *
 * Both spellings are attested for E142 header data: the schema puts
 * Orientation / OriginLocation / AxisDirection on `SubstrateMap` as attributes
 * and `LotId` under `Substrate` as an element [XSD-normativ], while the
 * real-world documents collected in REKON3 7.7 show the same information moving
 * between the two forms. Reading both costs one lookup and rescues documents no
 * dialect-blind reader could touch.
 *
 * CONFLICT RULE (task O4 step 3): the ATTRIBUTE wins, with a warning. Nothing in
 * the material ranks the two - the rule is a decision, and the warning is what
 * makes it a safe one, because the losing value is named in the diagnostic.
 * @param el       The element.
 * @param children Its accepted children.
 * @param name     The datum's name; identical in both spellings.
 * @param path     The element's structural path.
 * @param ctx      The parse context.
 * @returns The value, or null when neither spelling is present.
 */
function dialectValue(el, children, name, path, ctx) {
    const fromAttr = el.attribute(name);
    const child = firstNamed(children, name);
    const fromChild = child === null ? null : child.text.trim();
    if (fromAttr !== null && fromChild !== null && fromAttr.trim() !== fromChild) {
        warnAt(ctx, 'E142_XML_DIALECT_CONFLICT', path, `${name} is present both as an attribute (${JSON.stringify(fromAttr)}) and as a child element `
            + `(${JSON.stringify(fromChild)}); the attribute wins.`);
    }
    return fromAttr !== null ? fromAttr : fromChild;
}
// ===================================================================
//  The element inventory of the V0125 model (= E142-0225)
//
//  One set per parent this parser walks, so an unknown name is DETECTED rather
//  than ignored. Members are the V0125 XSD's own child elements [XSD-normativ],
//  plus - where noted - the dialect spellings of task O4 step 3. Older revisions
//  are strict subsets (REKON3 9.1-9.4), so one inventory serves every accepted
//  namespace: a V0211 document simply never uses the V0921/V0125 additions.
// ===================================================================
/** Children of `MapData` [XSD-normativ, MapDataType]. */
const KNOWN_MAPDATA = new Set(['Layouts', 'Substrates', 'SubstrateMaps']);
/** Children of `Layouts` / `ChildLayouts` / `Substrates` / `SubstrateMaps` (single-member containers). */
const KNOWN_LAYOUTS = new Set(['Layout']);
/** @see KNOWN_LAYOUTS */
const KNOWN_CHILDLAYOUTS = new Set(['ChildLayout']);
/** @see KNOWN_LAYOUTS */
const KNOWN_SUBSTRATES = new Set(['Substrate']);
/** @see KNOWN_LAYOUTS */
const KNOWN_SUBSTRATEMAPS = new Set(['SubstrateMap']);
/** Children of `Layout` [XSD-normativ, LayoutType]. */
const KNOWN_LAYOUT = new Set([
    'Dimension', 'LowerLeft', 'DeviceSize', 'StepSize', 'Z', 'TopImage', 'BottomImage', 'ProductId', 'ChildLayouts',
]);
/** Children of `Substrate` [XSD-normativ, SubstrateType]. */
const KNOWN_SUBSTRATE = new Set([
    'LotId', 'AliasIds', 'CarrierType', 'CarrierId', 'SlotNumber', 'SubstrateNumber', 'GoodDevices',
    'SupplierName', 'Status',
]);
/**
 * Children of `SubstrateMap`: `Overlay` [XSD-normativ, SubstrateMapType] plus
 * the three element-spelled header data of task O4 step 3, which the schema
 * declares as attributes.
 */
const KNOWN_SUBSTRATEMAP = new Set(['Overlay', 'Orientation', 'OriginLocation', 'AxisDirection']);
/** Children of `Overlay` [XSD-normativ, OverlayType: ReferenceDevices + a 4-way choice]. */
const KNOWN_OVERLAY = new Set(['ReferenceDevices', 'BinCodeMap', 'DeviceIdMap', 'TransferMap', 'DeviceDataMap']);
/** Children of `ReferenceDevices` [XSD-normativ]. */
const KNOWN_REFERENCEDEVICES = new Set(['ReferenceDevice']);
/** Children of `ReferenceDevice` [XSD-normativ, ReferenceDeviceType]. */
const KNOWN_REFERENCEDEVICE = new Set(['Coordinates', 'Position']);
/** Children of `BinCodeMap` [XSD-normativ, BinCodeMapType]. */
const KNOWN_BINCODEMAP = new Set(['BinDefinitions', 'BinCode']);
/** Children of `DeviceIdMap` [XSD-normativ, DeviceIdMapType]: `<Id>` entries only. */
const KNOWN_DEVICEIDMAP = new Set(['Id']);
/** Children of `BinDefinitions` [XSD-normativ]. */
const KNOWN_BINDEFINITIONS = new Set(['BinDefinition']);
/** `SubstrateTypeEnum` members of V0125 [XSD-normativ]; older revisions are subsets (REKON3 9.2). */
const SUBSTRATE_TYPES = ['Wafer', 'Frame', 'Strip', 'Tray', 'TnR', 'Panel', 'PCB'];
/** `SubstrateSideEnum` members [XSD-normativ]; unchanged across all revisions. */
const SUBSTRATE_SIDES = ['TopSide', 'BottomSide'];
/** `OriginLocationEnum` members [XSD-normativ]; unchanged across all revisions. */
const ORIGIN_LOCATIONS = [
    'LowerLeft', 'UpperLeft', 'LowerRight', 'UpperRight', 'Center',
];
/** `AxisDirectionEnum` members [XSD-normativ]; unchanged across all revisions. */
const AXIS_DIRECTIONS = ['UpRight', 'DownRight', 'UpLeft', 'DownLeft'];
/** `BinTypeEnum` members [XSD-normativ]; unchanged across all revisions (note the spelling HexaDecimal). */
const BIN_TYPES = ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2'];
/** `MapTypeEnum` members [XSD-normativ]; note the literal slash in `Row/Column`. */
const MAP_TYPES = ['2DArray', 'Row/Column', 'Array', 'Coordinate'];
/**
 * The overlay kinds decision E-6a skips [XSD-normativ, OverlayType's choice].
 * `DeviceIdMap` was removed from this list under decision E-6b: it is now parsed
 * (see {@link parseDeviceIdMap}) for the cell -> device-id selection lookup.
 * `TransferMap` / `DeviceDataMap` remain skipped (DeviceDataMap needs the E138
 * `ccs:PVSet` payload, out of scope).
 */
const SKIPPED_OVERLAY_KINDS = ['TransferMap', 'DeviceDataMap'];
// ===================================================================
//  Leaf parsers
// ===================================================================
/**
 * `LogicalCoordinatesType`: X and Y, both `use="required"` `xs:integer`
 * [XSD-normativ].
 *
 * FRAME: as a `Dimension` these are counts; everywhere else - `ReferenceDevice/
 * Coordinates` above all - they are LOGICAL coordinates in the OriginLocation x
 * AxisDirection frame and may legitimately be negative (ASSUME-A A4.4/A4.5 [B],
 * "often results in negative index values" [Sekundaerquelle, Artwork]). This
 * function neither interprets nor converts them.
 * PDF-VERIFY: A4.5 grade B (ReferenceDevice clause).
 * @param el   The `LogicalCoordinatesType` element.
 * @param path Its structural path.
 * @returns The (x, y) pair.
 * @throws {E142ParseError} `E142_XML_ATTR_MISSING` / `E142_XML_ATTR_INVALID`.
 */
function parseLogicalCoordinates(el, path) {
    // The presence check first, so an absent attribute reports as MISSING
    // rather than as an invalid lexical form; both reads then cannot be null,
    // which is what the two casts record.
    requiredAttr(el, 'X', path);
    requiredAttr(el, 'Y', path);
    const x = intAttr(el, 'X', path);
    const y = intAttr(el, 'Y', path);
    return { x, y };
}
/**
 * `PhysicalCoordinatesType`: X and Y (`use="required"` `xs:double`) plus an
 * optional `Units` token [XSD-normativ]. Returns undefined when the element
 * carries no usable pair - see {@link doubleAttr} on the empty-value case.
 * Units are NOT resolved here: {@link resolveLayoutSpecifier} owns unit
 * resolution (ASSUME-A A8), including the DefaultUnits fallback (REKON3 6.4.4).
 * @param el   The `PhysicalCoordinatesType` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The pair, or undefined when it carries no usable value.
 * @throws {E142ParseError} `E142_XML_ATTR_MISSING` / `E142_XML_ATTR_INVALID`.
 */
function parsePhysicalCoordinates(el, path, ctx) {
    requiredAttr(el, 'X', path);
    requiredAttr(el, 'Y', path);
    const x = doubleAttr(el, 'X', path, ctx);
    const y = doubleAttr(el, 'Y', path, ctx);
    if (x === null || y === null) {
        return undefined;
    }
    const units = el.attribute('Units');
    const out = { x, y };
    if (units !== null && units.trim() !== '') {
        out.units = units.trim();
    }
    return out;
}
/**
 * `ZDimensionsType`: Order (`xs:integer`, default 0), Height (`xs:double`,
 * default 0), Units (optional) [XSD-normativ]. The XSD defaults are APPLIED
 * here - an absent attribute with a schema default is not an absent value.
 * Carry-only for placement.
 * @param el   The `Z` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The z descriptor.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function parseZ(el, path, ctx) {
    const out = {
        order: intAttr(el, 'Order', path) ?? 0,
        height: doubleAttr(el, 'Height', path, ctx) ?? 0,
    };
    const units = el.attribute('Units');
    if (units !== null && units.trim() !== '') {
        out.units = units.trim();
    }
    return out;
}
/**
 * `LayoutType` [XSD-normativ]. `Package` exists only from V0921 (REKON3 9.1) and
 * simply never appears in an older document, so reading it unconditionally is
 * the whole of this parser's version handling for it.
 *
 * `TopImage` / `BottomImage` / `AliasIds` / `CarrierType` / `CarrierId` /
 * `SlotNumber` / `SubstrateNumber` are recognized (they are in the inventory
 * sets, so they raise no unknown-element warning) but not modeled: the engine's
 * document model is the placement-relevant subset, and inventing carry-only
 * fields nothing consumes would be surface without a consumer.
 * @param el   The `Layout` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The layout node.
 * @throws {E142ParseError} On a missing/invalid attribute or a missing `Dimension`.
 */
function parseLayout(el, path, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_LAYOUT);
    const dimEl = firstNamed(children, 'Dimension');
    if (dimEl === null) {
        throw new E142ParseError('E142_XML_ELEMENT_MISSING', path, 'Layout has no <Dimension>; LayoutType declares it minOccurs="1".');
    }
    const out = {
        layoutId: trimId(requiredAttr(el, 'LayoutId', path), 'LayoutId', path, ctx),
        dimension: parseLogicalCoordinates(dimEl, childPath(path, 'Dimension')),
        package: boolAttr(el, 'Package', path, ctx, false),
        topLevel: boolAttr(el, 'TopLevel', path, ctx, false),
        defaultUnits: requiredAttr(el, 'DefaultUnits', path).trim(),
        childLayouts: [],
    };
    const lowerLeft = firstNamed(children, 'LowerLeft');
    if (lowerLeft !== null) {
        const p = parsePhysicalCoordinates(lowerLeft, childPath(path, 'LowerLeft'), ctx);
        if (p !== undefined) {
            out.lowerLeft = p;
        }
    }
    const deviceSize = firstNamed(children, 'DeviceSize');
    if (deviceSize !== null) {
        const p = parsePhysicalCoordinates(deviceSize, childPath(path, 'DeviceSize'), ctx);
        if (p !== undefined) {
            out.deviceSize = p;
        }
    }
    const stepSize = firstNamed(children, 'StepSize');
    if (stepSize !== null) {
        const p = parsePhysicalCoordinates(stepSize, childPath(path, 'StepSize'), ctx);
        if (p !== undefined) {
            out.stepSize = p;
        }
    }
    const z = firstNamed(children, 'Z');
    if (z !== null) {
        out.z = parseZ(z, childPath(path, 'Z'), ctx);
    }
    const productId = firstNamed(children, 'ProductId');
    if (productId !== null) {
        out.productId = productId.text.trim();
    }
    const childLayouts = firstNamed(children, 'ChildLayouts');
    if (childLayouts !== null) {
        const cPath = childPath(path, 'ChildLayouts');
        const refs = childrenOf(childLayouts, ctx, cPath, KNOWN_CHILDLAYOUTS);
        for (let i = 0; i < refs.length; i++) {
            const rPath = childPath(cPath, 'ChildLayout', i);
            const ref = refs[i].attribute('LayoutId');
            if (ref === null) {
                // ChildLayoutType declares @LayoutId WITHOUT use= [XSD-normativ],
                // i.e. optional, so an absent one is schema-legal - and refers to
                // nothing, which is why it is dropped rather than resolved. (The
                // ChildLayoutRef keyref does not fire on it either: an XSD 1.0
                // keyref with an absent field is simply not evaluated.)
                warnAt(ctx, 'E142_XML_CHILDLAYOUT_UNADDRESSED', rPath, 'ChildLayout carries no @LayoutId. The attribute is use="optional" in every inspected '
                    + 'revision, so this is schema-legal, but the reference addresses no layout and is dropped.');
                continue;
            }
            out.childLayouts.push(trimId(ref, 'LayoutId', rPath, ctx));
        }
    }
    return out;
}
/**
 * A `SubstrateTypeEnum` token, with the schema-evolution tolerance of task O4
 * step 5: an unknown value is WARNED and PASSED THROUGH as a string rather than
 * rejected. See {@link E142SubstrateTypeToken} for why (the TnR/Panel/PCB
 * prose-vs-schema lag of REKON3 9.2 is the precedent: for four years, documents
 * were legal per the standard's own prose and invalid per its own schema).
 *
 * The token is NOT trimmed: it is half of the SubstrateKey/SubstrateMapKey, and
 * an enumeration facet has no whitespace tolerance to borrow. A padded value
 * simply lands in the unknown-token path, warning and all.
 * @param raw  The raw attribute value.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @returns The token.
 */
function substrateTypeValue(raw, path, ctx) {
    if (SUBSTRATE_TYPES.indexOf(raw) === -1) {
        warnAt(ctx, 'E142_XML_SUBSTRATE_TYPE_UNKNOWN', path, `@SubstrateType=${JSON.stringify(raw)} is not a member of SubstrateTypeEnum `
            + `{${SUBSTRATE_TYPES.join(', ')}} in any inspected revision; carried through as a string `
            + `(schema-evolution tolerance, task O4 step 5). An XSD-validating reader would reject this `
            + `document (cvc-enumeration-valid); this reader deliberately does not.`);
    }
    return raw;
}
/**
 * `SubstrateType` (the element, not the enum) [XSD-normativ]. Carry-only for
 * placement; only `LotId` is lifted out of the nine optional children, because
 * task O4 step 3 names it and because it is the one substrate datum with a
 * documented dialect (REKON3 7.7).
 * @param el   The `Substrate` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The substrate record.
 * @throws {E142ParseError} On a missing/invalid attribute.
 */
function parseSubstrate(el, path, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_SUBSTRATE);
    const rawId = requiredAttr(el, 'SubstrateId', path);
    checkIdLength(rawId, MATERIAL_ID_MAX_LENGTH, 'SubstrateId', 'MaterialIdType', path, ctx);
    const out = {
        substrateType: substrateTypeValue(requiredAttr(el, 'SubstrateType', path), path, ctx),
        substrateId: trimId(rawId, 'SubstrateId', path, ctx),
    };
    const lotId = dialectValue(el, children, 'LotId', path, ctx);
    if (lotId !== null) {
        checkIdLength(lotId, LOT_ID_MAX_LENGTH, 'LotId', 'LotIdType', path, ctx);
        out.lotId = lotId.trim();
    }
    const goodDevices = firstNamed(children, 'GoodDevices');
    if (goodDevices !== null) {
        const text = goodDevices.text.trim();
        if (!/^\d+$/.test(text)) {
            throw new E142ParseError('E142_XML_ATTR_INVALID', childPath(path, 'GoodDevices'), `<GoodDevices>${JSON.stringify(text)}</GoodDevices> is not an xs:nonNegativeInteger.`);
        }
        out.goodDevices = Number(text);
    }
    const supplierName = firstNamed(children, 'SupplierName');
    if (supplierName !== null) {
        out.supplierName = supplierName.text.trim();
    }
    const status = firstNamed(children, 'Status');
    if (status !== null) {
        out.status = status.text.trim();
    }
    return out;
}
/**
 * The `SubstrateMap` header [XSD-normativ, SubstrateMapType attributes], with
 * every XSD default applied and the attribute-or-element dialect of task O4
 * step 3 honoured for Orientation / OriginLocation / AxisDirection.
 *
 * `SubstrateSide`, `SubstrateId`, `SubstrateType` and `LayoutSpecifier` are read
 * as attributes ONLY: no source shows an element spelling for them and the task
 * names exactly the three above, so tolerating more would be invention. Should a
 * dialect turn up, {@link dialectValue} is one call away for each.
 *
 * `Orientation` is range-checked against `OrientationType`'s facets (0..359,
 * [XSD-normativ]) and a violation is an ERROR, not a tolerated value: unlike an
 * unknown SubstrateType there is no schema-evolution reading of `Orientation=400`,
 * and the two repairs one might imagine (clamp, or normalize mod 360) are a
 * guess about a rotated substrate - i.e. about which way the wafer physically
 * sits. Guessing that silently is how a map gets rendered upside down.
 * @param el   The `SubstrateMap` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The header.
 * @throws {E142ParseError} On a missing/invalid attribute.
 */
function parseHeader(el, path, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_SUBSTRATEMAP);
    const rawId = requiredAttr(el, 'SubstrateId', path);
    checkIdLength(rawId, MATERIAL_ID_MAX_LENGTH, 'SubstrateId', 'MaterialIdType', path, ctx);
    let layoutSpecifier = el.attribute('LayoutSpecifier');
    if (layoutSpecifier === null) {
        // use="required" in every revision - but the domain model's own contract
        // says the specifier "may dangle / be absent (layoutless)", and an
        // absent one costs nothing a dangling one does not: both land on the
        // layoutless path, which the official example needs anyway.
        warnAt(ctx, 'E142_XML_LAYOUT_SPECIFIER_ABSENT', path, '@LayoutSpecifier is missing although every inspected XSD revision declares it use="required"; '
            + 'read as absent, which routes this map to the layoutless path (dims from the payload).');
        layoutSpecifier = '';
    }
    const orientationRaw = dialectValue(el, children, 'Orientation', path, ctx);
    let orientation = 0;
    if (orientationRaw !== null) {
        const text = orientationRaw.trim();
        if (!/^[+-]?\d+$/.test(text)) {
            throw new E142ParseError('E142_XML_ATTR_INVALID', path, `Orientation=${JSON.stringify(orientationRaw)} is not an xs:integer.`);
        }
        orientation = Number(text);
        if (orientation < 0 || orientation > 359) {
            throw new E142ParseError('E142_XML_ATTR_INVALID', path, `Orientation=${orientation} is outside OrientationType's facets [0, 359] [XSD-normativ, `
                + `REKON3 6.1.1]. Not repaired: any repair would be a guess about how the substrate `
                + `physically sits relative to the map data.`);
        }
    }
    const originRaw = dialectValue(el, children, 'OriginLocation', path, ctx);
    const axisRaw = dialectValue(el, children, 'AxisDirection', path, ctx);
    const sideRaw = el.attribute('SubstrateSide');
    return {
        substrateType: substrateTypeValue(requiredAttr(el, 'SubstrateType', path), path, ctx),
        substrateId: trimId(rawId, 'SubstrateId', path, ctx),
        layoutSpecifier: layoutSpecifier.trim(),
        substrateSide: sideRaw === null
            ? 'TopSide'
            : enumValue(sideRaw.trim(), SUBSTRATE_SIDES, 'SubstrateSide', path),
        orientation,
        originLocation: originRaw === null
            ? 'LowerLeft'
            : enumValue(originRaw.trim(), ORIGIN_LOCATIONS, 'OriginLocation', path),
        axisDirection: axisRaw === null
            ? 'UpRight'
            : enumValue(axisRaw.trim(), AXIS_DIRECTIONS, 'AxisDirection', path),
    };
}
/**
 * `ReferenceDeviceType` [XSD-normativ]: `Coordinates` (required, LOGICAL frame -
 * ASSUME-A A4.5 [B]), `Position` (optional, physical) and `Name` (optional,
 * default ''). Decision E-7: reference devices are CARRIED ALONG, never folded
 * into the placement math, so this parser does not convert their coordinates.
 * PDF-VERIFY: A4.5 grade B (ReferenceDevice clause).
 * @param el   The `ReferenceDevice` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The reference device.
 * @throws {E142ParseError} On a missing `Coordinates` or an invalid attribute.
 */
function parseReferenceDevice(el, path, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_REFERENCEDEVICE);
    const coords = firstNamed(children, 'Coordinates');
    if (coords === null) {
        throw new E142ParseError('E142_XML_ELEMENT_MISSING', path, 'ReferenceDevice has no <Coordinates>; ReferenceDeviceType declares it minOccurs="1".');
    }
    const out = {
        // @Name is use="optional" default="" [XSD-normativ]: an absent attribute
        // with a schema default IS its default, so it is applied rather than
        // left undefined - the same rule this parser follows for MapVersion,
        // Pick, TopLevel, Package, Order and Height. MapType is the one
        // attribute this does NOT hold for: its default is prose-only, see
        // parseBinCodeMap.
        name: el.attribute('Name') ?? '',
        coordinates: parseLogicalCoordinates(coords, childPath(path, 'Coordinates')),
    };
    const position = firstNamed(children, 'Position');
    if (position !== null) {
        const p = parsePhysicalCoordinates(position, childPath(path, 'Position'), ctx);
        if (p !== undefined) {
            out.position = p;
        }
    }
    return out;
}
/**
 * `BinDefinitionType` [XSD-normativ]: BinCode (required) plus BinCount,
 * BinQuality (default ''), BinDescription (default '') and Pick (default false).
 * `BinQuality` is a FREE STRING, not an enumeration - the schema declares no
 * facet, and the familiar Pass/Fail/Edge/Skip/Reference values are convention
 * only [Sekundaerquelle, Artwork; REKON3 7.1] - so no value is rejected here.
 * @param el   The `BinDefinition` element.
 * @param path Its structural path.
 * @returns The bin definition.
 * @throws {E142ParseError} On a missing/invalid attribute.
 */
function parseBinDefinition(el, path, ctx) {
    const out = {
        binCode: requiredAttr(el, 'BinCode', path),
        binQuality: el.attribute('BinQuality') ?? '',
        binDescription: el.attribute('BinDescription') ?? '',
        pick: boolAttr(el, 'Pick', path, ctx, false),
    };
    const count = intAttr(el, 'BinCount', path);
    if (count !== null) {
        if (count < 0) {
            throw new E142ParseError('E142_XML_ATTR_INVALID', path, `@BinCount=${count} is not an xs:nonNegativeInteger.`);
        }
        out.binCount = count;
    }
    return out;
}
/**
 * Resolves the lattice {@link decodeBinPayload} must fill, in SERIALIZATION
 * index space, from the two sources a document can offer - and reports every
 * disagreement between them.
 *
 * ---- The two sources ----
 *  (1) DECLARED: the layout reached through the LayoutSpecifier, run through
 *      {@link dimsInMapFrame} so the ASSUME-A A3 swap applies (for
 *      Orientation mod 180 == 90 the map view swaps the layout's X/Y). Absent
 *      for a LAYOUTLESS document.
 *  (2) OBSERVED: the payload's own shape. Available for `2DArray` ALONE, whose
 *      serialization is self-describing - one `<BinCode>` element per row
 *      (REKON3 6.5.3, structurally confirmed by every real example including
 *      SEMI's own) and one measurable token count per row ({@link countRowTokens}).
 *      `Array` (one un-broken stream), `Coordinate` and `Row/Column` (sparse)
 *      describe no shape at all: any factorisation of their token count would
 *      fit, so for them the declared lattice is the only source and its absence
 *      is fatal.
 *
 * ---- Why OBSERVED wins for 2DArray, with a warning ----
 * The standard's own words make the correspondence a RECOMMENDATION, not a rule:
 * "The length of each row and number of rows SHOULD correspond with the product
 * of the dimensions of the layouts defined by the LayoutSpecifier attribute,
 * rotated to the coordinate system of the SubstrateMap" [A quote, REKON3 6.5.2 -
 * emphasis on the modal verb, which is the standard's]. A `should` cannot make a
 * conforming reader reject a document, so a mismatch is a diagnostic, not a
 * fault; and between a COUNTED shape and a DERIVED one, the counted shape is the
 * observation. Adopting the observation also keeps one code path for the
 * layoutless case, which has nothing else.
 *
 * Two mismatches get two codes, because they are epistemically different:
 *  - `E142_XML_DIM_ORIENTATION_SWAP` - the shapes are exact TRANSPOSES and
 *    Orientation mod 180 == 90. SETTLED by task F1-V: SEMI E142-0225 requires the
 *    2DArray row length / row count to match the layout dimensions "rotated to the
 *    coordinate system of the SubstrateMap" [A], and Figure R2-11 shows the cell
 *    pitch transposing at 90/270. So the LAYOUT-derived map frame is right and a
 *    payload in the untransposed shape makes the DOCUMENT non-conformant.
 *  - `E142_XML_DIM_MISMATCH` - any other disagreement, e.g. a `MapType`-less
 *    single-line payload under a 5x4 layout (REKON3 7.7.3's CSDN document does
 *    exactly this).
 *
 * ---- The consequence a caller MUST know ----
 * When either warning fires, this payload's cols/rows DISAGREE with what
 * `computeGridPlacement` will derive from the same document, because that
 * function re-derives the map frame from the layout via {@link dimsInMapFrame}
 * and never sees the payload. `buildGridModel` takes cols/rows from the PAYLOAD
 * and the lattice basis from the PLACEMENT, so the combination would render a
 * plausible, wrong wafer. The two warnings exist to stop exactly that: a caller
 * that sees one may render the bin data but must treat the PLACEMENT GEOMETRY of
 * this overlay as unusable, and the document should be fixed at the source. The
 * parser still adopts the payload's counted shape rather than rejecting the file,
 * so a non-conformant document degrades to "data without trustworthy geometry"
 * instead of to nothing.
 * VERIFIED (F1-V): A3.1 [A] - E142-0225 MapType='2DArray' clause + Figure R2-11.
 *
 * @param observed The payload's own shape, or null when the form describes none.
 * @param declared The layout's map-frame shape, or null when layoutless.
 * @param mapType  The resolved MapType, for the diagnostics.
 * @param orientationDeg The document's Orientation, for the A3 reading.
 * @param path     Structural path of the `BinCodeMap`.
 * @param ctx      The parse context.
 * @returns The lattice to decode against.
 * @throws {E142ParseError} `E142_XML_DIMS_UNKNOWN` when neither source exists.
 */
function resolveSerializationDims(observed, declared, mapType, orientationDeg, path, ctx) {
    if (observed !== null && declared !== null) {
        if (observed.cols !== declared.cols || observed.rows !== declared.rows) {
            const transposed = observed.cols === declared.rows && observed.rows === declared.cols;
            const quadrant = (((Math.round(orientationDeg) % 180) + 180) % 180) === 90;
            if (transposed && quadrant) {
                warnAt(ctx, 'E142_XML_DIM_ORIENTATION_SWAP', path, `The layout declares a ${declared.rows} x ${declared.cols} device array which, at `
                    + `Orientation=${orientationDeg}, is a ${declared.cols} cols x ${declared.rows} rows MAP: `
                    + `SEMI E142-0225 requires the row length and row count to correspond to the layout `
                    + `dimensions "rotated to the coordinate system of the SubstrateMap" [A, MapType='2DArray'], `
                    + `and Figure R2-11 shows the cell pitch transposing at Orientation 90/270. This payload `
                    + `serializes the exact transpose of that, ${observed.cols} cols x ${observed.rows} rows, `
                    + `so THE DOCUMENT IS NON-CONFORMANT. The payload's own shape is adopted so the bin data `
                    + `still renders, but computeGridPlacement derives the lattice from the LAYOUT (correctly), `
                    + `so the two disagree: treat this overlay's PLACEMENT GEOMETRY as unusable and fix the `
                    + `document - either transpose the payload rows, or declare the layout Dimension that makes `
                    + `this map its rotation.`);
            }
            else {
                warnAt(ctx, 'E142_XML_DIM_MISMATCH', path, `The layout declares a ${declared.cols} cols x ${declared.rows} rows map (post-A3) but the `
                    + `MapType="${mapType}" payload serializes ${observed.cols} cols x ${observed.rows} rows. `
                    + `The payload's own shape is adopted: the prose only says the two SHOULD correspond `
                    + `[A quote, REKON3 6.5.2], so this is a deviation from a recommendation, not a fault. `
                    + `CONSEQUENCE: computeGridPlacement derives its lattice from the LAYOUT and will `
                    + `disagree with this payload - do not build a grid model from this overlay while this `
                    + `warning stands.`);
            }
        }
        return observed;
    }
    if (observed !== null) {
        return observed;
    }
    if (declared !== null) {
        return { cols: declared.cols, rows: declared.rows };
    }
    throw new E142ParseError('E142_XML_DIMS_UNKNOWN', path, `MapType="${mapType}" describes no lattice of its own and this document is layoutless (no `
        + `LayoutSpecifier target), so cols x rows is unknown. Only MapType="2DArray" is self-describing `
        + `(one <BinCode> element per row); for the other three the LayoutSpecifier must resolve.`);
}
/**
 * Converts a LOGICAL (X, Y) - the frame every X/Y attribute in a document lives
 * in (ASSUME-A A4.5 / A5.1 / A6.1) - into the SERIALIZATION (col, row) index
 * space the decoder speaks. The ONE conversion point of this module; the rule
 * itself lives in {@link mapCoordToIndex} (ASSUME-A A2.3 + A4.3).
 *
 * Out-of-range results are NOT filtered here: the decoder's own bounds check
 * reports them with the offending row/column and a message that says these are
 * serialization indices, which is a better diagnostic than anything this
 * function could produce, and it keeps one gate rather than two.
 * PDF-VERIFY: A2.1/2 (Figure A1-1b, the 2DArray clause), A4.3 (Table A4-1).
 * @param x      Logical X.
 * @param y      Logical Y.
 * @param header The map header (OriginLocation x AxisDirection).
 * @param dims   The serialization lattice.
 * @returns The (col, row) serialization index.
 */
function toSerializationIndex(x, y, header, dims) {
    return mapCoordToIndex(x, y, header.originLocation, header.axisDirection, dims.cols, dims.rows);
}
/**
 * Reads one `<BinCode>` element.
 *
 * The text is TRIMMED. `BinCodeContentType` is `xs:string` with `minLength=1`,
 * i.e. whiteSpace="preserve" [XSD-normativ], so this is a deliberate boundary
 * decision, not a schema reading: XML pretty-printers indent element content,
 * and this parser must not turn a re-indented file into a token error. It cannot
 * hide a defect either - the three fixed-width grammars contain no whitespace at
 * all, so an INTERIOR space still fails the decoder, and for `Decimal`
 * surrounding whitespace is the grammar's own separator (footnote #1 in
 * REKON3 6.5.2 [A quote]) and trimming it changes nothing.
 * @param el   The `BinCode` element.
 * @param path Its structural path.
 * @returns The raw entry.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function parseBinCode(el, path) {
    return {
        tokens: el.text.trim(),
        x: intAttr(el, 'X', path),
        y: intAttr(el, 'Y', path),
        lid: el.attribute('LID'),
        number: intAttr(el, 'Number', path),
        path,
    };
}
/**
 * Builds the `Coordinate` payload: one `<BinCode>` per device, X and Y both
 * required [A quote via ASSUME-A A6.1], content exactly one token.
 *
 * Splits the entries three ways:
 *  - X/Y present -> converted to a serialization index and placed on the grid.
 *    An entry carrying BOTH X/Y and LID is placed by its X/Y: the coordinates
 *    are the [A]-quoted addressing mode and LID is the [C]-graded one, so where
 *    they coexist the quoted one wins.
 *  - LID only -> CANNOT be placed on a rectangular lattice at all, since no
 *    source defines any LID-to-coordinate resolution (ASSUME-A A6.3 [C]; REKON3
 *    9.3 explicitly grades the MEANING of LID as [Inferenz] while the attribute
 *    itself is [XSD-normativ]). Carried in `sparseBinCodes`, excluded from the
 *    grid, and named in one aggregated warning. PDF-VERIFY: A6.3 grade C
 *    (the 0225 LID/FID/TID prose).
 *  - neither -> a typed error: the entry names no device by any known means.
 *
 * `Number` is carried and IGNORED for placement (ASSUME-A A6.2 [C]: assumed an
 * informational enumeration order; no source shows it in use - REKON3 6.5.5
 * records that no official `Coordinate` example with `Number` exists anywhere).
 * PDF-VERIFY: A6.2 grade C (Figure A1-1c / the BinCodeType clause).
 * @param raws   The raw `BinCode` entries.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @param ctx    The parse context.
 * @returns The decoder payload plus the pre-decode sparse model.
 * @throws {E142ParseError} `E142_XML_BINCODE_SHAPE`.
 */
function buildCoordinatePayload(raws, header, dims, ctx) {
    const payload = [];
    const sparse = [];
    for (const raw of raws) {
        const entry = { code: raw.tokens };
        if (raw.x !== null) {
            entry.x = raw.x;
        }
        if (raw.y !== null) {
            entry.y = raw.y;
        }
        if (raw.lid !== null) {
            entry.lid = raw.lid;
        }
        if (raw.number !== null) {
            entry.number = raw.number;
        }
        sparse.push(entry);
        if (raw.x !== null && raw.y !== null) {
            const { serCol, serRow } = toSerializationIndex(raw.x, raw.y, header, dims);
            payload.push({ x: serCol, y: serRow, bin: raw.tokens });
        }
        else if (raw.lid !== null) {
            ctx.lidOnly.push(raw.lid);
        }
        else {
            throw new E142ParseError('E142_XML_BINCODE_SHAPE', raw.path, 'MapType="Coordinate" requires both X and Y on every BinCode ("The X and Y coordinates must '
                + 'both be included" [A quote, REKON3 6.5.2]); this element carries '
                + `${raw.x !== null ? 'X but no Y' : raw.y !== null ? 'Y but no X' : 'neither'}, and no LID `
                + 'either, so it names no device.');
        }
    }
    return { payload, sparse };
}
/**
 * Builds the `Row/Column` payload: each `<BinCode>` is a RUN starting at its
 * (X, Y) and filling consecutive cells in the LOGICAL +X direction; its length
 * is its token count.
 *
 * GRADE [C+] - the shape is ASSUME-A A5, whose whole basis is the prose fragment
 * "Alternatively, a starting XY coordinate and length may be specified"
 * [A quote, REKON3 6.5.2] plus the `BinCodeType` attribute inventory plus the
 * absence of any `Length` attribute in any revision; REKON3 6.5.5 records that
 * NO complete official Row/Column example exists in any public source. The
 * SEMANTICS live behind one seam in E142Bins (`decodeRowColumnRuns`); this
 * function's only share of the assumption is that the start coordinate is
 * LOGICAL (A5.1) - hence the conversion - and that the fill direction needs
 * {@link logicalXStep}, because converting a start POINT does not carry a
 * DIRECTION.
 * PDF-VERIFY: A5 grade C+ (Figure A1-1a "Row/Column Format" + any worked example).
 * @param raws   The raw `BinCode` entries.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @returns The decoder payload.
 * @throws {E142ParseError} `E142_XML_BINCODE_SHAPE` when a run carries no start.
 */
function buildRowColumnPayload(raws, header, dims) {
    const runs = [];
    for (const raw of raws) {
        if (raw.x === null || raw.y === null) {
            throw new E142ParseError('E142_XML_BINCODE_SHAPE', raw.path, 'MapType="Row/Column" needs a starting X and Y on every BinCode (ASSUME-A A5.1/A5.2 [C+], '
                + 'from "a starting XY coordinate and length may be specified" [A quote, REKON3 6.5.2]); this '
                + `element carries ${raw.x !== null ? 'X but no Y' : raw.y !== null ? 'Y but no X' : 'neither'}. `
                + 'A LID is no substitute: no source defines a LID-to-coordinate resolution (A6.3 [C]), and a '
                + 'run without a start has nowhere to begin.');
        }
        const { serCol, serRow } = toSerializationIndex(raw.x, raw.y, header, dims);
        runs.push({ x: serCol, y: serRow, tokens: raw.tokens });
    }
    return runs;
}
/**
 * Reads one `<BinCodeMap>` into the overlay's meta, definitions, decoded payload
 * and - for `Coordinate` - its pre-decode sparse model.
 *
 * ---- The MapType default ----
 * The attribute is `use="optional"` with NO `default=` in ANY inspected revision
 * [XSD-normativ, REKON3 6.5.1], while the standard's prose says "If omitted the
 * default value is '2DArray'" [A quote, REKON3 6.5.2]. That is a documented
 * PROSE-vs-SCHEMA DIVERGENCE (REKON3 6.7 lists it as contradiction #2): a
 * schema-only reader sees an absent attribute and defaults nothing, so the
 * default MUST be applied APPLICATION-SIDE - here. The official
 * `BinCodeMap-Example.xml` depends on it (it omits `MapType` entirely and
 * serializes one row per element, REKON3 7.3). The MODEL keeps the document's
 * own value, i.e. `binCodeMapMeta.mapType` stays undefined for an absent
 * attribute, so a consumer can still tell "omitted" from "explicitly 2DArray";
 * only the decode uses {@link E142_DEFAULT_MAP_TYPE}.
 *
 * ---- Dispatch ----
 * By the RESOLVED MapType and never by inspecting the payload's shape: the
 * declared type is the document's statement of intent, and guessing from shape
 * is how a single-line `2DArray` silently becomes an `Array` (REKON3 7.7.3's
 * CSDN document is exactly that trap - see {@link resolveSerializationDims}).
 * @param el     The `BinCodeMap` element.
 * @param path   Its structural path.
 * @param header The owning map's header.
 * @param layout The resolved layout, or null when layoutless.
 * @param ctx    The parse context.
 * @returns The overlay fields this element contributes.
 * @throws {E142ParseError} On any structural, shape or decode defect.
 */
function parseBinCodeMap(el, path, header, layout, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_BINCODEMAP);
    const binType = enumValue(requiredAttr(el, 'BinType', path).trim(), BIN_TYPES, 'BinType', path);
    const nullBin = requiredAttr(el, 'NullBin', path);
    const rawMapType = el.attribute('MapType');
    const mapType = rawMapType === null
        ? E142_DEFAULT_MAP_TYPE
        : enumValue(rawMapType.trim(), MAP_TYPES, 'MapType', path);
    const out = {
        binCodeMapMeta: rawMapType === null ? { binType, nullBin } : { binType, nullBin, mapType },
    };
    const defsEl = firstNamed(children, 'BinDefinitions');
    if (defsEl !== null) {
        const defsPath = childPath(path, 'BinDefinitions');
        const defs = childrenOf(defsEl, ctx, defsPath, KNOWN_BINDEFINITIONS);
        out.binDefinitions = defs.map((d, i) => parseBinDefinition(d, childPath(defsPath, 'BinDefinition', i), ctx));
    }
    const binCodeEls = allNamed(children, 'BinCode');
    if (binCodeEls.length === 0) {
        throw new E142ParseError('E142_XML_ELEMENT_MISSING', path, 'BinCodeMap has no <BinCode>; BinCodeMapType declares it minOccurs="1" maxOccurs="unbounded".');
    }
    const raws = binCodeEls.map((b, i) => parseBinCode(b, childPath(path, 'BinCode', i)));
    // (1) The declared lattice: the layout, through the A3 swap.
    let declared = null;
    if (layout !== null) {
        const mf = dimsInMapFrame(layout, header.orientation);
        declared = { cols: mf.cols, rows: mf.rows };
    }
    // (2) The observed lattice: 2DArray alone describes its own shape.
    let observed = null;
    if (mapType === '2DArray') {
        observed = {
            cols: countRowTokens(binType, raws[0].tokens, `BinCode[1] of ${path}`),
            rows: raws.length,
        };
    }
    const dims = resolveSerializationDims(observed, declared, mapType, header.orientation, path, ctx);
    // Shape the payload the way the declared MapType demands.
    let payload;
    let xStep;
    switch (mapType) {
        case '2DArray':
            payload = raws.map((r) => r.tokens);
            break;
        case 'Array':
            if (raws.length !== 1) {
                throw new E142ParseError('E142_XML_BINCODE_SHAPE', path, `MapType="Array" carries the whole map in ONE element ("a single BinCode object can include `
                    + `the entire array of bin codes in row major format starting at the top left" [A quote, `
                    + `REKON3 6.5.2]); this map has ${raws.length}. Concatenating them would be a guess about `
                    + `the intended order.`);
            }
            payload = raws[0].tokens;
            break;
        case 'Coordinate': {
            const built = buildCoordinatePayload(raws, header, dims, ctx);
            payload = built.payload;
            out.sparseBinCodes = built.sparse;
            break;
        }
        case 'Row/Column':
            payload = buildRowColumnPayload(raws, header, dims);
            xStep = logicalXStep(header.axisDirection);
            break;
        default: {
            const _never = mapType;
            return _never;
        }
    }
    try {
        out.payload = decodeBinPayload(xStep === undefined ? { binType, nullBin, mapType } : { binType, nullBin, mapType, xStep }, dims, payload);
    }
    catch (e) {
        if (e instanceof E142DecodeError) {
            // Translate, never leak: one error type reaches a caller of this
            // module. The original travels in `cause`, so the decoder's
            // serialization row/column survives without being re-modeled here.
            throw new E142ParseError('E142_XML_DECODE', path, `${e.code}: ${e.message}`
                + (e.row === undefined ? '' : ` [serialization row ${e.row}${e.col === undefined ? '' : `, column ${e.col}`}]`), e);
        }
        throw e;
    }
    return out;
}
/**
 * Reads one `<Overlay>`: its `ReferenceDevices` (carried along, decision E-7)
 * plus the map of the XSD's 4-way choice.
 *
 * DECISION E-6a: `DeviceIdMap`, `TransferMap` and `DeviceDataMap` are SKIPPED
 * with one aggregated warning. They carry no bin data - device serial numbers,
 * substrate-to-substrate transfers and E138 `ccs:PVSet` parameter payloads
 * respectively (REKON3 7.2/7.4/7.5) - and the engine has no model for them, so
 * reading them would be surface without a consumer. An overlay whose map is
 * skipped still exists in the model, with meta and payload absent, exactly like
 * the legal "declared overlay with no map yet" case REKON3 7.7.3 shows.
 *
 * A `TransferMap`'s ATTRIBUTES are still read - see {@link parseE142Xml} - for
 * the FromSubstrateMapRef keyref of REKON3 10: "skipped" means "not modeled",
 * not "not looked at", and a dangling reference makes a document invalid whether
 * or not this reader renders the element it hangs off.
 * @param el     The `Overlay` element.
 * @param path   Its structural path.
 * @param header The owning map's header.
 * @param layout The resolved layout, or null when layoutless.
 * @param ctx    The parse context.
 * @returns The overlay.
 * @throws {E142ParseError} On any structural, shape or decode defect.
 */
/**
 * Reads a `DeviceIdMap` overlay (`DeviceIdMapType`): a flat, SPARSE list of
 * `<Id>` elements. Each `<Id>` (`DeviceIdType`) is `xs:string` content (the
 * device identifier) plus optional `X`/`Y` (`xs:integer`) and `LID`
 * (`xs:string`) - structurally the sparse {@link parseBinCode} minus `Number`.
 *
 * Every entry is carried verbatim in {@link E142DeviceIdEntry}; the frame-aware
 * cell index (which entries land on which grid cell) is the control's job, since
 * it owns the grid dimensions and the OriginLocation x AxisDirection frame the
 * `X`/`Y` live in (A4.5/A6.1 [B]). LID-only and address-less entries are carried
 * too - they cannot be placed on the lattice without a LID resolution no source
 * defines (A6.3 [C]) - and the control reports how many were unplaceable.
 * @param el   The `DeviceIdMap` element.
 * @param path Its structural path.
 * @param ctx  The parse context (unknown/foreign-child bookkeeping).
 * @returns The `<Id>` entries in document order.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID` for a non-integer X/Y.
 */
function parseDeviceIdMap(el, path, ctx) {
    const ids = childrenOf(el, ctx, path, KNOWN_DEVICEIDMAP);
    const entries = [];
    for (let i = 0; i < ids.length; i++) {
        const idEl = ids[i];
        const p = childPath(path, 'Id', i);
        const entry = { deviceId: idEl.text.trim() };
        const x = intAttr(idEl, 'X', p);
        const y = intAttr(idEl, 'Y', p);
        const lid = idEl.attribute('LID');
        if (x !== null) {
            entry.x = x;
        }
        if (y !== null) {
            entry.y = y;
        }
        if (lid !== null) {
            entry.lid = lid;
        }
        entries.push(entry);
    }
    return entries;
}
function parseOverlay(el, path, header, layout, ctx) {
    const children = childrenOf(el, ctx, path, KNOWN_OVERLAY);
    const out = {
        mapName: requiredAttr(el, 'MapName', path),
        mapVersion: el.attribute('MapVersion') ?? '',
        referenceDevices: [],
    };
    const refsEl = firstNamed(children, 'ReferenceDevices');
    if (refsEl !== null) {
        const refsPath = childPath(path, 'ReferenceDevices');
        const refs = childrenOf(refsEl, ctx, refsPath, KNOWN_REFERENCEDEVICES);
        for (let i = 0; i < refs.length; i++) {
            out.referenceDevices.push(parseReferenceDevice(refs[i], childPath(refsPath, 'ReferenceDevice', i), ctx));
        }
    }
    for (const kind of SKIPPED_OVERLAY_KINDS) {
        const n = allNamed(children, kind).length;
        if (n > 0) {
            ctx.skipped.set(kind, (ctx.skipped.get(kind) ?? 0) + n);
        }
    }
    const bcm = firstNamed(children, 'BinCodeMap');
    if (bcm !== null) {
        Object.assign(out, parseBinCodeMap(bcm, childPath(path, 'BinCodeMap'), header, layout, ctx));
    }
    const dim = firstNamed(children, 'DeviceIdMap');
    if (dim !== null) {
        out.deviceIdEntries = parseDeviceIdMap(dim, childPath(path, 'DeviceIdMap'), ctx);
    }
    return out;
}
// ===================================================================
//  Identity constraints  (REKON3 10, XSD-normativ, identical in every revision)
// ===================================================================
/**
 * Same-namespace children with a given name, WITHOUT the bookkeeping of
 * {@link childrenOf} - so the integrity walk cannot double-count the foreign and
 * unknown elements the model walk already counts.
 * @param el   The parent element.
 * @param ns   The document namespace.
 * @param name The local name to collect.
 * @returns The matching children, in document order.
 */
function sameNsNamed(el, ns, name) {
    const out = [];
    for (const c of el.children) {
        if (c.namespaceUri === ns && c.localName === name) {
            out.push(c);
        }
    }
    return out;
}
/** Joins key fields into one comparable string; NUL cannot occur in XML text, so it cannot collide. */
function keyOf(...fields) {
    return fields.join('\u0000');
}
/** Renders a key back into something readable for a diagnostic. */
function showKey(...fields) {
    return fields.map((f) => JSON.stringify(f)).join(', ');
}
/**
 * Validates the six `xs:key` / `xs:keyref` identity constraints the schema
 * declares on `MapData` - LayoutKey, SubstrateKey, SubstrateMapKey, OverlayKey,
 * ChildLayoutRef and FromSubstrateMapRef - confirmed identical across V0211,
 * V0921, V0224 and V0125 (REKON3 10 [XSD-normativ]). Task O4 step 5 requires
 * them IN CODE, because this parser deliberately does not run an XSD validator:
 * the framework ships none, the schemas import SEMI E138 (V0921+), and a
 * validating reader would reject the very dialects and evolutions this parser
 * exists to tolerate. Referential integrity, however, is not a dialect question
 * - a duplicate LayoutId or a ChildLayout pointing at nothing has no defensible
 * reading - so these six are errors, not warnings.
 *
 * RAW VALUES, deliberately. Every id type derives from `xs:string`
 * (whiteSpace="preserve"), so the schema compares the padded value; this
 * function does too, and {@link trimId} only affects what the MODEL carries.
 * That way trimming can neither invent a collision ("A" vs "A ") nor mask one.
 *
 * TWO XSD 1.0 subtleties are honoured rather than "improved":
 *  - a keyref whose fields are not all present is NOT evaluated (spec 3.11.4),
 *    so a `ChildLayout` without `@LayoutId` (the attribute is optional!) and a
 *    `TransferMap` missing one of its three From* attributes are not violations;
 *  - a defaulted attribute contributes its DEFAULT to a key, which is why
 *    `OverlayKey` uses `@MapVersion ?? ''`.
 * The one place this walk is laxer than a validator: an absent `@LayoutSpecifier`
 * participates in SubstrateMapKey as '' rather than failing the key outright -
 * it is a required attribute, so a validator would already have rejected the
 * document over the attribute itself, and this reader tolerates it (see
 * {@link parseHeader}).
 * @param root The `MapData` element.
 * @param ctx  The parse context.
 * @throws {E142ParseError} `E142_XML_INTEGRITY` on any violation.
 */
function checkIdentityConstraints(root, ctx) {
    const ns = ctx.ns;
    const rootPath = '/MapData';
    // --- LayoutKey: unique @LayoutId over Layouts/Layout ---
    const layoutIds = new Set();
    const layoutsEl = sameNsNamed(root, ns, 'Layouts')[0];
    if (layoutsEl !== undefined) {
        const layoutsPath = childPath(rootPath, 'Layouts');
        const layouts = sameNsNamed(layoutsEl, ns, 'Layout');
        for (let i = 0; i < layouts.length; i++) {
            const path = childPath(layoutsPath, 'Layout', i);
            const id = requiredAttr(layouts[i], 'LayoutId', path);
            if (layoutIds.has(id)) {
                throw new E142ParseError('E142_XML_INTEGRITY', path, `Duplicate LayoutId ${JSON.stringify(id)}: the LayoutKey xs:key (selector `
                    + `sm:Layouts/sm:Layout, field @LayoutId) requires it to be unique across the document `
                    + `[XSD-normativ, REKON3 10]. With two layouts of one name, no LayoutSpecifier path `
                    + `through them has a defined meaning.`);
            }
            layoutIds.add(id);
        }
        // --- ChildLayoutRef: every ChildLayout/@LayoutId resolves to a Layout ---
        for (let i = 0; i < layouts.length; i++) {
            const path = childPath(layoutsPath, 'Layout', i);
            const container = sameNsNamed(layouts[i], ns, 'ChildLayouts')[0];
            if (container === undefined) {
                continue;
            }
            const cPath = childPath(path, 'ChildLayouts');
            const refs = sameNsNamed(container, ns, 'ChildLayout');
            for (let k = 0; k < refs.length; k++) {
                const ref = refs[k].attribute('LayoutId');
                if (ref === null) {
                    continue; // optional attribute; keyref not evaluated
                }
                if (!layoutIds.has(ref)) {
                    throw new E142ParseError('E142_XML_INTEGRITY', childPath(cPath, 'ChildLayout', k), `ChildLayout references LayoutId ${JSON.stringify(ref)}, which no <Layout> defines: `
                        + `the ChildLayoutRef xs:keyref (refer="LayoutKey") forbids it [XSD-normativ, `
                        + `REKON3 10].`);
                }
            }
        }
    }
    // --- SubstrateKey: unique (@SubstrateType, @SubstrateId) over Substrates/Substrate ---
    const substratesEl = sameNsNamed(root, ns, 'Substrates')[0];
    if (substratesEl !== undefined) {
        const substratesPath = childPath(rootPath, 'Substrates');
        const seen = new Set();
        const subs = sameNsNamed(substratesEl, ns, 'Substrate');
        for (let i = 0; i < subs.length; i++) {
            const path = childPath(substratesPath, 'Substrate', i);
            const type = requiredAttr(subs[i], 'SubstrateType', path);
            const id = requiredAttr(subs[i], 'SubstrateId', path);
            const key = keyOf(type, id);
            if (seen.has(key)) {
                throw new E142ParseError('E142_XML_INTEGRITY', path, `Duplicate Substrate (${showKey(type, id)}): the SubstrateKey xs:key (fields `
                    + `@SubstrateType + @SubstrateId) requires the pair to be unique [XSD-normativ, REKON3 10].`);
            }
            seen.add(key);
        }
    }
    // --- SubstrateMapKey + OverlayKey + FromSubstrateMapRef ---
    const mapsEl = sameNsNamed(root, ns, 'SubstrateMaps')[0];
    if (mapsEl === undefined) {
        return;
    }
    const mapsPath = childPath(rootPath, 'SubstrateMaps');
    const maps = sameNsNamed(mapsEl, ns, 'SubstrateMap');
    const mapKeys = new Set();
    for (let i = 0; i < maps.length; i++) {
        const path = childPath(mapsPath, 'SubstrateMap', i);
        const type = requiredAttr(maps[i], 'SubstrateType', path);
        const id = requiredAttr(maps[i], 'SubstrateId', path);
        const spec = maps[i].attribute('LayoutSpecifier') ?? '';
        const key = keyOf(type, id, spec);
        if (mapKeys.has(key)) {
            throw new E142ParseError('E142_XML_INTEGRITY', path, `Duplicate SubstrateMap (${showKey(type, id, spec)}): the SubstrateMapKey xs:key (fields `
                + `@SubstrateType + @SubstrateId + @LayoutSpecifier) requires the triple to be unique `
                + `[XSD-normativ, REKON3 10]. Several maps per substrate ARE legal - with different `
                + `LayoutSpecifiers (REKON3 7.7.3).`);
        }
        mapKeys.add(key);
        const overlayKeys = new Set();
        const overlays = sameNsNamed(maps[i], ns, 'Overlay');
        for (let k = 0; k < overlays.length; k++) {
            const oPath = childPath(path, 'Overlay', k);
            const name = requiredAttr(overlays[k], 'MapName', oPath);
            const version = overlays[k].attribute('MapVersion') ?? '';
            const oKey = keyOf(name, version);
            if (overlayKeys.has(oKey)) {
                throw new E142ParseError('E142_XML_INTEGRITY', oPath, `Duplicate Overlay (${showKey(name, version)}) inside one SubstrateMap: the OverlayKey `
                    + `xs:key (fields @MapName + @MapVersion) requires the pair to be unique per SubstrateMap `
                    + `[XSD-normativ, REKON3 10]. Note @MapVersion defaults to "" and its default counts.`);
            }
            overlayKeys.add(oKey);
        }
    }
    // Second pass: the keyref can only be checked once every key exists.
    for (let i = 0; i < maps.length; i++) {
        const path = childPath(mapsPath, 'SubstrateMap', i);
        const overlays = sameNsNamed(maps[i], ns, 'Overlay');
        for (let k = 0; k < overlays.length; k++) {
            const oPath = childPath(path, 'Overlay', k);
            const transfers = sameNsNamed(overlays[k], ns, 'TransferMap');
            for (let t = 0; t < transfers.length; t++) {
                const fromType = transfers[t].attribute('FromSubstrateType');
                const fromId = transfers[t].attribute('FromSubstrateId');
                const fromSpec = transfers[t].attribute('FromSubstrateLayoutSpecifier');
                if (fromType === null || fromId === null || fromSpec === null) {
                    continue; // incomplete field set; keyref not evaluated
                }
                if (!mapKeys.has(keyOf(fromType, fromId, fromSpec))) {
                    throw new E142ParseError('E142_XML_INTEGRITY', childPath(oPath, 'TransferMap', t), `TransferMap sources (${showKey(fromType, fromId, fromSpec)}), which no <SubstrateMap> `
                        + `in this document declares: the FromSubstrateMapRef xs:keyref (refer=`
                        + `"SubstrateMapKey") forbids it [XSD-normativ, REKON3 10]. This element's CONTENT is `
                        + `skipped by decision E-6a, but "skipped" is not "unread": a dangling reference `
                        + `invalidates the document regardless of what this engine renders.`);
                }
            }
        }
    }
}
// ===================================================================
//  Entry point
// ===================================================================
/**
 * Resolves one SubstrateMap's LayoutSpecifier, memoized per specifier string.
 *
 * A LayoutSpecifier that does not resolve is a WARNING and never an error - the
 * required add-on rule of task O4, and it is forced by the material rather than
 * chosen: `LayoutSpecifier` is the ONE cross-reference in the schema that has NO
 * `xs:keyref` behind it (REKON3 10 lists all six constraints; none covers it),
 * and SEMI's own `BinCodeMap-Example.xml` ships a specifier -
 * "WaferLayout/Devices" - that resolves to nothing, because the file has no
 * `<Layouts>` element at all. A reader that errors here cannot read the
 * standard's own example. The layoutless path (dims from the payload) takes over.
 *
 * The domain module distinguishes "head not found" (returns null) from "path
 * broken below the head" (returns a typed error); both are dangling specifiers
 * here and both take the same route. What does NOT: a UNIT error, which is a
 * defect in a layout the path DID reach ("Anything else: typed error",
 * ASSUME-A A8) and stays fatal.
 * @param doc  The partially built document (its `layouts` are read).
 * @param spec The specifier string.
 * @param path The owning SubstrateMap's structural path.
 * @param ctx  The parse context.
 * @param memo The per-call memo.
 * @returns The resolved layout, or null for the layoutless path.
 * @throws {E142ParseError} `E142_XML_LAYOUT_INVALID`.
 */
function resolveLayoutFor(doc, spec, path, ctx, memo) {
    if (memo.has(spec)) {
        return memo.get(spec) ?? null;
    }
    let out = null;
    if (spec !== '') {
        const resolved = resolveLayoutSpecifier(doc, spec);
        if (resolved instanceof E142Error) {
            if (resolved.code === 'E142_LAYOUT_PATH_BROKEN' || resolved.code === 'E142_LAYOUT_MISSING') {
                warnAt(ctx, 'E142_XML_LAYOUT_SPECIFIER_DANGLING', path, `LayoutSpecifier ${JSON.stringify(spec)} does not resolve (${resolved.message}). No `
                    + `xs:keyref covers LayoutSpecifier [XSD-normativ, REKON3 10] and SEMI's own `
                    + `BinCodeMap-Example.xml ships a dangling one, so this is a warning: the map falls back `
                    + `to the layoutless path (dims from the payload, no physical scale in the document).`);
            }
            else {
                throw new E142ParseError('E142_XML_LAYOUT_INVALID', path, resolved.message, resolved);
            }
        }
        else if (resolved === null) {
            warnAt(ctx, 'E142_XML_LAYOUT_SPECIFIER_DANGLING', path, `LayoutSpecifier ${JSON.stringify(spec)} names no <Layout> in this document; falling back to `
                + `the layoutless path (dims from the payload, no physical scale in the document). Legal and `
                + `expected: no xs:keyref covers LayoutSpecifier and the official BinCodeMap-Example.xml is `
                + `exactly this shape (REKON3 7.3).`);
        }
        else {
            adoptWarnings(ctx, resolved.warnings);
            out = resolved;
        }
    }
    memo.set(spec, out);
    return out;
}
/**
 * Appends the aggregated diagnostics - the four "one aggregated warning" rules
 * of task O4 - after the walk, so each names its full inventory instead of
 * firing once per element.
 * @param ctx The parse context.
 */
function emitAggregatedWarnings(ctx) {
    if (ctx.foreign.size > 0) {
        const parts = [];
        for (const [ns, n] of ctx.foreign) {
            parts.push(`${ns} (${n} element${n === 1 ? '' : 's'})`);
        }
        warnGlobal(ctx, 'E142_XML_FOREIGN_NAMESPACE_SKIPPED', `Ignored elements from ${ctx.foreign.size} foreign namespace${ctx.foreign.size === 1 ? '' : 's'}: `
            + `${parts.join('; ')}. This is SEMI's own extension mechanism (REKON3 7.6): a vendor schema `
            + `extends a base type via xsi:type and hangs its own elements under its own namespace, e.g. `
            + `urn:semi-org:xsd.E142-1.V0211.SubstrateMap_ACMEProductsInc. The base-schema content of the `
            + `document is unaffected and was read in full.`);
    }
    if (ctx.skipped.size > 0) {
        const parts = [];
        for (const [kind, n] of ctx.skipped) {
            parts.push(`${kind} x${n}`);
        }
        warnGlobal(ctx, 'E142_XML_OVERLAY_KIND_SKIPPED', `Skipped ${parts.join(', ')} (decision E-6a): this engine models bin data only. Those overlays `
            + `carry device ids, substrate-to-substrate transfers and E138 ccs:PVSet parameter sets `
            + `(REKON3 7.2/7.4/7.5) - the overlays themselves stay in the model, without meta or payload.`);
    }
    if (ctx.lidOnly.length > 0) {
        const shown = ctx.lidOnly.slice(0, 8).map((l) => JSON.stringify(l)).join(', ');
        warnGlobal(ctx, 'E142_XML_LID_ONLY_EXCLUDED', `${ctx.lidOnly.length} BinCode entr${ctx.lidOnly.length === 1 ? 'y carries' : 'ies carry'} a V0125 `
            + `LID but no X/Y and ${ctx.lidOnly.length === 1 ? 'was' : 'were'} EXCLUDED from the grid `
            + `(carried in the overlay's sparseBinCodes instead): ${shown}`
            + `${ctx.lidOnly.length > 8 ? `, ... (+${ctx.lidOnly.length - 8} more)` : ''}. No source defines a `
            + `LID-to-coordinate resolution - the attribute is [XSD-normativ] (REKON3 9.3) but its meaning is `
            + `[Inferenz], and ASSUME-A A6.3 grades this handling [C]. PDF-VERIFY: the 0225 LID/FID/TID prose.`);
    }
    if (ctx.unknown.size > 0) {
        const parts = [];
        for (const [where, n] of ctx.unknown) {
            parts.push(`${where} x${n}`);
        }
        warnGlobal(ctx, 'E142_XML_UNKNOWN_ELEMENT_SKIPPED', `Ignored ${ctx.unknown.size} element name${ctx.unknown.size === 1 ? '' : 's'} that no inspected `
            + `revision (V0211/V0921/V0224/V0125) declares in this position: ${parts.join(', ')}. Not an error `
            + `- a later revision may add elements, exactly as V0921 added DeviceDataMap (REKON3 9.1) - but in `
            + `the E142 namespace an unknown name is more often a typo than a new revision.`);
    }
}
/**
 * Collapses identical warnings, first occurrence wins.
 *
 * Warnings carry their structural path, so this only ever merges genuinely
 * identical statements - most often a tolerated unit spelling reported once per
 * coordinate pair by the layout resolver (a single DefaultUnits="microns" layout
 * yields one per LowerLeft/DeviceSize/StepSize). One warning per distinct fact
 * is what a caller can act on; the same sentence three times is noise.
 * @param warnings The raw warnings in walk order.
 * @returns The unique warnings, in first-seen order.
 */
function dedupeWarnings(warnings) {
    const seen = new Set();
    const out = [];
    for (const w of warnings) {
        if (!seen.has(w)) {
            seen.add(w);
            out.push(w);
        }
    }
    return out;
}
/**
 * Parses one SEMI E142.1 `MapData` document into the engine's
 * {@link E142Document} plus warnings. The entry point of the XML input path and
 * the only export a caller normally needs.
 *
 * ---- What it accepts ----
 *  - NAMESPACE: `urn:semi-org:xsd.E142-1.V####.SubstrateMap` for every version
 *    with public evidence - V0105, V0805, V1005, V0211, V0921, V0224, V0125
 *    (REKON3 8) - and, with one warning, for any other V#### (the data model has
 *    been byte-identical across every inspected revision, REKON3 9.4). The
 *    version is recorded in {@link E142Document.schemaVersion}. Anything that is
 *    not an E142.1 SubstrateMap namespace is a typed error.
 *  - DIALECTS: header data as attributes or as child elements, attribute wins
 *    (task O4 step 3); `TopLevel="True"`; `X=""`; whitespace-padded ids; ids over
 *    their `maxLength`; unknown SubstrateType values; xsi:type extensions with
 *    foreign-namespace children; layoutless documents; overlays with no map.
 *    Each of these is warned about, none is repaired silently.
 *  - MULTI-OVERLAY: every overlay of every SubstrateMap is parsed and decoded.
 *    Which one to SHOW is the control's decision, not this parser's: no schema
 *    revision defines a default overlay (REKON3 10 shows OverlayKey enforcing
 *    uniqueness and nothing else), so a parser that picked one would be
 *    inventing a convention and hiding the others behind it.
 *
 * ---- What it refuses ----
 * Malformed XML, a non-E142 root, an XSD identity-constraint violation
 * (REKON3 10), a payload the decoder rejects, a lattice that cannot be
 * determined, and any attribute whose lexical form contradicts its XSD type.
 * A truncated document above all: it becomes `E142_XML_MALFORMED` and never a
 * short map.
 *
 * ---- Order of work ----
 * Identity constraints run BEFORE the model walk, over the raw tree: a document
 * with two layouts of one id has no defined meaning, and finding that out after
 * decoding 360 000 cells would be a waste and, worse, would report the wrong
 * defect first.
 * @param xml     The document text.
 * @param options Optional injection point for the XML provider; see
 *                {@link E142XmlParseOptions}.
 * @returns The document model and the warnings.
 * @throws {E142ParseError} Always this type and no other.
 */
export function parseE142Xml(xml, options) {
    const provider = (options && options.parseDocument) || domParseDocument;
    let root;
    try {
        root = provider(xml);
    }
    catch (e) {
        throw new E142ParseError('E142_XML_MALFORMED', '/', `The document is not well-formed XML: ${e instanceof Error ? e.message : String(e)}. A `
            + `truncated or malformed file is refused outright - a partially read map would render as a `
            + `complete, smaller one.`, e);
    }
    if (root === null || typeof root !== 'object' || typeof root.localName !== 'string') {
        throw new E142ParseError('E142_XML_MALFORMED', '/', 'The XML provider returned no document element.');
    }
    if (root.localName !== 'MapData') {
        throw new E142ParseError('E142_XML_NOT_E142', `/${root.localName}`, `The document element is <${root.localName}>; E142.1 declares exactly one global element, `
            + `<MapData> of type MapDataType [XSD-normativ, REKON3 8.2].`);
    }
    const match = E142_NAMESPACE_PATTERN.exec(root.namespaceUri);
    if (match === null) {
        throw new E142ParseError('E142_XML_NOT_E142', '/MapData', `The document element's namespace is ${JSON.stringify(root.namespaceUri)}; an E142.1 SubstrateMap `
            + `document is in urn:semi-org:xsd.E142-1.V####.SubstrateMap (REKON3 8). Note the schemas set `
            + `elementFormDefault="qualified", so an unqualified <MapData> is not an E142 document either.`);
    }
    const schemaVersion = match[1];
    const ctx = {
        ns: root.namespaceUri,
        warnings: [],
        foreign: new Map(),
        skipped: new Map(),
        lidOnly: [],
        unknown: new Map(),
    };
    if (E142_KNOWN_SCHEMA_VERSIONS.indexOf(schemaVersion) === -1) {
        warnGlobal(ctx, 'E142_XML_NAMESPACE_VERSION_UNKNOWN', `Namespace version ${schemaVersion} is not one of the versions with public evidence `
            + `(${E142_KNOWN_SCHEMA_VERSIONS.join(', ')}; REKON3 8). Parsed anyway with the V0125 model: the `
            + `data model this engine reads is byte-identical across every inspected revision (REKON3 9.4), `
            + `so a newer revision is far more likely to be readable than not. Anything it added beyond the `
            + `V0125 model will surface as an unknown-element warning.`);
    }
    // Identity first - see the banner above.
    checkIdentityConstraints(root, ctx);
    const rootPath = '/MapData';
    const rootChildren = childrenOf(root, ctx, rootPath, KNOWN_MAPDATA);
    const layouts = [];
    const layoutsEl = firstNamed(rootChildren, 'Layouts');
    if (layoutsEl !== null) {
        const layoutsPath = childPath(rootPath, 'Layouts');
        const els = childrenOf(layoutsEl, ctx, layoutsPath, KNOWN_LAYOUTS);
        for (let i = 0; i < els.length; i++) {
            layouts.push(parseLayout(els[i], childPath(layoutsPath, 'Layout', i), ctx));
        }
    }
    const substrates = [];
    const substratesEl = firstNamed(rootChildren, 'Substrates');
    if (substratesEl !== null) {
        const substratesPath = childPath(rootPath, 'Substrates');
        const els = childrenOf(substratesEl, ctx, substratesPath, KNOWN_SUBSTRATES);
        for (let i = 0; i < els.length; i++) {
            substrates.push(parseSubstrate(els[i], childPath(substratesPath, 'Substrate', i), ctx));
        }
    }
    const doc = {
        layouts,
        substrates,
        substrateMaps: [],
        namespaceUri: root.namespaceUri,
        schemaVersion,
    };
    const mapsEl = firstNamed(rootChildren, 'SubstrateMaps');
    if (mapsEl !== null) {
        const mapsPath = childPath(rootPath, 'SubstrateMaps');
        const els = childrenOf(mapsEl, ctx, mapsPath, KNOWN_SUBSTRATEMAPS);
        const memo = new Map();
        for (let i = 0; i < els.length; i++) {
            const path = childPath(mapsPath, 'SubstrateMap', i);
            const header = parseHeader(els[i], path, ctx);
            const overlayEls = childrenOf(els[i], ctx, path, KNOWN_SUBSTRATEMAP)
                .filter((c) => c.localName === 'Overlay');
            // Resolved lazily and once per specifier: a map with no bin data
            // (REKON3 7.7.3's "declared overlay with no map yet") must not be
            // told its layout dangles - nothing asked.
            let layout = null;
            let resolvedLayout = false;
            const overlays = [];
            for (let k = 0; k < overlayEls.length; k++) {
                if (!resolvedLayout && sameNsNamed(overlayEls[k], ctx.ns, 'BinCodeMap').length > 0) {
                    layout = resolveLayoutFor(doc, header.layoutSpecifier, path, ctx, memo);
                    resolvedLayout = true;
                }
                overlays.push(parseOverlay(overlayEls[k], childPath(path, 'Overlay', k), header, layout, ctx));
            }
            doc.substrateMaps.push({ header, overlays });
        }
    }
    emitAggregatedWarnings(ctx);
    return { doc, warnings: dedupeWarnings(ctx.warnings) };
}
// ===================================================================
//  Serialization: GridModel -> E142 MapData XML (decision E-4, export path)
// ===================================================================
/** The V0125 SubstrateMap namespace this serializer emits (the parser is namespace-tolerant). */
const E142_V0125_NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
/** Escapes text content for XML (`&`, `<`, `>`). */
function xmlText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Escapes an attribute value for XML (text set plus the double quote). */
function xmlAttr(s) {
    return xmlText(s).replace(/"/g, '&quot;');
}
/**
 * Serialises a built {@link GridModel} back to an E142 `MapData` XML document -
 * the inverse of {@link parseE142Xml} (decision E-4 was import-only; this adds
 * the export path). Round-trips: feeding the result back through
 * {@link parseE142Xml} (with any conforming DOM) reproduces the same cells.
 *
 * The emitted document is the canonical minimal form the parser accepts: one
 * top-level `Layout` (Dimension + StepSize, `DefaultUnits="mm"`, pitch from the
 * model's placement step magnitudes) and one `SubstrateMap` carrying one
 * `Overlay`/`BinCodeMap`. The header frame and orientation are attributes on
 * `SubstrateMap` (the XSD-normative form the parser's `dialectValue` reads);
 * `orientation` is the SOURCE map's, since the control's `E142OrientationOffset`
 * is a display correction (see {@link gridToGridData}).
 *
 * PAYLOAD FORM (identical rationale to {@link gridToGridData}): `Ascii` emits the
 * compact `2DArray` - one `<BinCode>` per full row of single-character tokens.
 * Numeric encodings emit the sparse `Coordinate` form - one `<BinCode X="" Y="">`
 * per non-null cell carrying the EXACT canonical token - which round-trips every
 * BinType without depending on fixed-width concatenation.
 * PDF-VERIFY: none - the inverse of an existing contract; the frame it
 * round-trips through is the parser's own A2/A4 frame.
 *
 * @param grid The built grid (its `placement` supplies the pitch).
 * @param opts The non-geometric fields a GridModel does not carry.
 * @returns A well-formed E142 `MapData` XML string.
 */
export function gridToE142Xml(grid, opts) {
    const { cols, rows, cells, binTable, placement } = grid;
    const nullToken = binTable.length > 0 ? binTable[0].code : '';
    const stepXmm = Math.hypot(placement.colStepXmm, placement.colStepYmm);
    const stepYmm = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
    const substrateType = (opts.substrateType && opts.substrateType !== '') ? opts.substrateType : 'Wafer';
    const substrateId = opts.substrateId ?? '';
    const mapName = opts.mapName ?? 'Map';
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push(`<MapData xmlns="${E142_V0125_NS}">`);
    L.push('  <Layouts>');
    L.push('    <Layout LayoutId="L0" DefaultUnits="mm" TopLevel="true">');
    L.push(`      <Dimension X="${cols}" Y="${rows}"/>`);
    L.push(`      <StepSize X="${stepXmm}" Y="${stepYmm}" Units="mm"/>`);
    L.push('    </Layout>');
    L.push('  </Layouts>');
    L.push('  <SubstrateMaps>');
    L.push(`    <SubstrateMap SubstrateType="${xmlAttr(substrateType)}" SubstrateId="${xmlAttr(substrateId)}"`
        + ` LayoutSpecifier="L0" Orientation="${opts.orientation}"`
        + ` OriginLocation="${opts.originLocation}" AxisDirection="${opts.axisDirection}">`);
    L.push(`      <Overlay MapName="${xmlAttr(mapName)}">`);
    const isCoord = opts.binType !== 'Ascii';
    L.push(`        <BinCodeMap BinType="${opts.binType}" NullBin="${xmlAttr(nullToken)}" MapType="${isCoord ? 'Coordinate' : '2DArray'}">`);
    if (opts.binDefinitions && opts.binDefinitions.length > 0) {
        L.push('          <BinDefinitions>');
        for (const d of opts.binDefinitions) {
            let a = `BinCode="${xmlAttr(d.binCode)}"`;
            if (d.binQuality !== '') {
                a += ` BinQuality="${xmlAttr(d.binQuality)}"`;
            }
            if (d.binDescription !== '') {
                a += ` BinDescription="${xmlAttr(d.binDescription)}"`;
            }
            if (d.binCount !== undefined) {
                a += ` BinCount="${d.binCount}"`;
            }
            if (d.pick) {
                a += ' Pick="true"';
            }
            L.push(`            <BinDefinition ${a}/>`);
        }
        L.push('          </BinDefinitions>');
    }
    if (isCoord) {
        for (let serRow = 0; serRow < rows; serRow++) {
            for (let serCol = 0; serCol < cols; serCol++) {
                const idx = cells[serRow * cols + serCol];
                if (idx === 0) {
                    continue;
                }
                const { x, y } = indexToMapCoord(serCol, serRow, opts.originLocation, opts.axisDirection, cols, rows);
                L.push(`          <BinCode X="${x}" Y="${y}">${xmlText(binTable[idx].code)}</BinCode>`);
            }
        }
    }
    else {
        for (let r = 0; r < rows; r++) {
            let s = '';
            for (let c = 0; c < cols; c++) {
                s += binTable[cells[r * cols + c]].code;
            }
            L.push(`          <BinCode>${xmlText(s)}</BinCode>`);
        }
    }
    L.push('        </BinCodeMap>');
    L.push('      </Overlay>');
    L.push('    </SubstrateMap>');
    L.push('  </SubstrateMaps>');
    L.push('</MapData>');
    return L.join('\n');
}
/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
 * @param root     The root object to hang the namespace off.
 * @param segments The namespace path.
 * @returns The namespace object.
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
const e142XmlNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Xml');
e142XmlNamespace['E142ParseError'] ??= E142ParseError;
e142XmlNamespace['parseE142Xml'] ??= parseE142Xml;
e142XmlNamespace['E142_KNOWN_SCHEMA_VERSIONS'] ??= E142_KNOWN_SCHEMA_VERSIONS;
//# sourceMappingURL=E142Xml.js.map