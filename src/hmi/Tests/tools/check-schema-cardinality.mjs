/*
 * check-schema-cardinality.mjs - the JSON Schema's `required` lists against the
 * XSD's `minOccurs` and `use`.
 *
 * WHY IT EXISTS. D-020 claims the JSON Schema in
 * `E142MapDataJson.Schema.json` is an EXHAUSTIVE restatement of the XSD, and
 * nothing checked the one half of that claim a human gets wrong: cardinality.
 * `Overlay` and `SubstrateMaps` were both marked `required` when the XSD says
 * `minOccurs="0"` (D-038, D-042), and both were found by a fixture failing, late,
 * rather than by a check. This closes that.
 *
 * ---- THE RULE, AND WHY IT IS NOT "COMPARE AGAINST THE NEWEST XSD" ----
 *
 * The JSON envelope carries `$namespace`, so ONE schema must validate documents of
 * EVERY E142 revision - exactly as the parser accepts them all. Cardinality is not
 * stable across revisions:
 *
 *   TransferType/@FX   V0125 optional   V0211, V0224, V0921 required
 *
 * A schema that required `FX` because the newest XSD does would reject a valid
 * V0125 document. So a member is required in JSON only when it is required in
 * **every revision in which it appears**, and optional in any revision makes it
 * optional here. Checking against one XSD would have produced four false
 * positives on `Transfer` alone - and a checker with false positives is worse than
 * no checker, because it teaches its reader to skip the output.
 *
 * ---- WHAT COUNTS AS OPTIONAL ----
 *
 *   `minOccurs="0"`                     optional
 *   `use="optional"`, or no `use`       optional  (the XSD default)
 *   anything inside an `xs:choice`      optional  - a branch may be the one not taken
 *   anything under a `minOccurs="0"`
 *     `xs:sequence`                     optional  - the whole group may be absent
 *
 * The `xs:choice` rule is the one a naive pass gets wrong: `OverlayType` wraps
 * `BinCodeMap`, `DeviceIdMap`, `TransferMap` and `DeviceDataMap` in a choice, and
 * each carries its own `minOccurs="1"`. None of them is required.
 *
 * Run: node tools/check-schema-cardinality.mjs
 * Exit: 0 when the two agree, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(ROOT, 'Controls/SubstrateMap/Schema/TypeDefinitions/E142MapDataJson.Schema.json');
const XSD_DIR = join(ROOT, 'Schema/E142');

/**
 * JSON definition -> XSD complexType.
 *
 * Written out rather than derived by stripping the `SubstrateMapE142` prefix and
 * appending `Type`: three of them do not follow that pattern
 * (`MapDataJson`->`MapDataType`, `BinCodeEntry`->`BinCodeType`,
 * `DeviceIdEntry`->`DeviceIdType`), and a rule with three exceptions is a table
 * that has not admitted it yet.
 */
const TYPE_OF = {
    SubstrateMapE142MapDataJson: 'MapDataType',
    SubstrateMapE142Layout: 'LayoutType',
    SubstrateMapE142Substrate: 'SubstrateType',
    SubstrateMapE142SubstrateMap: 'SubstrateMapType',
    SubstrateMapE142Overlay: 'OverlayType',
    SubstrateMapE142BinCodeMap: 'BinCodeMapType',
    SubstrateMapE142BinCodeEntry: 'BinCodeType',
    SubstrateMapE142BinDefinition: 'BinDefinitionType',
    SubstrateMapE142ReferenceDevice: 'ReferenceDeviceType',
    SubstrateMapE142DeviceIdEntry: 'DeviceIdType',
    SubstrateMapE142DeviceIdMap: 'DeviceIdMapType',
    SubstrateMapE142Transfer: 'TransferType',
    SubstrateMapE142TransferMap: 'TransferMapType',
    SubstrateMapE142Parameter: 'ParameterType',
    SubstrateMapE142DeviceData: 'DeviceDataType',
    SubstrateMapE142DeviceDataMap: 'DeviceDataMapType',
    SubstrateMapE142AliasId: 'AliasIdType',
    SubstrateMapE142LogicalCoordinates: 'LogicalCoordinatesType',
    SubstrateMapE142PhysicalCoordinates: 'PhysicalCoordinatesType',
    SubstrateMapE142ZDimensions: 'ZDimensionsType',
};

