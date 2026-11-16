/*
 * headings.mjs - a Markdown document's headings, and the anchors GitLab gives them.
 *
 * Shared by `toc.mjs`, which writes the tables of contents, and `check-readme.mjs`,
 * which resolves the repository front page's anchored links. One rule for an anchor
 * in two places would be two chances for a link to point at nothing.
 *
 * ---- THE ANCHOR RULE IS GITLAB'S ----
 *
 * The repository is on GitLab, so its renderer decides. GitLab lower-cases the
 * heading's TEXT, removes everything that is not a word character, a hyphen or a
 * space, turns spaces into hyphens, and collapses a run of hyphens into one. GitHub
 * does all of that except the collapse, so `A — B` is `a-b` on GitLab and `a--b` on
 * GitHub. A heading seen twice gets `-1`, `-2` appended, counted over EVERY heading
 * in the document, not only the ones a table of contents lists.
 *
 * "Text" means what the heading renders as: a code span contributes its contents,
 * a link its label, emphasis nothing. Taking the raw source instead would keep the
 * backticks out but the `**` in, and every emphasized heading would miss.
 *
 * ---- WHAT IS NOT A HEADING ----
 *
 * A `#` line inside a fenced code block is a shell comment or a Markdown sample,
 * and a table of contents that listed it would link to nothing. Fences are tracked
 * by their opening marker, so a ``` block can contain a ~~~ line and vice versa.
 */

/**
 * The text a heading renders as.
 * @param src The heading's source after the `#`s.
 * @returns The rendered text.
 */
export function headingText(src) {
    /*
     * Code spans first and verbatim: inside one, `user_data` keeps its underscore and
     * `*` is a character. Everything else loses its markup. An underscore only
     * delimits emphasis at a word boundary - `a_b_c` is one word, as CommonMark has it.
     */
    return src
        .replace(/\s+#+\s*$/, '')                                  // closing #s
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 === 1 ? part.slice(1, -1) : part
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                 // image -> alt
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                  // link -> label
            .replace(/<[^>]+>/g, '')                                  // inline HTML
            .replace(/\*\*(.+?)\*\*/g, '$1')                           // strong
            .replace(/(^|[^\p{L}\p{N}])__(.+?)__(?![\p{L}\p{N}])/gu, '$1$2')
            .replace(/\*(.+?)\*/g, '$1')                               // emphasis
            .replace(/(^|[^\p{L}\p{N}])_(.+?)_(?![\p{L}\p{N}])/gu, '$1$2')
            .replace(/\\(.)/g, '$1')))                                 // escapes
        .join('')
        .trim();
}

/**
 * The heading as a contents-list label: its own Markdown, so a code span stays a code
 * span, with links reduced to their label (a link inside a link is not a link) and
 * square brackets outside code escaped, so `[Unreleased]` is not read as one.
 * @param src The heading's source after the `#`s.
 * @returns The label.
 */
export function headingLabel(src) {
    return src
        .replace(/\s+#+\s*$/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/([[\]])/g, '\\$1')))
        .join('')
        .trim();
}

/**
 * GitLab's anchor for a heading text, before de-duplication.
 * @param text The rendered heading text.
 * @returns The anchor, without the `#`.
 */
export function anchorOf(text) {
    return text.trim().toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
        .replace(/ /g, '-')
        .replace(/-{2,}/g, '-');
}

/**
 * Every heading outside fenced code, in document order, with its unique anchor.
 * @param md       The document.
 * @param skip     Optional `[begin, end]` marker pair whose content is ignored -
 *                 the table of contents itself, which contains no headings but is
 *                 skipped so it never could.
 * @returns `{ level, text, label, anchor, line }` per heading; `line` is 0-based.
 */
export function headings(md, skip = null) {
    const out = [];
    const seen = new Map();
    let fence = null;
    let skipping = false;
    md.split(/\r?\n/).forEach((raw, line) => {
        if (skip !== null && raw.trim() === skip[0]) { skipping = true; return; }
        if (skip !== null && raw.trim() === skip[1]) { skipping = false; return; }
        if (skipping) { return; }
        const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
        if (f !== null) {
            if (fence === null) { fence = f[1][0].repeat(f[1].length); }
            else if (f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; }
            return;
        }
        if (fence !== null) { return; }
        const h = /^(#{1,6})\s+(.*)$/.exec(raw);
        if (h === null) { return; }
        const text = headingText(h[2]);
        const base = anchorOf(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.push({ level: h[1].length, text, label: headingLabel(h[2]), anchor: n === 0 ? base : `${base}-${n}`, line });
    });
    return out;
}
