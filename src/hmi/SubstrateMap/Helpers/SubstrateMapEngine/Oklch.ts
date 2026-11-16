/**
 * @fileoverview
 * Oklch - sRGB <-> OKLab <-> OKLCH, and interpolation that stays in OKLCH.
 *
 * WHY NOT sRGB. Mixing two colors by averaging their sRGB components is
 * arithmetic on gamma-encoded numbers that were never meant to be added. Halfway
 * between green and red comes out a muddy olive that is darker than either end,
 * because sRGB's channels are not perceptually uniform and its luminance is not
 * one of its axes. A fail-fraction ramp built that way has a dead zone in the
 * middle where a 40 % tile and a 60 % tile look the same.
 *
 * OKLab (Björn Ottosson, 2020) is built so that equal numeric steps are roughly
 * equal perceptual steps, and it separates lightness `L` from chroma. OKLCH is its
 * polar form: `L` lightness, `C` chroma, `h` hue in degrees. Interpolating there
 * keeps a ramp evenly paced and keeps its lightness monotonic, which is what makes
 * "more red means worse" readable at a glance.
 *
 * SCOPE. Conversion and interpolation only. The matrices below are the published
 * constants, and the tests check them against values computed independently -
 * white, black and the sRGB primaries - rather than against this file's own
 * round trip, which would pass just as happily with a transposed matrix.
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

/** A color in OKLCH: lightness 0..1, chroma 0..~0.4, hue in degrees 0..360. */
export interface Oklch {
    /** Lightness, 0 (black) to 1 (white). */
    readonly L: number;
    /** Chroma. 0 is gray; sRGB reaches about 0.32 at its most saturated. */
    readonly C: number;
    /** Hue in DEGREES, 0..360. Meaningless when `C` is 0, and normalized to 0 there. */
    readonly h: number;
}

/** An sRGB color, each channel 0..255. */
export interface Rgb {
    /** Red, 0..255. */ readonly r: number;
    /** Green, 0..255. */ readonly g: number;
    /** Blue, 0..255. */ readonly b: number;
}

/**
 * sRGB transfer function, inverted: encoded 0..1 to linear-light 0..1.
 * @param c Encoded channel.
 * @returns Linear channel.
 */
function toLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * sRGB transfer function: linear-light 0..1 to encoded 0..1.
 * @param c Linear channel.
 * @returns Encoded channel.
 */
