/**
 * @fileoverview
 * E142Json - the SEMI E142.1 JSON input path of the SubstrateMapEngine.
 *
 * WHAT THIS FILE IS NOT: a second parser. It contains no facet check, no
 * enumeration test, no id-length rule, no identity constraint and no bin decode.
 * Not one rule is reimplemented: a second, subtly different validator is the
 * failure this feature is most likely to produce, and the strongest way to avoid
 * it is to have nothing to keep in step.
 *
 * HOW. `E142Xml.ts` was built around one injectable seam. `parseE142Xml` takes
 * its document tree from an {@link E142XmlDocumentParser}, and everything
 * downstream is coded against {@link E142XmlElement} - a four-member interface
 * offering element, attribute and text lookup and nothing more. The option's own
 * contract invites exactly this use: "A node test injects a stub here; so may an
 * embedder that already holds a parsed tree in another shape."
 *
 * So this module presents a JSON document AS that interface and hands it to
 * `parseE142Xml`. The result is that every rule - the XSD facets, the six
 * identity constraints, the dialect tolerances, the aggregated warnings, the
 * token decode - is the SAME CODE for both formats, byte for byte. The two paths
 * cannot drift because there is only one path.
 *
 * THE MAPPING is structural only, and it is `Schema/E142/JSON-FORMAT.md` §5 in
 * executable form: which member names are attributes, which are child elements
 * with text, which are containers around a repeated element. Structure is not
 * validation; nothing below decides whether a value is legal, only where the
 * parser will look for it.
 *
 * WHAT THIS COSTS, stated plainly:
 *  - Warning and error CODES read `E142_XML_*` even for a JSON document, and
 *    structural paths read `/MapData/Substrates/Substrate[1]` rather than a JSON
 *    pointer. That is deliberate. One condition gives the same warning, with the
 *    same code, from both paths, and a parallel vocabulary
 *    would be the same drift risk as a parallel validator, moved into the
 *    diagnostics. The `XML` in the names is historical; renaming them to
 *    `E142_DOC_*` would be the tidy fix and a breaking change to a shipped
 *    contract.
 *  - Codes that only a JSON document can produce are `E142_JSON_*`. Those are
 *    new conditions, not restatements of existing rules.
 *
 * MODULE MECHANISM: an ES module linked with `.js` specifiers, with the idempotent
 * (`??=`) global bridge at the end exposing
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Json.
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

import { E142ParseError, parseE142Xml, type E142XmlElement, type E142XmlParseResult } from './E142Xml.js';
import { E138_NS, type PvValue } from './E138Pv.js';
import { encodePayloadRows, tokenSeparator } from './E142Bins.js';
import { decodeBinIndices, encodeBinIndices } from './BinCodec.js';
import {
    buildLogicalTable, type E142BinType, type E142AliasId, type E142BinDefinition,
    type E142DeviceDataMap, type E142DeviceIdEntry, type E142Document, type E142Layout,
    type E142LogicalCoordinates, type E142Overlay, type E142PhysicalCoordinates,
    type E142ReferenceDevice, type E142SparseBinCode, type E142Substrate,
    type E142SubstrateMapHeader, type E142TransferMap, type E142ZDimensions,
} from './E142.js';

// ===================================================================
//  Envelope vocabulary
// ===================================================================

/** The mandatory discriminator value. JSON-FORMAT.md §1. */
const E142_JSON_FORMAT = 'semi-e142';

/**
 * The envelope version this module understands. A higher one warns and parses.
 *
 * **2**, the version that added the optional `$binary` payload member. A
 * version-1 document is still read unchanged - a bump adds members, it does not
 * retire them - and a document that USES `$binary` while declaring version 1 is
 * warned about rather than refused, because its content is unambiguous and a
 * warning is preferred to a throw wherever the document is still usable.
 */
const E142_JSON_VERSION = 2;

/** The envelope version at which {@link E142_JSON_BINARY} became legal. */
const E142_JSON_BINARY_SINCE = 2;

/** The member carrying a payload as bin indices rather than as token text. */
const E142_JSON_BINARY = '$binary';

/** The namespace a document without `$namespace` is read as. */
const DEFAULT_NAMESPACE = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';

/** `xsi`, for the one attribute {@link E138Pv} reads through it. */
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/**
 * Members that are metadata rather than E142 content, and are therefore dropped
 * wherever they appear.
 *
 * `$comment` is in the set and the others are not, because it is legal at ANY
 * level rather than only on the envelope. JSON has no comment syntax, and every
 * XML fixture in the corpus carries a `<!-- -->` header stating what it covers
 * and which clause it came from, which makes the suite the readable index
 * into a standard that cannot be redistributed. Without `$comment` the JSON half
 * of that corpus would be the undocumented half. Ignored on read, never written,
 * and `$`-prefixed so it cannot collide with an XSD name.
 */
const ENVELOPE_MEMBERS: ReadonlySet<string> = new Set(['$format', '$version', '$namespace', '$comment']);

// ===================================================================
//  The structural mapping  (JSON-FORMAT.md §5, executable)
// ===================================================================

/**
 * Members whose JSON array is an XML CONTAINER element wrapping a repeated
 * child: `"Layouts": [...]` becomes `<Layouts><Layout/>...</Layouts>`.
 */
const CONTAINER_OF: Readonly<Record<string, string>> = {
    Layouts: 'Layout',
    Substrates: 'Substrate',
    SubstrateMaps: 'SubstrateMap',
    AliasIds: 'AliasId',
    BinDefinitions: 'BinDefinition',
    ReferenceDevices: 'ReferenceDevice',
    ChildLayouts: 'ChildLayout',
};

/**
 * Members whose SCALAR value is a child element carrying text, not an attribute.
 * Everything else scalar becomes an attribute.
 *
 * This is the one table that has to be right, and it is decided by the XSD, not
 * by taste: `Substrate/LotId` is an element and `SubstrateMap/@SubstrateId` is an
 * attribute, so the parser looks for them in different places. Getting an entry
 * wrong does not corrupt anything - the parser simply does not find the value and
 * reports it missing.
 */
