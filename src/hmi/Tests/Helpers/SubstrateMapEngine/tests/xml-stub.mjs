/*
 * Copyright 2026 ekvip automation GmbH
 * Licensed under the Apache License, Version 2.0 (see the E142 engine headers).
 */

/**
 * @fileoverview Dependency-free, namespace-aware XML document stub for the
 * parseE142Xml injection seam (E142XmlParseOptions.parseDocument). Shared by the
 * node test harnesses; meets the E142XmlElement contract of domParseDocument
 * verbatim (localName prefix-stripped, namespaceUri, element children, text,
 * attribute() with getAttributeNS semantics) and THROWS on ill-formed input.
 */

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
        if (body[0] === '#') {
            const cp = (body[1] === 'x' || body[1] === 'X')
                ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(cp)) { throw new Error('bad character reference ' + m); }
            return String.fromCodePoint(cp);
        }
        if (Object.prototype.hasOwnProperty.call(XML_ENTITIES, body)) { return XML_ENTITIES[body]; }
        throw new Error('unknown entity ' + m);
    });
}

/** An E142XmlElement over a parsed node; attribute() mirrors getAttributeNS. */
class StubElement {
    constructor(localName, namespaceUri, attrs, children, text) {
        this.localName = localName;
        this.namespaceUri = namespaceUri;
        this._attrs = attrs;
        this.children = children;
        this.text = text;
    }
    attribute(localName, namespaceUri) {
        const ns = (namespaceUri === undefined || namespaceUri === '') ? null : namespaceUri;
        for (const a of this._attrs) {
            if (a.local === localName && (a.ns ?? null) === ns) { return a.value; }
        }
        return null;
    }
}

/**
 * Parses XML text into the root {@link StubElement}, or throws on any
 * well-formedness violation (unbalanced tags, premature EOF, unquoted values,
 * unbound prefixes). No DTD subset / mixed-content support is needed for the
 * corpus; comments, PIs, CDATA and the XML declaration are handled.
 */
function stubParseDocument(xml) {
    let i = 0;
    const n = xml.length;
    const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    const nameStart = /[A-Za-z_:]/;
    const nameChar = /[A-Za-z0-9_:.\-]/;
    const readName = () => {
        const s = i;
        if (i >= n || !nameStart.test(xml[i])) { throw new Error('expected a name at offset ' + i); }
        i++;
        while (i < n && nameChar.test(xml[i])) { i++; }
        return xml.slice(s, i);
    };
    const skipMisc = () => {
        for (;;) {
            while (i < n && isWs(xml[i])) { i++; }
            if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i); if (e < 0) { throw new Error('unterminated processing instruction'); } i = e + 2; continue; }
            if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) { throw new Error('unterminated comment'); } i = e + 3; continue; }
            if (xml.startsWith('<!DOCTYPE', i)) { let d = 0; while (i < n) { const c = xml[i++]; if (c === '<') { d++; } else if (c === '>') { if (d === 0) { break; } d--; } } continue; }
            break;
        }
    };
    const resolve = (stack, prefix) => {
        for (let k = stack.length - 1; k >= 0; k--) { if (prefix in stack[k]) { return stack[k][prefix]; } }
        return prefix === '' ? '' : undefined;
    };
    const split = (qn) => { const c = qn.indexOf(':'); return c < 0 ? { prefix: '', local: qn } : { prefix: qn.slice(0, c), local: qn.slice(c + 1) }; };

    function parseElement(stack) {
        if (xml[i] !== '<') { throw new Error('expected < at offset ' + i); }
        i++;
        const rawName = readName();
        const rawAttrs = [];
        for (;;) {
            while (i < n && isWs(xml[i])) { i++; }
            if (i >= n) { throw new Error('unterminated start tag (unexpected EOF)'); }
            const c = xml[i];
            if (c === '>' || c === '/') { break; }
            const an = readName();
            while (i < n && isWs(xml[i])) { i++; }
            if (xml[i] !== '=') { throw new Error('expected = in attribute at offset ' + i); }
            i++;
            while (i < n && isWs(xml[i])) { i++; }
            const q = xml[i];
            if (q !== '"' && q !== "'") { throw new Error('unquoted attribute value at offset ' + i); }
            i++;
            const vs = i;
            while (i < n && xml[i] !== q) { i++; }
            if (i >= n) { throw new Error('unterminated attribute value (unexpected EOF)'); }
            const rawVal = xml.slice(vs, i);
            i++;
            rawAttrs.push({ name: an, value: decodeEntities(rawVal) });
        }
        const scope = {};
        for (const a of rawAttrs) {
            if (a.name === 'xmlns') { scope[''] = a.value; }
            else if (a.name.startsWith('xmlns:')) { scope[a.name.slice(6)] = a.value; }
        }
        stack.push(scope);
        const en = split(rawName);
        const elemNs = resolve(stack, en.prefix);
        if (elemNs === undefined) { throw new Error('unbound element prefix "' + en.prefix + '"'); }
        const attrs = [];
        for (const a of rawAttrs) {
            if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) { continue; }
            const sp = split(a.name);
            let ans = null;
            if (sp.prefix !== '') {
                const u = resolve(stack, sp.prefix);
                if (u === undefined) { throw new Error('unbound attribute prefix "' + sp.prefix + '"'); }
                ans = u;
            }
            attrs.push({ local: sp.local, ns: ans, value: a.value });
        }
        const children = [];
        let textBuf = '';
        if (xml[i] === '/') { i++; if (xml[i] !== '>') { throw new Error('malformed empty-element tag'); } i++; stack.pop(); return new StubElement(en.local, elemNs || '', attrs, children, ''); }
        if (xml[i] !== '>') { throw new Error('expected > at offset ' + i); }
        i++;
        for (;;) {
            if (i >= n) { throw new Error('unexpected EOF in element ' + rawName); }
            if (xml.startsWith('</', i)) {
                i += 2;
                const cn = readName();
                while (i < n && isWs(xml[i])) { i++; }
                if (xml[i] !== '>') { throw new Error('malformed end tag'); }
                i++;
                if (cn !== rawName) { throw new Error('mismatched end tag </' + cn + '> for <' + rawName + '>'); }
                break;
            }
            if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) { throw new Error('unterminated comment'); } i = e + 3; continue; }
            if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i); if (e < 0) { throw new Error('unterminated CDATA'); } textBuf += xml.slice(i + 9, e); i = e + 3; continue; }
            if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i); if (e < 0) { throw new Error('unterminated processing instruction'); } i = e + 2; continue; }
            if (xml[i] === '<') { children.push(parseElement(stack)); continue; }
            const ts = i;
            while (i < n && xml[i] !== '<') { i++; }
            textBuf += decodeEntities(xml.slice(ts, i));
        }
        stack.pop();
        const full = textBuf + children.map((c) => c.text).join('');
        return new StubElement(en.local, elemNs || '', attrs, children, full);
    }

    const stack = [{ xml: 'http://www.w3.org/XML/1998/namespace' }];
    skipMisc();
    if (i >= n || xml[i] !== '<') { throw new Error('no root element'); }
    const root = parseElement(stack);
    skipMisc();
    if (i < n) { throw new Error('trailing content after root element at offset ' + i); }
    return root;
}

export { stubParseDocument };