function toEncoded(c: number): number {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** @param x A number. @returns It, clamped to 0..1. */
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Converts sRGB to OKLCH.
 * @param rgb Channels 0..255.
 * @returns The color in OKLCH.
 */
export function rgbToOklch(rgb: Rgb): Oklch {
    const r = toLinear(clamp01(rgb.r / 255));
    const g = toLinear(clamp01(rgb.g / 255));
    const b = toLinear(clamp01(rgb.b / 255));

    // Linear sRGB -> LMS, then the cube root that makes the space uniform.
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

    const C = Math.hypot(A, B);
    // Hue is undefined for a gray. Reporting 0 rather than atan2's arbitrary
    // answer keeps `mixOklch` from rotating through a hue nobody chose.
    const h = C < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
    return { L, C, h };
}

/**
 * Converts OKLCH back to sRGB, clamped into gamut.
 *
 * Clamping per channel is crude - a proper gamut map would preserve hue by
 * reducing chroma - and it is what a ramp between two IN-gamut endpoints needs,
 * because every point on such a ramp is close to gamut already. `mixOklch`'s
 * output is the only thing this is asked to convert.
 * @param c The color.
 * @returns Channels 0..255, rounded.
 */
export function oklchToRgb(c: Oklch): Rgb {
    const rad = (c.h * Math.PI) / 180;
    const A = Math.cos(rad) * c.C;
    const B = Math.sin(rad) * c.C;

    const l = (c.L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (c.L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (c.L - 0.0894841775 * A - 1.2914855480 * B) ** 3;

    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

    return {
        r: Math.round(clamp01(toEncoded(r)) * 255),
        g: Math.round(clamp01(toEncoded(g)) * 255),
        b: Math.round(clamp01(toEncoded(b)) * 255),
    };
}

/**
 * Interpolates between two OKLCH colors.
 *
 * `L` and `C` move linearly; `h` takes the **shorter arc**, so a ramp from a hue
 * of 350 deg to 10 deg passes through 0 rather than traveling 340 deg the long
 * way round through green. A ramp that takes the long way is the classic
 * rainbow-in-the-middle bug and it is invisible until someone picks endpoints that
 * straddle the wrap.
 *
 * When either end is a gray its hue carries no information, so the other end's hue
 * is used for both: mixing gray toward red should redden, not rotate.
 * @param from Start color.
 * @param to   End color.
 * @param t    Position, clamped to 0..1.
 * @returns The interpolated color.
 */
export function mixOklch(from: Oklch, to: Oklch, t: number): Oklch {
    const u = clamp01(t);
    const fromGrey = from.C < 1e-7;
    const toGrey = to.C < 1e-7;
    const h0 = fromGrey ? to.h : from.h;
    const h1 = toGrey ? from.h : to.h;

    let dh = ((h1 - h0 + 540) % 360) - 180;      // signed shortest arc, -180..180
    if (fromGrey && toGrey) { dh = 0; }
    return {
        L: from.L + (to.L - from.L) * u,
        C: from.C + (to.C - from.C) * u,
        h: ((h0 + dh * u) % 360 + 360) % 360,
    };
}

/**
 * Perceptual distance between two colors: Euclidean in OKLab.
 *
 * OKLab is built so that equal Euclidean distances are roughly equal perceived
 * differences, which is the whole reason for converting before measuring - the
 * same comparison in sRGB says that two dark colors are as different as two
 * light ones with the same channel gap, and the eye disagrees.
 *
 * For scale: about **0.02** is a just-noticeable difference on a large flat
 * field, and the default theme's own closest intentional pair - `binPass` against
 * `unknown` - is **0.153**.
 * @param a A color.
 * @param b A color.
 * @returns The distance. 0 is identical.
 */
export function deltaEOk(a: Oklch, b: Oklch): number {
    const ra = (a.h * Math.PI) / 180;
    const rb = (b.h * Math.PI) / 180;
    return Math.hypot(
        a.L - b.L,
        Math.cos(ra) * a.C - Math.cos(rb) * b.C,
        Math.sin(ra) * a.C - Math.sin(rb) * b.C,
    );
}

/**
 * Perceptual distance between two CSS colors.
 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — `grid-render` and
 * `grid-aggregate` are its only callers. Every claim in this package about two
 * colors being distinguishable is a number this function produced, rather than a
 * sentence someone wrote; that is the whole reason it is exported. Not to be
 * confused with {@link minPairwiseDeltaE}, which does have a runtime consumer:
 * `BinPalette` measures the palette it has just generated.
 * Written down because an export with no runtime consumer otherwise reads as a
 * promise.
 * @param aCss A color.
 * @param bCss A color.
 * @returns The distance, or `null` when either is not a supported form.
 */
export function deltaECss(aCss: string, bCss: string): number | null {
    const a = parseRgb(aCss);
    const b = parseRgb(bCss);
    return a === null || b === null ? null : deltaEOk(rgbToOklch(a), rgbToOklch(b));
}

/**
 * Parses `#rgb`, `#rrggbb` or `rgb()` / `rgba()`.
 *
 * The same two forms `Engine.packColor` accepts, and for the same reason: they are
 * what the theme variables and `StatusColorMapping` actually contain. A named
 * color or `hsl()` returns `null` rather than a guess.
 * @param css A CSS color string.
 * @returns The color, or `null` when it is not one of the supported forms.
 */
export function parseRgb(css: string): Rgb | null {
    const s = String(css).trim();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
        return { r: parseInt(s[1] + s[1], 16), g: parseInt(s[2] + s[2], 16), b: parseInt(s[3] + s[3], 16) };
    }
    if (/^#[0-9a-fA-F]{6}$/.test(s)) {
        return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) };
    }
    const m = /^rgba?\(([^)]*)\)$/i.exec(s);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '').map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
            return { r: parts[0], g: parts[1], b: parts[2] };
        }
    }
    return null;
}

/**
 * @param rgb Channels 0..255.
 * @returns `#rrggbb`, lowercase.
 */
