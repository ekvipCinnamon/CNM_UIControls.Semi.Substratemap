/**
 * @fileoverview
 * E142Xml - the SEMI E142.1 XML input path of the SubstrateMapEngine: it turns
 * one `MapData` document into the engine's plain-data {@link E142Document} plus
 * a list of warnings, and nothing else.
 *
 * LAYERING. EXACTLY ONE thin extraction layer touches the DOM -
 * {@link domParseDocument} and the adapter behind it - and it is INJECTABLE:
 * everything downstream is coded against {@link E142XmlElement}, a four-member
 * interface offering element, attribute and text lookup and nothing more. Node
 * tests drive the whole parser through a stub implementation of that interface,
 * so the semantics are testable without a DOM and
 * a DOM quirk can never leak into the model. The interface is deliberately
 * READ-ONLY and NAMESPACE-AWARE: those are the only two DOM properties the E142
 * dialects actually need.
 *
 * DIVISION OF LABOUR with the two modules this file builds on:
 *  - E142.ts (domain) owns the LOGICAL FRAME and the layout tree: this file
 *    calls {@link resolveLayoutSpecifier}, {@link dimsInMapFrame},
 *    {@link mapCoordToIndex} and {@link logicalXStep} and re-derives none of
 *    their rules. Every X/Y this file reads out of a document is a LOGICAL
 *    coordinate (ReferenceDevice/Coordinates, Coordinate
 *    map X/Y and Row/Column start X/Y all live in the OriginLocation x
 *    AxisDirection frame); every X/Y it hands downstream is a SERIALIZATION
 *    index, converted in exactly one place ({@link toSerializationIndex}).
 *  - E142Bins.ts (decoder) owns the TOKEN GRAMMAR: this file extracts the raw
 *    row strings / sparse entries and calls {@link decodeBinPayload}. It
 *    contains no tokenizer - not even for the layoutless width measurement,
 *    which is {@link countRowTokens}, the decoder's own scanner.
 *
 * WHAT THIS FILE OWNS: namespace and version acceptance, the attribute-vs-child
 * dialects, the XSD identity constraints, the application-level
 * MapType default, the overlay-kind skip list, LID handling, and the resolution
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
 * PROVENANCE. Where a comment states a rule it also says where the rule comes
 * from: quoted from SEMI E142-0225, declared by the XSD, or inferred. An inferred
 * rule says so and gives its reasoning, so a reader can check it against the
 * standard rather than take it on trust.
 * Every rule below names its source, and an assumption that has not yet been
 * checked against the published standard says so and names what in the
 * standard would settle it.
 *
 * MODULE MECHANISM: authored as an ES module, linked with `.js`
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

import {
    E142_DEFAULT_MAP_TYPE,
    E142Error,
    countEngineParse, // dev instrumentation - REMOVABLE
    dimsInMapFrame,
    mapFrameSwapsAxes,
    positiveXY,
    indexToMapCoord,
    logicalXStep,
    mapCoordToIndex,
    resolveLayoutSpecifier,
    type E142AxisDirection,
    type E142BinCodeMapMeta,
    type E142BinDefinition,
    type E142BinType,
    type E142DeviceIdEntry,
    type E142Transfer,
    type E142TransferMap,
    type E142Parameter,
    type E142DeviceData,
    type E142DeviceDataMap,
    type E142Document,
    type E142Layout,
    type E142LogicalCoordinates,
    type E142MapType,
    type E142OriginLocation,
    type E142Overlay,
    type E142PhysicalCoordinates,
    type E142ReferenceDevice,
    type E142SparseBinCode,
    type E142Substrate,
    type E142SubstrateMapHeader,
    type E142SubstrateSide,
    type E142AliasId,
    type E142SubstrateTypeToken,
    type E142Warning,
    type E142ZDimensions,
    type ResolvedLayout,
    buildLogicalTable,
} from './E142.js';
import { E138_NS, parsePvSet, type PvValue } from './E138Pv.js';
import {
    countRowTokens, decodeBinPayload, encodePayloadRows, tokenSeparator, type E142BinPayload,
    type E142BinRun, type E142CoordinateEntry, type E142Dimension, E142DecodeError,
} from './E142Bins.js';
import type { GridModel } from './Engine.js';

// ===================================================================
//  The injectable document interface (the ONE DOM seam)
// ===================================================================

/**
 * The minimal read-only view of an XML element this parser is coded against -
 * the whole DOM seam, and the only thing a node test has to
 * stub. Four members: what the element is called, which namespace it is in, its
 * element children, its text, and its attributes.
 *
 * Deliberately absent: parents, siblings, node types, mixed-content walking,
 * namespace-prefix resolution and every mutator. The E142 dialects need none of
 * them, and each one would be another DOM behavior a stub could get subtly
 * wrong.
 */
export interface E142XmlElement {
    /**
     * The element's local name with any namespace prefix stripped, e.g.
     * 'SubstrateMap' for `<sm:SubstrateMap>`.
     */
    readonly localName: string;
    /**
     * The element's namespace URI, or '' for an element in no namespace. Never
     * null, so implementations cannot disagree about null-vs-empty.
     */
    readonly namespaceUri: string;
    /**
     * The element's ELEMENT children in document order. Text, comments and
     * processing instructions are not children here - E142 has no mixed content.
     */
    readonly children: readonly E142XmlElement[];
    /**
     * The element's character data, descendants included (DOM `textContent`).
     * This parser reads it on leaf elements only - `<BinCode>`, `<LotId>`,
     * `<GoodDevices>` and friends - where "descendants included" cannot differ
     * from "own text".
     */
    readonly text: string;
    /**
     * An attribute's value, or null when the attribute is absent.
     *
     * Every E142 attribute is UNQUALIFIED: all inspected revisions leave
     * `attributeFormDefault` at its default while setting
     * The XSD sets `elementFormDefault="qualified"`, so `attribute('X')` -
     * with `namespaceUri` omitted - is the normal call. The parameter exists for
     * the one qualified attribute the extension mechanism puts on E142 elements,
     * `xsi:type`.
     * @param localName    The attribute's local name.
     * @param namespaceUri The attribute's namespace, or '' / omitted for an
     *                     unqualified attribute.
     * @returns The attribute value, or null when absent.
     */
    attribute(localName: string, namespaceUri?: string): string | null;
}

/**
 * Turns XML text into the root {@link E142XmlElement}. THROWS on anything that
 * is not well-formed - a truncated document above all ({@link parseE142Xml}
 * translates that throw into a typed {@link E142ParseError}, so a truncated file
 * can never become a silently shortened map).
 */
export type E142XmlDocumentParser = (xml: string) => E142XmlElement;

/** Options of {@link parseE142Xml}. */
export interface E142XmlParseOptions {
    /**
     * The XML text -> element-tree provider. Defaults to {@link domParseDocument}
     * (the platform `DOMParser`). A node test injects a stub here; so may an
     * embedder that already holds a parsed tree in another shape.
     */
    readonly parseDocument?: E142XmlDocumentParser;
}

/** The result of {@link parseE142Xml}. */
export interface E142XmlParseResult {
    /** The decoded, DOM-free document model. */
    doc: E142Document;
    /**
     * Non-fatal diagnostics, each formatted `CODE: message` or
     * `CODE at /structural/path: message` and each unique (repeats of an
     * identical message are collapsed; the aggregated diagnostics named in the
     * task - foreign namespaces, skipped overlay kinds, LID-only entries - are
     * emitted once with their full inventory). Callers log these; the engine
     * layer never touches a console.
     */
    warnings: string[];
}

// ===================================================================
//  Typed error
// ===================================================================

/**
 * Discriminator of {@link E142ParseError}. Stable and machine-readable; the
 * human detail lives in the message and the location in
 * {@link E142ParseError.path}.
 */
export type E142ParseErrorCode =
    /** The XML is not well-formed (truncated, mismatched, unparsable). */
    | 'E142_XML_MALFORMED'
    /** The document element is not `MapData`, or its namespace is not an E142.1 SubstrateMap namespace. */
    | 'E142_XML_NOT_E142'
    /** An attribute the XSD declares `use="required"` is missing. */
    | 'E142_XML_ATTR_MISSING'
    /** An attribute's lexical form does not match its XSD type (integer, double, boolean, enumeration). */
    | 'E142_XML_ATTR_INVALID'
    /** An element the XSD declares with `minOccurs >= 1` is missing. */
    | 'E142_XML_ELEMENT_MISSING'
    /** An XSD identity constraint is violated: an `xs:key` duplicate or a dangling `xs:keyref`. */
    | 'E142_XML_INTEGRITY'
    /** The serialization lattice of a payload cannot be determined from the document. */
    | 'E142_XML_DIMS_UNKNOWN'
    /** The `BinCode` elements do not have the shape the (defaulted) `MapType` requires. */
    | 'E142_XML_BINCODE_SHAPE'
    /** A layout could not be resolved for a non-structural reason (an unknown unit above all). */
    | 'E142_XML_LAYOUT_INVALID'
    /** The payload was rejected by the decoder; `cause` carries the original E142DecodeError. */
    | 'E142_XML_DECODE';

/**
 * The one error this module throws. Carries a machine-readable {@link code}, the
 * STRUCTURAL PATH of the offending element (XPath-flavored, 1-based, e.g.
 * `/MapData/SubstrateMaps/SubstrateMap[1]/Overlay[2]/BinCodeMap`) and, for a
 * wrapped decode failure, the original error in {@link cause} - so a caller that
 * wants the decoder's serialization row/column can reach it without this module
 * re-inventing the fields.
 *
 * Nothing else escapes: DOM exceptions, decode errors and domain errors are all
 * translated, so `catch (e) { if (e instanceof E142ParseError)... }` is
 * exhaustive.
 */
export class E142ParseError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    public readonly code: E142ParseErrorCode;
    /** Structural path of the offending element, XPath-flavored and 1-based. */
    public readonly path: string;
    /** The wrapped original error, when this error translates one. */
    public readonly cause?: unknown;

    /**
     * @param code    The machine-readable discriminator.
     * @param path    Structural path of the offending element.
     * @param message Human-readable detail; should name the concrete values seen.
     * @param cause   The original error, when translating one.
     */
    public constructor(code: E142ParseErrorCode, path: string, message: string, cause?: unknown) {
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
 * `urn:semi-org:xsd.E142-1.V####.SubstrateMap`, as every published XSD declares. The
 * schema-file naming convention is the same token (`E142-1-V0125-Schema.xsd`).
 */
const E142_NAMESPACE_PATTERN = /^urn:semi-org:xsd\.E142-1\.(V\d{4})\.SubstrateMap$/;

/**
 * Every E142.1 namespace version with public evidence, in chronological order:
 * V0105 (E142.1-0305), V0805, V1005, V0211, V0921, V0224, V0125 (= E142-0225,
 * the target of this implementation). The last four are taken from official XSD
 * files; the first three are attested only by vendor example documents, which is
 * weaker evidence but enough to accept the namespace.
 *
 * Acceptance is by PATTERN, not by this list: a document in a well-formed E142.1
 * namespace whose version is not listed here still parses, with one warning.
 * The list only decides whether that warning fires. Every geometry attribute
 * this file reads is declared identically in all four official XSDs that were
 * compared - V0211, V0921, V0224 and V0125 - so a future revision is more likely
 * to be readable than not. Rejecting an unlisted version outright would also make
 * this parser stricter than the documents it will meet: the substrate types for
 * tape-and-reel, panel and PCB took years to reach the schema, and a reader that
 * refused each new namespace would have been wrong every time.
 */
export const E142_KNOWN_SCHEMA_VERSIONS: readonly string[] = [
    'V0105', 'V0805', 'V1005', 'V0211', 'V0921', 'V0224', 'V0125',
];

/** `MaterialIdType` maxLength, declared by the XSD; applies to SubstrateId and AliasId/@Value. */
const MATERIAL_ID_MAX_LENGTH = 32;

/** `LotIdType` maxLength, declared by the XSD; applies to LotId and CarrierId. */
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
class DomElement implements E142XmlElement {
    /** The wrapped DOM element. */
    private readonly el: Element;
    /** Memoized wrapper list, so a re-read of `children` does not re-allocate. */
    private wrapped: E142XmlElement[] | null = null;

    /** @param el The DOM element to wrap. */
    public constructor(el: Element) {
        this.el = el;
    }

    /** @inheritdoc */
    public get localName(): string {
        return this.el.localName;
    }

    /** @inheritdoc */
    public get namespaceUri(): string {
        return this.el.namespaceURI ?? '';
    }

    /** @inheritdoc */
    public get text(): string {
        return this.el.textContent ?? '';
    }

    /** @inheritdoc */
    public get children(): readonly E142XmlElement[] {
        if (this.wrapped === null) {
            const source = this.el.children;
            const out: E142XmlElement[] = new Array(source.length);
            for (let i = 0; i < source.length; i++) {
                out[i] = new DomElement(source[i]);
            }
            this.wrapped = out;
        }
        return this.wrapped;
    }

    /** @inheritdoc */
    public attribute(localName: string, namespaceUri?: string): string | null {
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
export function domParseDocument(xml: string): E142XmlElement {
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const root: Element | null = dom.documentElement;
    if (root === null) {
        throw new Error('DOMParser returned a document without a document element.');
    }
    if (root.localName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
        const detail = (root.textContent ?? '').trim().replace(/\s+/g, ' ');
        throw new Error(`DOMParser reported a parser error: ${detail.slice(0, 400)}`);
    }
    return new DomElement(root);
}

// ===================================================================
//  Warning sink + structural paths
// ===================================================================

/**
 * The mutable state of one {@link parseE142Xml} call: the document's namespace
 * plus the warning sink and the four aggregation buckets, each reported as one
 * aggregated warning.
 */
interface ParseContext {
    /** The document element's namespace; every element outside it is foreign. */
    readonly ns: string;
    /** Warnings in walk order; aggregates are appended at the end. */
    readonly warnings: string[];
    /** Foreign namespace -> number of skipped elements (aggregated). */
    readonly foreign: Map<string, number>;
    /** Skipped overlay kind -> count, aggregated into one warning per kind. */
    readonly skipped: Map<string, number>;
    /** LIDs of grid-less BinCode entries, aggregated into one warning. */
    readonly lidOnly: string[];
    /** `parentPath/elementName` of unknown same-namespace elements -> count (aggregated). */
    readonly unknown: Map<string, number>;
}

/**
 * Appends a warning bound to a structural path.
 * @param ctx     The parse context.
 * @param code    Stable machine code (the message's first token).
 * @param path    Structural path of the element the warning is about.
 * @param message Human-readable detail.
 */
function warnAt(ctx: ParseContext, code: string, path: string, message: string): void {
    ctx.warnings.push(`${code} at ${path}: ${message}`);
}

/**
 * Appends a document-level warning (no single element to point at).
 * @param ctx     The parse context.
 * @param code    Stable machine code (the message's first token).
 * @param message Human-readable detail.
 */
function warnGlobal(ctx: ParseContext, code: string, message: string): void {
    ctx.warnings.push(`${code}: ${message}`);
}

/**
 * Renders a domain-module {@link E142Warning} in this module's warning format,
 * so a caller sees one shape regardless of which layer produced a diagnostic.
 * @param ctx      The parse context.
 * @param warnings The domain warnings to adopt.
 */
function adoptWarnings(ctx: ParseContext, warnings: readonly E142Warning[]): void {
    for (const w of warnings) {
        ctx.warnings.push(`${w.code}: ${w.message}`);
    }
}

/**
 * A child path segment, XPath-flavored and 1-based (`.../Overlay[2]`). The
 * index is omitted for elements that occur at most once under their parent, so
 * paths stay readable.
 * @param parent Parent path.
 * @param name   Child element name.
 * @param index  0-based index among same-named siblings, or undefined for a singleton.
 * @returns The child's structural path.
 */
function childPath(parent: string, name: string, index?: number): string {
    return index === undefined ? `${parent}/${name}` : `${parent}/${name}[${index + 1}]`;
}

// ===================================================================
//  Element / attribute readers  (pure, over the injectable interface)
// ===================================================================

/**
 * The same-namespace element children of `el`, with the two tolerance rules of
 * the extension mechanism applied:
 *
 *  - FOREIGN NAMESPACE -> skipped and counted, never an error. This is the whole
 *    of SEMI's own extension mechanism as far as a reader is concerned: the
 *    official `BinCodeMap-Extension-Example.xml` hangs an
 *    `sme:SupplierData` subtree off `Substrate` under a company namespace
 *    (`...SubstrateMap_ACMEProductsInc`) and marks the element with `xsi:type`
 *    itself. A reader that does not know the
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
function childrenOf(
    el: E142XmlElement,
    ctx: ParseContext,
    path: string,
    known: ReadonlySet<string>,
): E142XmlElement[] {
    const out: E142XmlElement[] = [];
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
function firstNamed(children: readonly E142XmlElement[], name: string): E142XmlElement | null {
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
function allNamed(children: readonly E142XmlElement[], name: string): E142XmlElement[] {
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
function requiredAttr(el: E142XmlElement, name: string, path: string): string {
    const v = el.attribute(name);
    if (v === null) {
        throw new E142ParseError(
            'E142_XML_ATTR_MISSING',
            path,
            `Attribute @${name} is missing; every inspected XSD revision declares it use="required" on `
            + `<${el.localName}>.`,
        );
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
function intAttr(el: E142XmlElement, name: string, path: string): number | null {
    const raw = el.attribute(name);
    if (raw === null) {
        return null;
    }
    const text = raw.trim();
    if (!/^[+-]?\d+$/.test(text)) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `@${name}=${JSON.stringify(raw)} is not an xs:integer.`,
        );
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `@${name}=${JSON.stringify(raw)} is outside the safe integer range; xs:integer is unbounded, this `
            + `engine's grids are not.`,
        );
    }
    return value;
}

/**
 * An `xs:double` attribute, or null when absent.
 *
 * ONE tolerance, and it is a real-world one: an EMPTY value is treated as an
 * ABSENT one, with a warning. `<DeviceSize X="" Y="" />` appears verbatim in the
 * published reference strip map, where it plainly means "no device
 * size", and `xs:double` has no lexical form for that. The dangerous reading is
 * the arithmetic one: `Number('')` is 0, and a zero DeviceSize is not "unknown",
 * it is "devices of size zero" - a map that renders empty. Treating it as absent
 * instead lets the documented fallback apply (deviceSize falls back to stepSize,
 * INF/NaN are rejected: the XSD admits their lexical forms, no
 * E142 quantity has a meaning for them, and they would poison the placement.
 * @param el   The element.
 * @param name The attribute's local name.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @returns The value, or null when the attribute is absent or empty.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function doubleAttr(el: E142XmlElement, name: string, path: string, ctx: ParseContext): number | null {
    const raw = el.attribute(name);
    if (raw === null) {
        return null;
    }
    const text = raw.trim();
    if (text === '') {
        warnAt(
            ctx,
            'E142_XML_EMPTY_NUMBER',
            path,
            `@${name} is empty and is read as ABSENT, not as 0 (observed in the GitHub reference strip map, `
            + `for example <DeviceSize X="" Y="" />). xs:double has no lexical form for "unknown"; reading it `
            + `as 0 would silently produce zero-sized devices.`,
        );
        return null;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `@${name}=${JSON.stringify(raw)} is not a finite xs:double.`,
        );
    }
    return Number(text);
}

/**
 * An `xs:boolean` attribute, defaulted when absent.
 *
 * TOLERANCE, observed: `TopLevel="True"` appears in the GitHub reference strip
 * map and in the fixture derived from it, although `xs:boolean`
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
function boolAttr(el: E142XmlElement, name: string, path: string, ctx: ParseContext, dflt: boolean): boolean {
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
        warnAt(
            ctx,
            'E142_XML_BOOLEAN_DIALECT',
            path,
            `@${name}=${JSON.stringify(raw)} is not an xs:boolean literal (true/false/1/0) but its intent is `
            + `unambiguous; accepted as ${lower}. Observed in real documents.`,
        );
        return lower === 'true';
    }
    throw new E142ParseError(
        'E142_XML_ATTR_INVALID',
        path,
        `@${name}=${JSON.stringify(raw)} is not an xs:boolean (true/false/1/0).`,
    );
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
function enumValue<T extends string>(raw: string, allowed: readonly T[], name: string, path: string): T {
    if ((allowed as readonly string[]).indexOf(raw) === -1) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `@${name}=${JSON.stringify(raw)} is not a member of {${allowed.join(', ')}}.`,
        );
    }
    return raw as T;
}

/**
 * Trims an id and warns that it did so.
 *
 * Whitespace-padded ids are trimmed. Note this is a
 * deliberate, warned DEVIATION from the letter of the schema: every id type
 * derives from `xs:string`, whose `whiteSpace` facet is `preserve`, so
 * `"  PADDED01  "` is schema-legal AND schema-distinct from `"PADDED01"`. The
 * warning exists because trimming silently would leave an operator unable to
 * explain why the id in the map no longer matches the id in the MES. The
 * XSD identity constraints are checked on the RAW values regardless -
 * see {@link parseE142Xml} - so trimming cannot invent or hide a key collision.
 * @param raw  The raw attribute value.
 * @param what The attribute's name, for the message.
 * @param path The element's structural path.
 * @param ctx  The parse context.
 * @returns The trimmed id.
 */
function trimId(raw: string, what: string, path: string, ctx: ParseContext): string {
    const trimmed = raw.trim();
    if (trimmed !== raw) {
        warnAt(
            ctx,
            'E142_XML_ID_TRIMMED',
            path,
            `@${what}=${JSON.stringify(raw)} carries surrounding whitespace; the model carries `
            + `${JSON.stringify(trimmed)}. The XSD preserves it (xs:string, whiteSpace="preserve"), so the `
            + `identity constraints are still checked on the raw value.`,
        );
    }
    return trimmed;
}

/**
 * Warns when an id exceeds its XSD `maxLength` - as a warning and not an error,
 * because real files violate these limits and a length facet
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
/**
 * Reads a child element typed `xs:nonNegativeInteger`.
 *
 * WHY NON-NEGATIVE AND NOT POSITIVE. E142-0225 Table 6 gives `SlotNumber`,
 * `SubstrateNumber` and `GoodDevices` as "Positive Integer"
 * in E142-0225's own words, but the schema declares all three
 * `xs:nonNegativeInteger`. The standard disagrees with its own
 * XSD, and the XSD wins here: a parser must not reject a document that
 * `xmllint` accepts. `0` is admitted for all three - and slot 0 is a real slot
 * in plenty of carrier conventions, so this is not a theoretical case.
 *
 * WHY NOT `^\d+$`. That is the shape this file used for `GoodDevices`, and it
 * is narrower than the type: `xs:nonNegativeInteger` also admits a leading `+`,
 * leading zeros, and `-0`. All three are accepted by the schema - verified
 * against `E142-1-V0125-Schema.xsd` - so all three are accepted here.
 * `-1` and `3.0` are rejected, by the schema and by this function alike.
 *
 * Surrounding whitespace is collapsed before the test, as XSD does for a
 * numeric type's lexical space.
 *
 * @param el   The child element, already located.
 * @param name Its local name, for the message.
 * @param path The element's own structural path.
 * @returns The value, `>= 0`.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID` when the text is not in the
 *         type's lexical space or is negative.
 */
function nonNegativeIntegerValue(el: E142XmlElement, name: string, path: string): number {
    const text = el.text.trim();
    // Lexical space of xs:nonNegativeInteger: optional sign, then digits. The
    // sign is allowed to be '-' only for zero, which the value check below
    // enforces without a second pattern.
    if (!/^[+-]?\d+$/.test(text)) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `<${name}>${JSON.stringify(text)}</${name}> is not an xs:nonNegativeInteger.`,
        );
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            path,
            `<${name}>${JSON.stringify(text)}</${name}> is not an xs:nonNegativeInteger.`,
        );
    }
    // Number('-0') is -0, and Object.is(-0, 0) is false. Normalize, so a
    // consumer comparing against 0 is not surprised by a schema-valid input.
    return value === 0 ? 0 : value;
}