const TEXT_CHILDREN: ReadonlySet<string> = new Set([
    // SubstrateType's xs:sequence
    'Substrate/LotId', 'Substrate/CarrierType', 'Substrate/CarrierId', 'Substrate/SlotNumber',
    'Substrate/SubstrateNumber', 'Substrate/GoodDevices', 'Substrate/SupplierName', 'Substrate/Status',
    // LayoutType's carry-only children
    'Layout/TopImage', 'Layout/BottomImage', 'Layout/ProductId',
    // MapType="Array" carries the whole payload as ONE string. Keyed by parent
    // because `BinCode` is an ELEMENT here and an ATTRIBUTE on BinDefinition -
    // an unkeyed set gets one of the two wrong, and the Array form threw
    // E142_XML_ELEMENT_MISSING until this was context-aware.
    'BinCodeMap/BinCode',
]);

/**
 * Every member name this format defines, flat and without regard to where it may
 * appear. Anything outside it is reported by {@link parseE142Json}.
 *
 * DELIBERATELY FLAT. A per-parent inventory would catch a known name used in the
 * wrong place as well, and would be a second copy of the XSD's structure to keep
 * in step - the drift this whole module exists to avoid. Flat under-warns and
 * never false-positives, which is the failure-tolerant direction; the
 * engineering-time schema catches placement, and the test suite validates the
 * corpus against it, which is what keeps this list honest.
 *
 * PVSet values are absent on purpose: they are built by {@link buildPvValues},
 * never by {@link buildElement}, and E138 owns their vocabulary.
 */
const KNOWN_MEMBERS: ReadonlySet<string> = new Set([
    '$format', '$version', '$namespace', '$text', '$comment', '$binary',
    'Codes', 'Data', 'Cols', 'Rows',
    'Layouts', 'Substrates', 'SubstrateMaps',
    'LayoutId', 'DefaultUnits', 'TopLevel', 'Package', 'Dimension', 'LowerLeft', 'DeviceSize',
    'StepSize', 'Z', 'TopImage', 'BottomImage', 'ProductId', 'ChildLayouts',
    'X', 'Y', 'Units', 'Order', 'Height',
    'SubstrateType', 'SubstrateId', 'LotId', 'AliasIds', 'CarrierType', 'CarrierId', 'SlotNumber',
    'SubstrateNumber', 'GoodDevices', 'SupplierName', 'Status', 'Type', 'Value',
    'LayoutSpecifier', 'SubstrateSide', 'Orientation', 'OriginLocation', 'AxisDirection', 'Overlay',
    'MapName', 'MapVersion', 'ReferenceDevices', 'BinCodeMap', 'DeviceIdMap', 'TransferMap',
    'DeviceDataMap', 'Name', 'Coordinates', 'Position',
    'BinType', 'NullBin', 'MapType', 'BinDefinitions', 'BinCode', 'BinCount', 'BinQuality',
    'BinDescription', 'Pick', 'LID', 'Number', 'Id',
    'FromSubstrateType', 'FromSubstrateId', 'FromSubstrateLayoutSpecifier', 'T',
    'FX', 'FY', 'FID', 'TX', 'TY', 'TID',
    'Parameter', 'DeviceData', 'Description', 'PVSet',
]);

/** The element's own text content, for the two mixed-content types. */
const TEXT_MEMBER = '$text';

// ===================================================================
//  The adapter
// ===================================================================

/** One attribute of a {@link JsonElement}. */
interface JsonAttribute {
    /** Local name. */
    readonly local: string;
    /** Namespace, or null for an unqualified attribute. */
    readonly ns: string | null;
    /** The value, already rendered to its lexical form. */
    readonly value: string;
}

/**
 * An {@link E142XmlElement} over a JSON value. Read-only and namespace-aware,
 * exactly as the interface requires; `attribute()` mirrors `getAttributeNS`.
 */
class JsonElement implements E142XmlElement {
    /** @inheritdoc */
    public readonly localName: string;
    /** @inheritdoc */
    public readonly namespaceUri: string;
    /** @inheritdoc */
    public readonly children: readonly E142XmlElement[];
    /** @inheritdoc */
    public readonly text: string;
    /** The attributes, in insertion order. */
    private readonly attrs: readonly JsonAttribute[];

    /**
     * @param localName    The element name.
     * @param namespaceUri The element's namespace.
     * @param attrs        Its attributes.
     * @param children     Its element children, in document order.
     * @param text         Its character data.
     */
    public constructor(
        localName: string,
        namespaceUri: string,
        attrs: readonly JsonAttribute[],
        children: readonly E142XmlElement[],
        text: string,
    ) {
        this.localName = localName;
        this.namespaceUri = namespaceUri;
        this.attrs = attrs;
        this.children = children;
        this.text = text;
    }

    /** @inheritdoc */
    public attribute(localName: string, namespaceUri?: string): string | null {
        const ns = (namespaceUri === undefined || namespaceUri === '') ? null : namespaceUri;
        for (const a of this.attrs) {
            if (a.local === localName && a.ns === ns) {
                return a.value;
            }
        }
        return null;
    }
}

/**
 * The lexical form of a JSON scalar, as XML would carry it.
 * @param v A JSON scalar.
 * @returns Its text.
 */
function lexical(v: unknown): string {
    return typeof v === 'string' ? v : String(v);
}

/** A plain JSON object, as opposed to an array or a scalar. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Builds the E138 `PVSet` value elements from their JSON form.
 *
 * Each value is a single-key object named for the `PVType` choice element that
 * carries it. Four shapes, and they are NOT interchangeable:
 *  - a scalar kind carries its lexical value: `{"F8": 1.5}`;
 *  - a scalar kind with `null` is NIL, which is how E138 spells "this value is
 *    absent" (`xsi:nil`), so it becomes that attribute;
 *  - `Su` and `Arr` carry an ARRAY of further values. Their fields are
 *    POSITIONAL, not named - `parsePvSet` recurses over the children and returns
 *    `PvValue[]` for both;
 *  - `NoValue` carries an object, because it has a required `@reasonCode` and an
 *    optional `<Description>` child. A bare `null` would lose both and warn on
 *    every document.
 * @param values The JSON array of values.
 * @param ns     The namespace to build them in.
 * @returns The value elements.
 */
