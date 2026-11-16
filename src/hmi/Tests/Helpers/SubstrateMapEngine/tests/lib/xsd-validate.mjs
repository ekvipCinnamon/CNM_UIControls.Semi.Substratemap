/*
 * xsd-validate.mjs - validate an E142 MapData document against a vendored XSD.
 *
 * Test-harness helper. Not shipped, not loaded by the control at runtime: the
 * HMI has no xmllint and does not validate. This exists so the suites can
 * assert that what the serializer emits is schema-valid, rather than merely
 * that it round-trips through our own parser - which would only prove the
 * parser and the serializer agree with each other.
 *
 * Contract
 * --------
 *   validateAgainstE142Xsd(xml, { version = 'V0125' }) -> { ok, errors }
 *
 *   ok === true    the document validates. errors is [].
 *   ok === false   the document was judged and rejected. errors is non-empty.
 *   ok === null    the document could NOT be judged. errors says why.
 *
 * The three-state result is the point. A caller that cannot tell "invalid"
 * from "could not check" will either skip real failures or fail clean runs on
 * machines without libxml2. So:
 *
 *   const r = validateAgainstE142Xsd(xml);
 *   if (r.ok === null) { skip(r.errors[0]); }   // environment, not the document
 *   else { ok(r.ok, r.errors.join('; ')); }
 *
 * ok:null covers three environment faults, distinguishable by errors[0]:
 *   - 'xmllint not available'          the binary is not on PATH
 *   - 'unknown schema version: ...'    caller asked for a revision we do not vendor
 *   - 'schema not usable: ...'         the XSD is missing or failed to compile
 *
 * That last one is worth its own state. xmllint exits 5 when the *schema*
 * fails to load or compile, and the commonest cause is E138-1-V0709-Schema.xsd
 * having gone missing from Schema/E142/ - the E142 revisions from V0921 on
 * xs:import it by bare relative filename, and without it they do not compile
 * at all, for any document. Reporting that as ok:false would blame the
 * document for a broken toolchain.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root is four levels up from tests/lib/. */
const SCHEMA_DIR = fileURLToPath(new URL('../../../../Schema/E142/', import.meta.url));

/** Revisions vendored under Schema/E142/. Keep in step with that directory. */
const KNOWN_VERSIONS = ['V0125', 'V0224', 'V0921', 'V0211'];

/** Placeholder substituted for the temp path, so errors are stable across runs. */
const DOC_LABEL = '<document>';

/**
 * Validate an E142 MapData document against a vendored XSD.
 *
 * @param {string} xml               the document, as text
 * @param {{version?: string}} [opts]
 * @returns {{ok: boolean|null, errors: string[]}}
 */
export function validateAgainstE142Xsd(xml, opts = {}) {
    const version = opts.version ?? 'V0125';

    if (!KNOWN_VERSIONS.includes(version)) {
        return {
            ok: null,
            errors: [`unknown schema version: ${version} (vendored: ${KNOWN_VERSIONS.join(', ')})`],
        };
    }

    const schema = join(SCHEMA_DIR, `E142-1-${version}-Schema.xsd`);
    if (!existsSync(schema)) {
        return { ok: null, errors: [`schema not usable: not found at ${schema}`] };
    }

    let dir = null;
    try {
        dir = mkdtempSync(join(tmpdir(), 'e142-xsd-'));
        const doc = join(dir, 'document.xml');
        writeFileSync(doc, xml, 'utf8');

        // --nonet: never resolve a schemaLocation over the network. Every import
        // we care about is local, and a document should not be able to make the
        // test suite phone out.
        const r = spawnSync('xmllint', ['--noout', '--nonet', '--schema', schema, doc], {
            encoding: 'utf8',
        });

        if (r.error && r.error.code === 'ENOENT') {
            return { ok: null, errors: ['xmllint not available'] };
        }
        if (r.error) {
            return { ok: null, errors: [`xmllint failed to run: ${r.error.message}`] };
        }

        const errors = cleanErrors(r.stderr, doc);

        // xmllint exit codes observed against libxml 2.9.14:
        //   0 valid | 1 the instance is not well-formed or not readable
        //   3 schema-validity failure | 5 the schema itself failed to load/compile
        if (r.status === 0) { return { ok: true, errors: [] }; }
        if (r.status === 5) {
            return {
                ok: null,
                errors: [`schema not usable: ${version} failed to compile`, ...errors],
            };
        }
        return {
            ok: false,
            errors: errors.length > 0 ? errors : [`xmllint exited ${r.status} without a message`],
        };
    } finally {
        if (dir) { rmSync(dir, { recursive: true, force: true }); }
    }
}

/**
 * Turn xmllint's stderr into a stable, caller-friendly list.
 *
 * Two things are stripped: the temp path, which changes every run and would
 * make error strings impossible to compare or snapshot, and the trailing
 * "<file> validates" / "<file> fails to validate" summary, which carries no
 * information the status code has not already given.
 *
 * @param {string} stderr
 * @param {string} docPath
 * @returns {string[]}
 */
function cleanErrors(stderr, docPath) {
    return String(stderr ?? '')
        .split('\n')
        .map((line) => line.split(docPath).join(DOC_LABEL).trimEnd())
        .filter((line) => line.trim() !== '')
        .filter((line) => !/^<document> (validates|fails to validate)$/.test(line.trim()));
}

export { KNOWN_VERSIONS, SCHEMA_DIR };