/**
 * Warns when an id is present but EMPTY.
 *
 * Three states are distinguishable in an E142 document and they are not the
 * same thing:
 *
 *   absent              `minOccurs="0"` - the producer says nothing
 *   present and empty   `<CarrierId></CarrierId>` - the producer says "" 
 *   present with value  the producer says something
 *
 * The XSD admits all three: none of `LotIdType` / `MaterialIdType` declares a
 * `minLength`. E142-0225 Table 6 does not - it states these ranges as "Text
 * 1-80 characters" (and Table 7 as "1-32" for `AliasId/@Value`)
 * in the standard's own words, and a range starting at 1 excludes the empty string.
 *
 * So a present-but-empty id is schema-valid and prose-invalid, and it carries no
 * information that "absent" does not already carry. It is NOT rejected - the
 * parser must not be stricter than the schema, and refusing a document xmllint
 * accepts would be exactly that - but it is worth saying out loud, because the
 * likeliest cause is a producer emitting an unset field rather than omitting it,
 * and a consumer reading `carrierId === ''` as a real carrier id will be wrong.
 *
 * @param raw   The raw text.
 * @param what  The field's name, for the message.
 * @param range The range the standard states, e.g. `"1-80"`.
 * @param table The table stating it, e.g. `"Table 6"`.
 * @param path  The element's structural path.
 * @param ctx   The parse context.
 */
function checkIdNotEmpty(
    raw: string,
    what: string,
    range: string,
    table: string,
    path: string,
    ctx: ParseContext,
): void {
    if (raw.trim() === '') {
        warnAt(
            ctx,
            'E142_XML_ID_EMPTY',
            path,
            `@${what} is present but empty. The XSD admits it (no minLength), but E142-0225 `
            + `${table} states the range as "Text ${range} characters", `
            + `which excludes the empty string. Treated as "no ${what}"; carried through unchanged.`,
        );
    }
}

function checkIdLength(
    raw: string,
    max: number,
    what: string,
    type: string,
    path: string,
    ctx: ParseContext,
): void {
    if (raw.length > max) {
        warnAt(
            ctx,
            'E142_XML_ID_TOO_LONG',
            path,
            `@${what} is ${raw.length} characters; the XSD declares ${type} with maxLength ${max}. `
            + 'Carried through unchanged.',
        );
    }
}

/**
 * Reads one datum that may arrive as an ATTRIBUTE or as a CHILD ELEMENT - the
 * dialect tolerance real documents need.
 *
 * Both spellings are attested for E142 header data: the schema puts
 * Orientation / OriginLocation / AxisDirection on `SubstrateMap` as attributes
 * and `LotId` under `Substrate` as an element, while the
 * real-world documents that were surveyed show the same information moving
 * between the two forms. Reading both costs one lookup and rescues documents no
 * dialect-blind reader could touch.
 *
 * CONFLICT RULE: the ATTRIBUTE wins, with a warning. Nothing in
 * the material ranks the two - the rule is a decision, and the warning is what
 * makes it a safe one, because the losing value is named in the diagnostic.
 * @param el       The element.
 * @param children Its accepted children.
 * @param name     The datum's name; identical in both spellings.
 * @param path     The element's structural path.
 * @param ctx      The parse context.
 * @returns The value, or null when neither spelling is present.
 */
function dialectValue(
    el: E142XmlElement,
    children: readonly E142XmlElement[],
    name: string,
    path: string,
    ctx: ParseContext,
): string | null {
    const fromAttr = el.attribute(name);
    const child = firstNamed(children, name);
    const fromChild = child === null ? null : child.text.trim();
    if (fromAttr !== null && fromChild !== null && fromAttr.trim() !== fromChild) {
        warnAt(
            ctx,
            'E142_XML_DIALECT_CONFLICT',
            path,
            `${name} is present both as an attribute (${JSON.stringify(fromAttr)}) and as a child element `
            + `(${JSON.stringify(fromChild)}); the attribute wins.`,
        );
    }
    return fromAttr !== null ? fromAttr : fromChild;
}

// ===================================================================
//  The element inventory of the V0125 model (= E142-0225)
//
//  One set per parent this parser walks, so an unknown name is DETECTED rather
//  than ignored. Members are the V0125 XSD's own child elements,
//  plus - where noted - the observed dialect spellings. Older revisions
//  are strict subsets, so one inventory serves every accepted
//  namespace: a V0211 document simply never uses the V0921/V0125 additions.
// ===================================================================

/** Children of `MapData`, per `MapDataType`. */
const KNOWN_MAPDATA = new Set(['Layouts', 'Substrates', 'SubstrateMaps']);
/** Children of `Layouts` / `ChildLayouts` / `Substrates` / `SubstrateMaps` (single-member containers). */
const KNOWN_LAYOUTS = new Set(['Layout']);
/** @see KNOWN_LAYOUTS */
const KNOWN_CHILDLAYOUTS = new Set(['ChildLayout']);
/** @see KNOWN_LAYOUTS */
const KNOWN_SUBSTRATES = new Set(['Substrate']);
/** @see KNOWN_LAYOUTS */
const KNOWN_SUBSTRATEMAPS = new Set(['SubstrateMap']);
/** Children of `AliasIds` (single-member container, `maxOccurs="unbounded"`). */
const KNOWN_ALIASIDS = new Set(['AliasId']);
/** Children of `Layout`, per `LayoutType`. */
const KNOWN_LAYOUT = new Set([
    'Dimension', 'LowerLeft', 'DeviceSize', 'StepSize', 'Z', 'TopImage', 'BottomImage', 'ProductId', 'ChildLayouts',
]);
/** Children of `Substrate`, per `SubstrateType`. */
const KNOWN_SUBSTRATE = new Set([
    'LotId', 'AliasIds', 'CarrierType', 'CarrierId', 'SlotNumber', 'SubstrateNumber', 'GoodDevices',
    'SupplierName', 'Status',
]);
/**
 * Children of `SubstrateMap`: `Overlay`, per `SubstrateMapType`, plus
 * the three header data observed spelled as elements, which the schema
 * declares as attributes.
 */
const KNOWN_SUBSTRATEMAP = new Set(['Overlay', 'Orientation', 'OriginLocation', 'AxisDirection']);
/** Children of `Overlay`, per `OverlayType`: `ReferenceDevices` plus a four-way choice. */
const KNOWN_OVERLAY = new Set(['ReferenceDevices', 'BinCodeMap', 'DeviceIdMap', 'TransferMap', 'DeviceDataMap']);
/** Children of `ReferenceDevices`, per the XSD. */
const KNOWN_REFERENCEDEVICES = new Set(['ReferenceDevice']);
/** Children of `ReferenceDevice`, per `ReferenceDeviceType`. */
const KNOWN_REFERENCEDEVICE = new Set(['Coordinates', 'Position']);
/** Children of `BinCodeMap`, per `BinCodeMapType`. */
const KNOWN_BINCODEMAP = new Set(['BinDefinitions', 'BinCode']);
/** Children of `DeviceIdMap`, per `DeviceIdMapType`: `<Id>` entries only. */
const KNOWN_DEVICEIDMAP = new Set(['Id']);
/**
 * Children of `TransferMap`. ONE member, and it is `T` - not `Transfer`.
 * `TransferMapType` declares `<xs:element name="T" type="sm:TransferType"
 * maxOccurs="unbounded"/>`. The TYPE is `TransferType` and
 * E142-0225's figures label the arrows `Transfer(...)`, so `Transfer` is the
 * natural guess; a parser making it finds no children and reports an EMPTY map
 * instead of failing, which is the failure mode worth naming here.
 */
const KNOWN_TRANSFERMAP = new Set(['T']);
/**
 * Children of `DeviceDataMap`. Both are `minOccurs="1" maxOccurs="unbounded"`
 * as the XSD declares.
 *
 * `PVSet` is deliberately NOT here: it is a child of `DeviceData`, and it lives
 * in the **E138** namespace, so `childrenOf` - which only returns
 * same-namespace children - would never hand it over anyway. It is resolved by
 * namespace, explicitly, in {@link parseDeviceDataMap}.
 */
const KNOWN_DEVICEDATAMAP = new Set(['Parameter', 'DeviceData']);
/** Children of `BinDefinitions`, per the XSD. */
const KNOWN_BINDEFINITIONS = new Set(['BinDefinition']);

/** `SubstrateTypeEnum` members of V0125; older revisions declare strict subsets. */
const SUBSTRATE_TYPES = ['Wafer', 'Frame', 'Strip', 'Tray', 'TnR', 'Panel', 'PCB'] as const;
/** `SubstrateSideEnum` members; unchanged across all revisions. */
const SUBSTRATE_SIDES: readonly E142SubstrateSide[] = ['TopSide', 'BottomSide'];
/** `OriginLocationEnum` members; unchanged across all revisions. */
const ORIGIN_LOCATIONS: readonly E142OriginLocation[] = [
    'LowerLeft', 'UpperLeft', 'LowerRight', 'UpperRight', 'Center',
];
/** `AxisDirectionEnum` members; unchanged across all revisions. */
const AXIS_DIRECTIONS: readonly E142AxisDirection[] = ['UpRight', 'DownRight', 'UpLeft', 'DownLeft'];
/** `BinTypeEnum` members; unchanged across all revisions (note the spelling HexaDecimal). */
const BIN_TYPES: readonly E142BinType[] = ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2'];
/** `MapTypeEnum` members; note the literal slash in `Row/Column`. */
const MAP_TYPES: readonly E142MapType[] = ['2DArray', 'Row/Column', 'Array', 'Coordinate'];

/**
 * The overlay kinds this parser recognizes but does not model, from
 * `OverlayType`'s choice. `DeviceIdMap` left this list once it was parsed
 * (see {@link parseDeviceIdMap}) for the cell -> device-id selection lookup.
 * `TransferMap` / `DeviceDataMap` remain skipped (DeviceDataMap needs the E138
 * `ccs:PVSet` payload, out of scope).
 */
/**
 * Overlay kinds recognized but not modeled, counted into one "skipped" report.
 *
 * EMPTY. Every overlay kind `OverlayType` declares is parsed. The constant and its
 * reporting stay because the NEXT revision of E142 will add a kind this parser
 * does not know, and an unknown same-namespace element is already counted by
 * `childrenOf` - this list is for kinds that are recognized but deliberately
 * unread, and there are none.
 */
const SKIPPED_OVERLAY_KINDS: readonly string[] = [];

// ===================================================================
//  Leaf parsers
// ===================================================================

/**
 * `LogicalCoordinatesType`: X and Y, both `use="required"` `xs:integer`
 * as the XSD declares.
 *
 * FRAME: as a `Dimension` these are counts; everywhere else - `ReferenceDevice/
 * Coordinates` above all - they are LOGICAL coordinates in the OriginLocation x
 * AxisDirection frame and may legitimately be negative. That is inferred from
 * the frame attributes rather than stated outright, and is supported by vendor
 * documentation observing that this "often results in negative index values". This
 * function neither interprets nor converts them.
 * @param el   The `LogicalCoordinatesType` element.
 * @param path Its structural path.
 * @returns The (x, y) pair.
 * @throws {E142ParseError} `E142_XML_ATTR_MISSING` / `E142_XML_ATTR_INVALID`.
 */
function parseLogicalCoordinates(el: E142XmlElement, path: string): E142LogicalCoordinates {
    // The presence check first, so an absent attribute reports as MISSING
    // rather than as an invalid lexical form; both reads then cannot be null,
    // which is what the two casts record.
    requiredAttr(el, 'X', path);
    requiredAttr(el, 'Y', path);
    const x = intAttr(el, 'X', path) as number;
    const y = intAttr(el, 'Y', path) as number;
    return { x, y };
}

/**
 * `PhysicalCoordinatesType`: X and Y (`use="required"` `xs:double`) plus an
 * optional `Units` token. Returns undefined when the element
 * carries no usable pair - see {@link doubleAttr} on the empty-value case.
 * Units are NOT resolved here: {@link resolveLayoutSpecifier} owns unit
 * resolution, including the DefaultUnits fallback.
 * @param el   The `PhysicalCoordinatesType` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The pair, or undefined when it carries no usable value.
 * @throws {E142ParseError} `E142_XML_ATTR_MISSING` / `E142_XML_ATTR_INVALID`.
 */
function parsePhysicalCoordinates(
    el: E142XmlElement,
    path: string,
    ctx: ParseContext,
): E142PhysicalCoordinates | undefined {
    requiredAttr(el, 'X', path);
    requiredAttr(el, 'Y', path);
    const x = doubleAttr(el, 'X', path, ctx);
    const y = doubleAttr(el, 'Y', path, ctx);
    if (x === null || y === null) {
        return undefined;
    }
    const units = el.attribute('Units');
    const out: E142PhysicalCoordinates = { x, y };
    if (units !== null && units.trim() !== '') {
        out.units = units.trim();
    }
    return out;
}

/**
 * `ZDimensionsType`: Order (`xs:integer`, default 0), Height (`xs:double`,
 * default 0), Units (optional). The XSD defaults are APPLIED
 * here - an absent attribute with a schema default is not an absent value.
 * Carry-only for placement.
 * @param el   The `Z` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The z descriptor.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function parseZ(el: E142XmlElement, path: string, ctx: ParseContext): E142ZDimensions {
    const out: E142ZDimensions = {
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
 * `LayoutType`. `Package` exists only from V0921 onwards and
 * simply never appears in an older document, so reading it unconditionally is
 * the whole of this parser's version handling for it.
 *
 * NOTHING IN `LayoutType` IS DROPPED ANY MORE. This comment used to carry a
 * list of recognized-but-unmodeled children; every one of them is now read.
 * `TopImage` and `BottomImage` were the last two (they are the only members of
 * that old list that ever belonged to `LayoutType` at all - `AliasIds`,
 * `CarrierType`, `CarrierId`, `SlotNumber` and `SubstrateNumber` hang off
 * `Substrate`, and this function never saw them).
 *
 * `TopImage` / `BottomImage` / `ProductId` are CARRY-ONLY: read into the model,
 * never fetched, never rendered, never syntax-checked. All three are `xs:string`
 * in the XSD, so no facet applies and the trim below is normalization, not
 * validation.
 * @param el   The `Layout` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The layout node.
 * @throws {E142ParseError} On a missing/invalid attribute or a missing `Dimension`.
 */
function parseLayout(el: E142XmlElement, path: string, ctx: ParseContext): E142Layout {
    const children = childrenOf(el, ctx, path, KNOWN_LAYOUT);
    const dimEl = firstNamed(children, 'Dimension');
    if (dimEl === null) {
        throw new E142ParseError(
            'E142_XML_ELEMENT_MISSING',
            path,
            'Layout has no <Dimension>; LayoutType declares it minOccurs="1".',
        );
    }
    const out: E142Layout = {
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
    const topImage = firstNamed(children, 'TopImage');
    if (topImage !== null) {
        out.topImage = topImage.text.trim();
    }
    const bottomImage = firstNamed(children, 'BottomImage');
    if (bottomImage !== null) {
        out.bottomImage = bottomImage.text.trim();
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
                // ChildLayoutType declares @LayoutId without a use= attribute,
                // i.e. optional, so an absent one is schema-legal - and refers to
                // nothing, which is why it is dropped rather than resolved. (The
                // ChildLayoutRef keyref does not fire on it either: an XSD 1.0
                // keyref with an absent field is simply not evaluated.)
                warnAt(
                    ctx,
                    'E142_XML_CHILDLAYOUT_UNADDRESSED',
                    rPath,
                    'ChildLayout carries no @LayoutId. The attribute is use="optional" in every inspected '
                    + 'revision, so this is schema-legal, but the reference addresses no layout and is dropped.',
                );
                continue;
            }
            out.childLayouts.push(trimId(ref, 'LayoutId', rPath, ctx));
        }
    }
    return out;
}

