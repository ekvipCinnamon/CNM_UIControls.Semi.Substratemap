# The E142 model API

**What this document is.** The contract of six functions and one type. `SubstrateMap` the control is
one consumer of them; this is the layer underneath, and it is the part of the SubstrateMap package
that is worth using without the control.

Nothing here is a claim you have to take on trust. Every guarantee names the suite and the assertion
that holds it up, by naming the file and quoting the assertion, so it can be grepped and read.

---

## 1. What is standardized, and what this engine adds

**SEMI E142 specifies a data model for substrate mapping, and an XML Schema that represents it on the
wire.** E142.1 is titled *"Specification for XML Schema for Substrate Mapping"*.
`[Primary source]`

This engine implements the model — it is `E142Document` in TypeScript — and provides a **second
transport** for the same model in JSON. Neither transport is privileged:

```
   parseE142Xml  ──┐                        ┌──▶  e142DocumentToXml
                   ├──▶   E142Document  ────┤
   parseE142Json ──┘                        └──▶  e142DocumentToJson

                    encodeBinIndices  /  decodeBinIndices
                    (the compact form of one decoded payload)
```

**The JSON transport is not part of E142.** The word *JSON* appears zero times in E142-0225, E142.1,
E142.2, E142.3 and E142.4 — checked across all six documents. `[Primary source]` The envelope
is defined in [`../../Schema/E142/JSON-FORMAT.md`](../../Schema/E142/JSON-FORMAT.md); it carries the
XSD's own element and attribute names verbatim so the two read against each other, and it adds one
thing XML has no reason for: a base64 payload for the bin indices.

**The practical consequence:** across a company boundary, send XML. Not because JSON is lesser here,
but because it is the one a stranger's stack is guaranteed to read.

### Why the two transports cannot disagree

`parseE142Json` does not parse. It presents a JSON document as the element interface `parseE142Xml`
already consumes, and hands it over. There is **one implementation** of every facet, every identity
constraint, every dialect tolerance and every warning; the transports have nothing to diverge *with*.
`[Inference]`

That is the design decision the whole layer rests on, and it is why the equivalence numbers below are
what they are rather than the result of two implementations being carefully kept in step.

---

## 2. The six functions

### Reading

```ts
parseE142Xml(xml: string, options?: E142XmlParseOptions): E142XmlParseResult
parseE142Json(source: string | object, options?: E142JsonParseOptions): E142XmlParseResult
```

Both return `{ doc: E142Document, warnings: string[] }` — the same type, because they produce the same
thing.

- **`parseE142Json` accepts an object as well as a string.** That is the point of it: a document
  arriving as a typed symbol should not be `JSON.stringify`'d so the parser can immediately parse it
  back.
- **Warnings are strings beginning with a stable code**, e.g. `E142_JSON_UNKNOWN_MEMBER: …`. They are
  diagnostics, not failures; a document that produces warnings has still been read.
- **Failure is a throw**, not a warning, and only when the document cannot yield a model at all:
  `E142ParseError` with a `.code` and a structural path. An identity-constraint violation — a
  duplicate `LayoutId`, a dangling keyref — is a throw on **both** transports with the **same code**
  (`e142-representations.test.mjs` — *"with the identical error code, not merely both failing"*).

### Writing

```ts
e142DocumentToXml (doc: E142Document, options?: E142DocumentToXmlOptions):  string
e142DocumentToJson(doc: E142Document, options?: E142JsonSerializeOptions): string
```

Both are **byte-stable**: serializing the same document twice gives identical bytes, for XML and
for JSON, over every fixture (`e142-json.test.mjs`).

`e142DocumentToJson` takes `{ binary?: true }` to write payloads as `$binary` index blocks instead of
token text. See §5 before reaching for it.

`e142DocumentToJson` can **refuse**: `E142JsonSerializeError` with code
`E142_JSON_BINARY_UNSUPPORTED`, when `binary` is asked for on a `Coordinate` or `Row/Column` payload.
Those address every entry individually — X, Y, LID, Number — and an index stream has nowhere to put
it. It refuses rather than silently writing tokens, because a caller who asked for binary and got text
would not find out (`e142-json.test.mjs` — *"and four are REFUSED, not silently written as tokens"*).

### The compact payload form

```ts
encodeBinIndices(source: BinIndexSource): { codes: readonly string[], data: string }
decodeBinIndices(codes: readonly string[], data: string): Uint16Array
```

One decoded payload as a code table plus base64 of **little-endian `uint16`** cell indices, row-major.

