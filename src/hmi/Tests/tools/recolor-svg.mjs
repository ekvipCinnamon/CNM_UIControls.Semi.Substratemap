#!/usr/bin/env node
/*
 * recolor-svg.mjs - the dark variant of an SVG, from this project's colour engine.
 *
 * WHY NOT A CSS FILTER. `filter: invert()` rotates hue as well as lightness and
 * turns a blue accent orange. Mirroring lightness in OKLCH preserves colour
 * identity, and it is the operation `rgbToOklch` / `oklchToRgb` are already
 * checked against published values for (`D-082`). This project decides colour by
 * measurement; this is that rule in a new place.
 *
 * The output is a CHECKED-IN FILE, not a runtime filter. A designer can replace
 * it at any time and nothing regenerates it behind their back.
 *
 * ---- THE MIRROR IS COMPRESSED, AND THAT IS NOT A COMPROMISE ----
 *
 * `W-16` specifies `L -> 1 - L`. Applied literally to `NoData.svg` it destroys
 * half the illustration, and the reason is a property of the ENCODING rather
 * than of the arithmetic:
 *
 *     8-bit sRGB grey   0      1      2      3      5
 *     OKLCH L           0.000  0.067  0.085  0.097  0.115
 *
 * The very first step jumps L by 0.067 - more than three times the 0.02 at which
 * two colours become distinguishable. **Below L = 0.067 there is nothing but
 * black.** The source is a near-monochrome ramp with 22 of its 39 fills above
 * L = 0.9, so a plain mirror sends more than half the drawing into that hole:
 * measured, 49 pairs that were visibly distinct in the source come out
 * indistinguishable, three separate light greys all landing on #000000.
 *
 * So the mirror lands in `[FLOOR, 1]` instead of `[0, 1]`. `FLOOR` is just above
 * the L of rgb(1,1,1), which is the first value that is not black; a sweep over
 * the range confirms it, at 6 lost pairs against 49. See `D-150`.
 *
 * ---- WHAT IS NOT ASSERTED, AND WHY ----
 *
 * `W-16` asks that applying the tool twice return the original. **No operation
 * through OKLCH and back to 8-bit hex can do that**, compressed or not: the round
 * trip alone loses a bit, and #a09f9d comes back as #a09f9c under the plain
 * mirror. What replaces it is the check that Done-when was a proxy for - that the
 * arithmetic is sound - stated directly. See `tools-smoke`.
 *
 * Run:  node tools/recolor-svg.mjs <input.svg> <output.svg>
 *       node tools/recolor-svg.mjs --check <input.svg> <output.svg>
 * Exit: 0 on success; 1 if --check finds the output stale or a fill unparseable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseRgb, rgbToOklch, oklchToRgb } from '../Helpers/SubstrateMapEngine/Oklch.js';

/**
 * The darkest lightness the mirror will produce.
 *
 * Just above `L(rgb 1,1,1) = 0.0670`, which is the first 8-bit grey that is not
 * pure black. Anything mirrored below it is unrepresentable and collapses.
 */
export const FLOOR = 0.08;

/** A `.stNN { fill: #rrggbb; }` rule, which is the whole of this SVG's colour. */
const RULE = /(\.st\d+\s*\{[^}]*?fill:\s*)(#[0-9a-fA-F]{3,8})(\s*;?[^}]*\})/g;

/**
 * The dark counterpart of one colour.
 *
 * Chroma and hue are carried through untouched - that is the entire point, and
 * it is what a hue-rotating filter cannot do.
 * @param css A CSS colour.
 * @returns The mirrored colour as `#rrggbb`, or `null` when it does not parse.
 */
export function mirrorColor(css) {
    const rgb = parseRgb(css);
    if (rgb === null) { return null; }
    const c = rgbToOklch(rgb);
    const out = oklchToRgb({ L: FLOOR + (1 - c.L) * (1 - FLOOR), C: c.C, h: c.h });
    return '#' + [out.r, out.g, out.b]
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Rewrites every `.stNN` fill in an SVG.
 *
 * Only the `<style>` rules, because that is where every colour in this file is -
 * measured, not assumed: `fill=` and `stroke=` attributes appear zero times. A
 * source that put colour in an attribute would come through UNCHANGED and look
 * like the tool had done nothing, so the count is returned and the caller checks
 * it.
 * @param svg The source text.
 * @returns `{ text, changed, unparseable }`.
 */
export function recolorSvg(svg) {
    let changed = 0;
    const unparseable = [];
    const text = svg.replace(RULE, (whole, head, color, tail) => {
        const dark = mirrorColor(color);
        if (dark === null) { unparseable.push(color); return whole; }
        changed++;
        return head + dark + tail;
    });
    return { text, changed, unparseable };
}

/* ------------------------------------------------------------------- CLI */

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const args = process.argv.slice(2);
    const check = args[0] === '--check';
    const [input, output] = check ? args.slice(1) : args;
    if (!input || !output) {
        console.error('usage: node tools/recolor-svg.mjs [--check] <input.svg> <output.svg>');
        process.exit(2);
    }

    const source = readFileSync(input, 'utf8');
    const { text, changed, unparseable } = recolorSvg(source);

    console.log(`\n  recolor-svg  ${input} -> ${output}`);
    console.log('='.repeat(60));
    console.log(`  fills rewritten : ${changed}`);
    if (unparseable.length > 0) {
        console.log(`  UNPARSEABLE     : ${unparseable.join(', ')}`);
    }

    if (check) {
        /*
         * The regenerate-and-compare that keeps a checked-in file honest. A
         * designer's hand-painted replacement fails it, which is correct: the file
         * is theirs at that point and the tool should not be claiming to have
         * produced it. Delete the check from the gate, do not weaken it.
         */
        const existing = readFileSync(output, 'utf8');
        const same = existing === text;
        console.log(`  ${output} is ${same ? 'up to date' : 'STALE'}`);
        console.log('='.repeat(60) + '\n');
        process.exit(same && unparseable.length === 0 ? 0 : 1);
    }

    writeFileSync(output, text);
    console.log('='.repeat(60) + '\n');
    process.exit(unparseable.length === 0 ? 0 : 1);
}