/**
 * A `SubstrateTypeEnum` token, with schema-evolution tolerance: an unknown
 * value is WARNED and PASSED THROUGH as a string rather than
 * rejected. See {@link E142SubstrateTypeToken} for why (the TnR/Panel/PCB
 * lag between the prose and the schema is the precedent: for four years, documents
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
function substrateTypeValue(raw: string, path: string, ctx: ParseContext): E142SubstrateTypeToken {
    if ((SUBSTRATE_TYPES as readonly string[]).indexOf(raw) === -1) {
        warnAt(
            ctx,
            'E142_XML_SUBSTRATE_TYPE_UNKNOWN',
            path,
            `@SubstrateType=${JSON.stringify(raw)} is not a member of SubstrateTypeEnum `
            + `{${SUBSTRATE_TYPES.join(', ')}} in any inspected revision; carried through as a string `
            + `(schema-evolution tolerance). An XSD-validating reader would reject this `
            + `document (cvc-enumeration-valid); this reader deliberately does not.`,
        );
    }
    return raw;
}

/**
 * `SubstrateType` (the element, not the enum). Carry-only for
 * placement; `LotId` is lifted with the dialect real documents use, and
 * `AliasIds`, `GoodDevices`, `SupplierName` and `Status` are read as elements.
 *
 * ALIAS IDS. `AliasIdsType` is a single-member container of one or more
 * `AliasId`, each carrying `@Type` and `@Value` - BOTH `use="required"`
 * by `AliasIdType`, so a missing one is a parse error naming the
 * element's own indexed path rather than the substrate's.
 *
 * `@Value` is `MaterialIdType`, handled exactly as `SubstrateId` is: the
 * `maxLength 32` breach WARNS and carries the value through, because a length
 * facet is the one XSD constraint whose breach costs a reader nothing (see
 * {@link checkIdLength}). E142-0225 Table 7 states the range as "Text 1-32
 * characters", in the standard's own words, i.e. it also asserts a minimum of one that
 * `MaterialIdType` does not carry - so an empty `@Value` is XSD-valid and
 * prose-invalid. That is warned about too, and not rejected: refusing a document
 * the schema accepts would be this parser being stricter than the standard it
 * implements.
 *
 * `@Type` is an OPEN vocabulary - Table 7 gives examples (`FrontsideId`,
 * `BacksideId`, `WaferId`, `FrameId`) and no restriction - so an unrecognized
 * type is carried verbatim with no warning at all.
 *
 * CARRIER. `CarrierType` is an unconstrained `xs:string` and is carried as-is.
 * `CarrierId` is **`LotIdType`, maxLength 80** in the XSD - NOT the
 * `MaterialIdType` 32 that `SubstrateId` and `AliasId/@Value` carry. The two
 * id-like types sit two lines apart in the same `xs:sequence` and are easy to
 * conflate; {@link LOT_ID_MAX_LENGTH}'s own comment has named `CarrierId` as one
 * of its members since before this function read the field. Checking it at 32
 * would warn on every carrier id between 33 and 80 characters - documents the
 * schema accepts without complaint.
 *
 * SLOT / SUBSTRATE NUMBER / GOOD DEVICES. All three are read through
 * {@link nonNegativeIntegerValue}, so `0` is accepted. E142-0225 Table 6 calls
 * them "Positive Integer" while the XSD types them `xs:nonNegativeInteger`; the
 * standard contradicts its own schema and the schema is what a document is
 * validated against, so `0` cannot be an error here. `GoodDevices` already
 * behaved this way and keeps doing so - what changed is only that it no longer
 * rejects the `+5` / `007` / `-0` lexical forms the type admits, which it used
 * to because its pattern was `^\d+$` rather than the type's own lexical space.
 *
 * 80 is also the length a TwinCAT / CODESYS `STRING` defaults to when no length
 * is given, which is very likely why the standard picked it for the id fields a
 * PLC actually carries. That is inferred, not stated: the vendor default is checkable, the
 * motive is not, and IEC 61131-3 itself leaves the default implementation-
 * defined rather than mandating 80. Nothing in this parser depends on the
 * reason; the facet is the contract.
 * @param el   The `Substrate` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The substrate record.
 * @throws {E142ParseError} On a missing/invalid attribute.
 */
