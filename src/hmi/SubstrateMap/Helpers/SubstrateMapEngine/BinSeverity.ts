/*
 * BinSeverity.ts - the declared order over bins, and the vocabulary it rests on.
 *
 * WHY THIS FILE EXISTS. `binSeverity`,
 * `binSeverityTable`, `resolveBinQuality`, `BIN_QUALITY_RESERVED` and the four
 * `SEVERITY_*` constants lived in `Engine.ts` while every consumer of them lived
 * in `GridAggregate.ts`. That was tolerable with one consumer. The spatial filter
 * needs a palette-index-to-rank table and the bin statistics need the
 * rank per code, so there are three, and the move is due.
 *
 * ---- THIS FILE IMPORTS NOTHING, AND THAT IS THE POINT ----
 *
 * `Engine.ts` once had zero top-level imports, and the module graph must stay a
 * tree. `Engine.ts` now imports THIS file, so the root of the tree moved here
 * rather than disappearing. The invariant is acyclicity with a leaf that depends
 * on nothing, not the identity of the file that happens to be it.
 *
 * `BinTableEntry` came with the move for the same reason. `binSeverity` takes one,
 * so leaving the type behind would have meant a type-only import back into
 * `Engine.ts` - erased at emit, invisible at runtime, and a reference cycle on
 * paper that a reader would have to reason about every time. `Engine.ts`
 * re-exports it, so nothing that imports it today has to change.
 *
 * NO BEHAVIOR CHANGED HERE. Every line below was moved, not rewritten.
 */

/**
 * One row of a {@link GridModel.binTable}: a canonical bin code plus the joined
 * definition metadata, normalized. Exactly one row per
 * {@link DecodedBinPayload.codes} entry and at the same index, so `cells[i]`
 * indexes this table directly - which is what lets the renderer and the hit-test
 * resolve a cell without materializing anything per cell.
 */
export interface BinTableEntry {
    /** The canonical bin code token (the `codes` entry this row was built from). */
    code: string;
    /** Joined quality, trimmed; `null` when no definition matched or it carried none. */
    quality: string | null;
    /** Joined pick flag; `false` when no definition matched or it carried none. */
    pick: boolean;
}

/**
 * What a `BinQuality` token resolves to.
 *
 * Four outcomes, because three of them need different handling and collapsing
 * any two loses a diagnosis:
 *
 * - `'pass'` / `'fail'` - one of the two values E142 RESERVES, or an author alias
 *   onto one of them;
 * - `'undeclared'` - the attribute was absent or empty. E142-0225: *"If not
 *   present then BinQuality is undefined."* Not a defect and never warned about;
 * - `'unmapped'` - a token was declared that is neither reserved nor aliased. Also
 *   not a defect - the standard says *"Other values defined by an application"* -
 *   but this engine cannot place it on a severity scale, so it warns and says how
 *   to fix it.
 */
export type BinQualityResolution = 'pass' | 'fail' | 'undeclared' | 'unmapped';

/**
 * The `BinQuality` values SEMI E142-0225 reserves, and the only two recognized
 * without an author alias.
 *
 * **The list is exactly two on purpose, and it is the standard's list rather than
 * ours.** E142-0225 Table 6: *"The following values are reserved: 'Pass' -
 * Indicates a quality that has commercial value; 'Fail' - Indicates a quality that
 * does not have commercial value. Other values defined by an application."*
 * `[Primary source]`
 *
 * So `Good`, `Reject`, `Schlecht`, or the `A` / `B` / `C` / `D` that the standard's
 * own R2-1.6.3 pick-and-place example uses, are all legal E142 and none of them is
 * reserved. Adding any of them here would be claiming a reservation the standard
 * does not make - and the failure mode of guessing wrong is a failing die painted
 * with the passing color, which is the exact harm this whole feature exists to
 * prevent. Vocabulary belongs to the author, through `BinQualityAliases`.
 */
export const BIN_QUALITY_RESERVED: readonly string[] = ['pass', 'fail'];

/**
 * Resolves one `BinQuality` token to a severity.
 *
 * Matching is case-insensitive and trims, on both the token and the alias keys:
 * the existing `pass` / `fail` comparison already lowercased, and an author who
 * writes `Reject` in the map and `reject` in the document meant the same thing.
 * @param quality The declared token, or `null`.
 * @param aliases Author token -> `pass` / `fail`, or `null`.
 * @returns The resolution.
 */
export function resolveBinQuality(
    quality: string | null,
    aliases: Record<string, string> | null,
): BinQualityResolution {
    const q = (quality ?? '').trim().toLowerCase();
    if (q === '') { return 'undeclared'; }
    if (q === 'pass' || q === 'fail') { return q; }
    if (aliases) {
        for (const key of Object.keys(aliases)) {
            if (key.trim().toLowerCase() !== q) { continue; }
            const to = String(aliases[key] ?? '').trim().toLowerCase();
            // An alias may only point at a reserved value. Aliasing onto a third
            // token would invent a severity the ladder has no place for.
            if (to === 'pass' || to === 'fail') { return to; }
        }
    }
    return 'unmapped';
}