/**
 * Definitions with no XSD counterpart, each with the reason.
 *
 * Listed rather than skipped: Done-when 3 of this task is that every definition is
 * either checked or named here. A definition that quietly matched nothing would be
 * the same gap this tool exists to close, in a new place.
 */
const UNMATCHED = {
    SubstrateMapE142PvValue:
        'E138, not E142 - PVSet lives in E138-1-V0709-Schema.xsd and is referenced by ccs:PVSet. Its '
        + 'sixteen PVType alternatives are covered by the e142-devicedata suite instead.',
    SubstrateMapE142BinaryPayload:
        'JSON-only. $binary is this transport\'s extension (Task 16); the XSD has no counterpart '
        + 'because XML has no reason for one.',
};

/**
 * Members whose cardinality deliberately differs, each with the reason.
 *
 * The same shape as the corpus\'s SCHEMA_INVALID and WARNING_CODES_DIFFER maps: an
 * entry names the member, both sources\' claims, and why. An exemption without a
 * reason is a suppression.
 */
const DELIBERATE = {
    'SubstrateMapE142BinCodeMap/BinCode':
        'XSD requires BinCode; JSON makes it "BinCode XOR $binary" through a oneOf, so it cannot sit '
        + 'in `required` - a $binary document has no BinCode at all. The oneOf enforces exactly-one, '
        + 'which is stricter than the XSD rather than looser (Task 16, D-051).',
};

/* ------------------------------------------------------------------ XSD */

/**
 * Minimal XML element reader: enough to walk an XSD's structure.
 *
 * A dependency-free reader rather than a parser library, matching the rest of
 * `tools/`. It reads tag names, attributes and nesting, which is all a cardinality
 * walk needs.
 * @param xml The document text.
 * @returns The root node, `{ tag, attrs, children }`.
 */
function parseXml(xml) {
    const root = { tag: '#root', attrs: {}, children: [] };
    const stack = [root];
    const re = /<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const [, closing, tag, rawAttrs, selfClose] = m;
        if (closing) { if (stack.length > 1) { stack.pop(); } continue; }
        const attrs = {};
        for (const a of rawAttrs.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) { attrs[a[1]] = a[2]; }
        const node = { tag: tag.replace(/^.*:/, ''), attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) { stack.push(node); }
    }
    return root;
}

/**
 * The cardinality of every member of one complexType.
 * @param root    The XSD root node.
 * @param ctName  The complexType name.
 * @returns `{ member: boolean }` where true means required, or null when absent.
 */
function xsdCardinality(root, ctName) {
    const find = (node) => {
        for (const c of node.children) {
            if (c.tag === 'complexType' && c.attrs.name === ctName) { return c; }
            const deeper = find(c);
            if (deeper !== null) { return deeper; }
        }
        return null;
    };
    const ct = find(root);
    if (ct === null) { return null; }

    const out = {};
    const walk = (node, optional) => {
        for (const c of node.children) {
            if (c.tag === 'sequence' || c.tag === 'all') {
                walk(c, optional || c.attrs.minOccurs === '0');
            } else if (c.tag === 'choice') {
                // Every branch of a choice is optional: one of them is the branch
                // not taken. OverlayType is the case that matters.
                walk(c, true);
            } else if (c.tag === 'complexContent' || c.tag === 'simpleContent'
                || c.tag === 'extension' || c.tag === 'restriction') {
                walk(c, optional);
            } else if (c.tag === 'element') {
                // `ref="ccs:PVSet"` carries no @name; the local name is the member.
                const name = c.attrs.name ?? (c.attrs.ref ?? '').replace(/^.*:/, '');
                if (name !== '') { out[name] = !optional && c.attrs.minOccurs !== '0'; }
            } else if (c.tag === 'attribute') {
                const name = c.attrs.name ?? (c.attrs.ref ?? '').replace(/^.*:/, '');
                if (name !== '') { out[name] = c.attrs.use === 'required'; }
            }
        }
    };
    walk(ct, false);
    return out;
}

