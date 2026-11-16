/*
 * sheet.mjs - a tiny raster sheet and a PNG writer, for the review tools.
 *
 * Extracted from `contact-sheet.mjs` at `W-24`, when a second sheet needed the
 * same code. PNG by hand: zlib is in Node, and the alternative was a dependency
 * for one function.
 *
 * The extraction is verified by the aggregation contact sheet coming out BYTE-
 * IDENTICAL before and after - see `gates/W-24.md`. A shared helper that changed
 * one pixel of the existing sheet would be a worse trade than a second copy.
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ font */

/*
 * 5x7, uppercase and digits only - the label vocabulary is fixed and small, and
 * a full font would be more lines than the rest of this file. Each glyph is
 * seven rows of five bits, most significant bit leftmost.
 */
const FONT = {
    A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x1e, 0x11, 0x11, 0x11, 0x1e],
    C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
    E: [0x1f, 0x10, 0x1e, 0x10, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x1e, 0x10, 0x10, 0x10, 0x10],
    G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x1f, 0x11, 0x11, 0x11, 0x11],
    I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
    K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
    M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
    Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
    S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
    W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
    Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
    0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
    2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
    4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
    6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
    '-': [0, 0, 0, 0x1f, 0, 0, 0], '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
    '=': [0, 0, 0x1f, 0, 0x1f, 0, 0], '%': [0x11, 0x01, 0x02, 0x04, 0x08, 0x10, 0x11],
    ' ': [0, 0, 0, 0, 0, 0, 0], ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
    '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10], '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
    ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
};

/* ------------------------------------------------------------------ canvas */

/** A plain RGB byte canvas. */
export class Sheet {
    /** @param w Width. @param h Height. @param bg `[r,g,b]`. */
    constructor(w, h, bg) {
        this.w = w;
        this.h = h;
        this.bg = bg;
        this.px = Buffer.alloc(w * h * 3);
        for (let i = 0; i < w * h; i++) {
            this.px[i * 3] = bg[0];
            this.px[i * 3 + 1] = bg[1];
            this.px[i * 3 + 2] = bg[2];
        }
    }

    /** @param x X. @param y Y. @param c `[r,g,b]`. @returns Nothing. */
    set(x, y, c) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) { return; }
        const i = (y * this.w + x) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
    }

    /** @param x X. @param y Y. @param w W. @param h H. @param c Colour. @returns Nothing. */
    /**
     * Reads a pixel, for blending (`W-38a`).
     *
     * Out of bounds returns the background, so a caller blending against the edge
     * gets the same answer it would have got one pixel inside.
     * @param x Column. @param y Row.
     * @returns `[r, g, b]`.
     */
    get(x, y) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) { return this.bg; }
        const i = (y * this.w + x) * 3;
        return [this.px[i], this.px[i + 1], this.px[i + 2]];
    }

    rect(x, y, w, h, c) {
        for (let j = 0; j < h; j++) { for (let i = 0; i < w; i++) { this.set(x + i, y + j, c); } }
    }

    /**
     * Nearest-neighbour blit of a packed RGBA tile, composited on the sheet.
     * @param words Uint32Array of packed RGBA.
     * @param sw    Source width.
     * @param sh    Source height.
     * @param x     Destination x.
     * @param y     Destination y.
     * @param size  Destination side.
     * @returns Nothing.
     */
    blit(words, sw, sh, x, y, size) {
        for (let j = 0; j < size; j++) {
            const sy = Math.min(sh - 1, Math.floor((j * sh) / size));
            for (let i = 0; i < size; i++) {
                const sx = Math.min(sw - 1, Math.floor((i * sw) / size));
                const wd = words[sy * sw + sx] >>> 0;
                const a = (wd >>> 24) / 255;
                if (a === 0) { continue; }
                const dst = ((y + j) * this.w + (x + i)) * 3;
                if (y + j < 0 || y + j >= this.h || x + i < 0 || x + i >= this.w) { continue; }
                for (let k = 0; k < 3; k++) {
                    const src = (wd >>> (k * 8)) & 0xff;
                    this.px[dst + k] = Math.round(src * a + this.px[dst + k] * (1 - a));
                }
            }
        }
    }

    /** @param s Text. @param x X. @param y Y. @param c Colour. @param sc Scale. @returns Nothing. */
    text(s, x, y, c, sc = 1) {
        let cx = x;
        for (const ch of String(s).toUpperCase()) {
            const g = FONT[ch] ?? FONT[' '];
            for (let r = 0; r < 7; r++) {
                for (let b = 0; b < 5; b++) {
                    if ((g[r] >> (4 - b)) & 1) {
                        this.rect(cx + b * sc, y + r * sc, sc, sc, c);
                    }
                }
            }
            cx += 6 * sc;
        }
    }

    /** @param s Text. @param sc Scale. @returns Width in pixels. */
    static width(s, sc = 1) { return String(s).length * 6 * sc; }
}

/* ------------------------------------------------------------------ PNG */

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c;
    }
    return t;
})();
/** @param b Bytes. @returns CRC32. */
const crc32 = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) { c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ -1) >>> 0;
};
/** @param type Type. @param data Payload. @returns Chunk. */
const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
};
/** @param path Path. @param sheet A {@link Sheet}. @returns Nothing. */
export function writePng(path, sheet) {
    const raw = Buffer.alloc(sheet.h * (1 + sheet.w * 3));
    for (let y = 0; y < sheet.h; y++) {
        raw[y * (1 + sheet.w * 3)] = 0;
        sheet.px.copy(raw, y * (1 + sheet.w * 3) + 1, y * sheet.w * 3, (y + 1) * sheet.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(sheet.w, 0);
    ihdr.writeUInt32BE(sheet.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    writeFileSync(path, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