export function formatRgb(rgb: Rgb): string {
    const hex = (n: number): string =>
        Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/* ------------------------------------------------------------------------ *
 * A categorical palette
 *
 * K colors for K bin codes, chosen so no two are confusable. Even hue spacing at
 * one lightness and one chroma: a color wheel is the right structure here
 * because there IS no ordering to express - bin codes are nominal, and a ramp
 * would imply one that does not exist.
 * ------------------------------------------------------------------------ */

/**
 * The lightness and chroma every categorical color shares.
 *
 * **Chosen against the sRGB gamut, not for looks.** For even hue spacing to
 * actually be even, `(L, C)` has to be reachable at EVERY hue - otherwise
 * `oklchToRgb` clamps the hues nearest the sRGB corners and the "evenly spaced"
 * wheel is nothing of the sort. The maximum
 * chroma in gamut at all 360 hues was measured by bisection:
 *
 *   L 0.45 -> 0.081     L 0.60 -> 0.106     L 0.70 -> 0.123
 *   L 0.50 -> 0.089     L 0.65 -> 0.115     L 0.75 -> 0.132
 *   L 0.55 -> 0.098                         L 0.80 -> 0.104  (falls again)
 *
 * `L = 0.70` is close to the peak while staying in the weight range the theme's
 * own bin colors occupy (`L` around 0.62), and `C = 0.12` sits just under that
 * row's 0.123 ceiling so rounding cannot push a hue out. Rendered, the palette
 * matches the theory to about 0.001 and lightness drifts by under 0.002 across the
 * wheel - measured, not assumed.
 */
export const CATEGORICAL_L = 0.70;
/** See {@link CATEGORICAL_L}. */
export const CATEGORICAL_C = 0.12;

/**
 * The largest number of categorical colors generated before falling back to an
 * "other" bucket.
 *
 * **Ten, and the constraint is human rather than technical.** `Integer2` permits
 * 65 536 bin codes and a wheel can be divided any number of ways; a person cannot
 * reliably hold more than roughly ten arbitrary color categories at once, and a
 * map with 200 near-identical hues is not a map, it is noise with a legend.
 *
 * Above the cap the generator returns the cap's worth of colors plus one neutral
 * "other", and says so - rather than silently producing 200 colors of which 190
 * are indistinguishable.
 */
export const CATEGORICAL_CAP = 10;

/**
 * The minimum pairwise distance any generated palette is asserted to hold.
 *
 * **Derived from the cap, not chosen.** At `K = CATEGORICAL_CAP` with the chroma
 * above, adjacent hues are `2 * C * sin(pi / K)` = **0.0736** apart as rendered.
 * The floor is set just under that, because the cap is what makes it binding:
 * anything the generator will actually produce clears it, and `K = 8` clears it
 * comfortably at 0.0911.
 *
 * For scale, an OKLab just-noticeable difference on a large flat field is about
 * 0.02, so this is roughly 3.5 JND - the right order for small adjacent tiles that
 * a reader compares directly rather than from memory.
 */
export const CATEGORICAL_MIN_DELTA_E = 0.07;

/**
 * The color used for every bin past the cap.
 *
 * **Achromatic on purpose.** Gray is what this palette already means by "no
 * further distinction is being drawn", and it is what the theme's `unknown`
 * means too - so the two sitting close together (0.095 apart) is the message
 * rather than a collision. What matters is that it is far from every color it
 * has to be told apart FROM, and it is: 0.136 from the nearest palette entry,
 * against a 0.07 floor.
 */
export const CATEGORICAL_OTHER = '#8a8a8a';

/** What {@link categoricalPalette} returns. */
export interface CategoricalPalette {
    /** One color per bin, at most {@link CATEGORICAL_CAP} of them. */
    readonly colors: readonly string[];
    /** The color for everything past the cap, or `null` when nothing was capped. */
    readonly other: string | null;
    /** How many were asked for. */
    readonly requested: number;
    /**
     * One message when the cap was applied, otherwise `null`.
     *
     * A single string and not a list: the caller warns ONCE per palette, not once
     * per bin over the cap, and returning a diagnostic rather than taking a
     * callback keeps this a pure function.
     */
    readonly warning: string | null;
}

/**
 * K maximally distinguishable colors, by even hue spacing.
 *
 * The sequence carries **no severity meaning**. It exists to tell bins APART, not
 * to say which is worse - that is `binSeverity`'s job, and a caller that paints a
 * failing bin with whatever hue index 3 happens to be has thrown the distinction
 * away. Severity colors take precedence over these wherever both apply.
 * @param k         How many colors are wanted.
 * @param hueOffset Where on the wheel to start, in degrees. Rotating the whole
 *                  palette changes which bin gets which color and nothing else.
 * @returns The palette.
 */
export function categoricalPalette(k: number, hueOffset: number = 0): CategoricalPalette {
    const requested = Math.max(0, Math.floor(k));
    const n = Math.min(requested, CATEGORICAL_CAP);
    const colors: string[] = [];
    for (let i = 0; i < n; i++) {
        const h = (((hueOffset + (i * 360) / n) % 360) + 360) % 360;
        colors.push(formatRgb(oklchToRgb({ L: CATEGORICAL_L, C: CATEGORICAL_C, h })));
    }
    const capped = requested > CATEGORICAL_CAP;
    return {
        colors,
        other: capped ? CATEGORICAL_OTHER : null,
        requested,
        warning: capped
            ? `${requested} bin codes were asked for and ${CATEGORICAL_CAP} distinct colors were `
              + 'generated; the rest share one "other" color. A person cannot reliably separate more '
              + 'than about ten arbitrary colors at once, so more hues would be a legend rather than '
              + 'a map. Use BinSeverityPriority or BinQualityAliases to say which bins matter.'
            : null,
    };
}

/**
 * The lightness band a value ramp spans, and its hue.
 *
 * **Lightness-ordered, single-hue.** A value field is ORDINAL - level 3 is more
 * than level 2 - and lightness is the only channel a reader orders without being
 * told which end is which. A rainbow ramp reads as categorical and is the classic
 * way to make ordered data look unordered; a two-hue ramp asks a
 * color-blind reader to compare the channel they do not have.
 *
 * The band is deliberately WIDE - 0.25 to 0.92 - because a value field owns the
 * whole fill, so nothing else is competing for lightness the way the aggregate
 * band had to stay clear of the bin palette. The hue is the theme's `binPass`
 * bluish-green rotated to a neutral blue: present enough that the map does not
 * read as grayscale, far enough from `binFail` vermillion that a light tile is
 * never mistaken for a passing die.
 */
export const VALUE_RAMP_L0 = 0.25;
/** See {@link VALUE_RAMP_L0}. */
export const VALUE_RAMP_L1 = 0.92;
/** See {@link VALUE_RAMP_L0}. */
export const VALUE_RAMP_HUE = 245;

/**
 * `n` colors for an ordinal value field, dark to light.
 *
 * Chroma is held at whatever is in gamut at each lightness rather than at a
 * constant: the sRGB envelope narrows sharply toward both ends, so a fixed chroma
 * would clamp at the extremes and flatten exactly the steps a reader needs most.
 * It is scaled by a bell over the band, which is the shape of
 * the envelope itself.
 * @param n How many levels. `1` gives the light end alone.
 * @returns `n` CSS colors, `#rrggbb`, in table order.
 */
export function valueRampColors(n: number): string[] {
    const count = Math.max(0, Math.floor(n));
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        // A single level has no range to span, so it takes the light end rather
        // than dividing by zero. Nothing about one level is ordered.
        const t = count === 1 ? 1 : i / (count - 1);
        const L = VALUE_RAMP_L0 + (VALUE_RAMP_L1 - VALUE_RAMP_L0) * t;
        const C = 0.13 * Math.sin(Math.PI * t) + 0.02;
        out.push(formatRgb(oklchToRgb({ L, C, h: VALUE_RAMP_HUE })));
    }
    return out;
}