/* ------------------------------------------------------------------------ *
 * Severity
 *
 * Aggregation needs a TOTAL ORDER over bins, because a pixel standing for N x N
 * cells has to reduce them to one thing and "worst wins" is only meaningful if
 * worse is defined. Bin codes are nominal - `Ascii`, `Decimal`, `HexaDecimal` and
 * `Integer2` are tokens with no ordering - and color is worse than useless for
 * it: `[0,255]^3` is only partially ordered, and the values come from the theme,
 * so severity would change when someone edits a stylesheet.
 *
 * The order is therefore DECLARED, and this is where it is declared.
 * ------------------------------------------------------------------------ */

/** The null bin. Never painted, never selected, and the bottom of the scale. */
export const SEVERITY_NULL = 0;
/** A bin the document says has commercial value. */
export const SEVERITY_PASS = 1;
/**
 * A bin nobody classified.
 *
 * **Above `pass` on purpose.** A bin with no `BinQuality`, or one carrying a token
 * this control was never taught, has not been said to be good - and under
 * aggregation the cost of the two mistakes is not symmetric. Reporting an
 * unclassified die as passing hides it; reporting it as unclassified shows it. Rule
 * 9, failure-tolerant.
 */
export const SEVERITY_UNKNOWN = 2;
/** A bin the document says has no commercial value. */
export const SEVERITY_FAIL = 3;

/**
 * The rank of a bin on the severity scale.
 *
 * ---- THE LADDER ----
 *
 * 1. **A declared priority list, FLOORED AT `unknown`.** If `priority` names this
 *    bin's code, the author has said where it sits and it ranks above every
 *    unlisted one - UNLESS the document says the bin passes, in which case the
 *    list is ignored for it and the rank stays `pass`.
 *
 *    That exception is the whole reason this rung is not a plain override. The
 *    list is ordered most-severe-first, so an author who writes their vocabulary
 *    out as `["Pass", "Fail", "Scrap"]` - meaning "here is my ordering" rather
 *    than "here is what wins" - puts their PASSING code at the top of the scale.
 *    Under "worst wins" a tile holding one passing and one failing die then
 *    reduces to the passing bin, and the failure disappears. That is the exact
 *    harm this feature exists to prevent, reintroduced by a plausible reading of a
 *    view setting.
 *
 *    So: **the list orders the bins that are not known to be good.** A view
 *    setting may not silently overrule a document that says a die is saleable.
 *    The control warns when it happens (`E142_BIN_SEVERITY_PRIORITY_IGNORED`).
 * 2. **`BinQuality`,** through the two values E142 reserves plus whatever
 *    `BinQualityAliases` adds. `pass` and `fail` are the only tokens the
 *    standard reserves; everything else is application-defined.
 * 3. **`Pick`, in the one direction it carries information.** `Pick="true"` says
 *    the device *should be processed*, which is evidence of value, so it lifts an
 *    otherwise-unclassified bin to `pass`. `Pick="false"` lifts nothing,
 *    because `false` is the XSD default and appears
 *    on 65 of the 73 `BinDefinition`s in the corpus without anyone having typed it.
 * 4. Otherwise **`unknown`.**
 *
 * `BinQuality` is consulted BEFORE `Pick` rather than after, because a bin marked
 * `Pick="true"` and `BinQuality="Fail"` is a failing device being picked for
 * rework, and it is still a failing device. Pick may raise the floor under an
 * unclassified bin; it never lowers a declared one.
 *
 * The null bin is not decided here - it is index 0 of the bin table by invariant
 * and has no entry of its own to inspect. {@link binSeverityTable} applies it.
 * @param entry    The bin table entry.
 * @param priority Bin codes in severity order, **most severe first**. A listed code
 *                 outranks every unlisted one, except that a code the document
 *                 calls `pass` is never promoted - see rung 1.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @returns An integer rank; larger is more severe.
 */
export function binSeverity(
    entry: BinTableEntry,
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
): number {
    const q = resolveBinQuality(entry.quality, aliases ?? null);
    if (priority && q !== 'pass') {
        const at = priority.indexOf(entry.code);
        if (at >= 0) { return SEVERITY_FAIL + (priority.length - at); }
    }
    if (q === 'pass') { return SEVERITY_PASS; }
    if (q === 'fail') { return SEVERITY_FAIL; }
    // Undeclared or unmapped. Pick="true" is the document saying the device should
    // be processed, which is the only thing left that speaks to value.
    if (entry.pick === true) { return SEVERITY_PASS; }
    return SEVERITY_UNKNOWN;
}

/**
 * One severity rank per bin table index, ready for an aggregation reducer.
 *
 * Computed once per grid rather than per cell: a 1200x1200 map has 1.44 M cells
 * and at most a few hundred bins, so the reducer indexes this instead of
 * re-deciding.
 *
 * Index 0 is `SEVERITY_NULL` unconditionally - the null bin is the bin table's
 * first slot by invariant (ground truth 5), is never painted and is never
 * selected, so nothing about its `BinQuality` or `Pick` can make it matter.
 * @param binTable The grid's bin table.
 * @param priority Bin codes in severity order, most severe first.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @returns Ranks by bin index.
 */
export function binSeverityTable(
    binTable: readonly BinTableEntry[],
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
): Uint32Array {
    const out = new Uint32Array(binTable.length);
    for (let i = 1; i < binTable.length; i++) {
        out[i] = binSeverity(binTable[i], priority, aliases);
    }
    return out;                                    // out[0] stays SEVERITY_NULL
}
