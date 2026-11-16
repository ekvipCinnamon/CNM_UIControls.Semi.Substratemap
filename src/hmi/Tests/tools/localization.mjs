#!/usr/bin/env node
/*
 * localization.mjs - the localization files, generated from the descriptors.
 *
 * ---- KEYS ARE SEMANTIC, NOT ENGLISH TEXT ----
 *
 * The first version used the English string as the key, so `localizedText` held
 * entries a thousand characters long whose key was an entire paragraph. That is
 * unusable: it cannot be looked up by hand, it changes whenever the English is
 * reworded, and it makes a diff unreadable.
 *
 * Keys are now short and say what SLOT they fill:
 *
 *     <Control>.displayName          the control's name in the toolbox
 *     <Control>.description          its one-line summary
 *     category.<Name>                an attribute category's heading
 *
 * The category suffix is the category's own `name` from the descriptor, which is a
 * stable identifier the engineering tool already uses, and it is shared: `Data`
 * appears on three controls and is translated once.
 *
 * ---- THREE LOCALES, en-US IS THE DEFAULT ----
 *
 * `en-US`, `en-UK`, `de-DE`, one file each, wired through the descriptor's
 * `languages` map. `en-US` carries `order: 0` so it wins: the schema says the file
 * with the LOWEST order supplies a conflicting variable, which is how "default" is
 * expressed in a format that has no `default` field for text.
 *
 * A locale that says the same thing as `en-US` omits the key entirely rather than
 * repeating it. Three copies of "SEMI E142" are three things that can drift.
 *
 * ---- THE DESCRIPTION IS REWRITTEN, NOT TRANSLATED ----
 *
 * A control's `description` in the descriptor is a design rationale running to a
 * thousand characters - why the bin chart is one control and not two, and so on.
 * That is right for an engineer reading the source and wrong for a toolbox tooltip
 * in any language. Translating it produced German nobody would write, because it
 * was an English argument wearing German words.
 *
 * So the localized `description` is ONE PLAIN SENTENCE per locale, written for
 * somebody choosing a control from a palette. The rationale stays in the descriptor
 * for whoever opens the file.
 *
 * ---- WHAT IS STILL NOT VERIFIED ----
 *
 * How the engineering tool binds a descriptor slot to a key. The supplied
 * `Language.Schema.json` says only "the name of each text variable", and the
 * framework stub carries no example pair. The scheme above is a convention chosen
 * here. If the tool expects different variable names, THIS FILE is the single place
 * to change them and all three locales follow.
 *
 *   node tools/localization.mjs           write the files
 *   node tools/localization.mjs --check   exit 1 if they are out of step
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** en-US first: `order` 0 makes it the fallback for a variable another locale omits. */
const LOCALES = [['en-US', 0], ['en-UK', 1], ['de-DE', 2]];

const CONTROLS = ['SubstrateMap', 'SubstrateMapBase', 'SubstrateMapWidget',
    'SubstrateMapFilterBar', 'SubstrateMapBinChart'];

/**
 * key -> text per locale. `en-UK` appears only where the two English spellings
 * genuinely differ - `color`, `center`, `normalize`.
 */