function parseSubstrate(el: E142XmlElement, path: string, ctx: ParseContext): E142Substrate {
    const children = childrenOf(el, ctx, path, KNOWN_SUBSTRATE);
    const rawId = requiredAttr(el, 'SubstrateId', path);
    checkIdLength(rawId, MATERIAL_ID_MAX_LENGTH, 'SubstrateId', 'MaterialIdType', path, ctx);
    const out: E142Substrate = {
        substrateType: substrateTypeValue(requiredAttr(el, 'SubstrateType', path), path, ctx),
        substrateId: trimId(rawId, 'SubstrateId', path, ctx),
    };
    const lotId = dialectValue(el, children, 'LotId', path, ctx);
    if (lotId !== null) {
        checkIdLength(lotId, LOT_ID_MAX_LENGTH, 'LotId', 'LotIdType', path, ctx);
        checkIdNotEmpty(lotId, 'LotId', '1-80', 'Table 6', path, ctx);
        out.lotId = lotId.trim();
    }
    const aliasIdsEl = firstNamed(children, 'AliasIds');
    if (aliasIdsEl !== null) {
        const aPath = childPath(path, 'AliasIds');
        const entries = childrenOf(aliasIdsEl, ctx, aPath, KNOWN_ALIASIDS);
        const aliasIds: E142AliasId[] = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.localName !== 'AliasId') { continue; }
            const ePath = childPath(aPath, 'AliasId', i);
            const type = requiredAttr(entry, 'Type', ePath);
            const value = requiredAttr(entry, 'Value', ePath);
            checkIdLength(value, MATERIAL_ID_MAX_LENGTH, 'Value', 'MaterialIdType', ePath, ctx);
            checkIdNotEmpty(value, 'Value', '1-32', 'Table 7', ePath, ctx);
            aliasIds.push({ type: type.trim(), value: value.trim() });
        }
        if (aliasIds.length > 0) {
            out.aliasIds = aliasIds;
        }
    }
    const slotNumber = firstNamed(children, 'SlotNumber');
    if (slotNumber !== null) {
        out.slotNumber = nonNegativeIntegerValue(slotNumber, 'SlotNumber', childPath(path, 'SlotNumber'));
    }
    const substrateNumber = firstNamed(children, 'SubstrateNumber');
    if (substrateNumber !== null) {
        out.substrateNumber = nonNegativeIntegerValue(
            substrateNumber, 'SubstrateNumber', childPath(path, 'SubstrateNumber'),
        );
    }
    const goodDevices = firstNamed(children, 'GoodDevices');
    if (goodDevices !== null) {
        out.goodDevices = nonNegativeIntegerValue(goodDevices, 'GoodDevices', childPath(path, 'GoodDevices'));
    }
    const carrierType = firstNamed(children, 'CarrierType');
    if (carrierType !== null) {
        out.carrierType = carrierType.text.trim();
    }
    const carrierId = firstNamed(children, 'CarrierId');
    if (carrierId !== null) {
        const raw = carrierId.text;
        const cPath = childPath(path, 'CarrierId');
        checkIdLength(raw, LOT_ID_MAX_LENGTH, 'CarrierId', 'LotIdType', cPath, ctx);
        checkIdNotEmpty(raw, 'CarrierId', '1-80', 'Table 6', cPath, ctx);
        out.carrierId = raw.trim();
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
 * The `SubstrateMap` header, from `SubstrateMapType`'s attributes, with
 * every XSD default applied and the attribute-or-element dialect honored for
 * Orientation / OriginLocation / AxisDirection.
 *
 * `SubstrateSide`, `SubstrateId`, `SubstrateType` and `LayoutSpecifier` are read
 * as attributes ONLY: no source shows an element spelling for them, so
 * tolerating more than the three above would be invention. Should a
 * dialect turn up, {@link dialectValue} is one call away for each.
 *
 * `Orientation` is range-checked against `OrientationType`'s facets (0..359,
 * in the XSD) and a violation is an ERROR, not a tolerated value: unlike an
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
function parseHeader(el: E142XmlElement, path: string, ctx: ParseContext): E142SubstrateMapHeader {
    const children = childrenOf(el, ctx, path, KNOWN_SUBSTRATEMAP);
    const rawId = requiredAttr(el, 'SubstrateId', path);
    checkIdLength(rawId, MATERIAL_ID_MAX_LENGTH, 'SubstrateId', 'MaterialIdType', path, ctx);

    let layoutSpecifier = el.attribute('LayoutSpecifier');
    if (layoutSpecifier === null) {
        // use="required" in every revision - but the domain model's own contract
        // says the specifier "may dangle / be absent (layoutless)", and an
        // absent one costs nothing a dangling one does not: both land on the
        // layoutless path, which the official example needs anyway.
        warnAt(
            ctx,
            'E142_XML_LAYOUT_SPECIFIER_ABSENT',
            path,
            '@LayoutSpecifier is missing although every inspected XSD revision declares it use="required"; '
            + 'read as absent, which routes this map to the layoutless path (dims from the payload).',
        );
        layoutSpecifier = '';
    }

    const orientationRaw = dialectValue(el, children, 'Orientation', path, ctx);
    let orientation = 0;
    if (orientationRaw !== null) {
        const text = orientationRaw.trim();
        if (!/^[+-]?\d+$/.test(text)) {
            throw new E142ParseError(
                'E142_XML_ATTR_INVALID',
                path,
                `Orientation=${JSON.stringify(orientationRaw)} is not an xs:integer.`,
            );
        }
        orientation = Number(text);
        if (orientation < 0 || orientation > 359) {
            throw new E142ParseError(
                'E142_XML_ATTR_INVALID',
                path,
                `Orientation=${orientation} is outside OrientationType's declared facets [0, 359]. `
                + 'Not repaired: any repair would be a guess about how the substrate '
                + `physically sits relative to the map data.`,
            );
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
 * `ReferenceDeviceType`: `Coordinates` (required, and read in the LOGICAL frame -
 * inferred from the frame attributes), `Position` (optional, physical) and `Name` (optional,
 * default ''). Reference devices are CARRIED ALONG, never folded
 * into the placement math, so this parser does not convert their coordinates.
 * @param el   The `ReferenceDevice` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The reference device.
 * @throws {E142ParseError} On a missing `Coordinates` or an invalid attribute.
 */
function parseReferenceDevice(el: E142XmlElement, path: string, ctx: ParseContext): E142ReferenceDevice {
    const children = childrenOf(el, ctx, path, KNOWN_REFERENCEDEVICE);
    const coords = firstNamed(children, 'Coordinates');
    if (coords === null) {
        throw new E142ParseError(
            'E142_XML_ELEMENT_MISSING',
            path,
            'ReferenceDevice has no <Coordinates>; ReferenceDeviceType declares it minOccurs="1".',
        );
    }
    const out: E142ReferenceDevice = {
        // @Name is use="optional" default="" in the XSD: an absent attribute
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
 * `BinDefinitionType`: BinCode (required) plus BinCount,
 * BinQuality (default ''), BinDescription (default '') and Pick (default false).
 * `BinQuality` is a FREE STRING, not an enumeration - the schema declares no
 * facet, and the familiar Pass/Fail/Edge/Skip/Reference values are convention
 * only, according to vendor documentation - so no value is rejected here.
 * @param el   The `BinDefinition` element.
 * @param path Its structural path.
 * @returns The bin definition.
 * @throws {E142ParseError} On a missing/invalid attribute.
 */
function parseBinDefinition(el: E142XmlElement, path: string, ctx: ParseContext): E142BinDefinition {
    const out: E142BinDefinition = {
        binCode: requiredAttr(el, 'BinCode', path),
        binQuality: el.attribute('BinQuality') ?? '',
        binDescription: el.attribute('BinDescription') ?? '',
        pick: boolAttr(el, 'Pick', path, ctx, false),
    };
    const count = intAttr(el, 'BinCount', path);
    if (count !== null) {
        if (count < 0) {
            throw new E142ParseError(
                'E142_XML_ATTR_INVALID',
                path,
                `@BinCount=${count} is not an xs:nonNegativeInteger.`,
            );
        }
        out.binCount = count;
    }
    return out;
}

// ===================================================================
//  Serialization lattice resolution
// ===================================================================

/**
 * Where a payload's serialization lattice came from - carried only to keep
 * {@link resolveSerializationDims}'s two sources apart in its own diagnostics.
 */
interface DeclaredDims {
    /** Map-frame columns per the layout, after the Row/Column dimension swap. */
    cols: number;
    /** Map-frame rows per the layout, after the Row/Column dimension swap. */
    rows: number;
}

/**
 * Resolves the lattice {@link decodeBinPayload} must fill, in SERIALIZATION
 * index space, from the two sources a document can offer - and reports every
 * disagreement between them.
 *
 * ---- The two sources ----
 *  (1) DECLARED: the layout reached through the LayoutSpecifier, run through
 *      {@link dimsInMapFrame} so the Row/Column swap applies (for
 *      Orientation mod 180 == 90 the map view swaps the layout's X/Y). Absent
 *      for a LAYOUTLESS document.
 *  (2) OBSERVED: the payload's own shape. Available for `2DArray` ALONE, whose
 *      serialization is self-describing - one `<BinCode>` element per row
 *      structurally confirmed by every real example including
 *      SEMI's own) and one measurable token count per row ({@link countRowTokens}).
 *      `Array` (one un-broken stream), `Coordinate` and `Row/Column` (sparse)
 *      describe no shape at all: any factorization of their token count would
 *      fit, so for them the declared lattice is the only source and its absence
 *      is fatal.
 *
 * ---- Why OBSERVED wins for 2DArray, with a warning ----
 * The standard's own words make the correspondence a RECOMMENDATION, not a rule:
 * "The length of each row and number of rows SHOULD correspond with the product
 * of the dimensions of the layouts defined by the LayoutSpecifier attribute,
 * rotated to the coordinate system of the SubstrateMap" - E142-0225's own words,
 * emphasis on the modal verb, which is the standard's]. A `should` cannot make a
 * conforming reader reject a document, so a mismatch is a diagnostic, not a
 * fault; and between a COUNTED shape and a DERIVED one, the counted shape is the
 * observation. Adopting the observation also keeps one code path for the
 * layoutless case, which has nothing else.
 *
 * Two mismatches get two codes, because they are epistemically different:
 *  - `E142_XML_DIM_ORIENTATION_SWAP` - the shapes are exact TRANSPOSES and
 *    Orientation mod 180 == 90. SETTLED against SEMI E142-0225, which requires the
 *    2DArray row length / row count to match the layout dimensions "rotated to the
 *    coordinate system of the SubstrateMap", and Figure R2-11 shows the cell
 *    pitch transposing at 90/270. So the LAYOUT-derived map frame is right and a
 *    payload in the untransposed shape makes the DOCUMENT non-conformant.
 *  - `E142_XML_DIM_MISMATCH` - any other disagreement, e.g. a `MapType`-less
 *    single-line payload under a 5x4 layout (one surveyed document does
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
 * Settled by E142-0225's MapType='2DArray' clause together with Figure R2-11.
 *
 * @param observed The payload's own shape, or null when the form describes none.
 * @param declared The layout's map-frame shape, or null when layoutless.
 * @param mapType  The resolved MapType, for the diagnostics.
 * @param orientationDeg The document's Orientation, for the map-frame swap.
 * @param path     Structural path of the `BinCodeMap`.
 * @param ctx      The parse context.
 * @returns The lattice to decode against.
 * @throws {E142ParseError} `E142_XML_DIMS_UNKNOWN` when neither source exists.
 */
function resolveSerializationDims(
    observed: E142Dimension | null,
    declared: DeclaredDims | null,
    mapType: E142MapType,
    orientationDeg: number,
    path: string,
    ctx: ParseContext,
): E142Dimension {
    if (observed !== null && declared !== null) {
        if (observed.cols !== declared.cols || observed.rows !== declared.rows) {
            const transposed = observed.cols === declared.rows && observed.rows === declared.cols;
            const quadrant = (((Math.round(orientationDeg) % 180) + 180) % 180) === 90;
            if (transposed && quadrant) {
                warnAt(
                    ctx,
                    'E142_XML_DIM_ORIENTATION_SWAP',
                    path,
                    `The layout declares a ${declared.rows} x ${declared.cols} device array which, at `
                    + `Orientation=${orientationDeg}, is a ${declared.cols} cols x ${declared.rows} rows MAP: `
                    + `SEMI E142-0225 requires the row length and row count to correspond to the layout `
                    + `dimensions "rotated to the coordinate system of the SubstrateMap" [A, MapType='2DArray'], `
                    + `and Figure R2-11 shows the cell pitch transposing at Orientation 90/270. This payload `
                    + `serializes the exact transpose of that, ${observed.cols} cols x ${observed.rows} rows, `
                    + `so THE DOCUMENT IS NON-CONFORMANT. The payload's own shape is adopted so the bin data `
                    + `still renders, but computeGridPlacement derives the lattice from the LAYOUT (correctly), `
                    + `so the two disagree: treat this overlay's PLACEMENT GEOMETRY as unusable and fix the `
                    + `document - either transpose the payload rows, or declare the layout Dimension that makes `
                    + `this map its rotation.`,
                );
            } else {
                warnAt(
                    ctx,
                    'E142_XML_DIM_MISMATCH',
                    path,
                    `The layout declares a ${declared.cols} cols x ${declared.rows} rows map (post-A3) but the `
                    + `MapType="${mapType}" payload serializes ${observed.cols} cols x ${observed.rows} rows. `
                    + `The payload's own shape is adopted: the prose only says the two SHOULD correspond `
                    + 'in E142-0225\'s own words, so this is a deviation from a recommendation, not a fault. '
                    + `CONSEQUENCE: computeGridPlacement derives its lattice from the LAYOUT and will `
                    + `disagree with this payload - do not build a grid model from this overlay while this `
                    + `warning stands.`,
                );
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
    throw new E142ParseError(
        'E142_XML_DIMS_UNKNOWN',
        path,
        `MapType="${mapType}" describes no lattice of its own and this document is layoutless (no `
        + `LayoutSpecifier target), so cols x rows is unknown. Only MapType="2DArray" is self-describing `
        + `(one <BinCode> element per row); for the other three the LayoutSpecifier must resolve.`,
    );
}

/**
 * Converts a LOGICAL (X, Y) - the frame every X/Y attribute in a document lives
 * in - into the SERIALIZATION (col, row) index
 * space the decoder speaks. The ONE conversion point of this module; the rule
 * itself lives in {@link mapCoordToIndex}.
 *
 * Out-of-range results are NOT filtered here: the decoder's own bounds check
 * reports them with the offending row/column and a message that says these are
 * serialization indices, which is a better diagnostic than anything this
 * function could produce, and it keeps one gate rather than two.
 * The rule is stated by E142-0225's 2DArray clause with Figure A1-1b, and by Table A4-1.
 * @param x      Logical X.
 * @param y      Logical Y.
 * @param header The map header (OriginLocation x AxisDirection).
 * @param dims   The serialization lattice.
 * @returns The (col, row) serialization index.
 */
function toSerializationIndex(
    x: number,
    y: number,
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
): { serCol: number; serRow: number } {
    return mapCoordToIndex(x, y, header.originLocation, header.axisDirection, dims.cols, dims.rows);
}

// ===================================================================
//  BinCodeMap
// ===================================================================

/**
 * One `<BinCode>` element, read but not yet interpreted: text plus the four
 * optional attributes `BinCodeType` carries in V0125 (X, Y, LID, Number; LID is
 * the V0125 addition).
 */
interface RawBinCode {
    /** The element's trimmed text content. */
    tokens: string;
    /** Logical X, or null when absent. */
    x: number | null;
    /** Logical Y, or null when absent. */
    y: number | null;
    /** The V0125 LID, or null when absent. */
    lid: string | null;
    /** The Number attribute, or null when absent. */
    number: number | null;
    /** The element's structural path, for diagnostics. */
    path: string;
}

/**
 * Reads one `<BinCode>` element.
 *
 * The text is TRIMMED. `BinCodeContentType` is `xs:string` with `minLength=1`,
 * i.e. whiteSpace="preserve" in the XSD, so this is a deliberate boundary
 * decision, not a schema reading: XML pretty-printers indent element content,
 * and this parser must not turn a re-indented file into a token error. It cannot
 * hide a defect either - the three fixed-width grammars contain no whitespace at
 * all, so an INTERIOR space still fails the decoder, and for `Decimal`
 * surrounding whitespace is the grammar's own separator (footnote #1 in
 * quoted from E142-0225) and trimming it changes nothing.
 * @param el   The `BinCode` element.
 * @param path Its structural path.
 * @returns The raw entry.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID`.
 */
function parseBinCode(el: E142XmlElement, path: string): RawBinCode {
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
 * required, content exactly one token.
 *
 * Splits the entries three ways:
 *  - X/Y present -> converted to a serialization index and placed on the grid.
 *    An entry carrying BOTH X/Y and LID is placed by its X/Y: the coordinates
 *    are the addressing mode the standard states outright and LID is the weakly
 *    evidenced one, so where
 *    they coexist the quoted one wins.
 *  - LID only -> CANNOT be placed on a rectangular lattice at all, since no
 *    source defines any LID-to-coordinate resolution. The attribute itself is
 *    declared by the XSD; what it MEANS for placement is inferred, and thinly.
 *    Carried in `sparseBinCodes`, excluded from the
 *    grid, and named in one aggregated warning.
 *    (the 0225 LID/FID/TID prose).
 *  - neither -> a typed error: the entry names no device by any known means.
 *
 * `Number` is carried and IGNORED for placement. It is assumed to be an
 * informational enumeration order; no source shows it in use, which makes this a
 * weakly evidenced reading rather than a settled one.
 * records that no official `Coordinate` example with `Number` exists anywhere).
 * @param raws   The raw `BinCode` entries.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @param ctx    The parse context.
 * @returns The decoder payload plus the pre-decode sparse model.
 * @throws {E142ParseError} `E142_XML_BINCODE_SHAPE`.
 */
function buildCoordinatePayload(
    raws: readonly RawBinCode[],
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
    ctx: ParseContext,
): { payload: E142CoordinateEntry[]; sparse: E142SparseBinCode[]; lids: Map<number, string> } {
    const payload: E142CoordinateEntry[] = [];
    /**
     * Linear serialization index -> LID, for EVERY entry that carries one -
     * whether it was placed by coordinate or resolved from its LID. That is what
     * "expose the LID per cell" means: a cell named in the document keeps its
     * name regardless of how it was addressed.
     */
    const lids = new Map<number, string>();
    /**
     * Cells already taken by X/Y-addressed entries, so LID resolution can skip
     * them. §13.3 permits a map to mix the forms, and a LID-only entry must not
     * land on a cell an explicit coordinate already claimed - the decoder would
     * reject the duplicate and the whole map would fail over an ordering detail.
     */
    const taken = new Uint8Array(dims.cols * dims.rows);
    for (const raw of raws) {
        if (raw.x !== null && raw.y !== null) {
            const { serCol, serRow } = toSerializationIndex(raw.x, raw.y, header, dims);
            taken[serRow * dims.cols + serCol] = 1;
        }
    }
    /**
     * Row-major fill cursor for LID-only entries (DECISION-lid.md, tier 1):
     * document order fills the declared lattice, skipping cells already claimed.
     * Row-major to match `MapType="2DArray"`, where a BinCode element IS a row -
     * consistency inside one package beats a coin toss.
     */
    let cursor = 0;
    const sparse: E142SparseBinCode[] = [];
    for (const raw of raws) {
        const entry: E142SparseBinCode = { code: raw.tokens };
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
            if (raw.lid !== null) {
                // "or both" (13.3): the coordinate places it, the LID names it.
                lids.set(serRow * dims.cols + serCol, raw.lid);
            }
        } else if (raw.lid !== null) {
            while (cursor < taken.length && taken[cursor] !== 0) { cursor++; }
            if (cursor < taken.length) {
                taken[cursor] = 1;
                const serRow = Math.floor(cursor / dims.cols);
                const serCol = cursor - serRow * dims.cols;
                payload.push({ x: serCol, y: serRow, bin: raw.tokens });
                lids.set(cursor, raw.lid);
                cursor++;
            } else {
                // GENUINELY unresolvable: the lattice is full. Every remaining
                // LID-only entry has nowhere to go, and inventing a cell would
                // mean growing the lattice the document declared.
                ctx.lidOnly.push(raw.lid);
            }
        } else {
            throw new E142ParseError(
                'E142_XML_BINCODE_SHAPE',
                raw.path,
                'MapType="Coordinate" requires both X and Y on every BinCode ("The X and Y coordinates must '
                + 'both be included", in E142-0225\'s own words); this element carries '
                + `${raw.x !== null ? 'X but no Y' : raw.y !== null ? 'Y but no X' : 'neither'}, and no LID `
                + 'either, so it names no device.',
            );
        }
    }
    return { payload, sparse, lids };
}

/**
 * Builds the `Row/Column` payload: each `<BinCode>` is a RUN starting at its
 * (X, Y) and filling consecutive cells in the LOGICAL +X direction; its length
 * is its token count.
 *
 * WEAKLY EVIDENCED. The whole basis for this shape is the prose fragment
 * "Alternatively, a starting XY coordinate and length may be specified"
 * quoted from E142-0225, plus the `BinCodeType` attribute inventory, plus the
 * absence of any `Length` attribute in any revision. It is also unresolved that
 * NO complete official Row/Column example exists in any public source. The
 * SEMANTICS live behind one seam in E142Bins (`decodeRowColumnRuns`); this
 * function's only share of the assumption is that the start coordinate is
 * LOGICAL - hence the conversion - and that the fill direction needs
 * {@link logicalXStep}, because converting a start POINT does not carry a
 * DIRECTION.
 * UNVERIFIED: Figure A1-1a "Row/Column Format", or any worked example, would settle it.
 * @param raws   The raw `BinCode` entries.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @returns The decoder payload.
 * @throws {E142ParseError} `E142_XML_BINCODE_SHAPE` when a run carries no start.
 */
function buildRowColumnPayload(
    raws: readonly RawBinCode[],
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
): E142BinRun[] {
    const runs: E142BinRun[] = [];
    for (const raw of raws) {
        if (raw.x === null || raw.y === null) {
            throw new E142ParseError(
                'E142_XML_BINCODE_SHAPE',
                raw.path,
                'MapType="Row/Column" needs a starting X and Y on every BinCode, inferred from '
                + '"a starting XY coordinate and length may be specified" in E142-0225; this '
                + `element carries ${raw.x !== null ? 'X but no Y' : raw.y !== null ? 'Y but no X' : 'neither'}. `
                + 'A LID is no substitute: no source defines a LID-to-coordinate resolution, and a '
                + 'run without a start has nowhere to begin.',
            );
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
 * in the XSD, while the standard's prose says "If omitted the
 * default value is '2DArray'". That is a PROSE-vs-SCHEMA DIVERGENCE: a
 * schema-only reader sees an absent attribute and defaults nothing, so the
 * default MUST be applied APPLICATION-SIDE - here. The official
 * `BinCodeMap-Example.xml` depends on it (it omits `MapType` entirely and
 * serializes one row per element). The MODEL keeps the document's
 * own value, i.e. `binCodeMapMeta.mapType` stays undefined for an absent
 * attribute, so a consumer can still tell "omitted" from "explicitly 2DArray";
 * only the decode uses {@link E142_DEFAULT_MAP_TYPE}.
 *
 * ---- Dispatch ----
 * By the RESOLVED MapType and never by inspecting the payload's shape: the
 * declared type is the document's statement of intent, and guessing from shape
 * is how a single-line `2DArray` silently becomes an `Array` (one surveyed
 * CSDN document is exactly that trap - see {@link resolveSerializationDims}).
 * @param el     The `BinCodeMap` element.
 * @param path   Its structural path.
 * @param header The owning map's header.
 * @param layout The resolved layout, or null when layoutless.
 * @param ctx    The parse context.
 * @returns The overlay fields this element contributes.
 * @throws {E142ParseError} On any structural, shape or decode defect.
 */
function parseBinCodeMap(
    el: E142XmlElement,
    path: string,
    header: E142SubstrateMapHeader,
    layout: ResolvedLayout | null,
    ctx: ParseContext,
): Pick<E142Overlay, 'binCodeMapMeta' | 'binDefinitions' | 'sparseBinCodes' | 'payload'> {
    const children = childrenOf(el, ctx, path, KNOWN_BINCODEMAP);
    const binType = enumValue(requiredAttr(el, 'BinType', path).trim(), BIN_TYPES, 'BinType', path);
    const nullBin = requiredAttr(el, 'NullBin', path);
    const rawMapType = el.attribute('MapType');
    const mapType = rawMapType === null
        ? E142_DEFAULT_MAP_TYPE
        : enumValue(rawMapType.trim(), MAP_TYPES, 'MapType', path);

    const out: Pick<E142Overlay, 'binCodeMapMeta' | 'binDefinitions' | 'sparseBinCodes' | 'payload'> = {
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
        throw new E142ParseError(
            'E142_XML_ELEMENT_MISSING',
            path,
            'BinCodeMap has no <BinCode>; BinCodeMapType declares it minOccurs="1" maxOccurs="unbounded".',
        );
    }
    const raws = binCodeEls.map((b, i) => parseBinCode(b, childPath(path, 'BinCode', i)));

    // (1) The declared lattice: the layout, through the `Orientation` swap.
    let declared: DeclaredDims | null = null;
    if (layout !== null) {
        const mf = dimsInMapFrame(layout, header.orientation);
        declared = { cols: mf.cols, rows: mf.rows };
    }

    // (2) The observed lattice: 2DArray alone describes its own shape.
    let observed: E142Dimension | null = null;
    if (mapType === '2DArray') {
        observed = {
            cols: countRowTokens(binType, raws[0].tokens, `BinCode[1] of ${path}`),
            rows: raws.length,
        };
    }
    // A Coordinate map whose EVERY entry is LID-only describes no lattice of its
    // own, and without a Layout Dimension none can be supplied. That is not a
    // malformed document - it is an unresolvable one - so it warns and yields no
    // payload rather than throwing, and the overlay is simply not renderable.
    // Narrow on purpose: any entry carrying X/Y, or any declared dimension,
    // takes the normal path, so nothing that parses today can regress.
    if (mapType === 'Coordinate' && observed === null && declared === null
        && raws.length > 0 && raws.every((r) => r.x === null && r.y === null && r.lid !== null)) {
        for (const raw of raws) {
            ctx.lidOnly.push(raw.lid as string);
        }
        out.sparseBinCodes = raws.map((raw) => {
            const entry: E142SparseBinCode = { code: raw.tokens };
            entry.lid = raw.lid as string;
            if (raw.number !== null) { entry.number = raw.number; }
            return entry;
        });
        warnAt(
            ctx,
            'E142_XML_LID_NO_LATTICE',
            path,
            `all ${raws.length} BinCode entr${raws.length === 1 ? 'y is' : 'ies are'} addressed by LID `
            + 'only, and this document supplies no lattice to resolve them onto: MapType="Coordinate" '
            + 'does not describe its own shape (unlike "2DArray", where a BinCode element IS a row), '
            + 'and no Layout with a Dimension is reachable from the LayoutSpecifier. Supply a Layout '
            + 'Dimension, or address the entries by X/Y. The entries are retained on the overlay in '
            + 'sparseBinCodes; nothing is rendered.',
        );
        return out;
    }
    const dims = resolveSerializationDims(observed, declared, mapType, header.orientation, path, ctx);

    // Shape the payload the way the declared MapType demands.
    let payload: E142BinPayload;
    let xStep: 1 | -1 | undefined;
    /** Per-cell LIDs, only the Coordinate form can produce them. */
    let coordinateLids: Map<number, string> | undefined;
    switch (mapType) {
        case '2DArray':
            payload = raws.map((r) => r.tokens);
            break;
        case 'Array':
            if (raws.length !== 1) {
                throw new E142ParseError(
                    'E142_XML_BINCODE_SHAPE',
                    path,
                    `MapType="Array" carries the whole map in ONE element ("a single BinCode object can include `
                    + `the entire array of bin codes in row major format starting at the top left", in `
                    + `E142-0225's own words); this map has ${raws.length}. Concatenating them would be a guess about `
                    + `the intended order.`,
                );
            }
            payload = raws[0].tokens;
            break;
        case 'Coordinate': {
            const built = buildCoordinatePayload(raws, header, dims, ctx);
            payload = built.payload;
            out.sparseBinCodes = built.sparse;
            coordinateLids = built.lids;
            break;
        }
        case 'Row/Column':
            payload = buildRowColumnPayload(raws, header, dims);
            xStep = logicalXStep(header.axisDirection);
            break;
        default: {
            const _never: never = mapType;
            return _never;
        }
    }

    try {
        // Attached AFTER decoding: the decoder owns cells/codes and knows nothing
        // about LIDs, so bolting the map on here keeps that boundary intact.
        out.payload = decodeBinPayload(
            xStep === undefined ? { binType, nullBin, mapType } : { binType, nullBin, mapType, xStep },
            dims,
            payload,
        );
        if (coordinateLids !== undefined && coordinateLids.size > 0) {
            out.payload.lids = coordinateLids;
        }
    } catch (e) {
        if (e instanceof E142DecodeError) {
            // Translate, never leak: one error type reaches a caller of this
            // module. The original travels in `cause`, so the decoder's
            // serialization row/column survives without being re-modeled here.
            throw new E142ParseError(
                'E142_XML_DECODE',
                path,
                `${e.code}: ${e.message}`
                + (e.row === undefined ? '' : ` [serialization row ${e.row}${e.col === undefined ? '' : `, column ${e.col}`}]`),
                e,
            );
        }
        throw e;
    }
    return out;
}

/**
 * Parses one `<TransferMap>`: where a batch of devices came from, plus the moves.
 *
 * THE THREE `From*` ATTRIBUTES WARN RATHER THAN THROW when absent. They are
 * `use="required"` in the XSD - verified, and `xmllint` does reject a
 * document missing one - so this parser is deliberately MORE TOLERANT than the
 * schema here, which the standing policy permits (it may not be stricter; it may
 * be looser). The reason is specific rather than general: a `TransferMap` is
 * carry-only provenance, and the `<T>` endpoints stay perfectly readable when the
 * source identity is incomplete. Refusing the whole document would deny a
 * diagnostic tool the very records it is trying to show. Contrast
 * `AliasId/@Type`, which DOES throw: an alias without its type names nothing at
 * all, so there is no partial value to preserve.
 *
 * Each `<T>` carries six optional attributes, none coupled,
 * because each END is addressed independently - by a coordinate pair or by an
 * identifier. `FX/FY/TX/TY` go through {@link intAttr}, which is strict on the
 * lexical form of `xs:integer`; `FID/TID` are opaque strings, carried verbatim
 * like `LID`.
 *
 * A `<T>` carrying NOTHING is reported: it states no source, no destination and
 * no device, so it records no movement. That is a warning, not an error - the
 * remaining entries are still good.
 *
 * @param el   The `TransferMap` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The parsed map.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID` from {@link intAttr}.
 */
function parseTransferMap(el: E142XmlElement, path: string, ctx: ParseContext): E142TransferMap {
    const fromAttr = (name: string): string => {
        const raw = el.attribute(name);
        if (raw === null) {
            warnAt(
                ctx,
                'E142_XML_TRANSFER_FROM_MISSING',
                path,
                `TransferMap has no @${name}; the XSD declares it use="required" and the three From* `
                + 'attributes together are an intra-document reference (keyref FromSubstrateMapRef -> '
                + 'SubstrateMapKey), so the source substrate cannot be identified. The transfers '
                + 'themselves are still read; the source is reported as "".',
            );
            return '';
        }
        return raw.trim();
    };
    const out: E142TransferMap = {
        fromSubstrateType: fromAttr('FromSubstrateType'),
        fromSubstrateId: fromAttr('FromSubstrateId'),
        // NOT trimmed: a LayoutSpecifier is a path whose segments are matched
        // literally against LayoutId, and the empty string is a legitimate value
        // (the layoutless form), so there is nothing to normalize away.
        fromLayoutSpecifier: el.attribute('FromSubstrateLayoutSpecifier') ?? '',
        transfers: [],
    };
    if (el.attribute('FromSubstrateLayoutSpecifier') === null) {
        warnAt(
            ctx,
            'E142_XML_TRANSFER_FROM_MISSING',
            path,
            'TransferMap has no @FromSubstrateLayoutSpecifier; the XSD declares it use="required". '
            + 'The transfers themselves are still read; the source is reported as "".',
        );
    }

    const kids = childrenOf(el, ctx, path, KNOWN_TRANSFERMAP);
    let empty = 0;
    for (let i = 0; i < kids.length; i++) {
        const t = kids[i];
        if (t.localName !== 'T') { continue; }
        const tPath = childPath(path, 'T', i);
        const entry: E142Transfer = {};
        const fx = intAttr(t, 'FX', tPath);
        const fy = intAttr(t, 'FY', tPath);
        const tx = intAttr(t, 'TX', tPath);
        const ty = intAttr(t, 'TY', tPath);
        const fid = t.attribute('FID');
        const tid = t.attribute('TID');
        if (fx !== null) { entry.fx = fx; }
        if (fy !== null) { entry.fy = fy; }
        if (fid !== null) { entry.fid = fid; }
        if (tx !== null) { entry.tx = tx; }
        if (ty !== null) { entry.ty = ty; }
        if (tid !== null) { entry.tid = tid; }
        if (Object.keys(entry).length === 0) { empty++; }
        out.transfers.push(entry);
    }
    if (empty > 0) {
        warnAt(
            ctx,
            'E142_XML_TRANSFER_EMPTY',
            path,
            `${empty} <T> element${empty === 1 ? '' : 's'} carr${empty === 1 ? 'ies' : 'y'} none of `
            + 'FX/FY/FID/TX/TY/TID. Every attribute is optional in the XSD, so this is schema-valid, '
            + 'but such an element records no movement: it names neither end. Retained in document '
            + 'order so the indices still line up with the source.',
        );
    }
    return out;
}

/**
 * Parses one `<DeviceDataMap>`: the parameter list, and one record per device.
 *
 * THE PARAMETER LIST IS THE SCHEMA FOR THE VALUES. Table 19: "The order of
 * values shall match the order of parameters listed in the DeviceDataMap's
 * Parameter attribute." A `shall`, and the values carry
 * no names of their own - `values[i]` means `parameters[i]` and nothing else says
 * so. A count mismatch is therefore reported per record: it does not lose ONE
 * reading, it re-labels every reading after the discrepancy.
 *
 * It is a warning and not an error because a mismatch is a defect in the
 * DOCUMENT, and refusing it would deny a reader the values that ARE aligned -
 * the same reasoning that keeps a missing `TransferMap/@From*` non-fatal.
 *
 * `PVSet` IS RESOLVED IN THE E138 NAMESPACE. `DeviceDataType` declares
 * `<xs:element ref="ccs:PVSet"/>`, so the child is `{E138}PVSet`, not
 * `{E142}PVSet`. Looking for it by local name alone would find a wrongly-namespaced
 * element in a malformed document and silently accept it; looking for it in the
 * E142 namespace would find nothing in a correct one.
 *
 * @param el   The `DeviceDataMap` element.
 * @param path Its structural path.
 * @param ctx  The parse context.
 * @returns The parsed map.
 */
function parseDeviceDataMap(el: E142XmlElement, path: string, ctx: ParseContext): E142DeviceDataMap {
    const kids = childrenOf(el, ctx, path, KNOWN_DEVICEDATAMAP);
    const out: E142DeviceDataMap = { parameters: [], deviceData: [] };

    let pIdx = 0;
    let dIdx = 0;
    let nameless = 0;
    for (const kid of kids) {
        if (kid.localName === 'Parameter') {
            const p = childPath(path, 'Parameter', pIdx++);
            const name = kid.attribute('Name');
            if (name === null) {
                // Table 18 marks @Name required; ParameterType declares it with
                // no `use=`, so the XSD default is optional and a bare
                // <Parameter/> VALIDATES (verified with xmllint). Looser than the
                // prose, exactly as strict as the schema: reported, and carried
                // as '' so the position - which is what ties values to meaning -
                // is preserved.
                nameless++;
                out.parameters.push({ name: '' });
            } else {
                const entry: E142Parameter = { name };
                const desc = kid.attribute('Description');
                if (desc !== null) { entry.description = desc; }
                out.parameters.push(entry);
            }
            void p;
            continue;
        }
        if (kid.localName !== 'DeviceData') { continue; }
        const d = childPath(path, 'DeviceData', dIdx++);
        const entry: E142DeviceData = { values: [] };
        const x = intAttr(kid, 'X', d);
        const y = intAttr(kid, 'Y', d);
        const lid = kid.attribute('LID');
        if (x !== null) { entry.x = x; }
        if (y !== null) { entry.y = y; }
        if (lid !== null) { entry.lid = lid; }

        const sets = kid.children.filter(
            (k) => k.localName === 'PVSet' && k.namespaceUri === E138_NS,
        );
        if (sets.length === 0) {
            warnAt(ctx, 'E142_XML_DEVICEDATA_NO_PVSET', d,
                'this <DeviceData> carries no {E138}PVSet. DeviceDataType declares '
                + '<xs:element ref="ccs:PVSet" minOccurs="1"/>, so the document is '
                + 'invalid. The record is kept, with no values, so its position among the DeviceData '
                + 'is preserved.');
        } else {
            if (sets.length > 1) {
                warnAt(ctx, 'E142_XML_DEVICEDATA_MULTI_PVSET', d,
                    `this <DeviceData> carries ${sets.length} PVSet elements; DeviceDataType allows one `
                    + '(maxOccurs defaults to 1). Only the FIRST is read - concatenating '
                    + 'them would invent an order the document never stated, and order is what binds a '
                    + 'value to its parameter.');
            }
            entry.values = parsePvSet(
                sets[0],
                childPath(d, 'PVSet'),
                (code, p2, message) => { warnAt(ctx, code, p2, message); },
            );
        }
        out.deviceData.push(entry);
    }

    if (nameless > 0) {
        warnAt(ctx, 'E142_XML_PARAMETER_NO_NAME', path,
            `${nameless} <Parameter> element${nameless === 1 ? '' : 's'} carr${nameless === 1 ? 'ies' : 'y'} `
            + 'no @Name. Table 18 marks it required, but ParameterType declares it with no `use=` so the '
            + 'XSD default is optional and such a document validates - one of the standard\'s '
            + 'prose/schema disagreements. Carried as an empty name; the value at that position has '
            + 'nothing to label it.');
    }
    if (out.parameters.length === 0) {
        warnAt(ctx, 'E142_XML_DEVICEDATAMAP_EMPTY', path,
            'this <DeviceDataMap> declares no <Parameter>. DeviceDataMapType requires at least one '
            + '(minOccurs="1"), and without the list nothing labels the values - they '
            + 'are still read, positionally, but they mean nothing on their own.');
    }
    if (out.deviceData.length === 0) {
        warnAt(ctx, 'E142_XML_DEVICEDATAMAP_EMPTY', path,
            'this <DeviceDataMap> declares no <DeviceData>. DeviceDataMapType requires at least one '
            + '(minOccurs="1"). The parameter list is kept; there is nothing it applies to.');
    }

    // Table 19's `shall`, checked per record.
    const want = out.parameters.length;
    let mismatched = 0;
    for (let k = 0; k < out.deviceData.length; k++) {
        const got = out.deviceData[k].values.length;
        if (got !== want) { mismatched++; }
    }
    if (mismatched > 0 && want > 0) {
        const first = out.deviceData.find((dd) => dd.values.length !== want);
        warnAt(ctx, 'E142_XML_DEVICEDATA_VALUE_COUNT', path,
            `${mismatched} of ${out.deviceData.length} <DeviceData> record`
            + `${mismatched === 1 ? '' : 's'} do not carry exactly ${want} value`
            + `${want === 1 ? '' : 's'} - the first has ${first === undefined ? 0 : first.values.length}. `
            + 'Table 19: "The order of values shall match the order of parameters listed in the '
            + 'DeviceDataMap\'s Parameter attribute." The values carry no names, so position is the '
            + 'ONLY thing binding a value to a parameter: a missing or extra value does not lose one '
            + 'reading, it re-labels every reading after it. The values are reported as given; do not '
            + 'trust the pairing past the first discrepancy.');
    }
    return out;
}

/**
 * Reads a `DeviceIdMap` overlay (`DeviceIdMapType`): a flat, SPARSE list of
 * `<Id>` elements. Each `<Id>` (`DeviceIdType`) is `xs:string` content (the
 * device identifier) plus optional `X`/`Y` (`xs:integer`) and `LID`
 * (`xs:string`) - structurally the sparse {@link parseBinCode} minus `Number`.
 *
 * Every entry is carried verbatim in {@link E142DeviceIdEntry}; the frame-aware
 * cell index (which entries land on which grid cell) is the control's job, since
 * it owns the grid dimensions and the OriginLocation x AxisDirection frame the
 * `X`/`Y` live in. LID-only and address-less entries are carried
 * too - they cannot be placed on the lattice without a LID resolution no source
 * defines - and the control reports how many were unplaceable.
 * @param el   The `DeviceIdMap` element.
 * @param path Its structural path.
 * @param ctx  The parse context (unknown/foreign-child bookkeeping).
 * @returns The `<Id>` entries in document order.
 * @throws {E142ParseError} `E142_XML_ATTR_INVALID` for a non-integer X/Y.
 */
function parseDeviceIdMap(el: E142XmlElement, path: string, ctx: ParseContext): E142DeviceIdEntry[] {
    const ids = childrenOf(el, ctx, path, KNOWN_DEVICEIDMAP);
    const entries: E142DeviceIdEntry[] = [];
    for (let i = 0; i < ids.length; i++) {
        const idEl = ids[i];
        const p = childPath(path, 'Id', i);
        const entry: E142DeviceIdEntry = { deviceId: idEl.text.trim() };
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

/**
 * Reads one `<Overlay>`: its `ReferenceDevices` (carried along) plus the map of
 * the XSD's 4-way choice - `BinCodeMap`, `DeviceIdMap`, `TransferMap` or
 * `DeviceDataMap`. All four are parsed. Only `BinCodeMap` carries bin data and
 * is drawn; the other three - device serial numbers, substrate-to-substrate
 * transfers and E138 `ccs:PVSet` parameter payloads - are carried in the model
 * for the caller. An overlay that declares no map still exists in the model,
 * with meta and payload absent, which is the legal "declared overlay with no
 * map yet" case real documents show.
 * @param el     The `Overlay` element.
 * @param path   Its structural path.
 * @param header The owning map's header.
 * @param layout The resolved layout, or null when layoutless.
 * @param ctx    The parse context.
 * @returns The overlay.
 * @throws {E142ParseError} On any structural, shape or decode defect.
 */
function parseOverlay(
    el: E142XmlElement,
    path: string,
    header: E142SubstrateMapHeader,
    layout: ResolvedLayout | null,
    ctx: ParseContext,
): E142Overlay {
    const children = childrenOf(el, ctx, path, KNOWN_OVERLAY);
    const out: E142Overlay = {
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
    // ALL of them: OverlayType declares TransferMap maxOccurs="unbounded", and a
    // substrate that received devices from two sources MUST carry two maps -
    // the source is named per map, not per transfer.
    const tms = allNamed(children, 'TransferMap');
    if (tms.length > 0) {
        out.transferMaps = tms.map((tm, i) => parseTransferMap(tm, childPath(path, 'TransferMap', i), ctx));
    }
    // ALL of them, for the same reason as TransferMap: OverlayType declares
    // DeviceDataMap maxOccurs="unbounded".
    const ddms = allNamed(children, 'DeviceDataMap');
    if (ddms.length > 0) {
        out.deviceDataMaps = ddms.map((dm, i) => parseDeviceDataMap(dm, childPath(path, 'DeviceDataMap', i), ctx));
    }
    return out;
}

// ===================================================================
//  Identity constraints  (declared by the XSD, identical in every revision)
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
function sameNsNamed(el: E142XmlElement, ns: string, name: string): E142XmlElement[] {
    const out: E142XmlElement[] = [];
    for (const c of el.children) {
        if (c.namespaceUri === ns && c.localName === name) {
            out.push(c);
        }
    }
    return out;
}

/** Joins key fields into one comparable string; NUL cannot occur in XML text, so it cannot collide. */
function keyOf(...fields: string[]): string {
    return fields.join('\u0000');
}

/** Renders a key back into something readable for a diagnostic. */
function showKey(...fields: string[]): string {
    return fields.map((f) => JSON.stringify(f)).join(', ');
}

/**
 * Validates the six `xs:key` / `xs:keyref` identity constraints the schema
 * declares on `MapData` - LayoutKey, SubstrateKey, SubstrateMapKey, OverlayKey,
 * ChildLayoutRef and FromSubstrateMapRef - confirmed identical across V0211,
 * V0921, V0224 and V0125, declared identically in each. This parser requires
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
 * TWO XSD 1.0 subtleties are honored rather than "improved":
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
function checkIdentityConstraints(root: E142XmlElement, ctx: ParseContext): void {
    const ns = ctx.ns;
    const rootPath = '/MapData';

    // --- LayoutKey: unique @LayoutId over Layouts/Layout ---
    const layoutIds = new Set<string>();
    const layoutsEl = sameNsNamed(root, ns, 'Layouts')[0];
    if (layoutsEl !== undefined) {
        const layoutsPath = childPath(rootPath, 'Layouts');
        const layouts = sameNsNamed(layoutsEl, ns, 'Layout');
        for (let i = 0; i < layouts.length; i++) {
            const path = childPath(layoutsPath, 'Layout', i);
            const id = requiredAttr(layouts[i], 'LayoutId', path);
            if (layoutIds.has(id)) {
                throw new E142ParseError(
                    'E142_XML_INTEGRITY',
                    path,
                    `Duplicate LayoutId ${JSON.stringify(id)}: the LayoutKey xs:key (selector `
                    + `sm:Layouts/sm:Layout, field @LayoutId) requires it to be unique across the document `
                    + `in the XSD. With two layouts of one name, no LayoutSpecifier path `
                    + `through them has a defined meaning.`,
                );
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
                    continue;               // optional attribute; keyref not evaluated
                }
                if (!layoutIds.has(ref)) {
                    throw new E142ParseError(
                        'E142_XML_INTEGRITY',
                        childPath(cPath, 'ChildLayout', k),
                        `ChildLayout references LayoutId ${JSON.stringify(ref)}, which no <Layout> defines: `
                        + 'the ChildLayoutRef xs:keyref (refer="LayoutKey") forbids it.',
                    );
                }
            }
        }
    }

    // --- SubstrateKey: unique (@SubstrateType, @SubstrateId) over Substrates/Substrate ---
    const substratesEl = sameNsNamed(root, ns, 'Substrates')[0];
    if (substratesEl !== undefined) {
        const substratesPath = childPath(rootPath, 'Substrates');
        const seen = new Set<string>();
        const subs = sameNsNamed(substratesEl, ns, 'Substrate');
        for (let i = 0; i < subs.length; i++) {
            const path = childPath(substratesPath, 'Substrate', i);
            const type = requiredAttr(subs[i], 'SubstrateType', path);
            const id = requiredAttr(subs[i], 'SubstrateId', path);
            const key = keyOf(type, id);
            if (seen.has(key)) {
                throw new E142ParseError(
                    'E142_XML_INTEGRITY',
                    path,
                    `Duplicate Substrate (${showKey(type, id)}): the SubstrateKey xs:key (fields `
                    + `@SubstrateType + @SubstrateId) requires the pair to be unique in the XSD.`,
                );
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
    const mapKeys = new Set<string>();
    for (let i = 0; i < maps.length; i++) {
        const path = childPath(mapsPath, 'SubstrateMap', i);
        const type = requiredAttr(maps[i], 'SubstrateType', path);
        const id = requiredAttr(maps[i], 'SubstrateId', path);
        const spec = maps[i].attribute('LayoutSpecifier') ?? '';
        const key = keyOf(type, id, spec);
        if (mapKeys.has(key)) {
            throw new E142ParseError(
                'E142_XML_INTEGRITY',
                path,
                `Duplicate SubstrateMap (${showKey(type, id, spec)}): the SubstrateMapKey xs:key (fields `
                + `@SubstrateType + @SubstrateId + @LayoutSpecifier) requires the triple to be unique `
                + `in the XSD. Several maps per substrate ARE legal - with different `
                + 'LayoutSpecifiers.',
            );
        }
        mapKeys.add(key);

        const overlayKeys = new Set<string>();
        const overlays = sameNsNamed(maps[i], ns, 'Overlay');
        for (let k = 0; k < overlays.length; k++) {
            const oPath = childPath(path, 'Overlay', k);
            const name = requiredAttr(overlays[k], 'MapName', oPath);
            const version = overlays[k].attribute('MapVersion') ?? '';
            const oKey = keyOf(name, version);
            if (overlayKeys.has(oKey)) {
                throw new E142ParseError(
                    'E142_XML_INTEGRITY',
                    oPath,
                    `Duplicate Overlay (${showKey(name, version)}) inside one SubstrateMap: the OverlayKey `
                    + `xs:key (fields @MapName + @MapVersion) requires the pair to be unique per SubstrateMap `
                    + `in the XSD. Note @MapVersion defaults to "" and its default counts.`,
                );
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
                    continue;               // incomplete field set; keyref not evaluated
                }
                if (!mapKeys.has(keyOf(fromType, fromId, fromSpec))) {
                    throw new E142ParseError(
                        'E142_XML_INTEGRITY',
                        childPath(oPath, 'TransferMap', t),
                        `TransferMap sources (${showKey(fromType, fromId, fromSpec)}), which no <SubstrateMap> `
                        + `in this document declares: the FromSubstrateMapRef xs:keyref (refer=`
                        + `"SubstrateMapKey") forbids it in the XSD. This element's CONTENT is `
                        + `parsed, but a dangling reference `
                        + `invalidates the document regardless of what this engine renders.`,
                    );
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
 * A LayoutSpecifier that does not resolve is a WARNING and never an error - a
 * rule forced by the material rather than chosen: `LayoutSpecifier` is the ONE cross-reference in the schema that has NO
 * `xs:keyref` behind it (the XSD declares six identity constraints and none covers it),
 * and SEMI's own `BinCodeMap-Example.xml` ships a specifier -
 * "WaferLayout/Devices" - that resolves to nothing, because the file has no
 * `<Layouts>` element at all. A reader that errors here cannot read the
 * standard's own example. The layoutless path (dims from the payload) takes over.
 *
 * The domain module distinguishes "head not found" (returns null) from "path
 * broken below the head" (returns a typed error); both are dangling specifiers
 * here and both take the same route. What does NOT: a UNIT error, which is a
 * defect in a layout the path DID reach ("Anything else: typed error",
 * the units resolver) and stays fatal.
 * @param doc  The partially built document (its `layouts` are read).
 * @param spec The specifier string.
 * @param path The owning SubstrateMap's structural path.
 * @param ctx  The parse context.
 * @param memo The per-call memo.
 * @returns The resolved layout, or null for the layoutless path.
 * @throws {E142ParseError} `E142_XML_LAYOUT_INVALID`.
 */
function resolveLayoutFor(
    doc: E142Document,
    spec: string,
    path: string,
    ctx: ParseContext,
    memo: Map<string, ResolvedLayout | null>,
): ResolvedLayout | null {
    if (memo.has(spec)) {
        return memo.get(spec) ?? null;
    }
    let out: ResolvedLayout | null = null;
    if (spec !== '') {
        const resolved = resolveLayoutSpecifier(doc, spec);
        if (resolved instanceof E142Error) {
            if (resolved.code === 'E142_LAYOUT_PATH_BROKEN' || resolved.code === 'E142_LAYOUT_MISSING') {
                warnAt(
                    ctx,
                    'E142_XML_LAYOUT_SPECIFIER_DANGLING',
                    path,
                    `LayoutSpecifier ${JSON.stringify(spec)} does not resolve (${resolved.message}). No `
                    + `xs:keyref covers LayoutSpecifier in the XSD and SEMI's own `
                    + `BinCodeMap-Example.xml ships a dangling one, so this is a warning: the map falls back `
                    + `to the layoutless path (dims from the payload, no physical scale in the document).`,
                );
            } else {
                throw new E142ParseError('E142_XML_LAYOUT_INVALID', path, resolved.message, resolved);
            }
        } else if (resolved === null) {
            warnAt(
                ctx,
                'E142_XML_LAYOUT_SPECIFIER_DANGLING',
                path,
                `LayoutSpecifier ${JSON.stringify(spec)} names no <Layout> in this document; falling back to `
                + `the layoutless path (dims from the payload, no physical scale in the document). Legal and `
                + `expected: no xs:keyref covers LayoutSpecifier and the official BinCodeMap-Example.xml is `
                + `exactly this shape.`,
            );
        } else {
            adoptWarnings(ctx, resolved.warnings);
            out = resolved;
        }
    }
    memo.set(spec, out);
    return out;
}

/**
 * Appends the aggregated diagnostics - four kinds, one warning each - after
 * the walk, so each names its full inventory instead of
 * firing once per element.
 * @param ctx The parse context.
 */
function emitAggregatedWarnings(ctx: ParseContext): void {
    if (ctx.foreign.size > 0) {
        const parts: string[] = [];
        for (const [ns, n] of ctx.foreign) {
            parts.push(`${ns} (${n} element${n === 1 ? '' : 's'})`);
        }
        warnGlobal(
            ctx,
            'E142_XML_FOREIGN_NAMESPACE_SKIPPED',
            `Ignored elements from ${ctx.foreign.size} foreign namespace${ctx.foreign.size === 1 ? '' : 's'}: `
            + `${parts.join('; ')}. This is SEMI's own extension mechanism : a vendor schema `
            + `extends a base type via xsi:type and hangs its own elements under its own namespace, e.g. `
            + `urn:semi-org:xsd.E142-1.V0211.SubstrateMap_ACMEProductsInc. The base-schema content of the `
            + `document is unaffected and was read in full.`,
        );
    }
    if (ctx.skipped.size > 0) {
        const parts: string[] = [];
        for (const [kind, n] of ctx.skipped) {
            parts.push(`${kind} x${n}`);
        }
        warnGlobal(
            ctx,
            'E142_XML_OVERLAY_KIND_SKIPPED',
            `Skipped ${parts.join(', ')} : this engine models bin data only. Those overlays `
            + `carry device ids, substrate-to-substrate transfers and E138 ccs:PVSet parameter sets `
            + ` - the overlays themselves stay in the model, without meta or payload.`,
        );
    }
    if (ctx.lidOnly.length > 0) {
        const shown = ctx.lidOnly.slice(0, 8).map((l) => JSON.stringify(l)).join(', ');
        warnGlobal(
            ctx,
            'E142_XML_LID_ONLY_EXCLUDED',
            `${ctx.lidOnly.length} BinCode entr${ctx.lidOnly.length === 1 ? 'y carries' : 'ies carry'} a V0125 `
            + `LID but no X/Y and ${ctx.lidOnly.length === 1 ? 'was' : 'were'} EXCLUDED from the grid `
            + `(carried in the overlay's sparseBinCodes instead): ${shown}`
            + `${ctx.lidOnly.length > 8 ? `,... (+${ctx.lidOnly.length - 8} more)` : ''}. No source defines a `
            + `LID-to-coordinate resolution - the attribute is in the XSD  but its meaning is `
            + 'inferred rather than stated, which makes this handling weakly evidenced.',
        );
    }
    if (ctx.unknown.size > 0) {
        const parts: string[] = [];
        for (const [where, n] of ctx.unknown) {
            parts.push(`${where} x${n}`);
        }
        warnGlobal(
            ctx,
            'E142_XML_UNKNOWN_ELEMENT_SKIPPED',
            `Ignored ${ctx.unknown.size} element name${ctx.unknown.size === 1 ? '' : 's'} that no inspected `
            + `revision (V0211/V0921/V0224/V0125) declares in this position: ${parts.join(', ')}. Not an error `
            + `- a later revision may add elements, exactly as V0921 added DeviceDataMap  - but in `
            + `the E142 namespace an unknown name is more often a typo than a new revision.`,
        );
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
function dedupeWarnings(warnings: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
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
 *     - and, with one warning, for any other V#### (the data model has
 *    been identical across every inspected revision). The
 *    version is recorded in {@link E142Document.schemaVersion}. Anything that is
 *    not an E142.1 SubstrateMap namespace is a typed error.
 *  - DIALECTS: header data as attributes or as child elements, attribute wins
 *    on a conflict; `TopLevel="True"`; `X=""`; whitespace-padded ids; ids over
 *    their `maxLength`; unknown SubstrateType values; xsi:type extensions with
 *    foreign-namespace children; layoutless documents; overlays with no map.
 *    Each of these is warned about, none is repaired silently.
 *  - MULTI-OVERLAY: every overlay of every SubstrateMap is parsed and decoded.
 *    Which one to SHOW is the control's decision, not this parser's: no schema
 *    revision defines a default overlay (OverlayKey enforces
 *    uniqueness and nothing else), so a parser that picked one would be
 *    inventing a convention and hiding the others behind it.
 *
 * ---- What it refuses ----
 * Malformed XML, a non-E142 root, an XSD identity-constraint violation
 *, a payload the decoder rejects, a lattice that cannot be
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
export function parseE142Xml(xml: string, options?: E142XmlParseOptions): E142XmlParseResult {
    countEngineParse();         // dev instrumentation - REMOVABLE
    const provider: E142XmlDocumentParser = (options && options.parseDocument) || domParseDocument;
    let root: E142XmlElement;
    try {
        root = provider(xml);
    } catch (e) {
        throw new E142ParseError(
            'E142_XML_MALFORMED',
            '/',
            `The document is not well-formed XML: ${e instanceof Error ? e.message : String(e)}. A `
            + `truncated or malformed file is refused outright - a partially read map would render as a `
            + `complete, smaller one.`,
            e,
        );
    }
    if (root === null || typeof root !== 'object' || typeof root.localName !== 'string') {
        throw new E142ParseError(
            'E142_XML_MALFORMED',
            '/',
            'The XML provider returned no document element.',
        );
    }
    if (root.localName !== 'MapData') {
        throw new E142ParseError(
            'E142_XML_NOT_E142',
            `/${root.localName}`,
            `The document element is <${root.localName}>; E142.1 declares exactly one global element, `
            + `<MapData> of type MapDataType in the XSD.`,
        );
    }
    const match = E142_NAMESPACE_PATTERN.exec(root.namespaceUri);
    if (match === null) {
        throw new E142ParseError(
            'E142_XML_NOT_E142',
            '/MapData',
            `The document element's namespace is ${JSON.stringify(root.namespaceUri)}; an E142.1 SubstrateMap `
            + `document is in urn:semi-org:xsd.E142-1.V####.SubstrateMap. Note the schemas set `
            + `elementFormDefault="qualified", so an unqualified <MapData> is not an E142 document either.`,
        );
    }
    const schemaVersion = match[1];

    const ctx: ParseContext = {
        ns: root.namespaceUri,
        warnings: [],
        foreign: new Map<string, number>(),
        skipped: new Map<string, number>(),
        lidOnly: [],
        unknown: new Map<string, number>(),
    };
    if (E142_KNOWN_SCHEMA_VERSIONS.indexOf(schemaVersion) === -1) {
        warnGlobal(
            ctx,
            'E142_XML_NAMESPACE_VERSION_UNKNOWN',
            `Namespace version ${schemaVersion} is not one of the versions with public evidence `
            + `(${E142_KNOWN_SCHEMA_VERSIONS.join(', ')}). Parsed anyway with the V0125 model: the `
            + `data model this engine reads is byte-identical across every inspected revision, `
            + `so a newer revision is far more likely to be readable than not. Anything it added beyond the `
            + `V0125 model will surface as an unknown-element warning.`,
        );
    }

    // Identity first - see the banner above.
    checkIdentityConstraints(root, ctx);

    const rootPath = '/MapData';
    const rootChildren = childrenOf(root, ctx, rootPath, KNOWN_MAPDATA);

    const layouts: E142Layout[] = [];
    const layoutsEl = firstNamed(rootChildren, 'Layouts');
    if (layoutsEl !== null) {
        const layoutsPath = childPath(rootPath, 'Layouts');
        const els = childrenOf(layoutsEl, ctx, layoutsPath, KNOWN_LAYOUTS);
        for (let i = 0; i < els.length; i++) {
            layouts.push(parseLayout(els[i], childPath(layoutsPath, 'Layout', i), ctx));
        }
    }

    const substrates: E142Substrate[] = [];
    const substratesEl = firstNamed(rootChildren, 'Substrates');
    if (substratesEl !== null) {
        const substratesPath = childPath(rootPath, 'Substrates');
        const els = childrenOf(substratesEl, ctx, substratesPath, KNOWN_SUBSTRATES);
        for (let i = 0; i < els.length; i++) {
            substrates.push(parseSubstrate(els[i], childPath(substratesPath, 'Substrate', i), ctx));
        }
    }

    const doc: E142Document = {
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
        const memo = new Map<string, ResolvedLayout | null>();
        for (let i = 0; i < els.length; i++) {
            const path = childPath(mapsPath, 'SubstrateMap', i);
            const header = parseHeader(els[i], path, ctx);
            const overlayEls = childrenOf(els[i], ctx, path, KNOWN_SUBSTRATEMAP)
.filter((c) => c.localName === 'Overlay');
            // Resolved lazily and once per specifier: a map with no bin data
            // (the legal "declared overlay with no map yet" case) must not be
            // told its layout dangles - nothing asked.
            let layout: ResolvedLayout | null = null;
            let resolvedLayout = false;
            const overlays: E142Overlay[] = [];
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
//  Serialization: GridModel -> E142 MapData XML (export path)
// ===================================================================

/** The V0125 SubstrateMap namespace this serializer emits (the parser is namespace-tolerant). */
const E142_V0125_NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';

/**
 * The unit token a physical child should be emitted with.
 *
 * `PhysicalCoordinatesType` and `ZDimensionsType` both declare `Units`
 * `use="optional"` in the XSD, and an absent one means "the layout's
 * `DefaultUnits`". Since the emitted layout always declares `DefaultUnits="mm"`,
 * copying a value out of a source layout whose default was `um` and leaving
 * `Units` off would restate it as millimeters - a 1000x error in a document that
 * validates perfectly. So the token is always resolved and always written.
 *
 * @param own    The source element's own `Units`, if it had one.
 * @param layout The source layout, whose `DefaultUnits` is the fallback.
 * @returns The token to emit.
 */
function unitsFor(own: string | undefined, layout: E142Layout): string {
    return own !== undefined && own.trim() !== '' ? own.trim() : layout.defaultUnits;
}

/** Escapes text content for XML (`&`, `<`, `>`). */
function xmlText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Escapes an attribute value for XML (text set plus the double quote). */
function xmlAttr(s: string): string {
    return xmlText(s).replace(/"/g, '&quot;');
}

/**
 * Options for {@link gridToE142Xml} that a {@link GridModel} does not carry
 * (the frame, the source orientation and substrate type, the token encoding,
 * the identity, and any bin definitions).
 */
export interface GridToE142XmlOptions {
    /** `SubstrateMap/@SubstrateType`; empty/unknown is emitted as `Wafer` to keep the enum valid. */
    substrateType?: string;
    /** `SubstrateMap/@SubstrateId`. */
    substrateId?: string | null;
    /** `SubstrateMap/@Orientation` (the map's own; the control's display offset is NOT folded in). */
    orientation: number;
    /** OriginLocation of the frame the grid was built in. */
    originLocation: E142OriginLocation;
    /** AxisDirection of that frame. */
    axisDirection: E142AxisDirection;
    /** Bin-token encoding, needed to choose the payload form and canonicalize tokens. */
    binType: E142BinType;
    /** `Overlay/@MapName`; defaults to `"Map"`. */
    mapName?: string;
    /**
     * `Overlay/@MapVersion`. Together with `MapName` it is the overlay's identity
     * (the XSD `OverlayKey`), so it is emitted VERBATIM - never trimmed, never
     * normalized. Omitted when absent or `""`, which are the same key value.
     */
    mapVersion?: string;
    /** Bin definitions to emit under `<BinDefinitions>`, or `null`/absent to omit. */
    binDefinitions?: E142BinDefinition[] | null;
    /**
     * `Substrates/Substrate/LotId` (`LotIdType`, maxLength 80). Omitted when
     * absent or blank.
     */
    lotId?: string;
    /**
     * `Substrates/Substrate/GoodDevices` (`xs:nonNegativeInteger`). Omitted
     * unless it is a finite integer `>= 0`. Zero is a legitimate value here -
     * "no good devices" is a measurement - unlike a zero physical extent.
     */
    goodDevices?: number;
    /**
     * `Substrates/Substrate/AliasIds`. The container is emitted only when there
     * is at least one entry: `AliasIdsType` declares `AliasId` with no
     * `minOccurs`, so it defaults to 1 and an empty `<AliasIds/>` is
     * schema-INVALID in the XSD - verified against the vendored XSD.
     */
    aliasIds?: readonly E142AliasId[];
    /** `Substrates/Substrate/CarrierType` (`xs:string`). Omitted when blank. */
    carrierType?: string;
    /** `Substrates/Substrate/CarrierId` (`LotIdType`, maxLength 80). Omitted when blank. */
    carrierId?: string;
    /** `Substrates/Substrate/SlotNumber` (`xs:nonNegativeInteger`; zero is a real slot). */
    slotNumber?: number;
    /** `Substrates/Substrate/SubstrateNumber` (`xs:nonNegativeInteger`). */
    substrateNumber?: number;
    /** `Substrates/Substrate/SupplierName` (`xs:string`). Omitted when blank. */
    supplierName?: string;
    /** `Substrates/Substrate/Status` (`xs:string`, free-form - no enum). Omitted when blank. */
    status?: string;
    /**
     * `SubstrateMap/@SubstrateSide` - which physical face of the substrate the
     * map addresses.
     *
     * Emitted verbatim whenever it is supplied, `TopSide` included. See the
     * serializer's own notes for why absence is not neutral.
     */
    substrateSide?: E142SubstrateSide;
    /**
     * `TransferMap` records to re-emit, flattened across the source's transfer
     * overlays.
     *
     * FLATTENED ON PURPOSE. `OverlayType` is an `xs:choice` and declares
     * `TransferMap` `maxOccurs="unbounded"`, so every transfer of a substrate may
     * legally live in ONE overlay - which is what this emits. The source's
     * grouping into several overlays, and their names, are not reproduced; only
     * the transfers themselves are, and they are what carries the provenance.
     *
     * EACH IS EMITTED ONLY IF ITS REFERENCE RESOLVES. The three `From*`
     * attributes are an `xs:keyref` (`FromSubstrateMapRef` -> `SubstrateMapKey`)
     * onto a `SubstrateMap` in the SAME document, and this serializer emits
     * exactly one `SubstrateMap`. So a `TransferMap` survives the round trip only
     * when it points at that one - a self-reference. Anything else is dropped
     * with a warning rather than written out dangling, because a dangling keyref
     * makes the WHOLE document invalid: one unresolvable transfer would take the
     * bin codes down with it.
     */
    transferMaps?: readonly E142TransferMap[];
    /**
     * `MapName` for the emitted transfer overlay. Defaults to `'Transfers'`.
     *
     * A separate overlay is not a choice: `OverlayType`'s `xs:choice` means one
     * overlay carries a `BinCodeMap` OR `TransferMap`s, never both. `OverlayKey`
     * is (`@MapName`, `@MapVersion`), so this must differ from
     * {@link GridToE142XmlOptions.mapName} - if it does not, a suffix is added
     * rather than emitting a duplicate key.
     */
    transferOverlayName?: string;
    /**
     * Called for each non-fatal problem the serializer decides to work around.
     *
     * A CALLBACK rather than a changed return type. `gridToE142Xml` returns the
     * document as a `string`, and every existing caller and suite depends on
     * that; widening it to `{ xml, warnings }` for one diagnostic would be a
     * breaking change to a stable API for the sake of a rare path.
     *
     * Today exactly one thing reports here: a `TransferMap` dropped because its
     * `From*` reference cannot be satisfied. Silence means nothing was worked
     * around.
     *
     * @param code    A stable `E142_XML_*` code.
     * @param message A human-readable explanation.
     */
    onWarning?: (code: string, message: string) => void;
    /**
     * The source document's DEVICE layout - the deepest one on its
     * `LayoutSpecifier` path - when the caller has it.
     *
     * A {@link GridModel} carries geometry, not provenance: it knows the pitch
     * and the drawn extent because those became a placement, and knows nothing
     * about `LowerLeft`, `Z`, the two image URIs, `ProductId` or the `Package`
     * flag, none of which affect placement. Supplying the layout lets those
     * survive an export instead of being silently dropped.
     *
     * Values here are PREFERRED over the derived ones where both exist, because
     * the source is the more faithful of the two: a `DeviceSize` that came from
     * the document is exactly what the document said, whereas the placement's
     * `cellWmm` has been through a unit conversion and a quadrant swap.
     *
     * UNITS. Every physical value taken from here is emitted with an explicit
     * `Units` attribute - the source element's own if it had one, otherwise the
     * source LAYOUT's `DefaultUnits`. That is not decoration: the emitted layout
     * declares `DefaultUnits="mm"`, so a bare value copied from a document whose
     * layout was in microns would be silently reinterpreted as millimeters, a
     * 1000x error that validates cleanly.
     */
    sourceLayout?: E142Layout;
    /**
     * The substrate's own size in millimeters, emitted as `DeviceSize` on the
     * TOP-LEVEL layout - E142-0225 Table 2: "If this is the top level layout,
     * then this defines the size of the substrate itself."
     *
     * Optional and never defaulted. A {@link GridModel} knows the device lattice,
     * not the wafer it sits on, so there is nothing here to derive a substrate
     * size from; the control's outline is a rendering concern and is not the
     * same claim. Absent means the element is omitted, which Table 2 permits
     * ("If not present, then DeviceSize is not defined"). Inventing a plausible
     * number would be worse than omitting a true one: a consumer cannot tell a
     * measured substrate size from a guessed one.
     */
    substrateSizeMm?: { x: number; y: number };
}

/**
 * Serializes a built {@link GridModel} back to an E142 `MapData` XML document -
 * the inverse of {@link parseE142Xml} (the parser was import-only; this adds
 * the export path). Round-trips: feeding the result back through
 * {@link parseE142Xml} (with any conforming DOM) reproduces the same cells.
 *
 * LAYOUT TREE - two levels, not one. E142-0225 Table 2, `Dimension` row:
 * "The number of columns (X-axis) and rows (Y-axis) in the layout. If this is
 * the top level layout then X=1, Y=1." The device matrix
 * therefore cannot live on the top-level layout; it belongs to a child, and the
 * top level exists to carry the substrate. So the emitted document is:
 *
 *   Layout `L0`          TopLevel="true", Dimension 1x1, ChildLayouts -> L0_Devices
 *   Layout `L0_Devices`  Dimension cols x rows, StepSize from the placement
 *   SubstrateMap         LayoutSpecifier="L0/L0_Devices"
 *
 * THIS RULE IS PROSE-NORMATIVE ONLY AND NOT XSD-ENFORCED. `LayoutType/Dimension`
 * is a plain `LogicalCoordinatesType` with required integer X/Y and no facet, and
 * no identity constraint ties a `TopLevel="true"` layout's Dimension to 1x1. The
 * previous single-layout output - device matrix on the top level - was and is
 * fully XSD-valid: `xmllint` cannot catch this class of defect, and a validation
 * gate that passes says nothing about it. Only a semantic assertion can.
 *
 * Half of the new structure IS schema-checked and half is not, which is worth
 * knowing before trusting a green validator: `ChildLayout/@LayoutId` is the
 * target of the `ChildLayoutRef` keyref onto `LayoutKey` in the XSD, so a
 * child reference naming a non-existent layout is caught; but
 * `SubstrateMap/@LayoutSpecifier` is NOT a keyref - it is an `xs:string`
 * participating in `SubstrateMapKey` in the XSD - so the "L0/L0_Devices"
 * path itself validates whatever it names, including nothing.
 *
 * SUBSTRATES. A `<Substrates>` block is emitted between `<Layouts>` and
 * `<SubstrateMaps>` whenever the substrate has an identity, carrying whichever
 * of the NINE `SubstrateType` children the caller supplied, in the XSD's own
 * sequence order: `LotId`, `AliasIds`, `CarrierType`, `CarrierId`, `SlotNumber`,
 * `SubstrateNumber`, `GoodDevices`, `SupplierName`, `Status` in the XSD.
 * Every one is `minOccurs="0"`, so any subset is a valid document.
 *
 * `AliasIds` is the one child that is not a leaf. Its container is emitted only
 * when there is at least one entry, because `AliasIdsType` declares `AliasId`
 * without `minOccurs` - which defaults to 1 - so an empty `<AliasIds/>` is
 * schema-invalid. Both `@Type` and `@Value` are `use="required"`, so an entry
 * with an empty value is written as `Value=""` rather than dropped: the alias
 * still carries its `@Type`, and dropping the entry would lose that as well.
 * The parser warns about the empty value on the way back in.
 *
 * The `(SubstrateType, SubstrateId)` pair is taken from the SAME locals the
 * `SubstrateMap` element uses, not recomputed. `SubstrateKey` selects
 * `Substrates/Substrate` on that pair and `SubstrateMapKey` selects
 * `SubstrateMaps/SubstrateMap` on it plus `LayoutSpecifier` in the XSD: the
 * two elements are joined by those fields, so a mismatch would not be a cosmetic
 * inconsistency but a substrate record describing a different substrate.
 *
 * NO IDENTITY, NO BLOCK. With an empty `substrateId` there is nothing to key a
 * `Substrate` on - `SubstrateId` is `use="required"` - so the whole element is
 * omitted, which `Substrates` `minOccurs="0"` allows. Any `lotId` / `goodDevices`
 * supplied alongside an empty id is therefore dropped: attaching them to a
 * blank-keyed record would assert that a substrate with no identity has a lot.
 *
 * Blank strings are treated as absent for the three text children, because the
 * parser trims them on the way in - `<LotId>   </LotId>` reads back as `""`, so
 * emitting it would claim a lot id that is not one. This is deliberately NOT the
 * `MapVersion` rule below, where trimming is forbidden: `MapVersion` is half of
 * the `OverlayKey` and whitespace there is a different key, whereas none of these
 * four participates in any key.
 *
 * MAP VERSION. `Overlay/@MapVersion` is emitted when non-empty and omitted
 * otherwise. This is not the `SubstrateSide` policy above, and the difference is
 * deliberate: `MapVersion` is declared `use="optional" default=""` in the XSD
 * and is a FIELD OF THE OVERLAY'S IDENTITY - the `OverlayKey` xs:key selects
 * `sm:Overlay` on (`@MapName`, `@MapVersion`) in the XSD. An
 * absent `MapVersion` and `MapVersion=""` are therefore not merely equivalent in
 * meaning, they are the SAME KEY, and this parser already relies on that when it
 * checks overlay uniqueness. Emitting `MapVersion=""` would add a byte that
 * changes nothing and invites a reader to believe an empty version was asserted
 * rather than defaulted.
 *
 * The value is passed through UNTOUCHED - not trimmed, not case-folded. Trimming
 * looks like a tidy-up and is not one: `MapVersion=" "` and `MapVersion=""` are
 * different keys, so silently collapsing whitespace would re-identify the
 * overlay. Only the exact empty string is treated as "no version".
 *
 * SUBSTRATE SIDE - policy: EMIT WHENEVER KNOWN, INCLUDING `TopSide`.
 *
 * The attribute is declared `use="optional" default="TopSide"` in the XSD,
 * which makes its absence an assertion rather than a silence: a document with no
 * `SubstrateSide` does not say "side unknown", it says `TopSide`. That is why
 * dropping it was not a loss of detail but a corruption - a `BottomSide` map
 * round-tripped into a document that positively claims the opposite face, and
 * `SubstrateSide` is a coordinate-system attribute (E142-0225 Tables 4, 9, 14, 16
 * and Figure R2-17, "Example Where Translation Is Required as SubstrateSide
 * Differs", page 41), so the claim propagates into how every coordinate in the
 * document is read.
 *
 * Of the two available policies, "emit only when != TopSide" is defensible - the
 * default is normative, so the omission is technically correct - but it leaves
 * the common case depending on every consumer applying an XSD default, which a
 * schema-unaware reader parsing attributes directly will not do. Emitting the
 * value whenever it is known costs one attribute and removes that dependency, so
 * that is the policy here, applied consistently: supplied means emitted, always.
 *
 * When `substrateSide` is NOT supplied the attribute is omitted, and the document
 * therefore asserts `TopSide` by default. That is unavoidable - the enum has no
 * "unknown" member and the attribute has a default, so there is no way to write
 * a document that declines to answer. It is the caller's assertion to make;
 * nothing is invented here to paper over it.
 *
 * Attribute ORDER (`SubstrateType`, `SubstrateId`, `LayoutSpecifier`,
 * `SubstrateSide`, `Orientation`, `OriginLocation`, `AxisDirection`) follows the
 * XSD's declaration order. XML attribute order carries no meaning and no
 * validator checks it; it is matched deliberately so a hand-diff against the
 * schema, or against another producer's output, lines up.
 *
 * DEVICE SIZE. The child layout carries `DeviceSize` - the DRAWN extent of one
 * device - alongside `StepSize`, the full pitch. E142-0225 Table 2, `StepSize`
 * row: "StepSize - DeviceSize is equal to the 'street' width between devices."
 * Emitting only `StepSize` therefore does not merely lose
 * detail, it asserts a street width of zero: a 5 mm pitch with a 4 mm device
 * re-imports as a 5 mm device, because the parser's documented fallback when
 * `DeviceSize` is absent is `deviceSize = stepSize`. The value comes from
 * `placement.cellWmm` / `cellLmm`, which the parser produced from the source's
 * own `DeviceSize` on the way in, so a street survives the round trip instead of
 * being silently closed.
 *
 * Emitted only when both extents are finite and strictly positive - `DeviceSize`
 * declares X and Y `use="required"` in the XSD, so a half-known size cannot
 * be expressed and is omitted whole. `Units="mm"` is stated explicitly rather
 * than relying on the layout's `DefaultUnits`.
 *
 * On the TOP-LEVEL layout `DeviceSize` means something different - the substrate's
 * own size, not a device's (Table 2) - and is emitted only when the caller passes
 * {@link GridToE142XmlOptions.substrateSizeMm}. It is never derived.
 *
 * The remaining Table 2 top-level rules are satisfied by omission, which the
 * table explicitly permits in E142-0225's own words: `LowerLeft` absent means
 * X=0, Y=0 (required of a top-level layout); `Z` absent means Order=0,
 * Height=0 (likewise); and `TopLevel` absent on `L0_Devices` is the same as
 * `TopLevel=False`, which the table says "may be omitted from child" layouts.
 * `DeviceSize` on the top level would be the substrate's own size - not emitted
 * here, because a GridModel does not carry it.
 *
 * The rest is the canonical minimal form the parser accepts: one `SubstrateMap`
 * carrying one `Overlay`/`BinCodeMap`. The header frame and orientation are
 * attributes on `SubstrateMap` (the form the XSD declares, which the parser's
 * `dialectValue` reads); `orientation` is the SOURCE map's, since the control's
 * `E142OrientationOffset` is a display correction (see {@link gridToGridData}).
 *
 * PAYLOAD FORM (identical rationale to {@link gridToGridData}): `Ascii` emits the
 * compact `2DArray` - one `<BinCode>` per full row of single-character tokens.
 * Numeric encodings emit the sparse `Coordinate` form - one `<BinCode X="" Y="">`
 * per non-null cell carrying the EXACT canonical token - which round-trips every
 * BinType without depending on fixed-width concatenation.
 * Not a SEMI assumption: this is the inverse of an existing contract, and the
 * frame it round-trips through is the parser's own logical frame.
 *
 * @param grid The built grid (its `placement` supplies the pitch).
 * @param opts The non-geometric fields a GridModel does not carry.
 * @returns A well-formed E142 `MapData` XML string.
 */
export function gridToE142Xml(grid: GridModel, opts: GridToE142XmlOptions): string {
    const { cols, rows, cells, binTable, placement } = grid;
    const nullToken = binTable.length > 0 ? binTable[0].code : '';
    // The grid, its pitch and its cell extent are all in the MAP frame. `Layout`
    // is not: it is layout-frame by construction, because one Layout may be
    // referenced by several SubstrateMaps at different Orientations (E142-0225
    // 12.1.2), so it cannot hold per-map values. Undo the `Orientation` swap on
    // everything that goes into `<Layout>`; the payload below stays map-frame,
    // which is what Table 12 asks of it.
    const swap = mapFrameSwapsAxes(opts.orientation);
    const mapStepX = Math.hypot(placement.colStepXmm, placement.colStepYmm);
    const mapStepY = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
    const layoutCols = swap ? rows : cols;
    const layoutRows = swap ? cols : rows;
    const stepXmm = swap ? mapStepY : mapStepX;
    const stepYmm = swap ? mapStepX : mapStepY;
    // DeviceSize is all-or-nothing: X and Y are both use="required", so a
    // half-known extent cannot be expressed and the element is dropped whole.
    const deviceSize = swap
        ? positiveXY(placement.cellLmm, placement.cellWmm)
        : positiveXY(placement.cellWmm, placement.cellLmm);
    const substrateSize = opts.substrateSizeMm !== undefined
        ? positiveXY(opts.substrateSizeMm.x, opts.substrateSizeMm.y)
        : null;
    // Substrate record children. Blank text is absent (the parser trims), and
    // GoodDevices must survive xs:nonNegativeInteger or it is not emitted at all.
    const substrateChildren: string[] = [];
    const textChild = (name: string, v: string | undefined): void => {
        if (typeof v === 'string' && v.trim() !== '') {
            substrateChildren.push(`      <${name}>${xmlText(v)}</${name}>`);
        }
    };
    // xs:nonNegativeInteger children. Zero is emitted - it is a value, not an
    // absence (E142-0225 Table 6 calls these "Positive Integer" but the schema
    // says non-negative, and the schema is what the document is validated
    // against). A negative, fractional or non-finite number is not a count and
    // is dropped rather than written out as schema-invalid.
    const intChild = (name: string, v: number | undefined): void => {
        if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0) {
            substrateChildren.push(`      <${name}>${v}</${name}>`);
        }
    };
    // XSD sequence order: LotId, AliasIds, CarrierType, CarrierId, SlotNumber,
    // SubstrateNumber, GoodDevices, SupplierName, Status in the XSD.
    textChild('LotId', opts.lotId);
    if (opts.aliasIds !== undefined && opts.aliasIds.length > 0) {
        substrateChildren.push('      <AliasIds>');
        for (const a of opts.aliasIds) {
            // Both attributes are use="required", so neither can be omitted. An
            // empty @Value is emitted as "" rather than dropping the entry: the
            // alias still carries its @Type, and dropping it would lose that too.
            // The parser warns about the empty value on the way back in.
            substrateChildren.push(
                `        <AliasId Type="${xmlAttr(a.type)}" Value="${xmlAttr(a.value)}"/>`,
            );
        }
        substrateChildren.push('      </AliasIds>');
    }
    textChild('CarrierType', opts.carrierType);
    textChild('CarrierId', opts.carrierId);
    intChild('SlotNumber', opts.slotNumber);
    intChild('SubstrateNumber', opts.substrateNumber);
    intChild('GoodDevices', opts.goodDevices);
    textChild('SupplierName', opts.supplierName);
    textChild('Status', opts.status);

    // Half of the overlay's identity. Verbatim, and omitted only for the exact
    // empty string - "" and absent are the same OverlayKey value.
    const version = (opts.mapVersion !== undefined && opts.mapVersion !== '')
        ? ` MapVersion="${xmlAttr(opts.mapVersion)}"`
        : '';
    // Emitted whenever known, TopSide included: absence is not silence, it is a
    // TopSide claim (the attribute's XSD default). Nothing is substituted when
    // the caller supplies nothing.
    const side = opts.substrateSide !== undefined ? ` SubstrateSide="${opts.substrateSide}"` : '';
    const substrateType = (opts.substrateType && opts.substrateType !== '') ? opts.substrateType : 'Wafer';
    /*
     * The parser tolerates an unrecognized SubstrateType with a warning, because
     * it may never be stricter than the schema. The EXPORTER inherits the token
     * and would otherwise write a document that SubstrateTypeEnum rejects, with
     * nothing said about it - tolerant on the way in, silently invalid on the way
     * out.
     *
     * Reported, not refused, and not substituted. Refusing would make the
     * exporter stricter than the parser; substituting would invent a substrate
     * type the source never claimed.
     */
    if (!(SUBSTRATE_TYPES as readonly string[]).includes(substrateType)) {
        opts.onWarning?.(
            'E142_XML_EXPORT_SUBSTRATE_TYPE_UNKNOWN',
            `SubstrateType=${JSON.stringify(substrateType)} is not a member of SubstrateTypeEnum `
            + `(${SUBSTRATE_TYPES.join(', ')}). The emitted document WILL NOT VALIDATE against `
            + 'the E142.1 XSD. It is carried through verbatim rather than replaced, because replacing '
            + 'it would invent a substrate type the source never claimed.',
        );
    }
    const substrateId = opts.substrateId ?? '';
    const mapName = opts.mapName ?? 'Map';

    const L: string[] = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push(`<MapData xmlns="${E142_V0125_NS}">`);
    L.push('  <Layouts>');
    // Top level: the substrate. Dimension is 1x1 per Table 2, NOT the device
    // matrix - that hangs off it as a child layout.
    L.push('    <Layout LayoutId="L0" DefaultUnits="mm" TopLevel="true">');
    L.push('      <Dimension X="1" Y="1"/>');
    // Table 2: on a TOP-LEVEL layout DeviceSize is the substrate's own size.
    // Only ever emitted from an explicit caller-supplied value - never derived.
    if (substrateSize !== null) {
        L.push(`      <DeviceSize X="${substrateSize.x}" Y="${substrateSize.y}" Units="mm"/>`);
    }
    L.push('      <ChildLayouts><ChildLayout LayoutId="L0_Devices"/></ChildLayouts>');
    L.push('    </Layout>');
    // Device layout: the real matrix, the drawn device extent and the pitch.
    // TopLevel is omitted, which Table 2 states is the same as TopLevel=False.
    // Sequence order is fixed by the XSD: Dimension, LowerLeft, DeviceSize,
    // StepSize, Z, TopImage, BottomImage, ProductId, ChildLayouts.
    // Sequence order is fixed by the XSD and strict: Dimension, LowerLeft,
    // DeviceSize, StepSize, Z, TopImage, BottomImage, ProductId, ChildLayouts
    // in the XSD. Everything below follows it.
    const src = opts.sourceLayout;
    const pkg = src !== undefined && src.package ? ' Package="true"' : '';
    L.push(`    <Layout LayoutId="L0_Devices" DefaultUnits="mm"${pkg}>`);
    L.push(`      <Dimension X="${layoutCols}" Y="${layoutRows}"/>`);
    if (src !== undefined && src.lowerLeft !== undefined) {
        const ll = src.lowerLeft;
        L.push(`      <LowerLeft X="${ll.x}" Y="${ll.y}" Units="${xmlAttr(unitsFor(ll.units, src))}"/>`);
    }
    const srcDeviceSize = src !== undefined && src.deviceSize !== undefined
        ? positiveXY(src.deviceSize.x, src.deviceSize.y)
        : null;
    if (src !== undefined && srcDeviceSize !== null) {
        // Preferred over the derived extent: this is what the document said,
        // before a unit conversion and a possible quadrant swap.
        //
        // But only when it passes the same guard everything physical passes.
        // A source may state <DeviceSize X="0" Y="0"/> - the official
        // microns example does - and zero is not a measurement, it is a
        // missing one (Table 2 gives "not present" a defined meaning that a
        // zero would misrepresent). Copying it through would export a
        // degenerate cell that re-imports at zero extent, where the derived
        // path correctly falls back to the pitch. Fidelity to a source means
        // its measurements, not its defects.
        L.push(`      <DeviceSize X="${srcDeviceSize.x}" Y="${srcDeviceSize.y}"`
            + ` Units="${xmlAttr(unitsFor(src.deviceSize?.units, src))}"/>`);
    } else if (deviceSize !== null) {
        L.push(`      <DeviceSize X="${deviceSize.x}" Y="${deviceSize.y}" Units="mm"/>`);
    }
    // Same guard for the pitch: a zero StepSize is not a lattice.
    const srcStepSize = src !== undefined && src.stepSize !== undefined
        ? positiveXY(src.stepSize.x, src.stepSize.y)
        : null;
    if (src !== undefined && srcStepSize !== null) {
        L.push(`      <StepSize X="${srcStepSize.x}" Y="${srcStepSize.y}"`
            + ` Units="${xmlAttr(unitsFor(src.stepSize?.units, src))}"/>`);
    } else {
        L.push(`      <StepSize X="${stepXmm}" Y="${stepYmm}" Units="mm"/>`);
    }
    if (src !== undefined && src.z !== undefined) {
        // Order and Height are both use="optional" with default 0 in the XSD,
        // and the PARSER MATERIALIZES those defaults - `<Z Order="3"/>` arrives
        // as {order: 3, height: 0}. "Stated" and "defaulted" are therefore not
        // distinguishable here, so both attributes are written whenever the
        // model has them. `<Z Order="3" Height="0"/>` and `<Z Order="3"/>` mean
        // the same thing to any conforming reader; being explicit costs nothing
        // and removes a dependency on the reader applying the default.
        let a = '';
        if (src.z.order !== undefined) { a += ` Order="${src.z.order}"`; }
        if (src.z.height !== undefined) {
            a += ` Height="${src.z.height}" Units="${xmlAttr(unitsFor(src.z.units, src))}"`;
        }
        L.push(`      <Z${a}/>`);
    }
    if (src !== undefined && src.topImage !== undefined) {
        L.push(`      <TopImage>${xmlText(src.topImage)}</TopImage>`);
    }
    if (src !== undefined && src.bottomImage !== undefined) {
        L.push(`      <BottomImage>${xmlText(src.bottomImage)}</BottomImage>`);
    }
    if (src !== undefined && src.productId !== undefined) {
        L.push(`      <ProductId>${xmlText(src.productId)}</ProductId>`);
    }
    L.push('    </Layout>');
    L.push('  </Layouts>');
    if (substrateId !== '') {
        L.push('  <Substrates>');
        const open = `    <Substrate SubstrateType="${xmlAttr(substrateType)}" SubstrateId="${xmlAttr(substrateId)}"`;
        if (substrateChildren.length === 0) {
            L.push(open + '/>');
        } else {
            L.push(open + '>');
            for (const child of substrateChildren) { L.push(child); }
            L.push('    </Substrate>');
        }
        L.push('  </Substrates>');
    }
    L.push('  <SubstrateMaps>');
    L.push(
        `    <SubstrateMap SubstrateType="${xmlAttr(substrateType)}" SubstrateId="${xmlAttr(substrateId)}"`
        + ` LayoutSpecifier="L0/L0_Devices"${side} Orientation="${opts.orientation}"`
        + ` OriginLocation="${opts.originLocation}" AxisDirection="${opts.axisDirection}">`,
    );
    L.push(`      <Overlay MapName="${xmlAttr(mapName)}"${version}>`);

    const isCoord = opts.binType !== 'Ascii';
    L.push(`        <BinCodeMap BinType="${opts.binType}" NullBin="${xmlAttr(nullToken)}" MapType="${isCoord ? 'Coordinate' : '2DArray'}">`);
    if (opts.binDefinitions && opts.binDefinitions.length > 0) {
        L.push('          <BinDefinitions>');
        for (const d of opts.binDefinitions) {
            let a = `BinCode="${xmlAttr(d.binCode)}"`;
            if (d.binQuality !== '') { a += ` BinQuality="${xmlAttr(d.binQuality)}"`; }
            if (d.binDescription !== '') { a += ` BinDescription="${xmlAttr(d.binDescription)}"`; }
            if (d.binCount !== undefined) { a += ` BinCount="${d.binCount}"`; }
            if (d.pick) { a += ' Pick="true"'; }
            L.push(`            <BinDefinition ${a}/>`);
        }
        L.push('          </BinDefinitions>');
    }
    if (isCoord) {
        for (let serRow = 0; serRow < rows; serRow++) {
            for (let serCol = 0; serCol < cols; serCol++) {
                const idx = cells[serRow * cols + serCol];
                if (idx === 0) { continue; }
                const { x, y } = indexToMapCoord(serCol, serRow, opts.originLocation, opts.axisDirection, cols, rows);
                L.push(`          <BinCode X="${x}" Y="${y}">${xmlText(binTable[idx].code)}</BinCode>`);
            }
        }
    } else {
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

    /*
     * Transfers, in their own overlay. Emitted last so the bin codes are never
     * at risk: a TransferMap whose From* triple does not resolve is DROPPED here,
     * not written, because `xmllint` rejects the entire document for one dangling
     * keyref - the bin codes would be lost to a provenance record.
     *
     * "Resolves" means: matches the one SubstrateMap this document contains, on
     * all three fields of SubstrateMapKey.
     */
    if (opts.transferMaps !== undefined && opts.transferMaps.length > 0) {
        const selfType = substrateType;
        const selfId = substrateId;
        const selfSpec = 'L0/L0_Devices';
        const keep = opts.transferMaps.filter(
            (tm) => tm.fromSubstrateType === selfType
                && tm.fromSubstrateId === selfId
                && tm.fromLayoutSpecifier === selfSpec,
        );
        const dropped = opts.transferMaps.length - keep.length;
        if (dropped > 0) {
            opts.onWarning?.(
                'E142_XML_TRANSFER_UNRESOLVABLE',
                    `${dropped} TransferMap${dropped === 1 ? '' : 's'} ${dropped === 1 ? 'was' : 'were'} NOT `
                    + 'emitted: each names a source substrate that is not in this document, and the '
                    + 'FromSubstrateMapRef keyref would dangle. This serializer writes ONE SubstrateMap '
                    + `(${selfType}, ${selfId === '' ? '(empty)' : selfId}, ${selfSpec}), so only a transfer `
                    + 'referencing THAT one can be carried. Emitting a dangling reference would make the whole '
                    + 'document fail validation and take the bin codes with it.',
            );
        }
        if (keep.length > 0) {
            let tName = opts.transferOverlayName ?? 'Transfers';
            if (tName === mapName) {
                // OverlayKey is (MapName, MapVersion); a duplicate is invalid.
                tName = tName + '-Transfers';
            }
            L.push(`      <Overlay MapName="${xmlAttr(tName)}">`);
            for (const tm of keep) {
                L.push(
                    `        <TransferMap FromSubstrateType="${xmlAttr(tm.fromSubstrateType)}"`
                    + ` FromSubstrateId="${xmlAttr(tm.fromSubstrateId)}"`
                    + ` FromSubstrateLayoutSpecifier="${xmlAttr(tm.fromLayoutSpecifier)}">`,
                );
                for (const t of tm.transfers) {
                    // Attribute order is the XSD's declaration order: FX FY FID
                    // TX TY TID. Absent attributes are omitted, never written as
                    // empty - `xs:integer` has no empty lexical form.
                    let a = '';
                    if (t.fx !== undefined) { a += ` FX="${t.fx}"`; }
                    if (t.fy !== undefined) { a += ` FY="${t.fy}"`; }
                    if (t.fid !== undefined) { a += ` FID="${xmlAttr(t.fid)}"`; }
                    if (t.tx !== undefined) { a += ` TX="${t.tx}"`; }
                    if (t.ty !== undefined) { a += ` TY="${t.ty}"`; }
                    if (t.tid !== undefined) { a += ` TID="${xmlAttr(t.tid)}"`; }
                    L.push(`          <T${a}/>`);
                }
                L.push('        </TransferMap>');
            }
            L.push('      </Overlay>');
        }
    }
    L.push('    </SubstrateMap>');
    L.push('  </SubstrateMaps>');
    L.push('</MapData>');
    return L.join('\n');
}


// ===================================================================
//  E142Document -> XML
//
//  The missing half of the transport symmetry. E142 specifies a DATA MODEL and an
//  XML representation of it for transport; this engine holds the model as
//  `E142Document` and reads both representations into it through one parser. Until
//  now it could only write one of them back out: `e142DocumentToJson` existed and
//  the XML side had `gridToE142Xml`, which starts from `GridModel` - the control's
//  flat single-map render structure - and therefore cannot express a second
//  substrate map, a second overlay, a TransferMap or a DeviceDataMap at all.
//
//  This is the model's own serializer, and it mirrors `e142DocumentToJson`
//  decision for decision:
//
//   - member ORDER is the XSD's `xs:sequence`, so output is byte-stable and a
//     hand-diff against the schema lines up;
//   - absent / empty / present stay three states, because E142 distinguishes them;
//   - `SubstrateSide` is written whenever known, TopSide included: its absence
//     ASSERTS the top face and that assertion propagates into every coordinate;
//   - a payload is written from `sparseBinCodes` where the parser kept them and
//     re-encoded from the decoded cells where it did not, through the SAME
//     `encodePayloadRows` and `buildLogicalTable` the JSON serializer uses.
//
//  WHAT IT IS NOT. It does not reproduce a source file byte for byte, and cannot:
//  the model does not retain original row text, whitespace, attribute order,
//  comments, unknown members or foreign-namespace subtrees. That limit belongs to
//  the model and applies to the JSON serializer identically. The round trip this
//  supports is over the MODEL - `doc -> xml -> doc` - which is the one that means
//  anything.
// ===================================================================

/** Options of {@link e142DocumentToXml}. */
export interface E142DocumentToXmlOptions {
    /** Indent step in spaces. Default 2; 0 emits one line. */
    readonly indent?: number;
}

/**
 * Serializes an {@link E142Document} back to SEMI E142.1 MapData XML.
 * @param doc     The document.
 * @param options Optional formatting.
 * @returns The XML text, with an XML declaration.
 * @see e142DocumentToJson for the same document in the other transport.
 */
export function e142DocumentToXml(doc: E142Document, options?: E142DocumentToXmlOptions): string {
    const step = options?.indent ?? 2;
    const nl = step > 0 ? '\n' : '';
    const pad = (d: number): string => (step > 0 ? ' '.repeat(d * step) : '');
    const out: string[] = [];
    const open = (d: number, name: string, attrs: string[], selfClose = false): void => {
        out.push(`${pad(d)}<${name}${attrs.join('')}${selfClose ? '/>' : '>'}`);
    };
    const close = (d: number, name: string): void => { out.push(`${pad(d)}</${name}>`); };
    /** An attribute, or nothing when the value is absent. Empty string IS a value. */
    const attr = (name: string, v: string | number | boolean | undefined): string =>
        (v === undefined ? '' : ` ${name}="${xmlAttr(String(v))}"`);
    /** A text child, or nothing when absent. */
    const text = (d: number, name: string, v: string | number | undefined): void => {
        if (v !== undefined) { out.push(`${pad(d)}<${name}>${xmlText(String(v))}</${name}>`); }
    };
    /** `PhysicalCoordinatesType`: X and Y required, Units optional. */
    const physical = (d: number, name: string, c: E142PhysicalCoordinates | undefined): void => {
        if (c === undefined) { return; }
        open(d, name, [attr('X', c.x), attr('Y', c.y), attr('Units', c.units)], true);
    };

    out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    open(0, 'MapData', [attr('xmlns', doc.namespaceUri ?? E142_V0125_NS)]);

    /* ---- Layouts ---- */
    if (doc.layouts.length > 0) {
        open(1, 'Layouts', []);
        for (const l of doc.layouts) {
            open(2, 'Layout', [
                attr('LayoutId', l.layoutId),
                attr('DefaultUnits', l.defaultUnits),
                // XSD default false: written only when true, so an absent attribute
                // and a false one say the same thing and a round trip cannot
                // invent a difference between them.
                l.topLevel ? attr('TopLevel', 'true') : '',
                l.package ? attr('Package', 'true') : '',
            ]);
            open(3, 'Dimension', [attr('X', l.dimension.x), attr('Y', l.dimension.y)], true);
            physical(3, 'LowerLeft', l.lowerLeft);
            physical(3, 'DeviceSize', l.deviceSize);
            physical(3, 'StepSize', l.stepSize);
            if (l.z !== undefined) {
                open(3, 'Z', [attr('Order', l.z.order), attr('Height', l.z.height),
                    attr('Units', l.z.units)], true);
            }
            text(3, 'TopImage', l.topImage);
            text(3, 'BottomImage', l.bottomImage);
            text(3, 'ProductId', l.productId);
            if (l.childLayouts.length > 0) {
                open(3, 'ChildLayouts', []);
                for (const c of l.childLayouts) {
                    open(4, 'ChildLayout', [attr('LayoutId', c)], true);
                }
                close(3, 'ChildLayouts');
            }
            close(2, 'Layout');
        }
        close(1, 'Layouts');
    }

    /* ---- Substrates: children in the XSD's xs:sequence order ---- */
    if (doc.substrates.length > 0) {
        open(1, 'Substrates', []);
        for (const sub of doc.substrates) {
            open(2, 'Substrate',
                [attr('SubstrateType', sub.substrateType), attr('SubstrateId', sub.substrateId)]);
            text(3, 'LotId', sub.lotId);
            if (sub.aliasIds !== undefined && sub.aliasIds.length > 0) {
                open(3, 'AliasIds', []);
                for (const a of sub.aliasIds) {
                    open(4, 'AliasId', [attr('Type', a.type), attr('Value', a.value)], true);
                }
                close(3, 'AliasIds');
            }
            text(3, 'CarrierType', sub.carrierType);
            text(3, 'CarrierId', sub.carrierId);
            text(3, 'SlotNumber', sub.slotNumber);
            text(3, 'SubstrateNumber', sub.substrateNumber);
            // Zero is a value, not an absence: xs:nonNegativeInteger, whatever
            // Table 6 calls it.
            text(3, 'GoodDevices', sub.goodDevices);
            text(3, 'SupplierName', sub.supplierName);
            text(3, 'Status', sub.status);
            close(2, 'Substrate');
        }
        close(1, 'Substrates');
    }

    /* ---- SubstrateMaps ---- */
    if (doc.substrateMaps.length > 0) {
        open(1, 'SubstrateMaps', []);
        for (const map of doc.substrateMaps) {
            const h = map.header;
            open(2, 'SubstrateMap', [
                attr('SubstrateType', h.substrateType),
                attr('SubstrateId', h.substrateId),
                // "" is the layoutless form and a VALUE; never omitted.
                attr('LayoutSpecifier', h.layoutSpecifier),
                attr('SubstrateSide', h.substrateSide),
                attr('Orientation', h.orientation),
                attr('OriginLocation', h.originLocation),
                attr('AxisDirection', h.axisDirection),
            ], map.overlays.length === 0);
            if (map.overlays.length === 0) { continue; }
            for (const ov of map.overlays) {
                writeOverlay(out, 3, ov, h, pad, open, close, attr, text);
            }
            close(2, 'SubstrateMap');
        }
        close(1, 'SubstrateMaps');
    }

    close(0, 'MapData');
    return out.join(nl) + nl;
}

/**
 * Writes one `<Overlay>` and whichever of the four payload kinds it carries.
 *
 * Split out because `OverlayType` is an `xs:choice` of four unrelated shapes and
 * inlining all of them buries the document structure above.
 * @param out    The line buffer.
 * @param d      Indent depth.
 * @param ov     The overlay.
 * @param header The owning map's header; its frame places a Row/Column payload.
 * @param pad    Indent helper.
 * @param open   Element-open helper.
 * @param close  Element-close helper.
 * @param attr   Attribute helper.
 * @param text   Text-child helper.
 */
function writeOverlay(
    out: string[],
    d: number,
    ov: E142Overlay,
    header: E142SubstrateMapHeader,
    pad: (d: number) => string,
    open: (d: number, name: string, attrs: string[], selfClose?: boolean) => void,
    close: (d: number, name: string) => void,
    attr: (name: string, v: string | number | boolean | undefined) => string,
    text: (d: number, name: string, v: string | number | undefined) => void,
): void {
    open(d, 'Overlay', [
        attr('MapName', ov.mapName),
        // Absent and "" are the SAME OverlayKey value, so writing "" asserts
        // nothing and invites a reader to think it does.
        ov.mapVersion !== '' ? attr('MapVersion', ov.mapVersion) : '',
    ]);

    if (ov.referenceDevices.length > 0) {
        open(d + 1, 'ReferenceDevices', []);
        for (const r of ov.referenceDevices) {
            open(d + 2, 'ReferenceDevice', [attr('Name', r.name)]);
            open(d + 3, 'Coordinates',
                [attr('X', r.coordinates.x), attr('Y', r.coordinates.y)], true);
            if (r.position !== undefined) {
                open(d + 3, 'Position', [attr('X', r.position.x), attr('Y', r.position.y),
                    attr('Units', r.position.units)], true);
            }
            close(d + 2, 'ReferenceDevice');
        }
        close(d + 1, 'ReferenceDevices');
    }

    const meta = ov.binCodeMapMeta;
    if (meta !== undefined) {
        open(d + 1, 'BinCodeMap', [attr('BinType', meta.binType), attr('NullBin', meta.nullBin),
            attr('MapType', meta.mapType)]);
        if (ov.binDefinitions !== undefined && ov.binDefinitions.length > 0) {
            open(d + 2, 'BinDefinitions', []);
            for (const b of ov.binDefinitions) {
                open(d + 3, 'BinDefinition', [
                    attr('BinCode', b.binCode),
                    b.binQuality !== '' ? attr('BinQuality', b.binQuality) : '',
                    b.binDescription !== '' ? attr('BinDescription', b.binDescription) : '',
                    attr('BinCount', b.binCount),
                    b.pick ? attr('Pick', 'true') : '',
                ], true);
            }
            close(d + 2, 'BinDefinitions');
        }
        writePayload(out, d + 2, ov, meta, header, pad, attr);
        close(d + 1, 'BinCodeMap');
    }

    if (ov.deviceIdEntries !== undefined && ov.deviceIdEntries.length > 0) {
        open(d + 1, 'DeviceIdMap', []);
        for (const e of ov.deviceIdEntries) {
            out.push(`${pad(d + 2)}<Id${attr('X', e.x)}${attr('Y', e.y)}${attr('LID', e.lid)}>`
                + `${xmlText(e.deviceId)}</Id>`);
        }
        close(d + 1, 'DeviceIdMap');
    }

    if (ov.transferMaps !== undefined) {
        for (const m of ov.transferMaps) {
            open(d + 1, 'TransferMap', [
                // Empty means ABSENT for these two - the model has no separate
                // absent state, and an empty @FromSubstrateId is a dangling keyref
                // that turns a parseable document into a rejected one.
                m.fromSubstrateType !== '' ? attr('FromSubstrateType', m.fromSubstrateType) : '',
                m.fromSubstrateId !== '' ? attr('FromSubstrateId', m.fromSubstrateId) : '',
                // "" here is the layoutless form and a real value.
                attr('FromSubstrateLayoutSpecifier', m.fromLayoutSpecifier),
            ]);
            for (const t of m.transfers) {
                open(d + 2, 'T', [attr('FX', t.fx), attr('FY', t.fy), attr('FID', t.fid),
                    attr('TX', t.tx), attr('TY', t.ty), attr('TID', t.tid)], true);
            }
            close(d + 1, 'TransferMap');
        }
    }

    if (ov.deviceDataMaps !== undefined) {
        for (const m of ov.deviceDataMaps) {
            open(d + 1, 'DeviceDataMap', []);
            for (const p of m.parameters) {
                open(d + 2, 'Parameter',
                    [attr('Name', p.name), attr('Description', p.description)], true);
            }
            for (const r of m.deviceData) {
                open(d + 2, 'DeviceData',
                    [attr('X', r.x), attr('Y', r.y), attr('LID', r.lid)]);
                open(d + 3, 'ccs:PVSet', [attr('xmlns:ccs', E138_NS)]);
                for (const v of r.values) { writePvValue(out, d + 4, v, pad, attr); }
                close(d + 3, 'ccs:PVSet');
                close(d + 2, 'DeviceData');
            }
            close(d + 1, 'DeviceDataMap');
        }
    }

    close(d, 'Overlay');
    // `text` is threaded through for symmetry with the caller's helper set even
    // where this function does not need it; dropping it would make the two
    // signatures differ for no reason.
    void text;
}

/**
 * Writes a `BinCodeMap`'s payload in whichever shape its `MapType` demands.
 * @param out    The line buffer.
 * @param d      Indent depth.
 * @param ov     The overlay.
 * @param meta   Its BinCodeMap metadata.
 * @param header The owning map's header.
 * @param pad    Indent helper.
 * @param attr   Attribute helper.
 */
function writePayload(
    out: string[],
    d: number,
    ov: E142Overlay,
    meta: E142BinCodeMapMeta,
    header: E142SubstrateMapHeader,
    pad: (d: number) => string,
    attr: (name: string, v: string | number | boolean | undefined) => string,
): void {
    const sparse = ov.sparseBinCodes;
    if (sparse !== undefined && sparse.length > 0) {
        for (const e of sparse) {
            out.push(`${pad(d)}<BinCode${attr('X', e.x)}${attr('Y', e.y)}${attr('LID', e.lid)}`
                + `${attr('Number', e.number)}>${xmlText(e.code)}</BinCode>`);
        }
        return;
    }
    const p = ov.payload;
    if (p === undefined) { return; }
    const rows = encodePayloadRows(p, meta.binType);

    if (meta.mapType === 'Array') {
        out.push(`${pad(d)}<BinCode>${xmlText(rows.join(tokenSeparator(meta.binType)))}</BinCode>`);
        return;
    }
    if (meta.mapType === 'Row/Column') {
        /*
         * Row/Column keeps NEITHER its raw text NOR its sparse entries - the
         * parser records them for Coordinate only - so every cell is re-addressed
         * through the frame. Single-token runs, which makes the output independent
         * of the decoder's xStep; the source's run partition is a serialization
         * detail the model does not carry. Exactly the JSON serializer's approach,
         * through the same buildLogicalTable.
         */
        const table = buildLogicalTable(header.originLocation, header.axisDirection, p.cols, p.rows);
        for (let i = 0; i < p.cells.length; i++) {
            if (p.cells[i] === 0) { continue; }
            const at = table[i];
            if (at === undefined) { continue; }
            const lid = p.lids?.get(i);
            out.push(`${pad(d)}<BinCode${attr('X', at.x)}${attr('Y', at.y)}`
                + `${attr('LID', lid)}>${xmlText(p.codes[p.cells[i]])}</BinCode>`);
        }
        return;
    }
    for (const row of rows) { out.push(`${pad(d)}<BinCode>${xmlText(row)}</BinCode>`); }
}

/**
 * Writes one E138 `PVSet` value.
 *
 * Four shapes, and they are not interchangeable: a scalar carries its lexical
 * value, a nil scalar carries `xsi:nil`, `Su` and `Arr` recurse over POSITIONAL
 * children, and `NoValue` carries a required `@reasonCode` plus a `<Description>`.
 * @param out  The line buffer.
 * @param d    Indent depth.
 * @param v    The value.
 * @param pad  Indent helper.
 * @param attr Attribute helper.
 */
function writePvValue(
    out: string[],
    d: number,
    v: PvValue,
    pad: (d: number) => string,
    attr: (name: string, x: string | number | boolean | undefined) => string,
): void {
    if (v.kind === 'Su' || v.kind === 'Arr') {
        out.push(`${pad(d)}<ccs:${v.kind}>`);
        const children = v.kind === 'Su' ? v.fields : v.items;
        for (const c of children) { writePvValue(out, d + 1, c, pad, attr); }
        out.push(`${pad(d)}</ccs:${v.kind}>`);
        return;
    }
    if (v.kind === 'NoValue') {
        out.push(`${pad(d)}<ccs:NoValue${attr('reasonCode', v.reasonCode)}>`);
        if (v.description !== undefined) {
            out.push(`${pad(d + 1)}<ccs:Description>${xmlText(v.description)}</ccs:Description>`);
        }
        out.push(`${pad(d)}</ccs:NoValue>`);
        return;
    }
    if (v.value === null) {
        out.push(`${pad(d)}<ccs:${v.kind} xsi:nil="true" `
            + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`);
        return;
    }
    out.push(`${pad(d)}<ccs:${v.kind}>${xmlText(String(v.value))}</ccs:${v.kind}>`);
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 *
 * Mirrors E142.ts and Engine.ts exactly, per the S1 module mechanism: the module
 * is consumed as TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Xml.* after
 * listing E142Xml.js as an EsModule dependency file. First-wins (??=)
 * assignments keep the first definition if the file is ever evaluated twice.
 * Unlike E142Bins - which carries no bridge so that its emitted JS is standalone
 * - this module already imports E142.js, whose own bridge touches TcHmi, so a
 * bridge here costs nothing that is not paid already; a node test stubs the
 * global either way.
 * ------------------------------------------------------------------------ */

declare const _E142ParseErrorAlias: typeof E142ParseError;
type _E142ParseErrorInstance = E142ParseError;
declare const _parseE142XmlAlias: typeof parseE142Xml;
declare const _e142DocumentToXmlAlias: typeof e142DocumentToXml;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Xml {
        /** Global (classic namespace) alias of the module export {@link E142ParseError}. */
        let E142ParseError: typeof _E142ParseErrorAlias;
        /** Instance type of the global alias. */
        type E142ParseError = _E142ParseErrorInstance;
        /** Global alias of {@link e142DocumentToXml}. */
        let e142DocumentToXml: typeof _e142DocumentToXmlAlias;
        /** Global alias of the module's entry point {@link parseE142Xml}. */
        let parseE142Xml: typeof _parseE142XmlAlias;
        /** Global alias of the accepted schema-version list. */
        let E142_KNOWN_SCHEMA_VERSIONS: readonly string[];
    }
}

/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
 * @param root     The root object to hang the namespace off.
 * @param segments The namespace path.
 * @returns The namespace object.
 */
function ensureNamespace(root: object,...segments: string[]): Record<string, unknown> {
    let current = root as Record<string, unknown>;
    for (const segment of segments) {
        current = (current[segment] ??= {}) as Record<string, unknown>;
    }
    return current;
}

// Idempotent registration guard: `??=` keeps the first definition if this file
// is ever evaluated twice (cannot happen through the module cache, but required
// for the classic fallback variant and free of cost here).
const e142XmlNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Xml');
e142XmlNamespace['E142ParseError'] ??= E142ParseError;
e142XmlNamespace['parseE142Xml'] ??= parseE142Xml;
e142XmlNamespace['e142DocumentToXml'] ??= e142DocumentToXml;
e142XmlNamespace['E142_KNOWN_SCHEMA_VERSIONS'] ??= E142_KNOWN_SCHEMA_VERSIONS;