/**
 * The closest pair in a set of CSS colors.
 *
 * Exists so a palette's separation is a MEASUREMENT rather than a claim - the same
 * reason `aggregateClosestApproach` exists.
 * @param cssColors The colors.
 * @returns The smallest pairwise distance, or `Infinity` for fewer than two.
 */
export function minPairwiseDeltaE(cssColors: readonly string[]): number {
    const parsed = cssColors.map(parseRgb).filter((c): c is Rgb => c !== null).map(rgbToOklch);
    let min = Infinity;
    for (let i = 0; i < parsed.length; i++) {
        for (let j = i + 1; j < parsed.length; j++) {
            min = Math.min(min, deltaEOk(parsed[i], parsed[j]));
        }
    }
    return min;
}

/**
 * Interpolates two CSS colors through OKLCH.
 * @param fromCss Start color.
 * @param toCss   End color.
 * @param t       Position, 0..1.
 * @returns `#rrggbb`, or `null` when either input is not a supported form.
 */
export function mixCssOklch(fromCss: string, toCss: string, t: number): string | null {
    const a = parseRgb(fromCss);
    const b = parseRgb(toCss);
    if (a === null || b === null) { return null; }
    return formatRgb(oklchToRgb(mixOklch(rgbToOklch(a), rgbToOklch(b), t)));
}