- **The byte order is a property of the format, not of the machine**, and the test asserts the bytes
  literally rather than round-tripping them — a round trip passes just as happily if both halves are
  big-endian (`e142-bincodec.test.mjs` — *"low byte FIRST, which is what little-endian means"*).
- **`codes[0]` is the null bin**, in every payload in the corpus (`e142-bincodec.test.mjs` —
  *"the null bin sits at index 0 in all"*).
- **The table order is load-bearing.** Index *i* means `codes[i]`; re-sorting or de-duplicating the
  table renumbers every cell.
- `uint16` is exactly enough and not more: the index space is bounded by the bin key space, whose
  largest is `Integer2` at 65 536 — indices 0..65 535, with nothing spare. A larger index is refused,
  never wrapped.

---

## 3. What a round trip promises

### Start with what is **not** preserved

A round trip is over the **model**, never the bytes. Serializing a parsed document and comparing it to
the file it came from will not match, on either transport, and this is not a defect to be fixed:

| Lost at parse | Why |
|---|---|
| a `2DArray` payload's original row text | the model holds cell indices and a code table; the source rows are gone |
| whitespace, indentation, attribute order | no model retains them |
| comments | likewise |
| unknown members | counted and warned about, then dropped — `E142Document` has no slot for them |
| foreign-namespace subtrees | the same, by the same reasoning |

Both transports lose exactly these, equally. Byte-identity over a *file* was never the target; the
round trip that means anything is `doc → text → doc`.

### What **is** preserved

Every route below produces a document structurally equal to the one it started from, across the whole
corpus:

| Route | Fixtures |
|---|---|
| `xml → doc → xml → doc` | 44 |
| `xml → doc → json → doc` | 44 |
| `xml → doc → json → doc → xml → doc` | 44 — crosses transports twice |
| `xml → doc → binary → doc` | 40 dense; the four per-entry `MapType`s are refused by design |

*(`e142-json.test.mjs` asserts every route above over all 44 parseable fixtures, and that
`parse(serialize(doc))` equals `doc` for each of them.)*

The corpus is 46 XML fixtures, 45 with a hand-authored JSON counterpart. The two that do not
round-trip are the deliberately invalid ones; the one XML fixture without a counterpart is
`v0211-invalid-truncated`, which has no JSON analogue by nature.