function buildPvValues(values: readonly unknown[], ns: string): E142XmlElement[] {
    const out: E142XmlElement[] = [];
    for (const value of values) {
        if (!isPlainObject(value)) {
            continue;                       // reported by the schema, not here
        }
        const keys = Object.keys(value);
        if (keys.length !== 1) {
            continue;                       // likewise
        }
        const kind = keys[0];
        const inner = value[kind];
        if (kind === 'Su' || kind === 'Arr') {
            out.push(new JsonElement(kind, ns, [],
                Array.isArray(inner) ? buildPvValues(inner, ns) : [], ''));
            continue;
        }
        if (kind === 'NoValue') {
            const attrs: JsonAttribute[] = [];
            const kids: E142XmlElement[] = [];
            if (isPlainObject(inner)) {
                if (inner['reasonCode'] !== undefined) {
                    attrs.push({ local: 'reasonCode', ns: null, value: lexical(inner['reasonCode']) });
                }
                if (inner['Description'] !== undefined) {
                    kids.push(new JsonElement('Description', ns, [], [], lexical(inner['Description'])));
                }
            }
            out.push(new JsonElement('NoValue', ns, attrs, kids, ''));
            continue;
        }
        if (inner === null) {
            out.push(new JsonElement(kind, ns, [{ local: 'nil', ns: XSI_NS, value: 'true' }], [], ''));
            continue;
        }
        out.push(new JsonElement(kind, ns, [], [], lexical(inner)));
    }
    return out;
}

/**
 * Rewrites every `$binary` payload in a document into the `BinCode` token text it
 * stands for, in place on a shallow copy, BEFORE the element tree is built.
 *
 * WHY A PRE-PASS AND NOT A SECOND PATH. `parseE142Json` exists by presenting JSON
 * as the element interface `parseE142Xml` already takes, and a payload
 * that arrives pre-decoded has no XML analogue to present. Rather than carve out
 * an exception - which would be the second parser this whole feature is organized
 * against - the binary form is expanded to tokens first. Everything downstream
 * then sees an ordinary document and every rule applies unchanged: the lattice
 * check, the facets, the identity constraints, the aggregated warnings.
 *
 * That is also why the binary form is *defined* as an encoding of the token text
 * rather than as a replacement for it. It compresses; it does not mean anything
 * the token form cannot.
 * @param root     The parsed document object.
 * @param version  The declared `$version`, for the too-old warning.
 * @param warnings Collected diagnostics; appended to.
 * @returns The document with every `$binary` expanded, or `root` when there is none.
 */
function expandBinaryPayloads(
    root: Record<string, unknown>,
    version: number,
    warnings: string[],
): Record<string, unknown> {
    const maps = root['SubstrateMaps'];
    if (!Array.isArray(maps)) { return root; }

    let found = 0;
    const nextMaps = maps.map((map, mapIndex) => {
        if (!isPlainObject(map) || !Array.isArray(map['Overlay'])) { return map; }
        const overlays = map['Overlay'].map((overlay, ovIndex) => {
            if (!isPlainObject(overlay)) { return overlay; }
            const bcm = overlay['BinCodeMap'];
            if (!isPlainObject(bcm) || bcm[E142_JSON_BINARY] === undefined) { return overlay; }

            found++;
            const at = `/MapData/SubstrateMaps/SubstrateMap[${mapIndex + 1}]/Overlay[${ovIndex + 1}]`
                + '/BinCodeMap';
            const rows = binaryToRows(bcm, at, warnings);
            const nextBcm: Record<string, unknown> = { ...bcm };
            delete nextBcm[E142_JSON_BINARY];
            if (rows !== null) {
                // MapType decides the SHAPE, exactly as it does for token text:
                // Array is one row-major stream, everything else is one entry per
                // row. Expanding to the wrong shape produces a document that
                // serializes cleanly and fails to parse - E142_XML_BINCODE_SHAPE.
                const shaped: string | string[] = bcm['MapType'] === 'Array'
                    ? rows.join(tokenSeparator((bcm['BinType'] as E142BinType) ?? 'Ascii'))
                    : rows;
                if (bcm['BinCode'] !== undefined) {
                    warnings.push(
                        `E142_JSON_BINARY_AND_TOKENS at ${at}: the BinCodeMap carries BOTH $binary and `
                        + 'BinCode. They are two encodings of one payload and cannot disagree usefully, '
                        + 'so $binary wins and BinCode is ignored - the binary form is the one a '
                        + 'producer went out of its way to write.');
                }
                nextBcm['BinCode'] = shaped;
            } else if (bcm['BinCode'] === undefined) {
                /*
                 * A malformed block with no token fallback leaves the BinCodeMap
                 * with no payload at all, and the XML path then throws
                 * E142_XML_ELEMENT_MISSING - "BinCodeMap has no <BinCode>", which
                 * is true and names the wrong cause. Thrown here instead, so the
                 * message says what the document actually did.
                 */
                throw new E142ParseError('E142_XML_ELEMENT_MISSING', at,
                    `The BinCodeMap's ${E142_JSON_BINARY} block is unusable and there is no BinCode to `
                    + `fall back on, so the overlay has no payload. See the ${E142_JSON_BINARY} warning `
                    + 'above for what is wrong with it.');
            }
            return { ...overlay, BinCodeMap: nextBcm };
        });
        return { ...map, Overlay: overlays };
    });

    if (found === 0) { return root; }
    if (version < E142_JSON_BINARY_SINCE) {
        warnings.push(
            `E142_JSON_BINARY_VERSION_TOO_OLD: the document declares $version ${version} and uses `
            + `${E142_JSON_BINARY}, which is legal from ${E142_JSON_BINARY_SINCE}. Read anyway - the `
            + 'content is unambiguous and refusing it would reject a document this engine understands '
            + 'perfectly.');
    }
    return { ...root, SubstrateMaps: nextMaps };
}

/**
 * Expands one `$binary` block into `BinCode` rows.
 *
 * The block carries its own `Cols` and `Rows`, because the index stream alone
 * cannot say where a row ends and a `Layout` may be absent or may dangle. Rows are
 * joined with the separator the bin type requires - the same `isDelimited` rule the
 * decoder reads them back with, never a second table.
 * @param bcm      The BinCodeMap object.
 * @param at       The structural path, for diagnostics.
 * @param warnings Collected diagnostics; appended to.
 * @returns One token string per row, or `null` when the block is unusable.
 */