/* ----------------------------------------------------------------- run */

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const xsdFiles = readdirSync(XSD_DIR).filter((f) => /^E142-1-.*\.xsd$/.test(f)).sort();
const revisions = xsdFiles.map((f) => ({ name: f, root: parseXml(readFileSync(join(XSD_DIR, f), 'utf8')) }));

console.log('\n=============================');
console.log('  schema cardinality vs XSD');
console.log('=============================\n');
console.log(`  revisions consulted (${revisions.length}): ${xsdFiles.join(', ')}`);
console.log('  rule: required in JSON only if required in EVERY revision that has the member\n');

const findings = [];
let checkedDefs = 0;
let checkedMembers = 0;

for (const [defName, def] of Object.entries(schema.definitions)) {
    if (UNMATCHED[defName] !== undefined) { continue; }
    const ctName = TYPE_OF[defName];
    if (ctName === undefined) {
        findings.push({ where: defName, why: 'no entry in TYPE_OF and no entry in UNMATCHED — this '
            + 'definition is checked by nothing, which is the gap this tool exists to close' });
        continue;
    }

    /* Union the revisions: a member is required only where every revision that
     * declares it says so. */
    const union = new Map();
    for (const rev of revisions) {
        const card = xsdCardinality(rev.root, ctName);
        if (card === null) { continue; }
        for (const [member, req] of Object.entries(card)) {
            const prev = union.get(member);
            union.set(member, prev === undefined ? { req, seen: [rev.name] }
                : { req: prev.req && req, seen: [...prev.seen, rev.name] });
        }
    }
    if (union.size === 0) {
        findings.push({ where: defName, why: `complexType ${ctName} is in no revision on disk` });
        continue;
    }

    checkedDefs++;
    const required = new Set(def.required ?? []);
    const properties = new Set(Object.keys(def.properties ?? {}));

    for (const [member, { req, seen }] of union) {
        if (member.startsWith('$')) { continue; }
        if (!properties.has(member)) {
            // A member the JSON omits entirely is a coverage question, not a
            // cardinality one, and D-020's exhaustiveness claim already covers it.
            // Reported only when the XSD requires it, where the omission is fatal.
            if (req) {
                findings.push({ where: `${defName}/${member}`,
                    why: `XSD requires it (${seen.join(', ')}) and the JSON definition has no such property` });
            }
            continue;
        }
        checkedMembers++;
        const key = `${defName}/${member}`;
        const jsonReq = required.has(member);
        if (jsonReq === req) { continue; }
        if (DELIBERATE[key] !== undefined) { continue; }
        findings.push({
            where: key,
            why: req
                ? `XSD says REQUIRED in every revision that has it (${seen.join(', ')}); JSON does not list it in "required"`
                : `XSD says OPTIONAL in at least one revision (${seen.join(', ')}); JSON lists it in "required", so a valid document would be rejected`,
        });
    }
}

console.log(`  checked   ${checkedDefs} definitions, ${checkedMembers} members`);
console.log(`  unmatched ${Object.keys(UNMATCHED).length}, each with a reason:`);
for (const [d, why] of Object.entries(UNMATCHED)) { console.log(`    ${d}\n      ${why}`); }
if (Object.keys(DELIBERATE).length > 0) {
    console.log(`  deliberate divergences ${Object.keys(DELIBERATE).length}, each with a reason:`);
    for (const [d, why] of Object.entries(DELIBERATE)) { console.log(`    ${d}\n      ${why}`); }
}

const total = checkedDefs + Object.keys(UNMATCHED).length;
if (total !== Object.keys(schema.definitions).length) {
    findings.push({ where: '(coverage)', why: `${Object.keys(schema.definitions).length} definitions `
        + `exist but only ${total} are accounted for` });
}

console.log('');
if (findings.length === 0) {
    console.log('=============================');
    console.log('  OK — every required list matches the XSD');
    console.log('=============================\n');
    process.exit(0);
}
console.log('  DISAGREEMENTS:');
for (const f of findings) { console.log(`    [cardinality] ${f.where}\n      ${f.why}`); }
console.log('\n=============================');
console.log(`  ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
console.log('=============================\n');
process.exit(1);