**And one layer up:** the control renders the same cell pattern — lattice, a hash of the whole cell
array, and the bin table in order — from either transport, for every corpus map
(`e142-representations.test.mjs` — *"every corpus map renders the same cell pattern from both
attributes"*).

---

## 4. The two places the transports differ

Both are properties of the **transports**, not defects, and both are asserted rather than exempted —
the suite checks that each path raises exactly what is recorded, including the absence.

| | XML | JSON |
|---|---|---|
| a vendor subtree | `E142_XML_FOREIGN_NAMESPACE_SKIPPED` | `E142_JSON_UNKNOWN_MEMBER` |
| `TopLevel="True"` (capital T) | `E142_XML_BOOLEAN_DIALECT` | **nothing** |

**Namespaces.** XML has them and JSON does not, so extension content is a foreign namespace in one and
an unrecognized member in the other. Same fate — counted, reported, dropped — by a different
mechanism (`e142-representations.test.mjs` — *"same fate, different mechanism"*).

**Lexical dialect.** Every XML value is text, so `TopLevel="True"` needs a tolerance and a warning.
JSON has real booleans and there is nothing to tolerate, so it raises **zero** codes — an absent
problem, not a missing warning. The suite asserts the count is zero rather than merely permitting
silence (`e142-representations.test.mjs` — *"and JSON raises NOTHING"*).

**The XML dialect tolerances are deliberately not reproduced in JSON.** There is no legacy JSON
producer to be tolerant of.

---

## 5. Before you use `$binary`

It is an **encoding of the token text**, not a second format: on read it is expanded back into tokens
before anything else looks at the document, so it can mean nothing the token form cannot. Either JSON
input accepts either form.

Measured, at every size from 50² to 1200²:

| `BinType` | token chars/cell | size vs token JSON | parse |
|---|---|---|---|
| `Ascii` | 1 | **+166 %** | **5.0× slower** |
| `HexaDecimal` | 2 | **+33 %** | **3.7× slower** |
| `Decimal` | 4 | −33 % | 2.3× slower |
| `Integer2` | 4 | −33 % | 2.6× slower |

Base64 of two bytes is 2.67 characters per cell, so the size column is arithmetic rather than a
property of any document. The time column follows from the expansion above: a binary document pays the
base64 decode **and** the full token decode, so it is slower by construction.

**It is a wire optimization, not a load optimization.** Worth it when the transport is the constraint
and the bin type is four characters wide; worth nothing otherwise. The full table, regenerated by
`node tools/bench-parse.mjs --write-readme`, is in the README under *Representation sizes and parse
times*.

---

## 6. Calling it

```ts
import { parseE142Xml, e142DocumentToXml } from './E142Xml.js';
import { parseE142Json, e142DocumentToJson } from './E142Json.js';

// Read either transport into the one model.
const { doc, warnings } = parseE142Json(symbolValue);   // string or object
for (const w of warnings) { console.warn(w); }          // "E142_…: explanation"

// Write it back to either.
const asXml  = e142DocumentToXml(doc);
const asJson = e142DocumentToJson(doc);
const small  = e142DocumentToJson(doc, { binary: true });  // may throw; see §2
```

Errors worth catching by name: **`E142ParseError`** (`.code`, `.path`) from either reader,
**`E142JsonSerializeError`** (`.code`) from `e142DocumentToJson`, and **`BinCodecError`** (`.code`)
from the codec. All carry a stable code and a message that says what the document did, not merely that
something failed.

---

## 7. Where the evidence lives

| Suite | What it holds |
|---|---|
| `tests/e142-json.test.mjs` | the JSON parser as an adapter, both serializers, the four transport routes, `$binary` |
| `tests/e142-representations.test.mjs` | XML against JSON across the whole corpus, per-feature families, the control-level comparison |
| `tests/e142-bincodec.test.mjs` | the codec: byte order asserted literally, the null bin, the refusals |
| `tests/e142-e2e.test.mjs` | the engine end to end, including everything above through the real pipeline |
| `tests/lib/representations.mjs` | the three exception maps — `PENDING_JSON`, `SCHEMA_INVALID`, `WARNING_CODES_DIFFER` — each entry naming a fixture, a code, and a reason |

Three decisions shape this API more than any other: **one parser, two transports** — XML and JSON
reach the same document tree through one set of rules; **`$binary` expands before the tree is built**,
so nothing downstream ever sees the binary form; and **the XML serializer shares its payload helpers**
with the parser rather than keeping a second copy of the rules.

---

## 8. Exports with no runtime consumer

These are not part of the model API — they belong to aggregation and color — but they are exported
from the same package, so a reader who imports from this engine meets them. **Nothing the control
renders calls them.** They are the measuring surface the suites use, and they are exported for that
and only that.

| Export | In | Called by | Why it exists |
|---|---|---|---|
| `accumulateBuckets` | `GridAggregate.ts` | `grid-monoid`, `grid-render`, `grid-aggregate` | The render pass accumulates inline. This is the same accumulation exposed, so a suite can build a bucket set and read it rather than assert about pixels and hope the accumulation underneath was the one it meant. |
| `aggregateClosestApproach` | `GridAggregate.ts` | `grid-aggregate` | The separation between the aggregate palette and the theme is a MEASUREMENT the suite reads, not a claim it repeats. |
| `aggregationFactorLinear` | `Engine.ts` | `grid-render`, `grid-aggregate` | The dispatcher computes the factor inline. This is the same arithmetic exposed, so a suite can sweep it across zooms without rendering. |
| `bucketIsPainted` | `GridAggregate.ts` | `grid-aggregate` | The suite asks the emptiness question the renderer asks, instead of restating the rule in its own words and then agreeing with itself. |
| `deltaECss` | `Oklch.ts` | `grid-render`, `grid-aggregate` | Every claim in this package about two colors being distinguishable is a number this produced. |
| `maxSeverity` | `GridAggregate.ts` | `grid-monoid`, `grid-aggregate` | `renderGridAggregate` reduces inline. This is the same reduction exposed, so the monoid laws can be asserted on the operation rather than on a frame that happened to use it. |

This project decides palettes and reducers by measurement, so a measuring surface is a deliberate cost
rather than dead weight. Writing it down is the point: an export with no runtime consumer otherwise
reads as a promise to whoever finds it in the module surface, and the name cannot tell you which it is.

**The set is computed, not remembered.** `tools-smoke` checks each of the six for both properties —
no runtime caller, and the marker in its own documentation — and fails if either moves. A name that
gains a runtime caller leaves the list, as `categoricalPalette` and `minPairwiseDeltaE` did when the
categorical fallback started building and measuring the palette.

**Ten other exports also have no caller inside this package**, and they are a different question, not
answered here: the model API in §2 and §6 exists for a consumer OUTSIDE the package, and the engine
counters and `gridCacheKeyForTest` are instrumentation. Neither group is documented as such anywhere.