const TEXT = {
    /* ---- display names ---------------------------------------------------- */
    'SubstrateMap.displayName': { 'en-US': 'Substrate map', 'de-DE': 'Substratemap' },
    'SubstrateMapBase.displayName': {
        'en-US': 'Substrate map base (abstract)',
        'de-DE': 'Substratemap-Basis (abstrakt)',
    },
    'SubstrateMapWidget.displayName': {
        'en-US': 'Substrate map tile', 'de-DE': 'Substratemap-Kachel',
    },
    'SubstrateMapFilterBar.displayName': {
        'en-US': 'Substrate map filter bar', 'de-DE': 'Substratemap-Filterleiste',
    },
    'SubstrateMapBinChart.displayName': {
        'en-US': 'Substrate map bin chart', 'de-DE': 'Substratemap-Bin-Diagramm',
    },

    /* ---- one-sentence descriptions ---------------------------------------- */
    'SubstrateMap.description': {
        'en-US': 'Draws one substrate: its outline, its dies colored by status, and the labels '
            + 'over them. Reads SEMI E142 XML, Stream-21 transfer data or compact GridData.',
        'en-UK': 'Draws one substrate: its outline, its dies coloured by status, and the labels '
            + 'over them. Reads SEMI E142 XML, Stream-21 transfer data or compact GridData.',
        'de-DE': 'Zeichnet ein Substrat: Umriss, nach Status eingefärbte Dies und die '
            + 'Beschriftungen darüber. Liest SEMI-E142-XML, Stream-21-Transferdaten oder '
            + 'kompaktes GridData.',
    },
    'SubstrateMapBase.description': {
        'en-US': 'Abstract base for the substrate map controls. Not placeable; it provides the '
            + 'canvas, the resize handling and the render path its subclasses share.',
        'de-DE': 'Abstrakte Basis der Substratemap-Steuerelemente. Nicht platzierbar; sie '
            + 'stellt Canvas, Größenanpassung und Renderpfad für die abgeleiteten '
            + 'Steuerelemente bereit.',
    },
    'SubstrateMapWidget.description': {
        'en-US': 'A dashboard tile showing one substrate at a glance, with its identity, its '
            + 'yield and a marking when the data stops arriving.',
        'de-DE': 'Eine Dashboard-Kachel, die ein Substrat auf einen Blick zeigt - mit ID, '
            + 'Yield und einer Markierung, sobald keine Daten mehr eintreffen.',
    },
    'SubstrateMapFilterBar.description': {
        'en-US': 'A row of selectors that drives the filter settings of one or more substrate '
            + 'maps. Draws no map itself.',
        'de-DE': 'Eine Reihe von Auswahlfeldern, die die Filtereinstellungen einer oder mehrerer '
            + 'Substratemaps steuert. Zeichnet selbst keine Substratemap.',
    },
    'SubstrateMapBinChart.description': {
        'en-US': 'Counts the bins of one substrate and shows them as bars or as shares of the '
            + 'whole.',
        'de-DE': 'Zählt die Bins eines Substrats und zeigt sie als Balken oder als Anteile am '
            + 'Ganzen.',
    },

    /* ---- runtime strings the controls draw --------------------------------- */
    /*
     * Read with `this.__localization.getText(key)`. `getText` returns THE KEY when a
     * locale has no text for it, so every one of these must exist in en-US or the
     * operator sees `bar.filter` on the screen.
     */
    /*
     * "Filter" twice - once as the bar's field label and once as the attribute
     * category - is flagged by the engineering tool as a duplicate value. The
     * warning is a poor rule in general: German has one `Bank` for a bank and a
     * bench, and two concepts sharing a word is normal in every language. But here
     * the two really are the same word for the same idea in the same file, so the
     * label is made specific rather than the warning suppressed - and a reader of
     * the bar now sees which selector they are looking at.
     */
    'bar.filter': { 'en-US': 'Spatial filter', 'de-DE': 'Spatial Filter' },
    'bar.channel': { 'en-US': 'Channel', 'de-DE': 'Kanal' },
    'bar.highlight': { 'en-US': 'Highlight', 'de-DE': 'Hervorheben' },
    'bar.radius': { 'en-US': 'Radius' },
    'bar.radius.off': { 'en-US': 'off', 'de-DE': 'aus' },
    'bar.radius.one': { 'en-US': '1 cell', 'de-DE': '1 Zelle' },
    /* `{0}` is the count. The schema documents `{0}`, `{1}` as the placeholder form. */
    'bar.radius.many': { 'en-US': '{0} cells', 'de-DE': '{0} Zellen' },
    'bar.highlight.none': { 'en-US': 'none', 'de-DE': 'keine' },
    'bar.highlight.1': {
        'en-US': '1 \u00b7 pass and worse', 'de-DE': '1 \u00b7 Pass und schlechter',
    },
    'bar.highlight.2': {
        'en-US': '2 \u00b7 unknown and worse', 'de-DE': '2 \u00b7 Unknown und schlechter',
    },
    'bar.highlight.3': { 'en-US': '3 \u00b7 fail only', 'de-DE': '3 \u00b7 nur Fail' },
    'chart.other': { 'en-US': 'Other', 'de-DE': 'Sonstige' },
    'age.measured': { 'en-US': 'measured', 'de-DE': 'gemessen' },
    'age.received': { 'en-US': 'received', 'de-DE': 'empfangen' },

    /* ---- attribute categories --------------------------------------------- */
    'category.Data': { 'en-US': 'Data', 'de-DE': 'Daten' },
    'category.Substrate': { 'en-US': 'Substrate', 'de-DE': 'Substrat' },
    'category.Origin': { 'en-US': 'Origin', 'de-DE': 'Ursprung' },
    'category.View': { 'en-US': 'View', 'de-DE': 'Ansicht' },
    'category.Common': { 'en-US': 'Common', 'de-DE': 'Allgemein' },
    'category.Selection': { 'en-US': 'Selection', 'de-DE': 'Auswahl' },
    'category.SEMI-E142': { 'en-US': 'SEMI E142' },
    'category.Spatial-filter': { 'en-US': 'Spatial filter', 'de-DE': 'Spatial Filter' },
    'category.Channel': { 'en-US': 'Channel', 'de-DE': 'Kanal' },
    'category.Reference': { 'en-US': 'Reference', 'de-DE': 'Referenz' },
    'category.No-data': { 'en-US': 'No data', 'de-DE': 'Keine Daten' },
    'category.Tile': { 'en-US': 'Tile', 'de-DE': 'Kachel' },
    'category.Filter': { 'en-US': 'Filter' },
    'category.Chart': { 'en-US': 'Chart', 'de-DE': 'Diagramm' },
};