function binaryToRows(
    bcm: Record<string, unknown>,
    at: string,
    warnings: string[],
): string[] | null {
    const block = bcm[E142_JSON_BINARY];
    if (!isPlainObject(block)) {
        warnings.push(`E142_JSON_BINARY_MALFORMED at ${at}: ${E142_JSON_BINARY} is not an object.`);
        return null;
    }
    const codes = block['Codes'];
    const data = block['Data'];
    const cols = block['Cols'];
    const rows = block['Rows'];
    if (!Array.isArray(codes) || typeof data !== 'string'
        || typeof cols !== 'number' || typeof rows !== 'number') {
        warnings.push(
            `E142_JSON_BINARY_MALFORMED at ${at}: ${E142_JSON_BINARY} needs Codes (array), Data `
            + '(string), Cols and Rows (numbers). The block is ignored and the payload is read from '
            + 'BinCode if one is present.');
        return null;
    }

    let indices: Uint16Array;
    try {
        indices = decodeBinIndices(codes as string[], data);
    } catch (e) {
        warnings.push(
            `E142_JSON_BINARY_MALFORMED at ${at}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
    if (indices.length !== cols * rows) {
        warnings.push(
            `E142_JSON_BINARY_MALFORMED at ${at}: the index block holds ${indices.length} cells but `
            + `Cols x Rows is ${cols * rows}. The two disagree, so neither can be trusted.`);
        return null;
    }

    const sep = tokenSeparator((bcm['BinType'] as E142BinType) ?? 'Ascii');
    const out: string[] = [];
    for (let y = 0; y < rows; y++) {
        const row: string[] = [];
        for (let x = 0; x < cols; x++) { row.push(String(codes[indices[y * cols + x]] ?? '')); }
        out.push(row.join(sep));
    }
    return out;
}

/**
 * Builds one element from a JSON object, applying the structural mapping.
 *
 * Every member becomes exactly one of: the element's text ({@link TEXT_MEMBER}),
 * an attribute, a child element, or - for the `$`-prefixed envelope members -
 * nothing, because they are metadata and the caller has already read them.
 * @param name The element name.
 * @param ns   The document namespace.
 * @param obj  The JSON object.
 * @returns The element.
 */
function buildElement(
    name: string,
    ns: string,
    obj: Record<string, unknown>,
    unknown: Map<string, number>,
): JsonElement {
    const attrs: JsonAttribute[] = [];
    const children: E142XmlElement[] = [];
    let text = '';

    for (const [key, value] of Object.entries(obj)) {
        if (key === TEXT_MEMBER) {
            text = lexical(value);
            continue;
        }
        if (ENVELOPE_MEMBERS.has(key)) {
            continue;
        }
        if (value === undefined) {
            continue;
        }
        if (!KNOWN_MEMBERS.has(key)) {
            // Counted, not refused. An object or array member would also reach
            // childrenOf and be reported as an unknown ELEMENT; a scalar one
            // would become an attribute and vanish without trace, which is the
            // silent trap this catches - a mistyped "SubstrateID" is the single
            // likeliest JSON authoring error and it must not be free.
            const where = `${name}/${key}`;
            unknown.set(where, (unknown.get(where) ?? 0) + 1);
            continue;
        }

        if (Array.isArray(value)) {
            const wrapped = CONTAINER_OF[key];
            if (wrapped !== undefined) {
                // A container element around a repeated child.
                const inner: E142XmlElement[] = [];
                for (const item of value) {
                    if (key === 'ChildLayouts') {
                        // Flattened in JSON to an array of LayoutId strings; XML
                        // spells it <ChildLayout LayoutId="..."/>.
                        inner.push(new JsonElement(wrapped, ns,
                            [{ local: 'LayoutId', ns: null, value: lexical(item) }], [], ''));
                    } else if (isPlainObject(item)) {
                        inner.push(buildElement(wrapped, ns, item, unknown));
                    }
                }
                children.push(new JsonElement(key, ns, [], inner, ''));
                continue;
            }
            if (key === 'PVSet') {
                // The one E138-namespaced element: parseDeviceDataMap resolves it
                // by namespace, explicitly, so an unqualified one would be missed.
                children.push(new JsonElement('PVSet', E138_NS, [], buildPvValues(value, E138_NS), ''));
                continue;
            }
            // A repeated element with no container: Overlay, TransferMap,
            // DeviceDataMap, T, Parameter, DeviceData, BinCode, Id.
            for (const item of value) {
                children.push(isPlainObject(item)
                    ? buildElement(key, ns, item, unknown)
                    : new JsonElement(key, ns, [], [], lexical(item)));
            }
            continue;
        }

        if (isPlainObject(value)) {
            children.push(buildElement(key, ns, value, unknown));
            continue;
        }

        if (TEXT_CHILDREN.has(`${name}/${key}`)) {
            children.push(new JsonElement(key, ns, [], [], lexical(value)));
            continue;
        }

        if (value === null) {
            // JSON-FORMAT.md §4: null is never written and is rejected on read.
            // Dropping it here makes the member ABSENT, which is the state the
            // producer most likely meant; the schema rejects it outright.
            continue;
        }

        attrs.push({ local: key, ns: null, value: lexical(value) });
    }

    // MapType=Array carries the whole payload as one string rather than an array.
    return new JsonElement(name, ns, attrs, children, text);
}

// ===================================================================
//  Entry point
// ===================================================================

/**
 * Raised when a serialization request cannot be honored.
 *
 * A local class rather than {@link E142ParseError}, whose `code` is a CLOSED union
 * of the XML path's codes: widening it to admit a serializer-only code would
 * change a shipped type for the sake of one throw, and changing a shipped type
 * is always the more expensive option. Nothing about this failure is a parse failure anyway - the
 * document is fine, the request was not.
 */
export class E142JsonSerializeError extends Error {
    /** A stable code. */
    public readonly code: string;

    /**
     * @param code    The stable code.
     * @param message What was asked for, and why it cannot be given.
     */
    public constructor(code: string, message: string) {
        super(message);
        this.name = 'E142JsonSerializeError';
        this.code = code;
    }
}

/** Options of {@link parseE142Json}. */
export interface E142JsonParseOptions {
    /**
     * The text -> value provider. Defaults to `JSON.parse`. Present for the same
     * reason {@link E142XmlParseOptions.parseDocument} is: a host that already
     * holds the document in another shape should not have to re-serialize it.
     * A caller that already has the OBJECT should pass it to
     * {@link parseE142Json} directly instead - the signature accepts one.
     */
    readonly parseJson?: (text: string) => unknown;
}

/**
 * Parses a SEMI E142.1 document in its JSON representation into the engine's
 * {@link E142Document} plus warnings - the same shapes {@link parseE142Xml}
 * returns, produced by the same code.
 *
 * ---- What it accepts ----
 *  - A STRING, parsed with `JSON.parse` (or the injected provider).
 *  - An OBJECT, used as-is. This is the case the feature exists for: an
 *    `E142MapDataJson` binding arrives as a typed HMI symbol, not as an escaped
 *    string, and round-tripping a five-megabyte document through
 *    `JSON.stringify` to satisfy a signature would undo the point.
 *  - `$version` above this module's, with a warning: a later envelope adds
 *    members, and an unknown member is already a warning rather than a refusal.
 *
 * ---- What it refuses ----
 * Text that is not JSON, a value that is not an object, a missing or wrong
 * `$format`, and a `$version` that is not a positive integer. Everything past
 * the envelope is refused, or tolerated, by exactly the rules the XML path
 * applies - see the file header.
 * @param source  The document text, or the already-parsed document object.
 * @param options Optional injection point for the text -> value provider.
 * @returns The document model and the warnings.
 * @throws {E142ParseError} Always this type and no other.
 */
export function parseE142Json(source: string | object, options?: E142JsonParseOptions): E142XmlParseResult {
    let root: unknown;
    if (typeof source === 'string') {
        const provider = (options && options.parseJson) || ((t: string): unknown => JSON.parse(t));
        try {
            root = provider(source);
        } catch (e) {
            throw new E142ParseError(
                'E142_XML_MALFORMED',
                '/',
                `The document is not well-formed JSON: ${e instanceof Error ? e.message : String(e)}. A `
                + `truncated or malformed file is refused outright - a partially read map would render as `
                + `a complete, smaller one.`,
                e,
            );
        }
    } else {
        root = source;
    }

    if (!isPlainObject(root)) {
        throw new E142ParseError(
            'E142_XML_MALFORMED',
            '/',
            `An E142 JSON document is a JSON object; this is ${Array.isArray(root) ? 'an array' : typeof root}.`,
        );
    }

    const format = root['$format'];
    if (format !== E142_JSON_FORMAT) {
        throw new E142ParseError(
            'E142_XML_NOT_E142',
            '/',
            `$format is ${JSON.stringify(format ?? null)}; an E142 JSON document declares `
            + `${JSON.stringify(E142_JSON_FORMAT)} as its FIRST member. A GridData document declares no `
            + `$format at all, which is what keeps the two contracts apart.`,
        );
    }

    const version = root['$version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new E142ParseError(
            'E142_XML_ATTR_INVALID',
            '/',
            `$version is ${JSON.stringify(version ?? null)}; it is mandatory and must be a positive `
            + `integer. It versions the ENVELOPE, not SEMI's schema - that travels in $namespace.`,
        );
    }

    const warnings: string[] = [];
    if (version > E142_JSON_VERSION) {
        warnings.push(
            `E142_JSON_VERSION_AHEAD: $version is ${version}; this engine implements `
            + `${E142_JSON_VERSION}. Parsed anyway - a later envelope adds members, and an unknown `
            + `member is a warning rather than a refusal. Anything it added will surface as one.`,
        );
    }

    const namespaceRaw = root['$namespace'];
    let namespaceUri = DEFAULT_NAMESPACE;
    if (namespaceRaw !== undefined) {
        if (typeof namespaceRaw !== 'string') {
            throw new E142ParseError(
                'E142_XML_ATTR_INVALID',
                '/',
                `$namespace is ${JSON.stringify(namespaceRaw)}; it carries the E142.1 namespace URI as a `
                + `string, or is omitted.`,
            );
        }
        namespaceUri = namespaceRaw;
    }

    // BEFORE the tree: a pre-decoded payload has no XML analogue, so the binary
    // form is expanded to tokens and everything downstream sees an ordinary
    // document. See expandBinaryPayloads.
    const expanded = expandBinaryPayloads(root, version, warnings);

    const unknown = new Map<string, number>();
    const tree = buildElement('MapData', namespaceUri, expanded, unknown);
    if (unknown.size > 0) {
        const parts: string[] = [];
        for (const [where, n] of unknown) { parts.push(`${where} x${n}`); }
        warnings.push(
            `E142_JSON_UNKNOWN_MEMBER: Ignored ${unknown.size} member name`
            + `${unknown.size === 1 ? '' : 's'} this format does not define: ${parts.join(', ')}. `
            + `Not an error - a later envelope may add members, so a document is not rejected over `
            + `an unrecognized name. The members are dropped, not carried: `
            + `E142Document has no slot for them and the XML path drops foreign content the same way.`,
        );
    }

    /*
     * And here every rule runs: namespace acceptance, the six identity
     * constraints, the facets, the dialect tolerance, the layout resolution, the
     * token decode, the aggregated warnings. None of it is restated above.
     */
    const parsed = parseE142Xml('', { parseDocument: (): E142XmlElement => tree });
    return { doc: parsed.doc, warnings: warnings.concat(parsed.warnings) };
}

