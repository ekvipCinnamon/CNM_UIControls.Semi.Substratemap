# Changelog

Every change a consumer of this package can see. Kept in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the four-part
scheme the TwinCAT package feed uses.

Entries describe what changed for somebody **using** the controls. The reasoning behind a choice lives
in the source comment beside it, and the design records that produced it are not distributed.

<!-- TOC:BEGIN -->
**Contents**

- [\[Unreleased\]](#unreleased)
- [\[5.0.0.0\] - 2026-11-10](#5000-2026-11-10)
  - [Breaking: what a consumer must do](#breaking-what-a-consumer-must-do)
    - [1. The package id is `Ekvip.Cinnamon.Semi.SubstrateMap`](#1-the-package-id-is-ekvipcinnamonsemisubstratemap)
    - [2. Localization keys name the slot they fill, not the English text](#2-localization-keys-name-the-slot-they-fill-not-the-english-text)
  - [Fixed](#fixed)
  - [Changed](#changed)
  - [Added](#added)
- [\[4.0.0.0\]](#4000)
  - [Breaking: what a consumer must do](#breaking-what-a-consumer-must-do-1)
    - [1. An unbound control draws a no-data image, not a demo wafer](#1-an-unbound-control-draws-a-no-data-image-not-a-demo-wafer)
    - [2. A view binding an outline *and* `ShowDemoItems` now draws the demo](#2-a-view-binding-an-outline-and-showdemoitems-now-draws-the-demo)
    - [3. Bin codes with no `BinQuality` and no `StatusColorMapping` entry get a color](#3-bin-codes-with-no-binquality-and-no-statuscolormapping-entry-get-a-color)
    - [4. `onItemSelected` is raised after the attributes it describes](#4-onitemselected-is-raised-after-the-attributes-it-describes)
  - [Also in this release](#also-in-this-release)
    - [New controls](#new-controls)
    - [Filters and channels](#filters-and-channels)
    - [The golden map](#the-golden-map)
    - [Age and staleness](#age-and-staleness)
  - [Version consistency](#version-consistency)
  - [Compatibility](#compatibility)
<!-- TOC:END -->

---

## [Unreleased]

Nothing yet.

## [5.0.0.0] - 2026-11-10

A major release because two changes ask something of a consumer. **Nothing a view binds has
changed:** no attribute, event or function was added, removed, renamed, retyped or re-defaulted since
4.0.0.0.

### Breaking: what a consumer must do

#### 1. The package id is `Ekvip.Cinnamon.Semi.SubstrateMap`

**Who sees it:** every engineering project that references the package. It was `SubstrateMap`, and
NuGet does not offer a package under a new id as an upgrade of the old one.

**What to do:** replace the package reference. **The control namespace is unchanged** -
`TcHmi.Controls.CNM_UIControls.SEMI.*` - so no view needs editing.

#### 2. Localization keys name the slot they fill, not the English text

**Who sees it:** anything that reads this package's `.localization` files by key. A key is now
`SubstrateMapBinChart.displayName` or `category.Data`, where before it was the whole English string -
in one case a thousand characters long.

**What to do:** update those keys. The controls and the views using them are unaffected.

### Fixed

- **The stale marking and the age text were drawn at the wrong size on any display whose device pixel
  ratio is not 1.** A tile's dashed stale border appeared as a small box near the top-left corner at
  roughly `1/ratio` of its intended size, and the `received …` text with it — 27 % of the tile at ratio
  3.125, 68 % at 1.25. The overlay took whatever transform the map draw left on the canvas; it now sets
  its own. **On a ratio-1 display nothing changed, which is why this survived so long.**
- **A long substrate identity ran through the chart's timestamp.** The identity is drawn from the left
  and the age from the right, and nothing measured whether they fit — `W-SORT 256x256` on a 250-pixel
  chart produced `W-SORT  256x25ceived 14:05:26`. The identity is now shortened with an ellipsis to the
  room available. **The timestamp is never shortened**: half a clock time is not a time.
- **The dashboard tile and the bin chart ignored `E142MapData` and `E142MapDataJson`.** Both declared
  the attributes, stored them, and built their grid from `GridData` only, so a tile bound to a valid
  E142 document showed *"no data"* while holding it. Both now read all three inputs by the same route
  the map does, and agree with it on all 58 document fixtures.
- **A tile kept a selection it never reported.** The pointer path filled a selection and drew a ring
  that was then discarded. A control that does not select now declines before hit-testing.
- **The share chart drew its legend over its own header.** The header band is reserved in both chart
  styles.
- **`nuget pack` could not find the icon on a case-sensitive filesystem.** The nuspec declares
  `images/logo.png`; the repository held the file as `Images/logo.png`. Windows resolves one to the
  other, so a build there was not affected; a Linux build was.
- **The README named the wrong anchor box.** With no Outline bound, the origin anchors attach to the
  grid's extent, or to a default 200 mm substrate when there is no grid either — not, as the README
  said, to the items' own bounding box. The behavior is unchanged; the documentation now describes it.
- **The build failed on Linux.** The TwinCAT HMI framework package references its jQuery types as
  `JQuery/` and ships them as `jQuery/`; a case-sensitive filesystem treats those as two directories.
  `npm run tsconfig` now links the name the reference wants, and `npm run doctor` reports a missing
  link. **The package itself is unchanged** - this concerns building it, not using it.

### Changed

- **The controls appear in the Toolbox under `Cinnamon SEMI`.**
- **`en-US`, `en-UK` and `de-DE` are supplied**, with `en-US` as the default. The toolbox descriptions
  are one plain sentence per locale rather than the design rationale that was there before.
- **The strings the controls draw are localized** — the filter bar's labels and options, its radius
  readout, and the chart's remainder bucket. Bin codes are **not** translated: they are the document's
  own data, and translating them would make a chart disagree with the map beside it.
- **Three diagnostic messages read differently.** `E142_JSON_UNKNOWN_MEMBER`,
  `E142_XML_SUBSTRATE_TYPE_UNKNOWN` and `E142_XML_INTEGRITY` cited internal task and rule numbers in
  their text; they now state the reason instead. **The codes are unchanged** — match on the code,
  never on the message.
- **The shipped text is US English throughout** — documentation, descriptors, source comments and
  messages. The `en-UK` localization is the one deliberate exception.

### Added

- **The diagnostic register says what to do.** All 29 `E142_*` codes now carry a likely cause and a
  remedy, and where the control recovers by itself the entry says so.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the controls and the engine fit together, with diagrams
  generated from the sources.
- **[API.md](API.md)** — five symptoms, each with the file, the line and the call chain to break on.
  Written for the moment something is wrong and you do not want to start at the top.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — prerequisites, the three commands, and where the `.nupkg`
  comes from.
- **Worked examples and screen captures in the README.**

---

## [4.0.0.0]

### Breaking: what a consumer must do

#### 1. An unbound control draws a no-data image, not a demo wafer

**Who sees it:** any view with an unbound `GridData`, `E142MapData` or `E142MapDataJson`.

Before, a control with nothing bound drew a sample wafer. It looked like data, and on more than one
panel it *was* mistaken for data. Now it draws an explanatory image: a picture that says *there is
nothing here*, in the theme's own colors.

**What to do:** if you were relying on the demo appearing in a running view — for a placeholder, a
screenshot, or a training panel — set `ShowDemoItems="true"` explicitly. It is off by default.

**If you were not**, do nothing. A view that always binds data is unaffected.

#### 2. A view binding an outline *and* `ShowDemoItems` now draws the demo

**Who sees it:** views shaped like `Desktop.view` panel 6 — an outline bound, `ShowDemoItems` on, no
map.

Before, binding an outline suppressed the demo, so the flag did nothing and the panel showed an empty
substrate. That was a defect: the flag was on, and nothing honored it. The demo now draws **inside**
the bound outline, scaled to fit it.

**What to do:** if such a panel is meant to be empty, turn `ShowDemoItems` off. It is the flag that
was being ignored, and it is now doing what it says.

Real bound items still suppress the demo. Only the *empty* case changed.

#### 3. Bin codes with no `BinQuality` and no `StatusColorMapping` entry get a color

**Who sees it:** maps carrying codes that declare neither.

Before, such a code fell through to the unknown color — so eight sort grades rendered as eight
identical grays. Now each gets a distinct color from a categorical palette, with a measured minimum
perceptual separation.

**What to do:** if you were relying on unqualified codes being visually merged, declare a
`StatusColorMapping` entry giving them the same color explicitly. Relying on the merge was relying on
a limitation.

**A map whose codes all carry `BinQuality` renders byte-identically to before.** Quality coloring
still wins over the categorical fallback, so the common case does not move.

#### 4. `onItemSelected` is raised after the attributes it describes

**Who sees it:** any view whose `onItemSelected` action reads `SelectedItemId`, `SelectedItemStatus`
or `SelectedItems`.

Before, the event was raised **before** those attributes were written, so a handler reading them got
the *previous* selection — and on the first click of a session there was none, so it read `null`. It
looked intermittent because re-clicking the same cell leaves the attributes unchanged and only a click
on a new cell showed it.

**What to do:** if you built a workaround — a one-click delay, a second read, ignoring the first
event — remove it. If you read the event's own payload rather than the attributes, nothing changes for
you; the payload was always correct.

**Ordering is the only change.** The event fires once per click as before, with the same payload.

---

### Also in this release

Three new controls, a filter pipeline, a golden-map comparison and a reference overlay. All additive.

#### New controls

| Control | What it is |
|---|---|
| `SubstrateMapWidget` | A dashboard tile. A map with a smaller attribute surface, not a container holding one. |
| `SubstrateMapBinChart` | Bins counted, as bars or as proportions. One control for both. |
| `SubstrateMapFilterBar` | Selectors that drive a map's filters through a binding. Renders no map. |

Each is registered, themed for Base and Base-Dark, and documented in the README.

#### Filters and channels

`SpatialFilter` — `None`, `Median`, `Min`, `Max`, `Box`, `Gauss` — over `FieldView` — `Bins`,
`FailDensity`, `ValueField`. Eight of the eighteen pairings are illegal and are reported rather than
silently substituted. See the README's table.

Filters run over the aggregated bitmap, so **they engage when the map aggregates and not before**.

#### The golden map

`ReferenceGridData` and `ReferenceMode` compare a map against another. The useful reference is not a
perfect wafer but one carrying what the wafer is *supposed* to contain — test dies, dummy dies,
process-control structures, which bin as defects by design. Bind it and they gray out; what stays lit
is what is actually wrong.

#### Age and staleness

`MapTimestamp` on the map, the tile and the chart — the same attribute, so one symbol drives all
three. Where it is unbound, the control shows when the payload arrived instead, and says which clock
it used.

`StaleAfterSeconds` marks a tile whose data has stopped arriving. The control wakes to check at a rate
**derived from the threshold**, so a fifteen-minute takt is not polled every second and a
one-second takt is not polled every minute. Nothing runs when no threshold is set.

---

### Version consistency

The 2.0 notes took credit for fixing exactly this class of inconsistency, and it had come back — in
two places at once. The nuspec read `4.0.0.0` while **all four new controls' `Description.json` read
`0.0.1.0`**, and the nuspec's own release notes still led with `3.0.0.0`.

All of it now says `4.0.0.0`, and **`check-manifest` compares three things**: the nuspec's `<version>`,
every control's descriptor, and the version the release notes lead with. It found all five faults on
its first run.

An earlier draft of this section claimed a gate already existed. It did not. A claim in shipped
documentation about a check that is not there is worse than the drift it describes, because it tells a
reader not to look.

---

### Compatibility

- **No existing binding changes meaning.** Every attribute added in this release defaults to today's
  behavior.
- **No attribute was removed or renamed.**
- **The three items above are the complete list of visible changes.** Anything else that looks
  different is a defect; please report it.