/**
 * The keys a control is responsible for, in a stable order.
 * @param name The control's folder name.
 * @param desc Its parsed descriptor.
 * @returns The key list.
 */
const RUNTIME = {
    SubstrateMapFilterBar: ['bar.filter', 'bar.channel', 'bar.highlight', 'bar.radius',
        'bar.radius.off', 'bar.radius.one', 'bar.radius.many', 'bar.highlight.none',
        'bar.highlight.1', 'bar.highlight.2', 'bar.highlight.3'],
    SubstrateMapBinChart: ['chart.other', 'age.measured', 'age.received'],
    SubstrateMapWidget: ['age.measured', 'age.received'],
    SubstrateMap: ['age.measured', 'age.received'],
    SubstrateMapBase: [],
};

/**
 * A category name turned into a legal key.
 *
 * The engineering tool rejects a key containing a space: *"The key must start with
 * a letter and it must not contain spaces, special characters and line breaks. It
 * may contain '.', '-' and '_'."* Three of the fourteen categories are two words -
 * `No data`, `Spatial filter`, `SEMI E142` - and their keys were invalid in the
 * IDE while validating against the framework's own JSON schema, which says nothing
 * about the character set.
 *
 * Non-alphanumerics collapse to `-`, which the rule allows and which keeps the name
 * readable: `category.No-data`. Not camel case, because a reader matching a key back
 * to the descriptor should be able to see the original.
 * @param name A category's `name` from the descriptor.
 * @returns The key suffix.
 */
function keySafe(name) {
    return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z]+/, '');
}

function keysFor(name, desc) {
    const out = [`${name}.displayName`, `${name}.description`, ...(RUNTIME[name] ?? [])];
    for (const c of desc.attributeCategories ?? []) {
        if (typeof c.name === 'string') { out.push(`category.${keySafe(c.name)}`); }
    }
    return out;
}

const missing = [];
const written = [];

for (const name of CONTROLS) {
    const desc = JSON.parse(readFileSync(join(ROOT, 'Controls', name, 'Description.json'), 'utf8'));
    const keys = keysFor(name, desc);
    for (const [locale, order] of LOCALES) {
        const text = {};
        for (const k of keys) {
            const entry = TEXT[k];
            if (entry === undefined) { missing.push(`${name}: no text for key "${k}"`); continue; }
            if (locale !== 'en-US' && entry[locale] === undefined) { continue; }
            text[k] = entry[locale] ?? entry['en-US'];
        }
        const file = {
            $schema: '../../Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1/runtimes/'
                + 'native1.12-tchmi/Schema/LocalizationDescription.Schema.json',
            scope: 'Control',
            locale,
            order,
            localizedText: text,
        };
        /*
         * A LOCALE THAT CHANGES NOTHING GETS NO FILE. `en-UK` differs from `en-US`
         * in one string across the whole package; the other four controls would get
         * an empty `localizedText`, which is a file that exists, validates, is
         * declared in the project, ships - and does nothing. This repository has
         * found that shape three times already.
         */
        if (Object.keys(text).length === 0) { continue; }
        const rel = `Controls/${name}/${locale}.localization`;
        const body = `${JSON.stringify(file, null, 2)}\n`.replace(/\n/g, '\r\n');
        const out = join(ROOT, rel);
        if (!CHECK) {
            writeFileSync(out, body, 'utf8');
            written.push(`${rel}  (${Object.keys(text).length} keys)`);
        } else if (!existsSync(out)) {
            missing.push(`${rel} does not exist`);
        } else if (readFileSync(out, 'utf8') !== body) {
            missing.push(`${rel} is out of step with its Description.json`);
        }
    }
}

if (missing.length > 0) {
    console.error('\n  Localization is incomplete:');
    for (const m of missing) { console.error(`    ${m}`); }
    console.error('  Add the text to TEXT in tools/localization.mjs, then re-run it.\n');
    process.exit(1);
}
if (CHECK) {
    console.log(`  localization          : ${CONTROLS.length} controls x ${LOCALES.length} `
        + 'locales, in step');
} else {
    for (const w of written) { console.log(`  wrote ${w}`); }
}
process.exit(0);