// ===================================================================
//  Serialization  (JSON-FORMAT.md §7)
// ===================================================================


/**
 * Adds `value` to `out` under `key` unless it is absent.
 *
 * ABSENT means `undefined` or `null`; an empty STRING is a value and is kept.
 * JSON-FORMAT.md §4 keeps absent, empty and present as three distinct states
 * because E142 does - `LayoutSpecifier: ""` is the layoutless form, not a missing
 * field, and collapsing the two would change what a document asserts.
 * @param out   The object under construction.
 * @param key   The member name.
 * @param value The value, or `undefined`/`null` to omit the member.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined && value !== null) { out[key] = value; }
}

/**
 * @param c A physical coordinate pair.
 * @returns `{ X, Y, Units? }`, or `undefined` when the pair is absent.
 */
function physical(c: E142PhysicalCoordinates | undefined): Record<string, unknown> | undefined {
    if (c === undefined) { return undefined; }
    const out: Record<string, unknown> = { X: c.x, Y: c.y };
    put(out, 'Units', c.units);
    return out;
}

/**
 * @param c A logical coordinate pair.
 * @returns `{ X, Y }`.
 */
function logical(c: E142LogicalCoordinates): Record<string, unknown> {
    return { X: c.x, Y: c.y };
}

/**
 * @param z The Z dimensions.
 * @returns `{ Order?, Height?, Units? }`, or `undefined` when absent.
 */
function zDimensions(z: E142ZDimensions | undefined): Record<string, unknown> | undefined {
    if (z === undefined) { return undefined; }
    const out: Record<string, unknown> = {};
    put(out, 'Order', z.order);
    put(out, 'Height', z.height);
    put(out, 'Units', z.units);
    return out;
}

/**
 * One E138 PVSet value, in the four shapes JSON-FORMAT.md §5.7 defines: a scalar
 * carries its value, a nil scalar carries `null`, `Su`/`Arr` carry an ARRAY
 * because their fields are positional, and `NoValue` carries an object because
 * `@reasonCode` is required.
 * @param v The value.
 * @returns The single-key object.
 */
function pvValue(v: PvValue): Record<string, unknown> {
    if (v.kind === 'Su') { return { Su: v.fields.map(pvValue) }; }
    if (v.kind === 'Arr') { return { Arr: v.items.map(pvValue) }; }
    if (v.kind === 'NoValue') {
        const inner: Record<string, unknown> = { reasonCode: v.reasonCode };
        put(inner, 'Description', v.description);
        return { NoValue: inner };
    }
    return { [v.kind]: v.value ?? null };
}



/**
 * @param e One sparse entry.
 * @returns `{ X?, Y?, LID?, Number?, $text }`.
 */
function sparseEntry(e: E142SparseBinCode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    put(out, 'X', e.x);
    put(out, 'Y', e.y);
    put(out, 'LID', e.lid);
    put(out, 'Number', e.number);
    out.$text = e.code;
    return out;
}

/**
 * The `BinCodeMap` object, whose `BinCode` shape is decided by `MapType`.
 *
 * `Coordinate` and `Row/Column` serialize from {@link E142Overlay.sparseBinCodes},
 * which the parser retained verbatim - their tokens survive exactly. `2DArray`
 * and `Array` have no such record and are re-encoded from the decoded payload;
 * `Array` is the same token stream joined row-major into one string.
 * @param overlay The overlay.
 * @returns The BinCodeMap object, or `undefined` when the overlay carries none.
 */
function binCodeMap(
    overlay: E142Overlay,
    header: E142SubstrateMapHeader,
    binary: boolean,
): Record<string, unknown> | undefined {
    const meta = overlay.binCodeMapMeta;
    if (meta === undefined) { return undefined; }
    const out: Record<string, unknown> = { BinType: meta.binType, NullBin: meta.nullBin };
    put(out, 'MapType', meta.mapType);
    if (overlay.binDefinitions !== undefined && overlay.binDefinitions.length > 0) {
        out.BinDefinitions = overlay.binDefinitions.map((d: E142BinDefinition) => {
            const b: Record<string, unknown> = { BinCode: d.binCode };
            // Empty strings are the parser's "absent" for these two, not a value:
            // BinDefinitionType declares no default and the model fills "".
            if (d.binQuality !== '') { b.BinQuality = d.binQuality; }
            if (d.binDescription !== '') { b.BinDescription = d.binDescription; }
            put(b, 'BinCount', d.binCount);
            if (d.pick) { b.Pick = true; }
            return b;
        });
    }
    /*
     * The binary form is defined for the DENSE payload forms only - 2DArray, Array,
     * and an absent MapType, which means 2DArray. Coordinate and Row/Column address
     * every entry individually, with X, Y, LID and Number, and an index stream has
     * nowhere to put any of that.
     *
     * The test is the declared MapType, NOT whether sparseBinCodes survived: the
     * parser retains those entries for Coordinate and drops them for Row/Column,
     * so a presence check refuses one form and silently mangles
     * the other. That is exactly what happened first - Row/Column reached the
     * binary branch, expanded to bare rows, and came back E142_XML_BINCODE_SHAPE.
     */
    const perEntry = meta.mapType === 'Coordinate' || meta.mapType === 'Row/Column';
    if (binary && perEntry) {
        throw new E142JsonSerializeError('E142_JSON_BINARY_UNSUPPORTED',
            `The overlay "${overlay.mapName}" declares MapType ${meta.mapType}, which addresses every `
            + 'entry individually - X, Y, LID and Number - and an index stream can express none of '
            + 'that. Refused rather than silently written as tokens: a caller who asked for the binary '
            + 'form and got the token form would not find out.');
    }

    const sparse = overlay.sparseBinCodes;
    if (sparse !== undefined && sparse.length > 0) {
        out.BinCode = sparse.map(sparseEntry);
        return out;
    }
    if (binary) {
        const p = overlay.payload;
        if (p === undefined) {
            throw new E142JsonSerializeError('E142_JSON_BINARY_UNSUPPORTED',
                `The overlay "${overlay.mapName}" has no decoded payload to encode.`);
        }
        /*
         * The code table is passed through in ITS EXISTING ORDER, which is the
         * whole reason the token text can be rebuilt exactly: index i means
         * codes[i] and nothing else, so a re-sorted table renumbers every cell.
         * BinCodec preserves that order rather than choosing one, and
         * codes[0] stays the null bin.
         */
        const enc = encodeBinIndices(p);
        out[E142_JSON_BINARY] = {
            Codes: enc.codes, Data: enc.data, Cols: p.cols, Rows: p.rows,
        };
        return out;
    }
    if (overlay.payload === undefined) { return out; }
    const rows = encodePayloadRows(overlay.payload, meta.binType);
    if (meta.mapType === 'Array') {
        out.BinCode = rows.join(tokenSeparator(meta.binType));
    } else if (meta.mapType === 'Row/Column') {
        /*
         * Row/Column is the one form that keeps NEITHER its raw text NOR its
         * sparse entries: the parser records `sparseBinCodes` for Coordinate only,
         * so all that survives is the decoded payload. Bare rows are invalid here
         * - every Row/Column entry needs a starting X and Y - and the X/Y in a
         * document are LOGICAL, which is why emitting the payload's row index
         * flipped the map vertically on the way back in.
         *
         * So: one single-token run per non-null cell, addressed through
         * {@link buildLogicalTable}. Single-token runs make the emitted form
         * independent of the decoder's xStep, which is the other thing a
         * multi-cell run depends on and the other rule this file must not restate.
         *
         * The source's run PARTITION is not recovered - a document may have used
         * one long run per row - but a partition is a serialization detail the
         * model does not carry and `parse(serialize(doc)) === doc` does not ask
         * for it. What is recovered is every cell, in the right place.
         */
        const p = overlay.payload;
        if (p !== undefined) {
            const table = buildLogicalTable(
                header.originLocation, header.axisDirection, p.cols, p.rows);
            const entries: Array<Record<string, unknown>> = [];
            for (let i = 0; i < p.cells.length; i++) {
                if (p.cells[i] === 0) { continue; }          // the null bin is index 0
                const at = table[i];
                if (at === undefined) { continue; }
                const e: Record<string, unknown> = { X: at.x, Y: at.y, $text: p.codes[p.cells[i]] };
                const lid = p.lids?.get(i);
                if (lid !== undefined) { e.LID = lid; }
                entries.push(e);
            }
            out.BinCode = entries;
        }
    } else {
        out.BinCode = rows;
    }
    return out;
}

/**
 * @param overlay The overlay.
 * @param header  The owning map's header; its frame is needed to address a
 *                Row/Column payload in logical coordinates.
 * @returns The Overlay object.
 */
function overlayToJson(
    overlay: E142Overlay,
    header: E142SubstrateMapHeader,
    binary: boolean,
): Record<string, unknown> {
    const out: Record<string, unknown> = { MapName: overlay.mapName };
    // Absent and "" are the SAME OverlayKey value, so writing "" asserts nothing
    // and invites a reader to think it does (JSON-FORMAT.md §5.5).
    if (overlay.mapVersion !== '') { out.MapVersion = overlay.mapVersion; }

    if (overlay.referenceDevices.length > 0) {
        out.ReferenceDevices = overlay.referenceDevices.map((r: E142ReferenceDevice) => {
            const d: Record<string, unknown> = {};
            put(d, 'Name', r.name);
            d.Coordinates = logical(r.coordinates);
            put(d, 'Position', physical(r.position));
            return d;
        });
    }
    put(out, 'BinCodeMap', binCodeMap(overlay, header, binary));

    if (overlay.deviceIdEntries !== undefined && overlay.deviceIdEntries.length > 0) {
        out.DeviceIdMap = {
            Id: overlay.deviceIdEntries.map((e: E142DeviceIdEntry) => {
                const i: Record<string, unknown> = {};
                put(i, 'X', e.x);
                put(i, 'Y', e.y);
                put(i, 'LID', e.lid);
                i.$text = e.deviceId;
                return i;
            }),
        };
    }
    if (overlay.transferMaps !== undefined && overlay.transferMaps.length > 0) {
        out.TransferMap = overlay.transferMaps.map((m: E142TransferMap) => {
            const tm: Record<string, unknown> = {};
            /*
             * ASYMMETRIC ON PURPOSE - a correctness fix, not tidiness. The model
             * stores an ABSENT From* as '' (there is no separate absent state),
             * and the parser treats the two very differently: an absent
             * @FromSubstrateId warns E142_XML_TRANSFER_FROM_MISSING and the
             * document parses, while an EMPTY one is a dangling
             * FromSubstrateMapRef keyref and THROWS E142_XML_INTEGRITY. Writing
             * '' for both therefore turned a document that parses into one that
             * is rejected - found by round-tripping v0125-transfer-degenerate.
             *
             * So @FromSubstrateType and @FromSubstrateId are omitted when empty:
             * '' is not a member of SubstrateTypeEnum, and cannot resolve as a
             * MaterialIdType either, so an empty one can only have meant absent.
             * @FromSubstrateLayoutSpecifier is ALWAYS written - there '' is the
             * layoutless form and a real value.
             *
             * A producer that wrote @FromSubstrateId="" explicitly comes back as
             * absent, so a throw becomes a warning. That is a widening, in the
             * failure-tolerant direction, and the model cannot
             * tell the two apart in any case.
             */
            if (m.fromSubstrateType !== '') { tm.FromSubstrateType = m.fromSubstrateType; }
            if (m.fromSubstrateId !== '') { tm.FromSubstrateId = m.fromSubstrateId; }
            tm.FromSubstrateLayoutSpecifier = m.fromLayoutSpecifier;
            tm.T = m.transfers.map((t) => {
                const e: Record<string, unknown> = {};
                put(e, 'FX', t.fx);
                put(e, 'FY', t.fy);
                put(e, 'FID', t.fid);
                put(e, 'TX', t.tx);
                put(e, 'TY', t.ty);
                put(e, 'TID', t.tid);
                return e;
            });
            return tm;
        });
    }
    if (overlay.deviceDataMaps !== undefined && overlay.deviceDataMaps.length > 0) {
        out.DeviceDataMap = overlay.deviceDataMaps.map((m: E142DeviceDataMap) => ({
            Parameter: m.parameters.map((p) => {
                const q: Record<string, unknown> = { Name: p.name };
                put(q, 'Description', p.description);
                return q;
            }),
            DeviceData: m.deviceData.map((d) => {
                const r: Record<string, unknown> = {};
                put(r, 'X', d.x);
                put(r, 'Y', d.y);
                put(r, 'LID', d.lid);
                r.PVSet = d.values.map(pvValue);
                return r;
            }),
        }));
    }
    return out;
}

/**
 * @param layout One layout.
 * @returns The Layout object, members in the XSD's declaration order.
 */
function layoutToJson(layout: E142Layout): Record<string, unknown> {
    const out: Record<string, unknown> = { LayoutId: layout.layoutId, DefaultUnits: layout.defaultUnits };
    // XSD default false: emitted only when true, so an absent member and a false
    // one say the same thing and the round trip cannot invent a difference.
    if (layout.topLevel) { out.TopLevel = true; }
    if (layout.package) { out.Package = true; }
    out.Dimension = logical(layout.dimension);
    put(out, 'LowerLeft', physical(layout.lowerLeft));
    put(out, 'DeviceSize', physical(layout.deviceSize));
    put(out, 'StepSize', physical(layout.stepSize));
    put(out, 'Z', zDimensions(layout.z));
    put(out, 'TopImage', layout.topImage);
    put(out, 'BottomImage', layout.bottomImage);
    put(out, 'ProductId', layout.productId);
    if (layout.childLayouts.length > 0) { out.ChildLayouts = layout.childLayouts.slice(); }
    return out;
}

/**
 * @param sub One substrate.
 * @returns The Substrate object, members in the XSD's xs:sequence order.
 */
function substrateToJson(sub: E142Substrate): Record<string, unknown> {
    const out: Record<string, unknown> = { SubstrateType: sub.substrateType, SubstrateId: sub.substrateId };
    put(out, 'LotId', sub.lotId);
    if (sub.aliasIds !== undefined && sub.aliasIds.length > 0) {
        out.AliasIds = sub.aliasIds.map((a: E142AliasId) => ({ Type: a.type, Value: a.value }));
    }
    put(out, 'CarrierType', sub.carrierType);
    put(out, 'CarrierId', sub.carrierId);
    put(out, 'SlotNumber', sub.slotNumber);
    put(out, 'SubstrateNumber', sub.substrateNumber);
    // Zero is a value, not an absence (ground truth 2). `put` omits only
    // undefined and null, so GoodDevices: 0 survives.
    put(out, 'GoodDevices', sub.goodDevices);
    put(out, 'SupplierName', sub.supplierName);
    put(out, 'Status', sub.status);
    return out;
}

/**
 * @param header   The map header.
 * @param overlays Its overlays.
 * @returns The SubstrateMap object.
 */
function substrateMapToJson(
    header: E142SubstrateMapHeader,
    overlays: readonly E142Overlay[],
    binary: boolean,
): Record<string, unknown> {
    return {
        SubstrateType: header.substrateType,
        SubstrateId: header.substrateId,
        // "" is the layoutless form and is a VALUE. Never omitted.
        LayoutSpecifier: header.layoutSpecifier,
        // Written even when TopSide: the XSD declares default="TopSide", so an
        // absent member ASSERTS the top face rather than saying nothing, and it is
        // a coordinate-system attribute - that assertion propagates into how every
        // coordinate in the document is read (JSON-FORMAT.md §5.4).
        SubstrateSide: header.substrateSide,
        Orientation: header.orientation,
        OriginLocation: header.originLocation,
        AxisDirection: header.axisDirection,
        Overlay: overlays.map((o) => overlayToJson(o, header, binary)),
    };
}

/** Options of {@link e142DocumentToJson}. */
export interface E142JsonSerializeOptions {
    /**
     * Indentation passed to `JSON.stringify`. Omitted or 0 gives the compact
     * form, which is the default because this output is a wire format first and a
     * file second.
     */
    readonly indent?: number;

    /**
     * Write payloads as `$binary` index blocks instead of `BinCode` token text.
     *
     * **Off by default, and deliberately opt-in.** The token text is what an E142
     * document carries and is normative (ground truth 1); the index block is a
     * compression of it that only this engine and its counterpart understand, so a
     * consumer receiving it unasked would get something it cannot read. Turning it
     * on also raises `$version` to 2.
     *
     * Refused for sparse payloads - `Coordinate` and `Row/Column` entries carry X,
     * Y, LID and Number, which an index stream cannot express - with
     * `E142_JSON_BINARY_UNSUPPORTED` rather than a silent fall back to tokens.
     */
    readonly binary?: boolean;
}

/**
 * Serializes an {@link E142Document} to its JSON representation.
 *
 * BYTE-STABLE BY CONSTRUCTION. Member order is fixed - envelope members first,
 * then `MapDataType`'s sequence, then each object's own XSD declaration order -
 * and every member is written by a literal in this file rather than by iterating
 * the model. Two calls on the same document therefore produce identical bytes,
 * and a diff between two serialized documents shows what differs rather than what
 * was enumerated in a different order.
 *
 * WHAT ROUND-TRIPS AND WHAT DOES NOT. `parse(serialize(doc))` equals `doc` for
 * everything the model holds. It is NOT byte-identical to the source file, and
 * cannot be: the model does not retain a `2DArray` payload's original row text
 * (see {@link encodeRows}), nor unknown members, nor a foreign-namespace subtree.
 * Those are model limits, not serializer ones, and they apply equally
 * to the XML path.
 * @param doc     The document.
 * @param options Optional indentation.
 * @returns The JSON text.
 */
export function e142DocumentToJson(doc: E142Document, options?: E142JsonSerializeOptions): string {
    const binary = options?.binary === true;
    const out: Record<string, unknown> = {
        $format: E142_JSON_FORMAT,
        // 1 unless the document actually uses a version-2 member. A token-form
        // document written as version 2 would be refused by a version-1 reader for
        // a feature it does not contain.
        $version: binary ? E142_JSON_BINARY_SINCE : 1,
    };
    // Round-tripped rather than defaulted, so a V0211 document does not come back
    // silently promoted to V0125.
    put(out, '$namespace', doc.namespaceUri);
    // schemaVersion is deliberately NOT emitted: it is derived from the namespace,
    // and two sources for one fact can disagree (JSON-FORMAT.md §5.1).

    if (doc.layouts.length > 0) { out.Layouts = doc.layouts.map(layoutToJson); }
    if (doc.substrates.length > 0) { out.Substrates = doc.substrates.map(substrateToJson); }
    out.SubstrateMaps = doc.substrateMaps.map((m) => substrateMapToJson(m.header, m.overlays, binary));

    const indent = options?.indent ?? 0;
    return indent > 0 ? JSON.stringify(out, null, indent) : JSON.stringify(out);
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 *
 * Mirrors E142Xml.ts exactly, per the S1 module mechanism. First-wins (??=) so a
 * second evaluation cannot orphan the first registration.
 * ------------------------------------------------------------------------ */

declare const _parseE142JsonAlias: typeof parseE142Json;
declare const _e142DocumentToJsonAlias: typeof e142DocumentToJson;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Json {
        /** Global alias of the module's entry point {@link parseE142Json}. */
        let parseE142Json: typeof _parseE142JsonAlias;
        /** Global alias of {@link e142DocumentToJson}. */
        let e142DocumentToJson: typeof _e142DocumentToJsonAlias;
    }
}

/**
 * Returns (creating on demand) the namespace object at `segments` below `root`.
 * First-wins on every level.
 * @param root     The root object to hang the namespace off.
 * @param segments The namespace path.
 * @returns The namespace object.
 */
function ensureNamespace(root: object, ...segments: string[]): Record<string, unknown> {
    let current = root as Record<string, unknown>;
    for (const segment of segments) {
        current = (current[segment] ??= {}) as Record<string, unknown>;
    }
    return current;
}

const e142JsonNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Json');
e142JsonNamespace['parseE142Json'] ??= parseE142Json;
e142JsonNamespace['e142DocumentToJson'] ??= e142DocumentToJson;
