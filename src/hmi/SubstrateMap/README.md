# SubstrateMap

![A substrate map: a wafer outline with its dies colored by status, the origin marker at the data
origin, and the substrate identity below.](Images/map-griddata.png)

*One control, one binding. The outline comes from a preset, the dies from `GridData`, and the line
underneath is the substrate identity and the age of the data.*

SubstrateMap renders a semiconductor substrate — a wafer or panel — together with
the features placed on it. The substrate itself is drawn from a single **Outline**
shape; the features are supplied as **Items**: dies, structures, keep-outs, test
sites, or any set of geometries you author. Each Item is filled according to its
**status**, may carry a **label**, and is individually selectable. Selection is
reported both as an event and as read-only outputs you can bind to symbols or other
controls.

The data model is small: an **Item** is a shape with a status, plus one pass-through
field (`user_data`) that is echoed back to you on selection, so you can carry your own
keys through a click without a lookup table. On top of that sits the substrate Outline
and a configurable **data
origin** that decouples the frame your Items are authored in from the substrate's own
geometric frame — so coordinates coming straight out of a stepper or vision system
can be dropped in without pre-transformation.

---

**What changed and what you must do about it** is in [CHANGELOG.md](CHANGELOG.md), including the
four breaking changes in 4.0.0.0.

**To build or change the package yourself**, [CONTRIBUTING.md](CONTRIBUTING.md) has the
prerequisites, the three commands, and where the `.nupkg` comes from.

**When something is wrong and you need a breakpoint**, [API.md](API.md) gives the call chain for
each symptom - the file, the method and the line to break on. The chains are traced from the
sources and every line reference is verified, so you can go straight to the frame that matters.

**How it is put together** — the class relationships, the engine’s module graph, and which
control uses what — is in [ARCHITECTURE.md](ARCHITECTURE.md). Those diagrams are generated from
the sources, so an arrow that is there is an import that exists.

<!-- TOC:BEGIN -->
**Contents**

- [Getting started](#getting-started)
  - [Install the package](#install-the-package)
  - [Place the control](#place-the-control)
  - [See it immediately (demo mode)](#see-it-immediately-demo-mode)
  - [Worked examples](#worked-examples)
  - [Bind your data](#bind-your-data)
- [Coordinates and orientation](#coordinates-and-orientation)
  - [Substrate frame (S)](#substrate-frame-s)
  - [Data frame (D)](#data-frame-d)
  - [Defaults](#defaults)
  - [Angles](#angles)
  - [Fit](#fit)
  - [Transform pipeline](#transform-pipeline)
- [Usage](#usage)
- [Items](#items)
  - [Geometry shapes](#geometry-shapes)
  - [Paint mode](#paint-mode)
  - [Z-order and `layer`](#z-order-and-layer)
  - [Example](#example)
- [Outline](#outline)
  - [Outline precedence](#outline-precedence)
  - [Outline presets](#outline-presets)
- [Origin](#origin)
  - [Example](#example-1)
  - [Origin marker](#origin-marker)
- [View](#view)
  - [Display-only](#display-only)
  - [Fit](#fit-1)
- [Status assignments](#status-assignments)
- [Status colors](#status-colors)
- [Labels](#labels)
- [SEMI E142](#semi-e142)
  - [Which one to bind](#which-one-to-bind)
  - [GridData (the compact path)](#griddata-the-compact-path)
  - [E142MapData (the XML path)](#e142mapdata-the-xml-path)
  - [E142TransferData (the Stream-21 transfer path)](#e142transferdata-the-stream-21-transfer-path)
  - [Which input wins](#which-input-wins)
  - [Choosing a map in a multi-substrate document](#choosing-a-map-in-a-multi-substrate-document)
  - [Attributes](#attributes)
  - [Cell colors](#cell-colors)
  - [Substrate side](#substrate-side)
  - [Orientation: the zero reference](#orientation-the-zero-reference)
  - [Reference-device alignment](#reference-device-alignment)
  - [Location identifiers (LID)](#location-identifiers-lid)
  - [Transfer maps (where a device came from)](#transfer-maps-where-a-device-came-from)
  - [Device data (E138 `PVSet`)](#device-data-e138-pvset)
  - [Sizing and fit](#sizing-and-fit)
  - [Payload size](#payload-size)
  - [Exporting a bound map](#exporting-a-bound-map)
- [Representation sizes and parse times](#representation-sizes-and-parse-times)
- [Bin quality](#bin-quality)
- [Severity](#severity)
  - [Why the priority list cannot promote a passing bin](#why-the-priority-list-cannot-promote-a-passing-bin)
  - [Choosing the reduction](#choosing-the-reduction)
  - [How many items is too many](#how-many-items-is-too-many)
  - [Injecting a transform](#injecting-a-transform)
  - [Touch targets](#touch-targets)
  - [Which selection event fires](#which-selection-event-fires)
  - [Telling a summary from a datum](#telling-a-summary-from-a-datum)
- [How to read a claim in this document](#how-to-read-a-claim-in-this-document)
- [E142 conformance](#e142-conformance)
  - [The matrix is about objects, not encodings](#the-matrix-is-about-objects-not-encodings)
  - [Out of scope by design](#out-of-scope-by-design)
  - [What this package claims](#what-this-package-claims)
- [Selection and the `onItemSelected` event](#selection-and-the-onitemselected-event)
  - [When the map has nothing to show](#when-the-map-has-nothing-to-show)
  - [Which filter works on which channel](#which-filter-works-on-which-channel)
  - [Filters need pixels, and the zoom decides](#filters-need-pixels-and-the-zoom-decides)
  - [What a filter costs](#what-a-filter-costs)
  - [When a selection event fires, its attributes are already written](#when-a-selection-event-fires-its-attributes-are-already-written)
  - [The four empty-ish states, and which one you are in](#the-four-empty-ish-states-and-which-one-you-are-in)
  - [The no-data image, and what to ship](#the-no-data-image-and-what-to-ship)
  - [Spatial filters, channels and a reference map](#spatial-filters-channels-and-a-reference-map)
  - [The bin chart](#the-bin-chart)
  - [The dashboard tile](#the-dashboard-tile)
  - [Driving the filters from a bar](#driving-the-filters-from-a-bar)
  - [Demo content is always marked](#demo-content-is-always-marked)
  - [How a bin code gets its color](#how-a-bin-code-gets-its-color)
  - [`onItemSelected` versus `SelectedItems`](#onitemselected-versus-selecteditems)
- [Selected outputs](#selected-outputs)
- [Attribute reference](#attribute-reference)
  - [SubstrateMap](#substratemap-1)
  - [SubstrateMapWidget](#substratemapwidget)
  - [SubstrateMapBinChart](#substratemapbinchart)
  - [SubstrateMapFilterBar](#substratemapfilterbar)
  - [SubstrateMapBase, inherited by the map, the tile and the chart](#substratemapbase-inherited-by-the-map-the-tile-and-the-chart)
- [Theming](#theming)
- [Diagnostic codes](#diagnostic-codes)
<!-- TOC:END -->

## Getting started

### Install the package

SubstrateMap ships in the **`Ekvip.Cinnamon.Semi.SubstrateMap`** framework-control
package. Add it to your TwinCAT HMI (TE2000) project the way you add any control
package. Once it is referenced, the controls appear in the Toolbox under
**Cinnamon SEMI**.

### Place the control

Drag **SubstrateMap** from the Toolbox onto a view or Content control. It sizes to its
container; give it a roughly square box for a round substrate. Rendering is
device-pixel-ratio aware, so the drawing stays crisp on high-DPI displays, and the
control re-fits automatically whenever it is resized.

### See it immediately (demo mode)

Set **`ShowDemoItems`** to `true` and the control draws a demo wafer map with nothing
bound: a 300 mm notch wafer (the `si-12in` preset) tiled with ~180 dies, each die a
swept outline, binned into five status classes on a fixed demo palette that runs from
a dark azure for the best bin to a rust red for the reject bin. Use it to
confirm placement, sizing, theming and selection before wiring real data, then set it
back to `false` in production. Demo
content only appears when nothing else supplies an outline — see
[Outline precedence](#outline) below.

### Worked examples

The markup below is what the engineering tool writes when you set the attributes; you
will normally set them in the designer rather than by hand. Each one is a complete,
placeable control.

**A map fed a SEMI E142 document.** One binding, and the map reads the identity, the
layout and the bins out of the document.

```html
<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMap"
     data-tchmi-id="Map"
     data-tchmi-width="480" data-tchmi-width-unit="px"
     data-tchmi-height="480" data-tchmi-height-unit="px"
     data-tchmi-e142-map-data="%s%PLC1::MapDataXml%/s%"
     data-tchmi-outline-preset="si-8in-p100"
     data-tchmi-substrate-identity-position="below"></div>
```

![Three maps beside three tiles: the same three substrates drawn as full maps on the left and as
compact dashboard tiles on the right.](Images/maps-and-tiles.png)

*The same three substrates, as maps and as tiles. A tile is a map with a smaller attribute surface -
no outline, no origin marker, and a marking of its own when the data stops arriving.*

**A dashboard tile.** The same document, a smaller surface, and a marking when the
feed stops. `StaleAfterSeconds` is the attribute a wall display needs and a map does
not.

```html
<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapWidget"
     data-tchmi-id="Tile"
     data-tchmi-width="210" data-tchmi-width-unit="px"
     data-tchmi-height="210" data-tchmi-height-unit="px"
     data-tchmi-e142-map-data="%s%PLC1::MapDataXml%/s%"
     data-tchmi-show-substrate-id="true"
     data-tchmi-show-yield="true"
     data-tchmi-stale-after-seconds="30"></div>
```

![A dashboard: three tiles above a filter bar, and below it the same lot drawn unfiltered and
filtered side by side with a bar chart and a share chart of its bins.](Images/dashboard.png)

*Unfiltered on the left, filtered on the right, from one bar. The comparison is the point: a filtered
image on its own says nothing about what the filter removed.*

**One filter bar driving two maps.** The bar writes the filter attributes; bind the
same symbols on the map you want filtered and leave the other unbound. Unfiltered
beside filtered is the comparison that makes a filter worth having — a filtered image
on its own says nothing about what the filter removed.

```html
<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapFilterBar"
     data-tchmi-id="Bar"
     data-tchmi-spatial-filter="%s%Internal::Filter%/s%"
     data-tchmi-spatial-filter-radius="%s%Internal::Radius%/s%"
     data-tchmi-field-view="%s%Internal::Channel%/s%"></div>

<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMap"
     data-tchmi-id="Filtered"
     data-tchmi-grid-data="%s%PLC1::Grid%/s%"
     data-tchmi-spatial-filter="%s%Internal::Filter%/s%"
     data-tchmi-spatial-filter-radius="%s%Internal::Radius%/s%"
     data-tchmi-field-view="%s%Internal::Channel%/s%"></div>
```

![Two pie charts and a bar chart, each headed by its substrate identity on the left and the age of
the data on the right.](Images/charts.png)

*Both chart styles off the same data. A long identity is shortened so it never runs into the
timestamp; the timestamp is never shortened, because half a clock time is not a time.*

**A bin chart beside the map.** It takes the **same map attributes the map does**, not
a reference to the map — an id coupling points at nothing the moment somebody moves
the map to another page, and the failure looks like *"the chart is empty"*.

```html
<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapBinChart"
     data-tchmi-id="Chart"
     data-tchmi-width="250" data-tchmi-width-unit="px"
     data-tchmi-height="155" data-tchmi-height-unit="px"
     data-tchmi-grid-data="%s%PLC1::Grid%/s%"
     data-tchmi-chart-style="Share"
     data-tchmi-chart-sort="CountDescending"></div>
```

**Reading the selection.** A click raises `onItemSelected` (or `onGroupSelected` when
a touch target covers several dies) and fills the read-only `Selected*` attributes, so
a detail panel can bind to them without handling the event at all.

```javascript
TcHmi.EventProvider.register('Map.onItemSelected', function (e, data) {
    // data.itemId, data.binCode, data.x, data.y
    TcHmi.Symbol.writeEx('%s%Internal::SelectedDie%/s%', data.itemId);
});
```

### Bind your data

The three attributes you will normally bind are **`Items`** (the features),
**`Outline`** (the substrate shape) and **`StatusColorMapping`** (status → color). Add
**`Labels`** and **`ItemStatusAssignments`** as needed. All of these are complex
attributes: set them inline as JSON, from an internal symbol, or from a PLC/server
symbol.

---

## Coordinates and orientation

SubstrateMap works in two coordinate frames. Getting the split right is the whole
trick to placing Items correctly.

### Substrate frame (S)

Two-dimensional, **millimeters**, **+x right, +y up**. Its origin is the substrate's
geometric center. For the standard presets the primary flat (or notch) sits at
**6 o'clock**, following SEMI convention. The **Outline is authored in this frame**,
and the bounding box of the Outline defines two things: the area the control fits to
the canvas, and the anchor points the data origin can attach to.

### Data frame (D)

The frame **every Item and Label is authored in**. D can be offset, rotated and
mirrored relative to S so that machine coordinates land in the right place without
conversion. That placement is governed by a group of origin attributes (full details
and a worked example in [Origin](#origin)):

- **`OriginLocation`** — where D's origin attaches on the outline's bounding box:
  `center`, `top-left`, `bottom-left`, `top-right`, `bottom-right`.
- **`OriginOffsetX` / `OriginOffsetY`** (with **`OriginOffsetPrefix`**) — an extra
  translation added to that anchor, along the S axes (+y up).
- **`OriginRotation`** — a rotation of D's axes about the data origin.
- **`YAxisDirection`** — `up` or `down`; `down` mirrors D's y axis for vision systems
  whose +y grows downward.

### Defaults

The origin attributes and the view rotation ship in this version. At their
**default values** — `OriginLocation` `center`, both offsets `0`, `OriginRotation`
`0`, `YAxisDirection` `up`, `MapRotation` `0` — the data frame coincides with the
substrate frame and the view is unrotated:

- origin at the **center of the outline's bounding box**,
- axes **aligned with the substrate frame** (+x right, +y up),
- no data rotation and no view rotation.

So if you leave the origin attributes untouched: **author your Items and Labels in
millimeters, with the origin at the substrate's center and +y pointing up** — the same
frame the Outline is drawn in. Change the origin attributes to move that frame; see
[Origin](#origin).

### Angles

Every angle you author — an Item's `orientation`, `OriginRotation` and `MapRotation`
— is **counter-clockwise-positive** as seen in a +y-up frame, and renders
counter-clockwise on screen. There is no hidden sign flip to compensate for. An Item's
`orientation` rotates that Item **about the center of its own combined geometry**, not
about the substrate origin. (With `YAxisDirection` set to `down`, a CCW-positive
orientation authored in that y-down frame appears clockwise on screen — that is the
intended physical behavior.)

### Fit

The substrate is scaled **uniformly** to fit the canvas with an **8 px margin**,
letterboxed — never stretched per axis.

#### What is fitted, and what is not

The **fit box** is chosen by the first of these that applies:

| # | When | The fit box is |
|---|---|---|
| 1 | an **`Outline`** is bound | the outline's `BBOX_S` |
| 2 | else an **`OutlinePreset`** is set | that preset's `BBOX_S` |
| 3 | else a **grid** is bound (`E142MapData`, `E142TransferData`, `GridData`) | the grid's extent, `stepSize × cols/rows` |
| 4 | else | a **200 mm × 200 mm square centered on the substrate origin** |

**Items never define the fit box.** A substrate has a size before anything is placed
on it, so adding, removing or moving an Item changes **no pixel** of the substrate —
not its scale and not its position. An Item lying outside the substrate is drawn
outside it rather than growing it.

Before this rule, row 4 was the union of the Item boxes, and every added Item re-fitted
the substrate: one Item gave an 8 × 8 mm fit, two gave 28 × 8 mm, five gave 88 × 8 mm,
and the center slid with them. That is visible, and it was the reason for the rule.

**The 200 mm default and how to change it.** Row 4 is only ever reached when the control
has been told nothing about the substrate: no `Outline`, no `OutlinePreset`, no grid.
200 mm is the bounding size of a 200 mm wafer, the most common production substrate.
To change it, say what the substrate is — bind an **`Outline`**, or set an
**`OutlinePreset`** (see [Outline presets](#outline-presets)). Both set the fit box and
draw the substrate, which is what you want if you know its size. There is no separate
attribute for the fallback extent, because those two already are one.

#### The identity band does not take space from the substrate

The substrate-identity line (`SubstrateId` and the age) is an **HTML element above or
below the canvas**, not something drawn on it, so its height comes out of the canvas'
height — and the canvas is what the substrate is fitted into.

**Exactly one line is reserved whenever `SubstrateIdentityPosition` is `above` or
`below`, whether or not there is anything to write in it, and no matter how long it
is.** The band's height is fixed, not merely floored: an over-long identity is clipped
with an ellipsis rather than wrapping to a second line. The substrate is therefore the
same size before and after data arrives, and the same size for a short id as for a
long one.

The age part of the line (`received HH:MM:SS` / `measured HH:MM:SS`) is restamped every
time a payload is bound — `Items`, `GridData`, `E142MapData`, `E142MapDataJson` or
`E142TransferData`. Rebinding an identical document does not restamp it: an unchanged
value is not an arrival.

Setting **`SubstrateIdentityPosition="none"`** removes the band entirely and gives its
space back to the substrate. That is the one thing that changes the substrate's size,
and it is deliberate: it is the author configuring the control, not content arriving.
The attribute is bindable, so flipping it at runtime does resize the substrate — as
would resizing the control itself.


### Transform pipeline

End to end, a point passes through four stages — **substrate frame → data frame → view →
canvas**:

1. **Substrate frame (S).** The Outline is authored here (millimeters, +y up, origin at
   the substrate center). Its axis-aligned bounding box `BBOX_S` is the fit box and the
   set of anchor points the data origin attaches to.
2. **Data frame (D).** Items and Labels are authored here and placed onto S by
   `D2S = T(anchor + offset) · R(OriginRotation) · Sc(1, YAxisDirection)`, where the
   anchor is the [`OriginLocation`](#origin) point on `BBOX_S`, the offset is
   `OriginOffsetX/Y` (scaled by `OriginOffsetPrefix`, measured along the S axes, +y up),
   and `Sc(1, YAxisDirection)` mirrors the y axis when `YAxisDirection` is `down`. The
   Outline skips this stage — it lives in S and never moves.
3. **View.** `VIEW = R(MapRotation)` rotates the whole construct — Outline, Items, Labels
   and the origin marker — about the substrate origin.
4. **Canvas.** A uniform letterbox scale `s` fits the VIEW-rotated `BBOX_S` into the
   canvas minus the 8 px margin, then `W = T(canvasCentre) · Sc(s, -s) · VIEW` maps to CSS
   pixels. The full chains are the Outline `p = W · p_S`, an Item
   `p = W · D2S · T(c_i) · R(theta_i) · T(-c_i) · p_geom` (its own orientation `theta_i`
   about its combined-geometry center `c_i`), and a Label `p = W · D2S · p_label` (the
   text itself is drawn upright).

The chain contains **exactly one axis flip** — the `Sc(s, -s)` inside `W` — so every
source angle, authored counter-clockwise-positive in a +y-up frame, renders
counter-clockwise on screen with no compensating sign. `YAxisDirection` `down` flips the
handedness of D, so a CCW-positive Item orientation authored in that y-down frame appears
**clockwise** on screen — the correct physical behavior. The hit-test rebuilds this same
chain minus the device-pixel base factor, so the clickable region always matches the
painted shape.

---

## Usage

A minimal placement in a view's HTML. Scalar attributes are set inline; the complex
attributes are shown inline here as compact JSON so the snippet is self-contained, but
in practice you would bind `Items`, `Outline`, `StatusColorMapping` and `Labels` to
symbols.

```html
<div data-tchmi-type="TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMap"
     data-tchmi-id="SubstrateMap"
     data-tchmi-width="480" data-tchmi-width-unit="px"
     data-tchmi-height="480" data-tchmi-height-unit="px"
     data-tchmi-selection-mode="single"
     data-tchmi-show-demo-items="false"
     data-tchmi-outline='{
       "unit": "meter", "prefix": "milli",
       "geometry": {
         "type": "polygon",
         "points": [{"x":100,"y":0},{"x":71,"y":71},{"x":0,"y":100},{"x":-71,"y":71},{"x":-100,"y":0},{"x":-71,"y":-71},{"x":0,"y":-100},{"x":71,"y":-71}]
       }
     }'
     data-tchmi-status-color-mapping='{ "pass": "#2e7d32", "fail": "#c62828", "test": "#1565c0" }'
     data-tchmi-items='[
       { "item_id": 1001, "name": "Die A1", "status": "pass",
         "unit": "meter", "prefix": "milli",
         "geometries": [ { "type": "rectangle", "center_position_x": -30,
                           "center_position_y": 20, "width": 18, "length": 12 } ] }
     ]'>
</div>
```

The full `Items`, `Outline`, `ItemStatusAssignments`, `StatusColorMapping` and `Labels`
shapes are documented in the sections below. Every attribute of every control is listed in the
[Attribute reference](#attribute-reference).

---

## Items

**Attributes:** [Item, label and demo attributes](#item-label-and-demo-attributes)

`Items` is an array. Each Item carries an optional identity and status, its own unit,
an optional orientation, and one or more geometries authored in the **data frame (D)**.

| Field                | Type                                   | Notes |
| -------------------- | -------------------------------------- | ----- |
| `item_id`            | number                                 | Optional. Numeric identity; referenced by `ItemStatusAssignments` and reported on selection. |
| `name`              | string                                 | Optional. Reported on selection. |
| `layer`             | number                                 | Optional. Z-order layer (see below). |
| `status`            | string                                 | Optional. Selects the fill color via `StatusColorMapping`; may be overridden by `ItemStatusAssignments`. |
| `unit`              | `"meter"`                              | Length unit for this Item's coordinates. |
| `prefix`            | metric prefix (`yocto` … `none`)        | Scales `unit`; e.g. `unit:"meter"` + `prefix:"milli"` means the coordinates are in millimeters. |
| `orientation`       | number                                 | Optional. Rotation of the Item about its own combined-geometry center. |
| `orientation_unit`  | `"degree"` \| `"radian"`               | Optional. Unit of `orientation`. |
| `orientation_prefix`| metric prefix                          | Optional. Scales `orientation`. |
| `user_data`         | string \| number                       | Optional. Opaque value passed through unchanged into the selection payload and exposed as `SelectedItemUserData`. SubstrateMap never interprets it. |
| `geometries`        | array of geometry                      | Required. One or more shapes, drawn together as one Item. |

### Geometry shapes

**Painted area is hit area.** A geometry is hit wherever it is colored, and nowhere
else:

| geometry | `stroke_width` | painted | hit |
|---|---|---|---|
| `rectangle`, `circle`, `ellipse`, `polygon` | absent | fill | interior |
| `rectangle`, `circle`, `ellipse`, `polygon` | present | **fill + edge** | **interior + edge** |
| `path` with a `close_path` | either | fill (+ edge) | interior (+ edge) |
| `polyline`, `path` without `close_path` | required / present | stroke | the stroke band |

A `stroke_width` on a closed shape adds an **edge**; it does not hollow the shape out.
Before 4.0.1 it did, so a large outlined die could only be tapped along its border —
while a small one felt fine, because the 4 px minimum hit band was most of it.

**To author an outline-only closed shape, use a `polyline` that returns to its start.**
It has no interior, so it is painted as a line and hit as a line.

Every geometry is authored in the Item's unit, in frame D, +y up. The supported shapes:

- **`rectangle`** — `{ "type": "rectangle", "x", "y", "width", "height" }` (center + extents)
- **`circle`** — `{ "type": "circle", "cx", "cy", "r" }`
- **`ellipse`** — `{ "type": "ellipse", "cx", "cy", "rx", "ry" }`
- **`polyline`** — `{ "type": "polyline", "points": [[x,y], …] }` (open, always stroked)
- **`polygon`** — `{ "type": "polygon", "points": [[x,y], …] }` (closed, filled)
- **`path`** — `{ "type": "path", "commands": [ … ] }` with commands
  `moveTo`, `lineTo`, `arc`, `bezierCurveTo`, `quadraticCurveTo`, `close`
  (arc angles are in degrees, CCW-positive, consistent with the frame).

### Paint mode

Each geometry is **filled** by default. Give a geometry a **`stroke_width`** and it is
drawn as an **outline** instead. **Polylines are always stroked.**

### Z-order and `layer`

Items **without** a `layer` are drawn first, in array order. Items **with** a `layer`
are drawn on top, in **ascending** layer order (ties keep array order). Use `layer` to
keep small features — markers, keep-outs, test sites — above larger die bodies.

### Example

A multi-geometry Item with an orientation and string `user_data`, followed by a
layered Item whose single geometry is a stroked path containing an arc, with numeric
`user_data`:

```json
[
  {
    "item_id": 1001,
    "name": "Die A1",
    "status": "pass",
    "unit": "meter",
    "prefix": "milli",
    "orientation": 30,
    "orientation_unit": "degree",
    "orientation_prefix": "none",
    "geometries": [
      {
        "type": "rectangle",
        "center_position_x": -30,
        "center_position_y": 20,
        "width": 18,
        "length": 12
      }
    ]
  }
]
```

Item 1001 is unlayered, so it is drawn first; it is rotated 30° CCW about the center of
its rectangle-plus-circle. Item 1002 has `layer: 2` and is drawn on top; because its
geometry carries a `stroke_width` it is outlined rather than filled, and the `arc`
sweeps CCW from −90° to +90° to round its right edge.

---

## Outline

**Attributes:** [Outline attributes](#outline-attributes)

The **`Outline`** is the substrate itself: a wrapper carrying a unit and one closed
geometry, authored in the **substrate frame (S)**.

```json
{
  "unit": "meter",
  "prefix": "milli",
  "geometry": {
    "type": "polygon",
    "points": [
      {
        "x": 100,
        "y": 0
      },
      {
        "x": 71,
        "y": 71
      },
      {
        "x": 0,
        "y": 100
      },
      {
        "x": -71,
        "y": 71
      },
      {
        "x": -100,
        "y": 0
      },
      {
        "x": -71,
        "y": -71
      },
      {
        "x": 0,
        "y": -100
      },
      {
        "x": 71,
        "y": -71
      }
    ]
  }
}
```

The geometry may be a `rectangle`, `circle`, `ellipse`, `polygon` or `path`
(multi-contour paths are allowed; the fill rule is non-zero). The example above is a
stylized 200 mm wafer with its flat at 6 o'clock. The Outline is **filled with the body
color** and **stroked with the edge color**, and **its bounding box defines the fit
box** and the anchor points for the data origin.

### Outline precedence

Whichever of the following applies first wins:

1. an explicit **`Outline`** binding,
2. the **`OutlinePreset`** attribute (see [Outline presets](#outline-presets) below),
3. the **demo outline**, when `ShowDemoItems` is `true`,
4. nothing.

### Outline presets

Set **`OutlinePreset`** to one of the keys below to draw a standard substrate
without authoring any geometry. Every preset is built in the **substrate frame (S)**,
centered on the substrate origin, with the primary flat or notch at **6 o'clock**. The
dimensions are the SEMI nominal values (millimeters). A bound **`Outline`** overrides
the preset; the preset overrides the demo. The default key **`none`** selects no preset
(falling through to the demo outline, or to nothing).

Two attributes modify how presets are drawn:

- **`SecondaryFlatDirection`** (`cw` default, or `ccw`) places the secondary flat
  clockwise or counter-clockwise from the primary, as seen on screen. It affects
  **disc-flats** presets only — single-flat, notch, pseudo-square and rectangle presets
  ignore it.
- **`NotchExaggeration`** (default `12`, clamped to `>= 1`) magnifies the true notch
  depth so the notch stays visible at wafer scale (a real notch is well under 1 % of the
  diameter). It affects **disc-notch** presets only.

Neither modifier ever changes a bound `Outline`.

**Silicon, flats** (⟨111⟩/⟨100⟩ = crystal orientation, P/N = doping; the secondary-flat
angle encodes the type):

| Key | Substrate |
| --- | --- |
| `si-2in-p111` | 2″ Si, ⌀50.8, single primary flat |
| `si-2in-n111` | 2″ Si, ⌀50.8, secondary flat 45° from primary |
| `si-2in-p100` | 2″ Si, ⌀50.8, secondary flat 90° from primary |
| `si-2in-n100` | 2″ Si, ⌀50.8, secondary flat 180° from primary |
| `si-3in-p111` | 3″ Si, ⌀76.2, single primary flat |
| `si-3in-n111` | 3″ Si, ⌀76.2, secondary flat 45° from primary |
| `si-3in-p100` | 3″ Si, ⌀76.2, secondary flat 90° from primary |
| `si-3in-n100` | 3″ Si, ⌀76.2, secondary flat 180° from primary |
| `si-4in-p111` | 4″ Si, ⌀100, single primary flat |
| `si-4in-n111` | 4″ Si, ⌀100, secondary flat 45° from primary |
| `si-4in-p100` | 4″ Si, ⌀100, secondary flat 90° from primary |
| `si-4in-n100` | 4″ Si, ⌀100, secondary flat 180° from primary |
| `si-5in-p111` | 5″ Si, ⌀125, single primary flat |
| `si-5in-n111` | 5″ Si, ⌀125, secondary flat 45° from primary |
| `si-5in-p100` | 5″ Si, ⌀125, secondary flat 90° from primary |
| `si-5in-n100` | 5″ Si, ⌀125, secondary flat 180° from primary |
| `si-6in-p111` | 6″ Si, ⌀150, single primary flat |
| `si-6in-n111` | 6″ Si, ⌀150, secondary flat 45° from primary |
| `si-6in-p100` | 6″ Si, ⌀150, secondary flat 90° from primary |
| `si-6in-n100` | 6″ Si, ⌀150, secondary flat 180° from primary |

**Silicon, notch** (300 mm and up use a notch, not flats):

| Key | Substrate |
| --- | --- |
| `si-8in` | 8″ Si, ⌀200, single notch |
| `si-12in` | 12″ Si, ⌀300, single notch |
| `si-18in` | 18″ Si, ⌀450, single notch |

**Compound and other round substrates:**

| Key | Substrate |
| --- | --- |
| `sic-4in` | 4″ SiC, ⌀100, primary + 90° secondary flat |
| `sic-6in-flat` | 6″ SiC, ⌀150, single primary flat |
| `sic-6in-notch` | 6″ SiC, ⌀150, single notch |
| `gaas-4in` | 4″ GaAs, ⌀100, primary + 90° secondary flat |
| `sapphire-2in` | 2″ sapphire, ⌀50.8, single primary flat |
| `sapphire-4in` | 4″ sapphire, ⌀100, single primary flat |

**Solar pseudo-square** (a square edge cut from a round ingot; the ingot diameter
chamfers the corners — the chamfer shrinks as the ingot approaches a full square):

| Key | Substrate |
| --- | --- |
| `solar-m0` | 156 mm pseudo-square from a ⌀200 ingot (large chamfer) |
| `solar-m2` | 156.75 mm pseudo-square from a ⌀210 ingot |
| `solar-g1` | 158.75 mm pseudo-square from a ⌀223 ingot (minimal chamfer) |
| `solar-m6` | 166 mm pseudo-square from a ⌀223 ingot |
| `solar-m10` | 182 mm pseudo-square from a ⌀247 ingot |
| `solar-g12` | 210 mm pseudo-square from a ⌀295 ingot (near-square) |

**Rectangular substrates** (flat-panel glass, ceramic):

| Key | Substrate |
| --- | --- |
| `glass-gen2.5` | 370 × 470 mm panel |
| `glass-gen4` | 550 × 650 mm panel |
| `ceramic-100x100` | 100 × 100 mm substrate |

---

## Origin

The **origin attributes** place the **data frame (D)** — the frame every Item and Label
is authored in — relative to the **substrate frame (S)**. They move Items and Labels
**only**: the Outline is authored in S and never moves, and it is the Outline's bounding
box (`BBOX_S`) that the anchors attach to. When no Outline is bound the anchor box is the
**grid's extent**, or with no grid either a **default 200 mm substrate** — never the items'
own bounding box, which would make the map change size as items are added.

Placement is the composition (rightmost factor applied first):

```
D2S = T(anchor + offset) · R(OriginRotation) · Sc(1, YAxisDirection)
```

The attributes are listed under [Origin attributes](#origin-attributes).

Two things worth stating explicitly:

- **Offsets are always along the substrate axes**, +y up, **regardless of
  `YAxisDirection`**. `YAxisDirection` mirrors the *authoring* of Item/Label coordinates,
  not the meaning of the offset.
- **Vision systems (`YAxisDirection` `down`).** Image/vision pipelines usually put the
  origin at the top-left with +y growing downward. Set `YAxisDirection` to `down` and
  pair it with `OriginLocation` `top-left` to author coordinates exactly as the vision
  system reports them. A CCW-positive Item `orientation` authored in that y-down frame
  then renders **clockwise** on screen — the correct physical behavior.
- **Round wafers (SEMI).** For round substrates the convention is to keep
  `OriginLocation` at **`center`** (the wafer center is the natural datum). This is a
  recommendation, not a constraint — any anchor is accepted.

### Example

All on a **100 × 100 mm rectangle** outline (so `BBOX_S` spans −50…+50 mm on each axis,
its lower-left corner at (−50, −50) in S):

- **`OriginLocation` `bottom-left`, `YAxisDirection` `up`:** an item at data (0, 0) sits
  at the lower-left outline corner; (10, 10) sits 10 mm right and 10 mm **above** that
  corner (inside the outline).
- **Same, `YAxisDirection` `down`:** (0, 0) is unchanged; (10, 10) now sits 10 mm right
  and 10 mm **below** the corner, i.e. **outside** the outline. (The natural y-down
  pairing is `OriginLocation` `top-left`.)
- **`OriginRotation` `90`** rotates the item ensemble 90° counter-clockwise **about the
  data origin (the anchor)**, not about the substrate center.

### Origin marker

Set **`ShowOriginMarker`** to `true` to overlay a diagnostic marker at the data origin:
a small crosshair marking the origin point, plus a `+x` and a `+y` axis stub with
arrowheads. The two axes are distinguished by arrowhead **count** — `+x` carries a single
head, `+y` a double one — not by color, so the marker stays readable for color-blind
viewers and in a single ink (it is drawn in the theme's selection color). Because it
rides the full data matrix, the marker shows the origin's **position, `OriginRotation`
and `YAxisDirection` at once**: rotate the data frame and the marker turns with it; set
`YAxisDirection` to `down` and the `+y` stub flips to point **downward** on screen —
exactly where the authored y axis points. The stubs and stroke stay a fixed size on
screen at any zoom, and the marker is purely visual: it is never hit-tested and cannot be
selected. Off by default.

---

## View

`MapRotation` rotates the **whole construct** — the Outline, all Items, all Labels and
the origin marker — as one, about the **substrate frame origin** (the center of the
outline's bounding box, where the origin marker's crosshair sits). It is a **view**
transform layered on top of everything else: it turns what you see without touching what
the data means.

Listed under [View attributes](#view-attributes).

The angle is **counter-clockwise-positive on screen** — the same sign convention as every
other angle in this control (see [Angles](#angles)), with no hidden flip. So on a
single-flat wafer, whose flat sits at **6 o'clock**:

- **`MapRotation` `90`** turns the flat counter-clockwise to **3 o'clock**,
- **`180`** to **12 o'clock**,
- **`270`** to **9 o'clock**.

### Display-only

`MapRotation` changes **only what is painted on the canvas**. It does **not**:

- change any Item's authored coordinates or `orientation`,
- change which Item a click or tap selects — a click hits the **same Item at any
  rotation** (0, 37, 90, 180 degrees all behave identically),
- change the `Selected*` outputs or the `onItemSelected` payload.

The substrate-identity label lives **outside the canvas** (above or below it), so it stays
upright and in place regardless of `MapRotation`. Label **text** stays upright too — only
each label's **box** turns with the construct, so a Label never reads sideways or
upside-down. To rotate the data ensemble *relative to* the substrate instead of the whole
view, use [`OriginRotation`](#origin).

### Fit

The drawing is **re-fitted** as it turns, so a non-zero `MapRotation` never clips. The fit
is deliberately **conservative**: it fits the rotated *bounding box* of the outline (not
the outline's actual silhouette), so a shape that does not fill its box gains a little
extra margin — a **45°-rotated square is fitted as its ≈√2-larger diagonal box**. This
keeps the fit robust without sampling the geometry; the cost is a slightly smaller drawing
at in-between angles.

---

## Status assignments

**Attributes:** [Status and color attributes](#status-and-color-attributes)

**`ItemStatusAssignments`** overrides the status embedded in an Item, matched by
`item_id`. This lets you drive status from live data without re-emitting the geometry.

```json
[
  { "item_id": 1001, "status": "fail" },
  { "item_id": 1002, "status": "rework" }
]
```

An assignment for `item_id` 1001 above replaces that Item's `status` of `"pass"` with
`"fail"`; the geometry, orientation and `user_data` are untouched.

---

## Status colors

**Attributes:** [Status and color attributes](#status-and-color-attributes)

**`StatusColorMapping`** maps a status string to a CSS color.

```json
{
  "pass":   "#2e7d32",
  "fail":   "#c62828",
  "rework": "#f9a825",
  "test":   "#1565c0"
}
```

An Item whose effective status is not present in the mapping falls back to the theme's
unknown-status color (`--substratemap-status-unknown`).

---

## Labels

**Attributes:** [Item, label and demo attributes](#item-label-and-demo-attributes)

**`Labels`** places free text on the substrate. Labels are authored in the **data frame
(D)**, using the same length handling as Items, but the **text itself is always drawn
upright** — it does not rotate with the data frame or the view.

```json
[
  {
    "center_position_x": -30,
    "center_position_y": 40,
    "width": 24,
    "length": 6,
    "unit": "meter",
    "prefix": "milli",
    "text": "Zone A"
  },
  {
    "center_position_x": 30,
    "center_position_y": 40,
    "width": 24,
    "length": 6,
    "unit": "meter",
    "prefix": "milli",
    "text": "Zone B"
  }
]
```

Each label is positioned by its anchor point in D; `horizontal_alignment` and
`vertical_alignment` place the text relative to that anchor. Label color and font come
from the theme (`--substratemap-label-font-color`, `--substratemap-label-font-family`,
`--substratemap-label-font-size`).

---

## SEMI E142

SubstrateMap can ingest a **SEMI E142 substrate map** directly and draw it as a grid
of binned cells, on top of (or instead of) the Items you author. This is the path to
use when your bin data comes from an E142 producer - a prober, a tester, or an MES -
rather than from hand-authored geometry. The grid is a first-class layer: it is
hit-tested and selectable exactly like Items, and each cell reports its bin and its
logical map coordinates on selection (see [Selection](#selection-and-the-onitemselected-event)).

There are **four mutually-exclusive inputs**, all bindable:

- **`GridData`** - a compact, PLC-friendly JSON contract describing a single map. Use
  this from a PLC/server symbol; it is the smallest and fastest of the four and the one
  to reach for first. On a 600 × 600 `Ascii` map: **362 kB and 5.1 ms**, against 362 kB
  and 6.8 ms for the E142 JSON envelope and 372 kB and 9.1 ms for the XML - one machine,
  one map, all three parsed in the same run, 2026-08. The margin is small; the reason to
  prefer it is that it is a *simpler contract*, not that it is quicker.
- **`E142MapData`** - a full **E142.1 MapData XML** document. Use this when you already
  have E142 XML in hand and do not want to reshape it.
- **`E142MapDataJson`** - the **same E142.1 document in JSON**. Not a different contract:
  it parses through the same code to the same model, so a map bound here renders
  identically to the same map bound as XML, warning for warning. Reach for it when the
  document arrives as a typed symbol rather than as text - the whole point is that you do
  not hand the control an opaque string. The format is
  [`Schema/E142/JSON-FORMAT.md`](Schema/E142/JSON-FORMAT.md).
- **`E142TransferData`** - the reassembled **E142.4 (Stream-21) item** content as raw
  bytes (base64, or a byte-value array). This is the **fallback for drivers that hand you
  *undecoded* bytes**: if your SECS stack already decodes the Stream-21 item to a string,
  bind that string to `E142MapData` and ignore this input. When you do bind bytes, they
  decode to XML and take the very same path as `E142MapData`
  (see [below](#e142transferdata-the-stream-21-transfer-path)).

### Which one to bind

Read down the first column that matches and stop.

| If … | bind | because |
|---|---|---|
| your data comes from a PLC or server symbol and is not an E142 document | **`GridData`** | it is the smallest contract and the fastest path, and it is what it was designed for |
| you already hold **E142 XML** | **`E142MapData`** | no reshaping, and it is the only form another vendor is guaranteed to read |
| you hold an E142 document as a **typed symbol** | **`E142MapDataJson`** | you do not have to serialize it just so the control can parse it back |
| a SECS driver hands you **undecoded Stream-21 bytes** | **`E142TransferData`** | it decodes them and then follows the `E142MapData` path exactly |

**About `$binary`.** The JSON envelope has an optional payload form carrying the bin indices as base64
instead of as token text. It is **not a separate input**: `E142MapDataJson` reads either form, and a
document using it renders identically. Reach for it only when the **wire** is the constraint and your
`BinType` is four characters wide — it is about a third smaller for `Decimal` and `Integer2`, **2.6×
larger** for `Ascii`, **1.3× larger** for `HexaDecimal`, and **2.3× to 5.0× slower to parse in every
case measured**, because the reader expands the indices back into token text before reading the
document. Bytes on the wire, paid for at load. The numbers are in
[Representation sizes and parse times](#representation-sizes-and-parse-times); none of that paragraph
is an estimate.

> **`GridData` is not E142 JSON, and the two are easy to confuse.** Both are JSON, both describe a
> map, and they are different contracts with different field names: `GridData` is camelCase
> (`dimension`, `binType`, `bins`), the E142 envelope uses the XSD's own PascalCase names
> (`Dimension`, `BinType`, `BinCode`) and must declare `"$format": "semi-e142"` as its first member.
> That case difference is the boundary, and it is deliberate — nothing can belong to both.
>
> Getting it wrong fails loudly rather than half-working, in both directions:
>
> - a `GridData` document on `E142MapDataJson` → `E142_XML_NOT_E142: $format is null …`
> - an E142 document on `GridData` → `E142_GRID_FIELD_MISSING: Required field 'dimension' is absent`
>
> Both clear the grid and report through `E142LastError`, so a wrong binding shows as an empty map
> with a reason, never as a plausible wrong one.

**Binding a second one does not fail.** The most recently written non-null input wins, which is
long-standing behavior and is not changing. What it now does as well is *say so*: writing a map
input while another is still bound logs `E142_MAP_INPUT_OVERRIDDEN`, naming the attribute that
lost, the one that won, and any others still bound. Clearing the winner falls back to the
highest-precedence input still bound, without a reload.

All four feed the *same* rendering pipeline, so everything below about placement, color,
identity and selection applies identically no matter which one you bind. Grid
**placement comes entirely from the map data** - the [Origin](#origin) attributes and
`YAxisDirection` keep governing **Items and Labels only**, and never move the grid.
`MapRotation` is a view transform and still turns the whole picture, grid included.
The grid draws **with or without an `Outline`**; a bound `Outline` (or `OutlinePreset`)
only affects how a scale-less map is fitted (see [Sizing](#sizing-and-fit) below).

### GridData (the compact path)

`GridData` is a single-map JSON document. A minimal 4x3 map with a 2 mm pitch:

```json
{
  "dimension":   { "x": 4, "y": 3 },
  "units":       "mm",
  "stepSize":    { "x": 2, "y": 2 },
  "originLocation": "LowerLeft",
  "axisDirection":  "UpRight",
  "binType": "Ascii",
  "nullBin": ".",
  "mapType": "2DArray",
  "binDefinitions": [
    { "binCode": "1", "binQuality": "pass", "binDescription": "Pass" },
    { "binCode": "0", "binQuality": "fail", "binDescription": "Fail" }
  ],
  "bins": ["1101", "1.01", "0110"],
  "substrateId": "W123", "lotId": "LOT-A", "goodDevices": 7
}
```

`dimension` is the logical grid extent (x = columns, y = rows). `stepSize` is the full
pitch (street included) in `units`; add `deviceSize` to draw cells smaller than their
pitch. `binType` names the token encoding and `nullBin` the empty-cell token; `mapType`
picks the payload form (`2DArray` here - one string per row, each the full grid width).
`originLocation` and `axisDirection` define the logical coordinate frame the cells are
addressed in. The optional `substrateId` / `lotId` / `goodDevices` are pass-throughs to
the read-only outputs. This exact document ships as the exported `DEMO_GRID_DATA`
constant - bind it (from a seeded symbol, or `setGridData(DEMO_GRID_DATA)` in code-behind)
to smoke-test the grid path end to end.

### E142MapData (the XML path)

`E142MapData` takes a complete E142.1 MapData XML document. Its shape is the SEMI
grammar - a `SubstrateMap` carrying an `OriginLocation` / `AxisDirection` / `Orientation`,
one or more overlays, and (optionally) a shared `Layout`. In skeleton:

```xml
<SubstrateMap SubstrateType="Wafer" SubstrateId="W123"
              OriginLocation="LowerLeft" AxisDirection="UpRight" Orientation="0">
  <BinCodeMap MapName="Bin" BinType="Ascii" NullBin="." MapType="2DArray">
    <BinDefinitions>
      <BinDefinition BinCode="1" BinQuality="pass"/>
      <BinDefinition BinCode="0" BinQuality="fail"/>
    </BinDefinitions>
    <!-- payload rows here -->
  </BinCodeMap>
</SubstrateMap>
```

Refer to the SEMI E142.1 specification (and the XSDs vendored at `Schema/E142/`) for the full
grammar; the parser follows it and reports the exact offending path in `E142LastError`
on a malformed document. When the document holds **several overlays**, bind
**`E142OverlayName`** to the overlay's `MapName` to choose one; left unset, the control
renders the **first BinCodeMap overlay that carries a payload**, in document order. A
name that matches a non-renderable or absent overlay is an error (reported, grid
cleared), not a silent fall-through.

### E142TransferData (the Stream-21 transfer path)

`E142TransferData` accepts the **reassembled item content** of a **SEMI E142.4** transfer -
the map shipped over **SECS-II Stream 21** ("Item Transfer") rather than embedded in a
Stream-14 message.

**What the standard fixes on the SECS/GEM side** (useful when wiring the symbol that feeds
this attribute; none of it is the control's concern):

- The reassembled item **is** an E142.1 XML document - `[E142.04-RQ-00008-00]` requires
  `MapData` to be formatted in XML according to the SEMI E142.1 XML Schema, and
  `[RQ-00009-00]` that **the sum of the `ITEMPART` data items shall be the `MapData`**. No
  compression and no application-level checksum are wrapped around it: the requirement is a
  plain sum, so anything else the item carried would not BE the MapData.
- `ITEMTYPE` is **`SEMI:SUBSTRATEMAPDATA:<SubstrateType>`**, the substrate type in all upper
  case - e.g. `SEMI:SUBSTRATEMAPDATA:WAFER`, `SEMI:SUBSTRATEMAPDATA:TRAY`. Fixed by
  `[RQ-00006-00]`; the permitted `SubstrateType` values are E142's, not E142.4's. Which
  values a given equipment actually supports is discoverable: `[RQ-00007-00]` requires it to
  support **`S21F9`** for exactly that.
- One Stream-21 transfer carries **one substrate**. `[RQ-00005-00]`: map data for multiple
  substrates "shall be transferred independently using the Stream 21 messages" - so several
  substrates are several transfers, not one larger item.
- `ITEMVERSION` is **a timestamp of last modification** `[RQ-00011-00]`, and it is
  **retained across an upload or a download** `[RQ-00012-00]`. It therefore identifies a
  REVISION of the map, not a transfer - two hosts holding the same `ITEMVERSION` hold the
  same map data.
- Readiness is announced by a collection event, referred to in the standard as
  **`E142SubstrateMapDataReady`** `[RQ-00020-00]`, which the equipment must provide and
  document. Its data variables depend on how many substrates it covers: `ItemType`,
  `ItemID`, `ItemLength`, `ItemVersion` for one `[RQ-00021-00]`, and `ItemType`,
  **`ItemIDList`, `ItemLengthList`, `ItemVersionList`** for several `[RQ-00022-00]`. Which
  equipment event the collection event is bound to is equipment-documented.

**Reach for `E142MapData` first.** The Stream-21 `ITEMPART` payload is `A:n` (ASCII) *or*
`B:n` (binary); if your SECS driver hands the finished item to the HMI as a **decoded
string**, that string *is* an E142.1 document - bind it to `E142MapData` and you are done.
`E142TransferData` earns its place only when the driver hands you **undecoded bytes** (a
`B:n` item, or a charset-agnostic driver). It is the byte-handling fallback, not the
preferred door; a decoded item never needs it.

When you do bind bytes, use either:

- a **base64 string** (the primary form), or
- a **`number[]` of byte values** 0..255 (the PLC-array-friendly form - a `BYTE`/`USINT`
  array marshalled straight through a symbol).

The control decodes the bytes to text and then runs them through the **exact same** XML
pipeline as `E142MapData` - so `E142OverlayName`, placement, color, sizing, identity and
selection all behave identically. Decoding sniffs the character encoding from a byte-order
mark and/or the XML declaration: a **BOM wins** over a mismatching declaration (with a
warning), a declaration is honored when there is no BOM, and **UTF-8** is assumed when
there is neither. UTF-8 and UTF-16 (LE/BE) are supported; a declaration naming anything
else falls back to UTF-8 with a warning. A decode or parse failure is reported in
`E142LastError` and clears the grid, exactly like the XML path.

**Boundary - what this control does and does not do.** SECS communication is **host-side**.
The **reassembly** of a Stream-21 item - collecting the `ITEMPART` chunks (whether one
`S21F3/F6` message or a sequence of `S21F17/F18` messages), ordering them, honoring
`ITEMACK`/`ITEMERROR`, and concatenating them back into the original item - is the job of
your **SECS/GEM host stack**, upstream of this control. This control implements the
**consumer side of E142.4's item *content* only**: it takes the finished item bytes your
stack writes to the bound symbol and renders them. It carries no Stream-21 transport, no
`ITEMPART` logic, and no collection-event plumbing (the "substrate map is ready" event is a
host-side signal; in HMI terms, **the symbol write is the trigger**).

> **`ITEMTYPE` (informational).** Stream 21 tags each item with an `ITEMTYPE` string, and
> for E142 substrate map data that string is **normative, not open**. `[E142.04-RQ-00006-00]`
> fixes it as `SEMI:SUBSTRATEMAPDATA:<SubstrateType>`, the substrate type in all upper case -
> the same value the bullet list above states. Discovery of what an equipment supports is
> `[E142.04-RQ-00007-00]`, which requires the equipment to support **`S21F9`** to tell the
> host which `ITEMTYPE` values it supports. (The requirement names `S21F9` only; `S21F19`/`F20`
> in `[RQ-00004-00]` is the separate question of which Stream-21 MESSAGES are accepted.)
>
> **This control still does not inspect it, and that is a placement decision rather than an
> uncertainty.** By the time map data reaches the HMI it is a value on a bound symbol; the
> item type was consumed upstream, where the S21 item was reassembled and routed. A control
> that re-checked it would be validating a decision already taken by the only layer that
> could act on the answer - and would then need its own configuration for which types to
> accept, duplicating the host stack's. Filtering by item type belongs in the host stack,
> upstream of the symbol.

The item bytes are assumed to be the **complete E142.1 MapData XML document** - the natural
Stream-21 payload, since Stream 21 exists precisely to ship maps too large for a Stream-14
message. If your equipment instead wraps the document in a vendor envelope or an
application-level container, that is a thin adapter in front of the decode step (the
engine's `E142Item` module marks the seam); the pipeline behind it is unchanged.

### Which input wins

`E142MapData`, `E142TransferData` and `GridData` are **mutually exclusive**. Binding one
while another is already set makes the **most recently written** one active and logs a
warning naming all bound inputs; clearing the active one (set it to `null`) falls back to
another still-bound input, else to the [demo](#see-it-immediately-demo-mode) / empty state.
(The fallback order when several remain bound is `E142MapData`, then `E142TransferData`,
then `GridData` - a deterministic tie-break for a misconfiguration, not a general priority:
a fresh write always wins.) A **bound map counts as bound content**, so it suppresses the
demo even while it is still loading or has errored - unbind it to bring the demo back.

### Choosing a map in a multi-substrate document

One E142 document may carry many substrates and many overlays - `MapUpload` is defined for
"one or more substrates" and `MapGroupDownload` for a whole lot or carrier. Four attributes
narrow that down to the one map this control renders, and they are applied **in this order**:

| # | Attribute | Narrows | Unset means |
| --- | --- | --- | --- |
| 1 | `E142SubstrateId` | `SubstrateMap/@SubstrateId` | don't filter on id |
| 2 | `E142LayoutSpecifier` | `SubstrateMap/@LayoutSpecifier` | don't filter on layout |
| 3 | `E142OverlayName` | `Overlay/@MapName` | first renderable `BinCodeMap` |
| 4 | `E142OverlayVersion` | `Overlay/@MapVersion` | don't filter on version |

**The substrate filters run first, and that is not an implementation detail.** Overlay names
are not unique across substrates - a document holding three wafers may well have a
`SortGrade` overlay on each. Searching overlays across the whole document would pick one of
them and discard the other two silently. Narrowing to a substrate first means the overlay
question is asked of one map.

**The two keys behave differently, because the schema makes them different.**

- `SubstrateMapKey` is an `xs:key` over (`@SubstrateType`, `@SubstrateId`,
  `@LayoutSpecifier`). With **both** substrate filters set, a schema-valid document can
  contain at most one match - ambiguity is only reachable when one of them is left unset.
- `OverlayKey` is (`@MapName`, `@MapVersion`), so **a name alone is genuinely ambiguous**.
  That is by design rather than by accident: the standard's own lifecycle downloads a map at
  `MapVersion=1` and uploads the processed result at `2`, both under one `MapName`. If your
  documents follow it, set the version.

#### What happens when a filter is ambiguous, wrong, or incomplete

| Situation | Result |
| --- | --- |
| Several maps or overlays survive | **Warning**, and the **first in document order** is rendered. Never an error - a document carrying several maps is perfectly legal, and refusing to draw would be a worse answer than drawing one of them and saying so. |
| A filter matches nothing | **Error**, and the message **lists what is actually available**. An operator who mistyped a wafer id needs the list, not the word "not found". |
| `E142OverlayVersion` set with no `E142OverlayName` | **Error.** An overlay is identified by the pair; a version alone is not an identity. Set the name too, or clear the version. |

`E142OverlayVersion` distinguishes **`null` from the empty string**, and the difference is
the schema's: `MapVersion` has an XSD default of `""`, so `""` selects overlays that state
*no* version, while `null` does not filter on version at all. This is the one filter where an
empty binding is not the same as an absent one.

#### `MapSubstrateCount`

Read-only: how many `SubstrateMap` elements the **bound document** contains, before any
filtering. It answers "is this a single-wafer document or a lot?" - which is exactly what you
need to know when a selection warning appears.

It is **derived from the parsed document, never maintained alongside it**, so it cannot drift
out of step. Two consequences worth knowing:

- On a **parse** failure there is no document, so the count clears to `null`.
- On a **selection** failure - a filter that matched nothing - the document is fine, so the
  count **stays**. Together with the error's list of available maps, that is enough to fix
  the filter without re-reading the file.

### Attributes

Listed in the attribute reference, in four groups: [E142 input attributes](#e142-input-attributes),
[E142 output attributes](#e142-output-attributes),
[Aggregation and touch attributes](#aggregation-and-touch-attributes), and the scale and side rows of
[View attributes](#view-attributes).

On a bad document the four read-only identity/error outputs behave as a unit: the grid
is cleared, `E142LastError` holds the message, and `MapSubstrateId` / `MapLotId` /
`MapGoodDevices` reset to `null`. On success `E142LastError` is `null` and the identity
outputs carry the map's values. When `SubstrateId` is unset and a map is bound, the
**identity area shows `MapSubstrateId`**, so the drawn substrate labels itself.

### Cell colors

One `StatusColorMapping` colors **items and grid cells alike**. For a cell the chain is:

1. if the cell's **bin code** is a key in `StatusColorMapping`, that color wins;
2. otherwise, if the bin's **quality** is the conventional `"pass"` or `"fail"`, the
   per-quality theme default is used (`--substratemap-bin-pass` / `--substratemap-bin-fail`);
3. otherwise the unknown-status color (`--substratemap-status-unknown`).

So naming a bin explicitly always overrides the quality default. For the GridData example
above, `StatusColorMapping` of `{ "1": "#1b9e77" }` paints the `1` cells teal by code and
lets the `0` cells fall to the `fail` default; drop the mapping entirely and both fall to
their quality defaults. The bin-quality defaults are bluish-green / vermillion rather than
green / red so the pair stays distinguishable under common color-vision deficiencies.

### Substrate side

`SubstrateMap/@SubstrateSide` says which **face** of the substrate a map describes -
`TopSide` or `BottomSide`. It is a statement about the data, not an instruction to the
renderer, and this control treats it that way.

**`SubstrateSide` on its own never mirrors anything.** The coordinate consequences of
looking at the other face are already carried by `OriginLocation` and `AxisDirection`, which
the control applies as it does for any map. A control that *also* mirrored on seeing
`BottomSide` would flip a conforming document twice - once from the frame attributes, once
from the side field.

If you want to look at a map from the opposite face, say so with **`ViewSubstrateSide`**:

| `ViewSubstrateSide` | Effect |
| --- | --- |
| `follow-map` *(default)* | **No mirror.** The map is drawn as seen from the face it describes. Byte-for-byte the behavior that existed before this attribute. |
| `TopSide` | Mirror when the map's `SubstrateSide` is `BottomSide`. |
| `BottomSide` | Mirror when the map's `SubstrateSide` is `TopSide`. |

Asking for the face the map already describes does nothing - the rule is simply "mirror when
the requested side differs from the map's". An unrecognized value warns and falls back to
`follow-map`; a bad binding should not blank the map. `MapSubstrateSide` reports the
**map's** side read-only, so a view can compare the two and show whether a mirror is active.

#### Which axis, and how confident

The mirror runs about the **vertical** axis: X is reversed, Y is unchanged.

That comes from E142-0225 **Figure R2-17**, *"Example Where Translation Is Required as
SubstrateSide Differs"*. It draws two panels with an **identical** wafer outline - notch at
the bottom in both - and changes only the frame: origin cell upper-left with X running right,
versus origin cell upper-**right** with X running **left**, Y running down in both. Figure
**R2-16** immediately above is the contrast case: it reverses **Y**, and is captioned as an
`OriginLocation` difference. The pair deliberately isolates different attributes and moves
different axes.

Two claims, two confidences, because they are not equally supported:

- **What the figures depict is settled by the figures themselves.** The shaded origin
  cell and the arrowheads are unambiguous in the rendered figure.
- **That `SubstrateSide` should not itself trigger a transform is an inference.** Reasoned from the
  figures plus the independence of the three attributes in the schema, and not stated in so
  many words anywhere in the standard. The full argument, including the rejected
  alternatives, is held with the package's design records rather than in this file - if
  someone finds prose in E142 that says otherwise, that argument is what should change
  first, and this paragraph with it.

#### The `GridData` path is always `TopSide`

`GridData` has **no side field at all**. The E142 XSD default for an absent `SubstrateSide`
is `TopSide`, so that is what the control reports on this path - the contract's answer, not
an invention. `MapSubstrateSide` reads `TopSide`, and consequently
`ViewSubstrateSide="BottomSide"` **does** mirror a `GridData` map.

#### When a mirror is applied

One informational message is logged per commit, naming both sides - for example
*"rendering mirrored - the map describes BottomSide and ViewSubstrateSide asks for
TopSide."* Not per frame, and not silent: a mirrored wafer looks like a perfectly ordinary
wafer, and silently rendering one is how a reader ends up reading a map backwards.

Reference-device registration follows the mirror automatically, so an anchored map stays
anchored. The identity label is drawn outside the canvas and is never mirrored.

### Orientation: the zero reference

`E142OrientationOffset` is added to the map's `Orientation` before placement; both are
**clockwise-positive** source angles. The **zero reference** is a **notch at 6 o'clock at
`Orientation` 0** - the same datum the [outline presets](#outline-presets) use, and the one
SEMI E142 Figure A1-2 shows (notch at 6, 9, 12 and 3 o'clock for `Orientation` 0, 90, 180
and 270 respectively). If your
E142 source measures Orientation against the opposite convention (notch at 12 o'clock at
0), set `E142OrientationOffset` to `180` once and leave it. Reach for the offset only to
reconcile a *source-side* convention: it is **not** a view control. To turn the rendered
map for display, use [`MapRotation`](#view), which rotates the whole construct without
touching the map's coordinates or the `Selected*` outputs.

### Reference-device alignment

An E142 `Overlay` may carry **`ReferenceDevices`** - named devices given both a logical
`Coordinates` pair and a physical `Position`. By default they are carried but **not** used
(placement comes from the layout/pitch alone). Set **`E142AlignToReferenceDevices`** to
`true` and the placement is **registered** to them: the control shifts the grid so the
reference devices' cell centers land, on average, on their stated `Position`s (a
least-squares **translation**; a single reference device is met exactly). A `Position`
without its own `Units` is read in the layout's `DefaultUnits`.

Per SEMI E142, `Position` is the offset of the reference device's **center** from the
**center of the substrate**, expressed along the **map's own X and Y axes** - so a rotated
(`Orientation`) or mirrored (`AxisDirection`) map has its `Position` axes rotated and
flipped with it, which the control accounts for. A `Position` without its own `Units` is
read in the layout's `DefaultUnits`.

This is **off by default** and **XML-path only** (a `GridData` document carries no
reference devices). It is a *translation* only - no rotation or scale: the standard gives
reference devices no rotation or scale attribute, so a translation is the only fit their
data determines, and it is exact for a single reference device. Reference devices whose
coordinates fall outside the grid, or that carry no `Position`, are ignored for alignment.

### Location identifiers (LID)

E142 lets a cell be addressed by coordinate, by name, or by both: *"The position on the
substrate shall be either the X and Y coordinate, or the location identifier, or both."*
A `LID` names the **socket**, not the device in it - *"The location identifier is still
present when the device is removed."* That distinction is why `lid` and `deviceId` are
separate fields in the selection payload, and why they must not be used interchangeably.

`LID` is `xs:string` with no facet, no uniqueness constraint and no ordering. The control
carries it **verbatim** - never trimmed, never case-folded - because it is a join key.

**A LID-only map has no lattice of its own**, so one has to come from somewhere. Three
tiers, in the order the control tries them:

| | Source | Behavior |
| --- | --- | --- |
| 1 | The document's own `<Layout><Dimension>` | Document order fills the declared lattice **row-major**, skipping cells an explicit `X`/`Y` already claimed. |
| 2 | `SubstrateType="TnR"` | R2-3.3: X runs along the tape **away from the hub**, Y indexes the row. A single-row tape declared `Dimension X=n Y=1` already satisfies this through tier 1, which is why no tape-specific code exists. |
| 3 | Nothing | **Refused.** `E142_XML_LID_NO_LATTICE` names the missing input; the entries are retained on the overlay and nothing is drawn. |

Tier 3 refuses rather than guessing a 1xN strip, and that is deliberate: a guessed lattice
renders, looks plausible, and silently asserts an adjacency the document never stated. An
operator would be misled by the tool rather than by the data.

**Mixed maps.** When an entry carries both forms the **coordinate places it** - a LID is a
name, a coordinate is a position, so there is nothing to arbitrate - and the LID still names
the cell. A LID that resolves to a *different* cell than its own `X`/`Y` warns and names
both. If more LID-only entries arrive than the lattice has free cells, the overflow is
reported by `E142_XML_LID_ONLY_EXCLUDED`, which lists the LIDs it set aside.

`lid` appears on the `onItemSelected` cell payload and on `SelectedItems`. An **empty
string** is a legal zero-length LID and is reported as `""`, not `null`.

### Transfer maps (where a device came from)

A `TransferMap` is E142's substrate-to-substrate traceability record. Each `<T>` element -
**`<T>`, not `<Transfer>`** - moves one device, and each **end is addressed independently**:
by a coordinate pair or by an identifier, never required to match. The standard's own worked
example chains `Transfer(FX,FY,TID)` from a wafer coordinate into a named tape pocket, then
`Transfer(FID,TX,TY)` from that pocket to a target coordinate.

Selecting a cell reports where its device came from:

| Field | Meaning |
| --- | --- |
| `fromSubstrateType`, `fromSubstrateId` | The source substrate. Both, because `SubstrateMapKey` is a triple and an id alone is half a key. |
| `fromX`, `fromY` | Position on the source, when that end used coordinates. |
| `fromLid` | Location on the source, when that end used an identifier - a tape pocket, typically. |

`fromX`/`fromY` and `fromLid` are **alternatives**: a die off a wafer reports coordinates
with `fromLid` null, and one out of a pocket reports the pocket with both coordinates null.
All five are null together when no transfer covers the cell.

**On export, an unresolvable transfer is omitted, not written.** The three `From*` attributes
are an `xs:keyref` onto a `SubstrateMap` in the *same* document, and this control writes
exactly one - so only a self-referencing transfer can be carried. Anything else is dropped
with `E142_XML_TRANSFER_UNRESOLVABLE`, which names the one key that would have resolved. The
reason is asymmetric damage: a dangling keyref invalidates the **whole** document, so one
unresolvable provenance record would take the bin codes down with it.

### Device data (E138 `PVSet`)

A `DeviceDataMap` pairs a `Parameter` list with per-device values, and the values are an
embedded SEMI **E138 `PVSet`** payload. All sixteen `PVType` alternatives are read:

| Group | Kinds |
| --- | --- |
| Numeric | `F8` `F4` `I8` `I4` `I2` `I1` `EI` |
| Textual | `S` `ES` `URI` `B64` |
| Other scalars | `D` (dateTime) `B` (boolean) |
| Recursive | `Su` (structure) `Arr` (array) |
| Absence | `NoValue` |

**`D` values are kept lexical - a string, never a `Date`.** `Date` normalizes an explicit
offset to UTC, truncates fractional seconds to milliseconds, cannot express "no timezone",
and rejects the leap second `:60` that `xsd:dateTime` permits. Re-emitting a parsed `Date`
would rewrite the document, so the string the document wrote is the value you get.

**Three ways to have no reading, kept distinct.** `xsi:nil` on a scalar keeps its kind and
reports `null`; a `NoValue` reports its `reasonCode` and description; an empty `<S/>` is the
empty **string**, which is a value. Rendered for display they read `(nil)`,
`(ValueNotAvailable: probe offline)` and nothing at all.

Selecting a cell reports `deviceData` as `{ name, value }` pairs, joined **by index** -
Table 19 requires the order of values to match the order of parameters, and the values carry
no names of their own. `SelectedItems` carries the same entries plus the raw `PvValue`, for a
consumer that needs the tree rather than the text: an `Arr` of `Su` displays as
`[(23, 57), (25, 63)]`, which is legible and useless to code.

**`E142DeviceDataOverlayName`** picks which `DeviceDataMap` overlay supplies the readings,
by `MapName`; `null` takes the first that carries device data. It is separate from
`E142OverlayName` because an overlay carries a `BinCodeMap` **or** a `DeviceDataMap`, never
both - a document that draws bin codes and reports parameters is using two overlays and needs
two selectors. A name matching none reports and supplies nothing rather than falling back.

### Sizing and fit

A map that carries a **physical scale** (a `stepSize`, or a `Layout` with real pitch)
renders at that size directly. A **scale-less** map (no layout, no `stepSize`) has only a
logical extent, so its size is inferred:

- set **both** `E142FallbackStepSizeX` and `E142FallbackStepSizeY` to render at that
  explicit pitch (millimeters);
- set exactly one and it is ignored (with a warning) - a pitch needs both axes;
- set neither and the grid is **fitted** to the `Outline`'s bounding box (or, with no
  outline, letterboxed to the canvas on its own).

The fit is a **nominal** convenience, not a physical measurement: it makes a scale-less
map visible and roughly proportioned, nothing more. When cell size matters, supply a real
pitch (in the map or via the fallback attributes).

### Payload size

All three inputs carry the map **inline** - as XML text, JSON, or item bytes bound to a
symbol - and the whole document is decoded and parsed on the UI thread on each write, so
they suit maps up to roughly a **few megabytes** of payload. Past that, parse cost and
symbol-transfer latency become noticeable; prefer `GridData` with a numeric `bins` array
over verbose XML, and split or down-sample very large maps upstream.

`E142TransferData` exists exactly because Stream 21 lifts the message-size limits that
constrain a Stream-14 map: a single SECS-II item is capped near **16 MB**, but a Stream-21
transfer chunks arbitrarily large content and the reassembled item can reach roughly **4 GB**
over HSMS - and is effectively **unbounded** with the multiple-message (`S21F17/F18`)
technique. That ceiling is the **transport's**, though, not this control's.

**Stream 21 fixes the wire, not the render.** A perfectly delivered transfer still lands the
*whole* document in the browser to be parsed on the UI thread, and the parse tree dwarfs any
bytes-vs-string difference. A dense full-device map of a 300 mm wafer (order 10^6 device IDs)
is tens to hundreds of MB of XML - well past both the ~16 MB item ceiling *and* what an
in-browser parse can carry. Neither `E142TransferData` nor the encoding choice moves that
limit: **the fix for a genuinely large wafer is a different *rendering* strategy - server-side
rasterization, tiling / level-of-detail, decimation, or an off-thread streaming parse - not a
larger input.** That is a deliberate design decision outside this control's current scope;
treat **a few megabytes as the practical UI limit for all three inline inputs** regardless of
how the map arrived, and keep the truly large transfers for offline or server-side processing.

### Exporting a bound map

The control also serializes the **currently bound** map back out, for round-tripping or
handing a map to another consumer:

- **`toGridData()`** returns a canonical `GridData` document (or `null` when no map is
  bound). Binding the result to `GridData` reproduces the same grid.
- **`toE142Xml()`** returns an E142 `MapData` XML string (or `null`), re-ingestible via
  `E142MapData`.

- **`readBinStatistics()`** returns the whole bound lattice counted by bin code:
  `{ totalCells, nullCount, bins: [ { code, count, quality, severity, color } ] }`. Never
  `null` — with nothing bound it returns `totalCells: 0` and an empty list, which is a chart
  that can draw its empty state rather than a value every caller has to branch on.

  **Untruncated**, unlike the `onGroupSelected` histogram. That one caps at ten because an
  event payload is O(K) in something the *document* controls and is rebuilt on every tap;
  neither is true of a function you ask for once per binding, and a bar chart that hides the
  eleventh-largest code is worthless.

  `sum(bins[].count) + nullCount === totalCells`, exactly and always. `bins` is descending by
  count then by code, so two readings of the same map serialize identically and a chart's bars
  do not reorder themselves between refreshes.

  `quality` is the token the **document** declared, verbatim, or `null` — `severity` already
  carries the resolution, and the declared token is the only field you cannot work out from the
  others. `color` is the color **the map actually paints** for that code, resolved through the
  same call the render path makes with the scene's `StatusColorMapping` and `BinQualityAliases`.
  It is deliberately *not* the raw `StatusColorMapping` value: a chart built from that shows one
  color where the map shows another for every code the mapping does not name.

  There is no bindable attribute for these numbers, on purpose. Anyone who needs them in a back
  end has an MES that already has them, and a bindable output would recount the lattice on every
  scene change to feed a symbol nobody reads.

Both take the pitch from what was drawn (physical when the source had a scale, nominal
otherwise, in millimeters) and emit the map's own `Orientation` - the display-only
`E142OrientationOffset` is deliberately **not** folded in, so re-ingesting the result does
not turn a view preference into data. Export is call-only (there is no export *attribute*);
ingest is unchanged.

**The round trip is not lossless, and the difference matters.** What follows is the actual
list rather than the word "faithful" - a vague fidelity claim is what let the original defect
sit unnoticed.

#### `toE142Xml()` preserves

| | |
| --- | --- |
| **Frame** | `OriginLocation`, `AxisDirection`, `Orientation` - the map's own, not the display offset |
| **Side** | `SubstrateSide`; `ViewSubstrateSide` is a view transform and is not written out |
| **Overlay** | `MapName` and `MapVersion`, so `OverlayKey` survives |
| **Geometry** | Step size and device size, in millimeters, and the source's layout tree where it had one - `LowerLeft`, `Z`, `TopImage`, `BottomImage`, `ProductId`, `@Package` |
| **Bins** | The cells, and `BinDefinitions` with code, count, quality, description and `Pick` |
| **Substrate identity** | `SubstrateId`, `LotId`, `GoodDevices`, `SupplierName`, `Status`, `CarrierType`, `CarrierId`, `SlotNumber`, `SubstrateNumber`, and the `AliasIds` list |
| **Transfers** | `TransferMap` records **where the reference resolves** - see below |

#### `toE142Xml()` does not preserve

| Dropped | Why |
| --- | --- |
| **`DeviceIdMap`** | Read as a lookup for selection, never modeled as an emittable overlay. |
| **`DeviceDataMap` and its `PVSet`** | Same: parsed and surfaced, not re-serialized. The E138 payload has its own serializer, but nothing wires it into the map export yet. |
| **Per-cell `LID`s** | Carried in the model and reported on selection, not written back to XML. |
| **`ReferenceDevices`** | Consumed to register the placement when `E142AlignToReferenceDevices` is on; the registration is baked into the geometry, so re-emitting the anchors would apply it twice. |
| **Every substrate but the rendered one** | The export writes **one** `SubstrateMap`. A multi-substrate document in, a single-substrate document out. |
| **A `TransferMap` whose source is not that one substrate** | The three `From*` attributes are an `xs:keyref` onto a `SubstrateMap` in the same document, so only a self-reference can resolve. Anything else is dropped with `E142_XML_TRANSFER_UNRESOLVABLE`, naming the one key that would have worked. Emitting it would dangle the keyref and invalidate the **whole** document - one provenance record would take the bin codes with it. |
| **Foreign-namespace extensions** | Skipped on ingest (reported), so there is nothing to write back. |
| **Original formatting and lexical spellings** | Numbers are re-formatted from their values; the document is regenerated, not edited. |

#### `toGridData()` preserves less, by contract

`GridData` is a compact format with no counterpart for `SupplierName`, `Status`,
`SubstrateSide` or `MapVersion`, so those four are absent from its output rather than lost by
accident. It **does** carry `dimension`, `stepSize`, `deviceSize`, `lowerLeft`, the frame,
`binType` / `nullBin` / `mapType`, `binDefinitions`, the cells, per-cell `lids`, and
`substrateId` / `lotId` / `goodDevices`.

---

## Representation sizes and parse times

One E142 document can be written three ways, and all three parse to the same model: **XML**, the
**JSON envelope** carrying the same token text, and the JSON envelope with **`$binary`** index
blocks in place of the tokens. Which to use is a size-against-time trade, and the numbers below are
measured rather than argued.

**The short version.** `$binary` is smaller only for the four-character bin types, `Decimal` and
`Integer2`, by about a third. It is **larger** for `Ascii` (2.6x) and `HexaDecimal` (1.3x), because
base64 of two bytes is 2.67 characters per cell against one and two token characters respectively -
arithmetic, not a property of any document. And it is **2.3× to 5.0× slower to parse**, in every one
of the twelve cases below, because the
reader expands the index block back into token text before anything else looks at the document, so
it pays the base64 decode *and* the full token decode. Use it when the wire is the constraint and
the bin type is four characters wide; otherwise the token form is smaller, faster, or both. Every
number in this section was measured, not estimated: one machine, one document written three ways,
all three parsed in the same run. The figures below were taken 2026-08 and are reproduced here as
they were measured.

<!-- BENCH:SIZES:BEGIN -->

Sizes, one document written three ways. Measured 2026-08 on one machine; the relative
picture is the part that holds, not the absolute figures.

| lattice | `BinType` | XML | JSON | JSON `$binary` | binary vs XML | binary vs JSON |
|---|---|---|---|---|---|---|
| 200×200 | `Ascii` | 45 kB | 40 kB | 105 kB | +131 % | +161 % **LARGER** |
| 200×200 | `Decimal` | 162 kB | 157 kB | 105 kB | -36 % | -33 % smaller |
| 200×200 | `HexaDecimal` | 84 kB | 79 kB | 105 kB | +24 % | +32 % **LARGER** |
| 200×200 | `Integer2` | 163 kB | 157 kB | 105 kB | -36 % | -33 % smaller |
| 600×600 | `Ascii` | 370 kB | 354 kB | 938 kB | +154 % | +165 % **LARGER** |
| 600×600 | `Decimal` | 1424 kB | 1408 kB | 938 kB | -34 % | -33 % smaller |
| 600×600 | `HexaDecimal` | 721 kB | 705 kB | 938 kB | +30 % | +33 % **LARGER** |
| 600×600 | `Integer2` | 1424 kB | 1408 kB | 938 kB | -34 % | -33 % smaller |
| 1200×1200 | `Ascii` | 1442 kB | 1410 kB | 3750 kB | +160 % | +166 % **LARGER** |
| 1200×1200 | `Decimal` | 5659 kB | 5628 kB | 3750 kB | -34 % | -33 % smaller |
| 1200×1200 | `HexaDecimal` | 2848 kB | 2816 kB | 3750 kB | +32 % | +33 % **LARGER** |
| 1200×1200 | `Integer2` | 5661 kB | 5629 kB | 3750 kB | -34 % | -33 % smaller |

Parse time to an `E142Document`, median of 20 runs after 5 warm-ups, milliseconds:

| lattice | `BinType` | XML | JSON | JSON `$binary` |
|---|---|---|---|---|
| 200×200 | `Ascii` | 1.3 | 0.8 | 3.8 |
| 200×200 | `Decimal` | 4.0 | 2.3 | 5.8 |
| 200×200 | `HexaDecimal` | 1.8 | 1.0 | 4.1 |
| 200×200 | `Integer2` | 3.2 | 2.2 | 4.7 |
| 600×600 | `Ascii` | 10.1 | 6.3 | 28.8 |
| 600×600 | `Decimal` | 32.0 | 20.5 | 47.4 |
| 600×600 | `HexaDecimal` | 14.2 | 8.3 | 31.5 |
| 600×600 | `Integer2` | 24.9 | 13.9 | 37.9 |
| 1200×1200 | `Ascii` | 34.3 | 23.2 | 116.2 |
| 1200×1200 | `Decimal` | 128.1 | 81.6 | 189.9 |
| 1200×1200 | `HexaDecimal` | 53.6 | 32.7 | 122.6 |
| 1200×1200 | `Integer2` | 93.6 | 54.9 | 145.1 |

<!-- BENCH:SIZES:END -->

Timings are machine-dependent and the XML column uses a hand-written parser rather than the
browser's `DOMParser`, so it is pessimistic; the relative picture is the part that holds. Measured
2026-08; re-measure on your own hardware before treating any absolute figure as a budget.

---

## Bin quality

E142-0225 reserves **exactly two** `BinQuality` values:

> *"The following values are reserved: 'Pass' — Indicates a quality that has commercial value;
> 'Fail' — Indicates a quality that does not have commercial value. Other values defined by an
> application. If not present then BinQuality is undefined."* `[Primary source]`

So a document whose bins say `Reject`, `Good`, `Schlecht` — or the `A` / `B` / `C` / `D` the
standard's own pick-and-place example uses — is **completely legal**, and this control has no way to
know which of them are bad. It does not guess: an unrecognized token draws in the unknown color and
logs `E142_BIN_QUALITY_UNMAPPED`, naming the token and the bin code carrying it.

**The default set is two tokens on purpose.** Adding `Good` or `Reject` to it would claim a
reservation the standard does not make, and the cost of guessing wrong is a failing die painted with
the passing color — the one outcome this control must never produce.

Say what your tokens mean instead:

```
data-tchmi-bin-quality-aliases='{ "Reject": "fail", "Ausschuss": "fail", "Gut": "pass" }'
```

Keys are matched case-insensitively and trimmed. A value other than `pass` or `fail` is ignored,
because aliasing onto a third token would invent a severity nothing can render. An **absent or empty**
`BinQuality` is never reported: the standard says it is simply undefined.

The warning is raised once per bin code and token, when the document arrives or the alias map changes
— not on every frame.

---

## Severity

Aggregation has to reduce many dies to one pixel, and "worst wins" only means something if *worse* is
defined. Bin codes are nominal — `Ascii`, `Decimal`, `HexaDecimal` and `Integer2` are tokens with no
ordering — so the order is **declared**, never inferred.

The ladder, in order:

1. **`BinSeverityPriority`**, if it names the bin's code — *and the bin is not known to be good*.
2. **`BinQuality`**, through the two values E142 reserves plus whatever
   [`BinQualityAliases`](#bin-quality) adds. `pass` and `fail`.
3. **`Pick="true"`**, which says the device *should be processed* and so lifts an otherwise
   unclassified bin to `pass`. `Pick="false"` lifts nothing: it is the XSD default and sits on almost
   every bin without anyone having typed it.
4. Otherwise **`unknown`**.

The scale is `nullBin < pass < unknown < fail`. **`unknown` sits above `pass` deliberately** — a bin
nobody classified has not been said to be good, and under aggregation the two mistakes do not cost the
same. Reporting an unclassified die as passing hides it; reporting it as unclassified shows it.

### Why the priority list cannot promote a passing bin

`BinSeverityPriority` is most-severe-first, so it is natural to write out a whole vocabulary:

```
data-tchmi-bin-severity-priority='["Pass", "Fail", "Scrap"]'
```

meaning *"here is my ordering"*. Read as *"here is what wins"*, that puts the **passing** code at the
top of the scale — and a tile holding one passing and one failing die then reduces to the passing bin.
The failure disappears. That is exactly the defect this control exists to stop.

So the list orders the bins that are **not known to be good**. A bin whose `BinQuality` resolves to
`pass` keeps its `pass` rank whatever the list says, and `E142_BIN_SEVERITY_PRIORITY_IGNORED` names
it. A view setting does not silently overrule a document that says a die is saleable.

Use it for the ordering the ladder genuinely cannot infer:

```
data-tchmi-bin-severity-priority='["Scrap", "Chipping", "MissingReference"]'
```

A code that is not in the bound map is reported with `E142_BIN_SEVERITY_PRIORITY_UNUSED` and ignored.
Both warnings are raised once, when the document arrives or the list changes.

### Choosing the reduction

An aggregated tile can say two different things, and neither is right everywhere:

| | says | fails when |
|---|---|---|
| `MaxSeverity` | the worst die in this pixel | most pixels hold a failure — a noisy wafer turns solid |
| `FailFraction` | how much of this pixel failed | a lone defect becomes a tint nobody notices |

**`Auto` measures which is happening rather than inferring it from the zoom.** The obvious rule —
switch by aggregation factor — reads the wrong axis: at one factor the chance a pixel holds a failing
die runs from **0.5 % to 100 %** depending on the defect rate. Predicting it from the map's own fail
rate is no better, because `1 − (1 − p)ⁿ` assumes defects are independent and every named wafer
pattern is clustered; a simulated edge ring predicted 96.8 % and measured 35.5 %.

So each aggregated frame measures its **saturation** — the fraction of painted pixels holding at least
one failing die — and that selects the reducer for the **next** frame. The measurement is free: the
reducer that just ran had already accumulated it, so it is a pass over pixels rather than over the
map's millions of cells.

Two thresholds, not one: it switches to `FailFraction` above **0.6** and back below **0.4**, so a map
sitting near the boundary does not alternate palettes as it is panned. The first frame after a
document binds is always `MaxSeverity` — the safe seed, since a rare defect stays visible and a
saturated map corrects itself on the next frame.

`AggregationMode` reports which one actually drew.

---

### How many items is too many

The **grid** path scales: a million dies are a typed array, and below one device pixel per cell they
aggregate. The **item** path does not, and the difference is worth stating as a number rather than as
a warning.

`itemsToModels` builds an object and a `Path2D` per item. Measured on this machine, median of three,
one rectangle geometry each:

| items | build | heap |
|---|---|---|
| 1 000 | 10 ms | 1.7 MB |
| 10 000 | 30 ms | 21 MB |
| 100 000 | **701 ms** | **145 MB** |

**The supported ceiling is 10 000 items.** At 10 k a rebuild costs about two frames, which a data
change can absorb. At 100 k it is a two-thirds-of-a-second freeze and 145 MB of heap, and the cost per
item has more than doubled — that is allocation pressure, not arithmetic, and it gets worse rather
than better as the panel runs.

Two caveats, both making the real number **worse** than the table:

- These were measured with a **stub** `Path2D` that records nothing. A browser's is a real geometry
  object, so treat every figure above as a floor.
- **Aggregation does not apply here.** Items are individually identified, individually hit-tested and
  individually styled; there is no bucket that could stand for several of them the way a grid tile
  stands for a thousand dies. Nothing in this feature raises the item ceiling, and nothing was
  intended to.

If you have more than ten thousand things to draw, they are dies rather than items — put them in a
`GridData` or an E142 overlay, where the whole of this document applies.

---

### Injecting a transform

`ViewTransform` takes six numbers, `[a, b, c, d, e, f]`, and composes them into the view. Zoom, pan,
rotation, shear, mirror — whatever the panel needs, without waiting for a release.

**Geometry only.** It cannot express a per-cell value: a relevance map, a thermal field or a probe
result is one number per die, and an affine matrix has nowhere to hold it. Those go in as an E142
overlay with the [`valueField`](#choosing-the-reduction) role.

**The translation is in millimeters, not pixels.** The transform is *post*-multiplied, so it acts in
the substrate frame — which also means scaling is anchored at the canvas center rather than the
top-left. Pre-multiplication would have given pixels and a corner anchor; the center anchor was worth
more, because units convert and an anchor does not:

```
millimeters = pixels / MapScale
```

`MapScale` is the **fit** scale and excludes your own transform, so it does not move as you zoom —
otherwise converting a pointer delta would need the answer you were computing.

Everything downstream follows for free: the hit test inverts the same matrix, the aggregation factor
reads it, and the layer cache key already carries its six components. A transform with a zero
determinant collapses the map to a line, so it is refused and identity is used — a blank canvas looks
like a data fault rather than like a bad matrix.

---

### Touch targets

When dies are drawn smaller than a fingertip, a tap has to select a **group** of them. `TouchTargetSize`
says how small is too small, in CSS pixels, default **40**.

**It governs hit resolution only.** The map still paints at one device pixel per bucket — a group is
how much of the map one tap picks up, not how coarsely it is drawn. Conflating the two would throw
away exactly the resolution aggregation recovered.

Grouping engages only when it has to: a cell already wider than the target is its own group.

**The unit, honestly.** A CSS pixel is a *reference* unit, not a physical one. `devicePixelRatio` is
accounted for — a 40 px target stays 40 px on a high-density panel — but two industrial panels of very
different physical size both report a ratio near 1, and the platform exposes no reliable physical
size. So the same setting is a comfortable finger on one and a small one on the other, and **the
author overrides per panel**. The control cannot know.

**24 is a floor, not a suggestion.** It is WCAG 2.2 SC 2.5.8, *Target Size (Minimum)*; the enhanced
criterion is 44, Apple's guidance 44 pt and Google's 48 dp. A smaller value is clamped and reported
with `E142_TOUCH_TARGET_CLAMPED`. If individual dies must be selectable at that size, zoom in — the
target is not the thing to shrink.

**`0` turns grouping off, and is the only value that does.** Every tap then selects one die and raises
`onItemSelected`, exactly as it did before grouping existed. The floor does not apply, because zero is
the *absence* of a target rather than a small one, and the floor exists to stop a target being too
small rather than to force one to exist. A negative number is **not** the opt-out — that is a target
too small, and it clamps to 24 with the warning like any other.

There is no separate `EnableGrouping` attribute on purpose: two settings saying one thing can
disagree, and then the control has to pick a winner in front of an author who set both deliberately.

A tapped group's cells enter the ordinary selection and take the same selection ring a single die
gets, so a tap always leaves a visible mark whichever event fired.


### Which selection event fires

| when | event | payload |
|---|---|---|
| a die is at least `TouchTargetSize` | `onItemSelected` | the die, exactly as before grouping existed |
| a die is smaller | `onGroupSelected` | the group descriptor |

**Never both.** A group has no item id, status or user data, so filling those fields would mean
inventing them — and a handler bound to `onItemSelected` expecting one die would receive a summary of
thousands. An **item** still wins outright: items are drawn on top of the grid, and grouping is about
dies being too small to tap, which an item is not.

The payload is the descriptor and **not the member cells**: a 12 900-cell group as a list of objects
is about 1.5 MB, built and serialized on every tap. Call `readGroupMembers(id)` with the descriptor's
`id` for the members, as a `Uint32Array`. The id is valid in the view that produced it; after a pan
there is no group to ask about, and the result is empty rather than wrong.

---

### Telling a summary from a datum

Two read-only outputs exist so a legend can say what it is showing:

| | |
|---|---|
| `AggregationFactor` | cells per device pixel, **by area** |
| `AggregationMode` | `None`, `PointSample`, `MaxSeverity` or `FailFraction` |

**The factor is an area count.** 6 dies per pixel is about **2.4 dies across**; the two differ by a
square and quoting the wrong one misstates the minification by its own square root. It is read from
the composed device matrix, so it follows a resize, a rotation and any injected view transform
without the document being re-parsed — and it is `null` when no map is bound, or when the lattice is
degenerate and every cell would share one pixel.

**`PointSample` is a defect being reported.** Below one cell per device pixel the renderer maps each
pixel back to exactly one cell and paints that. Every other cell in that pixel is invisible, and
which one survives is decided by where the grid happens to land relative to the pixel raster — pan by
half a pixel and the answer changes. On a yield map that is silent suppression of defects, so the
control says so rather than letting a legend imply the picture is complete.

---

## How to read a claim in this document

Two kinds of statement appear here and they rest on different things.

**Claims about the standard or about an external fact** carry a provenance tag, the same vocabulary
the source files use: `[XSD-normative]` for something the E142 schema requires, `[Primary source]`
for a quotation from SEMI, `[Secondary source]` for someone else's account of it, `[Inference]` for a reading the
sources permit but do not state. Where a tag is absent from such a sentence, the claim is not being
made.

**Claims about what this package does** carry no tag, and instead carry their reasoning. Where a
behavior is a choice rather than a consequence of the standard, the source comment says what the
choice was and what the alternative would have cost. That is the provenance a reader needs for
behavior: not *which standard says this* but *why it is this way and what breaks if you change it*.

The decision records behind those choices are part of the package's design history and are not
distributed. They used to be cited here by identifier; that was removed, because an identifier
pointing at a document the reader does not have is a dead reference rather than a provenance.

The distinction matters because the two are not interchangeable. `ITEMVERSION belongs to the Stream 21
message rather than to the map` **[Primary source]** is a fact about SEMI that would still be
true if this package did not exist. *The tile keeps the last map that worked* is a choice, and the
useful question about a choice is why — which the comment above that behavior answers.

Tagging behavior statements with source tags would make the tags worthless: a reader could no longer
tell which claims rest on the standard and which on us.

## E142 conformance

E142 defines **no conformance scheme** - no certificate, no test suite, no compliance clause
beyond the `Reqd` column of §7.2.2 and the §14 services. A conformance statement is therefore
self-declared, and a self-declared one is only worth anything if it is itemized. What follows
is one row per object of E142-0225 §§9-13, in the standard's own order.

### The matrix is about objects, not encodings

Every row below holds **identically for all four map inputs**. That is not a claim of diligence, it
is how the code is built: `E142MapDataJson` is presented to the *same* parser that reads
`E142MapData`, so there is one implementation of every facet, every identity
constraint and every warning. A JSON document cannot be more or less conformant than the XML document
it encodes, because nothing downstream of the first few lines can tell them apart. `[Inference]`

**What is standardized is the MODEL; XML is one transport for it.** E142 specifies a substrate-mapping
data model and an XML Schema that represents it on the wire. This package implements the model — it is
`E142Document` in TypeScript — and provides a second transport for the same model in JSON. Neither
transport is privileged: both are read by one parser into one model, and `e142DocumentToXml` and
`e142DocumentToJson` write it back out to either. Every route is asserted over the whole corpus,
including `XML → model → JSON → model → XML`, which crosses transports twice and must land on the
document it started from.

**SEMI standardized only the XML transport.** The word *JSON* does not appear anywhere in E142-0225,
E142.1, E142.2, E142.3 or E142.4 — checked across all six documents. `[Primary source]` So the
envelope in [`Schema/E142/JSON-FORMAT.md`](Schema/E142/JSON-FORMAT.md) is *this package's* transport
for the standard's model: it carries the XSD's own element and attribute names verbatim so the two
read against each other, and it adds what JSON can express and XML cannot — a base64 payload for the
bin indices. One practical consequence:

- **Across a company boundary, send XML.** Not because JSON is lesser here, but because it is the one
  a stranger's stack is guaranteed to read.
- **`GridData` is a third thing again** — not the E142 model at all. See the warning below.

**Four statuses:**

- **Full** - every attribute is parsed, retained, and either used or exposed.
- **Partial** - parsed and retained; some attributes are not surfaced. The unsurfaced ones
  are named.
- **Read-only** - parsed for integrity checking only.
- **Not supported** - what happens if one is encountered.

| Object | Status | Notes |
| --- | --- | --- |
| `MapData` | **Full** | `Layouts`, `Substrates` and `SubstrateMaps` all parsed; the `xs:key` / `xs:keyref` constraints are enforced. |
| `Layout` | **Partial** | `LayoutId`, `DefaultUnits`, `TopLevel`, `Package`, `Dimension`, `LowerLeft`, `DeviceSize`, `StepSize`, `ChildLayouts` all parsed and used. **Unsurfaced: `TopImage`, `BottomImage`, `ProductId`** - retained and re-emitted on export, but not drawn and not readable from a view. |
| `LogicalCoordinates` | **Full** | `X` / `Y`, as the logical map coordinate everywhere it appears. |
| `XYDimensions` | **Full** | The `X` / `Y` + `Units` shape behind `Dimension`, `LowerLeft`, `DeviceSize`, `StepSize` and `Position`; units are converted to millimeters. |
| `ZDimensions` | **Read-only** | `Order`, `Height`, `Units` are parsed and re-emitted. The control draws one plane, so `Z` orders nothing. |
| `ChildLayouts` | **Full** | Traversed by `LayoutSpecifier`; a broken or dangling path is reported with the offending segment. |
| `Substrate` | **Partial** | `SubstrateType`, `SubstrateId`, `LotId`, `GoodDevices`, `AliasIds`, `CarrierType`, `CarrierId`, `SlotNumber`, `SubstrateNumber` are all exposed as read-only `Map*` attributes. **Unsurfaced: `SupplierName`, `Status`** - retained and re-emitted on export, but no attribute reads them. |
| `AliasId` | **Full** | `Type` and `Value`, exposed as `MapAliasIds`. `Type` is an open vocabulary and is carried verbatim. |
| `SubstrateMap` | **Full** | All seven attributes: `SubstrateType`, `SubstrateId`, `LayoutSpecifier`, `SubstrateSide`, `Orientation`, `OriginLocation`, `AxisDirection`. |
| `Overlay` | **Full** | `MapName`, `MapVersion`, and all four payload kinds. Several overlays may be composed (see [`E142Overlays`](#e142-conformance)). |
| `ReferenceDevice` | **Partial** | `Coordinates` and `Position` drive optional placement registration (`E142AlignToReferenceDevices`). **Unsurfaced: `Name`** - parsed and retained, not exposed and not re-emitted. |
| `BinCodeMap` | **Full** | `BinType`, `NullBin`, `MapType`; all four `MapType` forms decode. |
| `BinCode` | **Partial** | `X`, `Y` and `LID` are used for placement and reported on selection. **Unsurfaced: `Number`** - parsed and retained, not exposed and not re-emitted. |
| `BinDefinition` | **Full** | `BinCode`, `BinCount`, `BinQuality`, `BinDescription`, `Pick` - quality drives the default fill, and all five survive an export. |
| `DeviceIdMap` | **Full** | Parsed as the cell → device-id lookup. |
| `DeviceId` | **Full** | `X`, `Y`, `LID` and the id itself; reported as `deviceId` on selection. Joined by LID first, then coordinate. |
| `TransferMap` | **Full** | The three `From*` attributes, and the `xs:keyref` onto `SubstrateMapKey` is enforced. |
| `Transfer` | **Full** | All six of `FX`, `FY`, `FID`, `TX`, `TY`, `TID`; reported as the five `from*` selection fields. The element is `<T>`. |
| `DeviceDataMap` | **Full** | `Parameter` and `DeviceData` lists; a value-count mismatch against the parameter list is reported. |
| `Parameter` | **Full** | `Name` and `Description`. A nameless `<Parameter/>` is reported and carried as an empty name. |
| `DeviceData` | **Full** | `X`, `Y`, `LID` and its `ccs:PVSet`. All sixteen E138 `PVType` alternatives are read, including `Su`, `Arr` and `NoValue`. |

#### Which control reads which of it

The matrix above is about the FORMAT. Five controls consume it, and they do not consume equally:

| Control | Reads | Does not |
|---|---|---|
| `SubstrateMap` | everything in the matrix | — |
| `SubstrateMapWidget` | `GridData`, `E142MapData`, `E142MapDataJson`, and the identity behind them | overlays, transfer maps, device data, reference devices |
| `SubstrateMapBinChart` | the same three inputs, for their bin table and cell counts | the lattice geometry it never draws, overlays, transfer maps |
| `SubstrateMapFilterBar` | nothing — it holds no map | all of it |
| `SubstrateMapBase` | nothing — it is the canvas, not a reader | all of it |

**A tile or a chart bound to a transfer map shows one substrate's worth of nothing**, because a
transfer map is a multi-substrate document and neither control has an attribute saying which. Bind
`E142TransferData` to the full control.

Nothing in §§9-13 is **Not supported**: every object above is at least parsed. The three
`Partial` rows name six attributes in total, and all six are retained in the model - they are
unsurfaced, not discarded.

### Out of scope by design

| Not implemented | Why |
| --- | --- |
| **§14 services** (`MapDownload`, `MapUpload`, `MapGroupDownload`, …) | Host-side. A service is a message exchange; this control renders whatever a host stack has already written to a bound symbol. |
| **E142.2, and `S14F1`/`F2` + `S6F11`** | Host-side. Object services and the collection-event report are SECS traffic, upstream of the symbol. |
| **E142.3** | Host-side, for the same reason. |
| **E142.4 transport** - `ITEMPART` reassembly, `ITEMACK` / `ITEMERROR`, collection events | Host-side. The control consumes the **finished item content**: bind the reassembled bytes to `E142TransferData` and it decodes them. Reassembly, acknowledgement and the readiness event all happen before that point. |
| **Very large maps** beyond a few megabytes of document | A limit, not a decision. Rendering stays responsive well past a 600 × 600 grid, but a document of tens of megabytes needs tiling or off-thread parsing, and neither exists yet. |
| **A JSON transport blessed by SEMI** | There isn't one to implement. E142 standardizes the model and an XML representation of it; the JSON envelope here is this package's second transport for the same model, name for name against the XSD. It is fully symmetric with the XML one — read and write, both directions — and it is not what a stranger's stack expects. `[Primary source]` |

### What this package claims

> Implements the consumer side of SEMI E142.1 across the full `MapData` object model -
> layouts, substrates, overlays, bin-code maps, device-id maps, transfer maps and device-data
> maps - and the item content of SEMI E142.4. Emitted documents validate against the E142.1
> XSD (V0125). See the conformance matrix for per-object coverage.

Nothing more than the matrix supports. In particular this is **not** a claim to implement
E142.2, E142.3, the §14 services or the Stream-21 transport, and not a claim of certified
conformance - E142 offers none to hold.

## Selection and the `onItemSelected` event

**`SelectionMode`** is `single` (the default) or `multi`. In `single` mode a click or
tap selects one element. In `multi` mode a click/tap **toggles** membership and a click
on empty space **clears** the selection. (Shift-drag rubber-band selection on pointer
devices is planned; `multi` mode today is click/tap toggle plus click-to-clear.)

Because grid-cell indices and `item_id`s can collide numerically, every selection entry
is typed with a **`kind`** of `'item'` or `'cell'`.

The control raises **`onItemSelected`** on every selection change, including a clear.

| Payload field | Type                                          | Meaning |
| ------------- | --------------------------------------------- | ------- |
| `itemId`      | number \| null                                | `item_id` of the last interacted element (a grid-cell index when `kind` is `'cell'`); `null` after a clear. |
| `status`      | string \| null                                | Status of that element; `null` after a clear. |
| `name`        | string \| null                                | Name of that element; `null` after a clear. |
| `userData`    | string \| number \| null                      | The element's `user_data`; `null` for grid cells or when unset. |
| `kind`        | `'item'` \| `'cell'`                          | What was interacted with. |
| `column`      | number *(cells only)*                         | Serialization column of the cell (its lattice column). Present only when `kind` is `'cell'`. |
| `row`         | number *(cells only)*                         | Serialization row of the cell. Present only when `kind` is `'cell'`. |
| `binCode`     | string \| null *(cells only)*                 | The cell's bin code. Present only when `kind` is `'cell'`. |
| `binQuality`  | string \| null *(cells only)*                 | The cell's bin quality, as the source declared it. Present only when `kind` is `'cell'`. |
| `mapX`        | number \| null *(cells only)*                 | Signed **logical** E142 map X of the cell (in its `OriginLocation` / `AxisDirection` frame), not the serialization column. Present only when `kind` is `'cell'`. |
| `mapY`        | number \| null *(cells only)*                 | Signed **logical** E142 map Y of the cell. Present only when `kind` is `'cell'`. |
| `deviceId`    | string \| null *(cells only)*                 | Device id from a `DeviceIdMap` overlay, matched to the cell by its logical coordinate. `null` when the map has no `DeviceIdMap` or that cell has no `<Id>` entry. Present only when `kind` is `'cell'`. |
| `selection`   | Array<{ `kind`, `itemId` }>                   | The full current selection (a single element in `single` mode; empty after a clear). |

Wire it up by adding an action or trigger on `SubstrateMap.onItemSelected` and reading
the payload fields — for example, writing `itemId` and `status` into symbols, or
calling a function that drills into the selected die.

The payload has a schema of its own,
`Controls/SubstrateMap/Schema/TypeDefinitions/ItemSelection.Schema.json`, and the table
above is the short form of it. Fields the table omits — `lid`, the five `from…` transfer
fields, `deviceData` and `overlays` — are described there.

### When the map has nothing to show

Four states, first match wins:

| | State | Shown |
| --- | ----- | ----- |
| 1 | real data is bound | the map |
| 2 | no real data, but a **last known state** | that state, plus an age label |
| 3 | no data, no last known state, `ShowDemoItems` | the demo, marked |
| 4 | otherwise | `NoDataImage` |

**Real data means something to draw.** A grid with cells counts; items count. A bound document
that produced nothing does *not* — that is precisely the case an empty state exists for. Nor
does an **outline alone**: an empty substrate body is a frame around nothing.

Row 2 is the tile's: only a control that keeps its last map ever reaches it. Row 3 is why binding an outline *and*
`ShowDemoItems` shows the demo inside your outline rather than an empty substrate.

`readEmptyState()` returns which row applies, so a surrounding layout can react to what the
control is actually showing rather than to what was bound to it.

Listed under [SubstrateMapBase](#substratemapbase-inherited-by-the-map-the-tile-and-the-chart):
declared on the base, so the map, the tile and the chart all have them.

### Which filter works on which channel

A filter and a channel are not independent. `Median`, `Min` and `Max` pick or order **palette
indices** — an index is a category, and the median of two categories is a category. `Box` and `Gauss`
**average**, and the average of two bin indices is not a bin.

|              | `Bins` | `FailDensity` | `ValueField` |
| ------------ | :----: | :-----------: | :----------: |
| `None`       | ✓ | ✓ | ✓ |
| `Median`     | ✓ | — | — |
| `Min`        | ✓ | — | — |
| `Max`        | ✓ | — | — |
| `Box`        | — | ✓ | ✓ |
| `Gauss`      | — | ✓ | ✓ |

Eight of the eighteen pairings are illegal. Bind one and the control **reports
`E142_FILTER_NOT_APPLICABLE` and filters nothing** — it does not silently pick something else, because
a filter that quietly became a different filter is worse than one that refused.

`SubstrateMapFilterBar` never offers an illegal pairing: it grays the kernel out and says why in the
tooltip. Changing the **channel** while an incompatible kernel is selected resets the kernel to
`None` — the channel is what you asked for, the kernel is what no longer applies.

**Radius `0` disables a filter as surely as `None` does.** Both are legal and mean the same thing;
neither is an error.

### Filters need pixels, and the zoom decides

A spatial filter runs over the **aggregated bitmap**, not over the lattice. That is what makes it
cheap — one pass over what is already on screen rather than over ninety thousand cells — and it is
why a filter has no effect until the map is aggregating.

The map aggregates when a cell is **smaller than one device pixel**. Above that, each die is drawn
individually and there is nothing to filter: a "3-pixel median" of a picture whose dies are four
pixels across would blur the dies, not the pattern.

So: **zoom out and the filter engages; zoom in and it stops.** That is a property of the operation,
not a limitation, and it is the same reason `FailDensity` exists — a density is a statement about a
neighborhood, and a neighborhood needs more than one die in it.

`readAggregation()` reports whether the last frame aggregated and which reducer it chose, so a view
can tell an operator why a filter appears to do nothing.

### What a filter costs

Measured over 640 000 device pixels, kernel only:

| Kernel | r = 1 | r = 2 | r = 5 |
| ------ | ----: | ----: | ----: |
| `Median` / `Min` / `Max` | 20 ms | 28 ms | 63 ms |
| `Box` / `Gauss` | 82 ms | 114 ms | 187 ms |

**This is per view change, not per frame.** The layer cache key includes the filter, so a cached tile
holds filtered pixels and panning or re-rendering the same view costs nothing further.

Radius is the dial that matters: `Median` at radius 1 costs a fifth of radius 5. Both scalar filters
are heavier because they convolve a float field rather than pick from a histogram.

### When a selection event fires, its attributes are already written

`onItemSelected` is raised **after** `SelectedItemId`, `SelectedItemStatus` and `SelectedItems` have
been updated. A view action reading any of them in response to the event sees the selection the event
is about, including on the first click of a session.

Before 4.0.0.0 the event was raised first, so a handler reading the attributes was one selection
behind — and on the first click there was no previous selection, so it read `null`. It looked
intermittent because re-clicking the **same** cell leaves the attributes unchanged, and only a click
on a new cell showed it.

**Prefer the event's own payload anyway.** It carries `itemId`, `status`, `name`, `userData`, `kind`
and `selection`, plus `column`, `row`, `binCode`, `binQuality`, `mapX` and `mapY` for a cell. The
attributes exist for binding to other controls, not for reading inside the handler that was just
told.

**`onGroupSelected` does not write those attributes at all.** A group is not an item selection; its
payload carries the group id, the cell count, the worst severity present and a histogram. The member
cells are drawn with the selection ring, but `SelectedItems` stays as it was — read the payload, or
call `readGroupMembers(id)`.

### The four empty-ish states, and which one you are in

Four different things can leave a control with little or nothing on screen, and **they are not
interchangeable**. The precedence is fixed:

| # | State | When | What you see |
|---|-------|------|--------------|
| 1 | `data` | a map is bound and readable | the map |
| 2 | `stale` | the map went away, and a previous one rendered | **the last map that worked**, with its age still counting |
| 3 | `demo` | nothing bound, and `ShowDemoItems` is on | a sample wafer, hatched and labeled `DEMO` |
| 4 | `nodata` | nothing bound, and no demo | the no-data image |

`readEmptyState()` returns exactly one of these. Read top to bottom: live data wins over a retained
map, a retained map wins over the demo, and the demo wins over the no-data image.

**A map of only null cells is none of these.** It is `data` — something arrived and parsed — and the
bin chart says so in words: `1600 cells, none carries a bin`. Falling back to the no-data image would
claim nothing was bound, which is false and hides a real problem.

**A retained map is not a screenshot.** The model is kept, not the pixels, so a stale tile still
resizes and re-themes. **A page reload loses it** — the point is to survive a gap in a feed, not a
restart.

### The no-data image, and what to ship

`NoDataImage` and `NoDataImageDark` take a URL. **Ship SVG if you can.** The image is drawn
contain-scaled into whatever box the control has, and a control may be a 200-pixel dashboard tile or
a full-screen view — one raster cannot serve both.

If you must ship a raster, **size it for the largest box it will appear in** and expect it to be
downscaled elsewhere: at least 512 px on the long edge for a full view, 256 px for a tile. Below
that, the letterboxed result is visibly soft.

The control picks the dark variant by **measuring the background's lightness**, not by asking the
theme its name — a custom theme that never says "dark" still gets the right image. If the URL fails
to load, the shipped fallback is drawn and `SUBSTRATEMAP_NODATA_IMAGE_UNAVAILABLE` is raised once per
URL.

### Spatial filters, channels and a reference map

The filter runs in **screen space**, after the render and before the blit, with its radius in
device pixels — so the result is zoom-dependent by design.

> This is a fast indicator on a dashboard. It does not replace systematic quality management.
> A reproducible, geometrically exact tool works from the MES data, where there is more than
> one record.

**RGB is not what gets filtered; the palette index is.** Every grid pixel is an index into a
palette the control owns, so `Median` returns a real bin color rather than an average of two.
A per-channel median on RGB is forbidden: the mean of green and red is brown, and brown is not
a bin category. With two colors nobody notices; with eight sort grades the image turns to mud.

Listed under [Filter attributes](#filter-attributes).

#### What a golden map is for

A wafer carries things that are **not defects but are not product either**: test dies, dummy dies,
process-control structures. They occupy real positions, they carry a bin code that is not a pass
bin, and to a plain bin map they look exactly like a defect — often a suspiciously regular one, a
row or a cross or a ring of them.

Bind a reference that contains them and they **gray out**, because they are expected. What stays
lit is what is actually wrong.

That is the whole value, and it is why the two modes exist. Against a reference with nothing
by-design in it, `Difference` and `NewOnly` agree exactly and the view tells you nothing you could
not read off the map itself. Against a reference that encodes what the wafer is *supposed* to
contain, they separate: a row of test dies stops shouting, and a real cluster in the same region
stops being lost among them.

Producing the reference needs no new tooling: run `toGridData()` on a wafer whose layout is the one
you expect, and bind the result back.
Every default changes nothing: an existing view picks up all seven and looks exactly as it did.

### The bin chart

`SubstrateMapBinChart` counts a map's bins. **One control for both presentations** — `ChartStyle` is
`Bars` or `Share` — because they consume identical data and share palette resolution, the empty
state, the remainder bucket and the sort order, differing only in geometry.

Listed under [SubstrateMapBinChart](#substratemapbinchart).

#### When the bar is the better choice

**A share chart with more than about five segments is harder to read than the bar chart beside it.**
People compare lengths well and angles badly, and a pie makes the comparison the reader is worst at
into the only one available. Ten segments in a ring is a legend with a decoration attached.

`Share` exists because it was asked for, and it is drawn properly: the percentages sum to exactly
100.0, the rounding remainder lands in the largest segment where it changes the reading least, and
slivers keep their true size while their labels move to the legend.

Use it for **two or three categories** — pass against fail, or pass against two failure modes — where
the point is the proportion rather than the comparison. Past that, `Bars`.

**Figures live in the legend, not in the wedges.** At 200 px a 12 % segment is wide enough to hold a
number by arithmetic and not by eye. The legend carries every category with its bin code and its
figure, so nothing is lost — and each wedge is separated by a thin line in the background color, so
two adjacent categorical colors cannot read as one segment.

**Every chart names its wafer and its age**, across the top. A chart beside a map is unambiguous; a
chart in a screenshot is a set of numbers about an unnamed wafer at an unknown time. There is no
attribute to switch it off.

**Bind the map, not the map control.** The chart takes the same map attributes `SubstrateMap` takes,
not a reference to a sibling by id — an id coupling points silently at nothing the moment someone
moves the map to another page, and the failure looks like *the chart is empty*. Binding both to one
symbol costs a second parse and cannot get out of step.

**Every bar is the map's color for that code.** The chart resolves no palette of its own.

**The axis is linear from zero.** No truncated origin: with yield data the distance to zero *is* the
information, and an axis starting at 940 makes a 4 % loss and a 0.4 % loss look the same.

A category with **count 0 does not appear** — a zero-height bar is a line nobody can read, and a
legend entry for something that did not happen is a category an operator will look for on the wafer
and not find.

#### An empty chart and an empty map are different things

**Nothing bound** shows the no-data image, the same one every control in this package shows. Not an
empty axis: a coordinate system with no bars in it says *zero failures*, and that is a claim nobody
made.

**A map of only null cells** — one that arrived and parsed, where every cell carries the null bin —
shows the cell count and a line saying none of them carries a bin. That is a different fact and an
operator can act on it: a map arrived and it is empty. Falling back to the no-data image would say
*nothing was bound*, which is false and hides the problem.

### The dashboard tile

`SubstrateMapWidget` is a **map**, not a container holding one — it extends the same base, so the
canvas, the theme, the empty state, the demo marking and the no-data image all come for free. What
it has instead of the full control is a much smaller surface: **three inputs and four flags.**

Listed under [SubstrateMapWidget](#substratemapwidget).

#### Clicking a tile opens the wafer

`onSubstrateSelected` fires on a click or tap **anywhere** in the tile, carrying:

```
{ substrateId, lotId, state, ageSeconds, ageSource, goodDevices, summary }
```

Enough to open the full view on the substrate the operator tapped. `state` is `data` or `stale`, so a
handler opening a stale wafer can say so; `summary` is the same shape `readBinStatistics()` returns,
so a handler that reads one already reads the other.

**No cell-level hit test.** The tile is one target. At 200 px a die is a fraction of a pixel and a
coordinate read off one would be a guess dressed as a fact — a dashboard that wants a cell opens the
full `SubstrateMap`.

**A tile showing nothing raises nothing.** Without a map there is no substrate to select, and an event
carrying nulls would make every handler check what the control already knows. A **stale** tile does
raise: the operator is looking at a wafer and wants to open it.

#### A tile keeps the last map that worked — in memory only

Unbind the data, or bind something that will not parse, and the tile **goes on showing the last map
that rendered**, with its age still counting from when that data arrived. An operator seeing a wafer
and a growing age knows more than one seeing an empty tile — and the age is what stops the first from
being a lie.

`E142LastError` says why, when the reason was a parse failure. Nothing else would: a tile silently
keeping an old picture is the failure this behavior would otherwise create.

**A page reload loses it.** The retained state is in memory and is not persisted. That is deliberate:
the point is to survive a momentary gap in a feed, not a restart, and persisting would mean deciding
how stale is too stale to restore — a question nobody has asked. Stated here rather than quietly
assumed.

With no previous map to fall back on, the tile shows the no-data image.

#### Every control shows its wafer and its age; the check rate follows your process

`MapTimestamp` is the same attribute on the **map**, the **tile** and the **chart**, so one symbol
drives all three. The map shows the age in its identity band beside the substrate id; the tile and
the chart paint it, because neither has a band.

**Staleness is the one thing that cannot be observed.** Data arrives by binding, size by a
`ResizeObserver`, theme by the framework — every other update here is a reaction to an event. A feed
going quiet produces no event, so the control has to wake up and look.

![A dashboard tile whose data has stopped arriving: a dashed border drawn just outside the
substrate, with the age of the last update beneath it.](Images/tile-stale.png)

*What a stale tile looks like. The dashed border sits just outside the substrate rather than on it,
so the marking is legible against the dies; the age underneath says how long ago the data arrived.*

**It wakes at a rate derived from your threshold**, because the threshold is the only place you have
already told it your process timescale:

| Takt | `StaleAfterSeconds` | Checks every | Late by at most |
| ---- | ------------------- | ------------ | --------------- |
| 15 min/substrate | 900 | 60 s (ceiling) | 6.7 % |
| 15 s/substrate | 45 | 4.5 s | 10 % |
| 1.2 s printer | 5 | 1 s (floor) | 20 % |

Never faster than once a second, never slower than once a minute, and **nothing runs at all when
`StaleAfterSeconds` is unset** — the cost lands only where the feature was asked for.

#### An E142 document does not know how old it is

This is worth stating plainly, because it is surprising. The `ITEMVERSION` value SEMI defines belongs
to the **Stream 21 message** that transports an item, not to the map — and the E142 XML schema has no
timestamp of its own outside a supplier extension block **[Primary source]**. **A conformant map cannot tell you when it
was made** **[Inference]**.

So the tile does not guess. It shows the receive time, labeled `received`, unless you bind
`MapTimestamp` from wherever your transport keeps the real one — and then it says `measured`. The two
are different facts: a map that arrived a second ago may describe a wafer tested this morning.

The age is drawn **unconditionally**; there is no flag to hide it. Every other readout here is
optional because the tile still means something without it. This one is not: the reason a tile exists
is that nobody has to look at it, and a tile that can silently show six-hour-old data is worse than
an empty one.

Past `StaleAfterSeconds` the tile gains a **dashed border**. Not a tint — every color on this tile is
data, and a yellowed wafer reads as a yield problem rather than a freshness one.

**Every default reproduces an empty tile**, so one dropped on a page and not yet bound shows the
no-data image and nothing else.

**What is deliberately absent**: rotation, origin marker, overlay selection, selection mode. A tile
needing those wants the full `SubstrateMap`. `E142TransferData` is absent too — a transfer map is a
multi-substrate document and a tile shows one substrate, so binding it would only raise the question
of which.

### Driving the filters from a bar

`SubstrateMapFilterBar` is a separate control that renders **no map**. It carries four of the filter
attributes — `SpatialFilter`, `SpatialFilterRadius`, `FieldView`, `HighlightFromSeverity` — with the
same names, types and schemas the map uses, so **one symbol binds to both**.

That separation is the point. A control holding a map *and* its controls means every map on a page
needs its own bar or gets none. Bound this way, one bar drives **two** maps — unfiltered on the
left, filtered on the right — and that comparison is what makes a filter worth looking at.

```
bar.SpatialFilter  ─┐
                    ├─ %i%FilterKernel%/i% ─┬─ mapLeft.SpatialFilter
                    ┘                       └─ mapRight.SpatialFilter
```

**Unavailable kernels are grayed out, not rejected.** The bar disables what the pairing rule would
refuse and says why in the option's tooltip. Being allowed to pick something and *then* told it did
not work is worse than seeing it unavailable, and it writes a diagnostic to the log for a mistake the
interface invited.

Changing the **channel** while an incompatible kernel is selected resets the kernel to `None` rather
than refusing the change: the channel is what you asked for, the kernel is what no longer applies.

### Demo content is always marked

When the control draws the demo it stamps a diagonal hatch across the whole drawing area and
the word **DEMO** in the middle. **There is no attribute to switch this off**, and that is
deliberate.

A plausible-looking gray wafer on a dashboard is worse than an empty tile, because it will be
believed — sooner or later someone reads a yield off sample data. The marking is the feature;
the picture is decoration.

It is a hatch and not a corner badge for the same reason: a badge sits in one corner and gets
missed, cropped by a tile, or covered by a surrounding layout, and a screenshot of the middle
of the map carries no trace of it. A hatch crosses every part of the drawn area, so no crop of
it is unmarked.

Both colors come from your theme (`--substratemap-edge-color` over `--substratemap-background`),
so a dark theme marks in light without any configuration. Bind any real data and the demo and
its marking disappear together, in the same frame.

### How a bin code gets its color

Four steps, first match wins:

1. an explicit **`StatusColorMapping`** entry for the code;
2. a **`BinQuality`** that resolves to `pass` or `fail`, painting `--substratemap-bin-pass`
   or `--substratemap-bin-fail`;
3. the **categorical palette** — a perceptually spaced color assigned by position in
   the bin table;
4. the **unknown** color.

Step 3 is why a map with eight sort grades and no qualities now shows eight colors
instead of one gray eight times. The palette is generated in OKLCH at a fixed lightness
and chroma, so the colors separate by a measured minimum ΔE and stay distinguishable
under deuteranopia and protanopia.

**It caps at ten.** Ten is roughly what a person can hold at once, so past it every
further code shares one "other" gray and the control logs
`SUBSTRATEMAP_CATEGORICAL_PALETTE_CAPPED` once. The cap is visible rather than silent:
`readBinStatistics()` counts *every* code, so the eleventh is present in the numbers and
gray on the map. If more than ten codes matter, say which by giving them a
`StatusColorMapping` entry or a `BinQuality`.

A map whose codes all carry a quality never reaches step 3 and renders exactly as it did
before this existed.

### `onItemSelected` versus `SelectedItems`

They are close relatives and **not the same shape**. Both describe the selection; the
event describes *what you just touched* and the attribute describes *everything that is
selected*. Every difference below is deliberate, and none of them is a rename you can
ignore.

| Difference | Event | `SelectedItems` | Why |
| ---------- | ----- | --------------- | --- |
| Spelling | `itemId`, `userData` | `item_id`, `user_data` | The event is a JavaScript payload and follows JavaScript convention; the attribute is a bound data type whose field names were fixed by `SelectionList.Schema.json` before the event existed. Renaming either would break every view already bound to it. |
| Scope of the single values | the **last interacted** element | — | `status`, `name`, `userData` and `kind` on the event describe one element. The attribute has no "last" concept; it is a list. |
| Per-entry detail | `selection` entries are `{ kind, itemId }` only | every entry carries `status`, `name`, `user_data` and, for cells, the full cell detail | The event fires on every selection change, so its `selection` is kept to identity. Read the attribute when you need the detail for all of them, the event when you need to know what changed. |
| `column`, `row` | **present** for a cell | absent | The attribute identifies a cell by its linear `item_id`. The event adds the serialization coordinates because a handler usually wants to *show* them. |
| `binCode` | **present** for a cell | absent | In an attribute entry, `status` **is** the bin code — a cell's bin is its status. The event repeats it under its own name so a handler need not know that. |
| `raw` in `deviceData` | **absent** | **present** | The event carries each reading as `{ name, value }`; the attribute carries `{ name, value, raw }`, `raw` being the E138 `PvValue` tree. **A view that needs the tree must read the attribute — the event will never carry it.** The event fires on every change and the tree can be arbitrarily deep, so it is not sent through an event payload. |
| Unknown cell values | present and `null` | **absent** | The event always sets its cell fields, using `null` where nothing is known. The attribute omits a field entirely when the corresponding overlay is not bound. So `'mapX' in entry` is a meaningful test on the attribute and always true on the event. |

The 2.0 release notes say the two "gain" the same set of fields. That is true of the
field *names* and not of `raw`, and not of the presence rules in the last row.

---

## Selected outputs

The same information is also available as **read-only** attributes you can bind
directly (they are `readOnly`; the control writes them), listed under
[Selection attributes](#selection-attributes).

The four scalar outputs always describe the **last interacted element** and reset to
`null` when the selection is cleared. `SelectedItems` describes the whole selection.

---

## Attribute reference

Every attribute of every control, in one place: grouped by control, then by topic. The sections
above explain what the attributes do and why; this is where to look one up.

**Two names for one attribute.** The tables name each attribute by its property name — the one the
TypeScript API uses, as in `setShowOriginMarker()` — and give beside it the name you write in a
view's HTML. The rule: `data-tchmi-`, then the property name in kebab case, a hyphen before each word. `ShowOriginMarker` is
`data-tchmi-show-origin-marker`; a run of digits stays with its letters, so `E142MapData` is
`data-tchmi-e142-map-data`; and a one-letter word is still a word, so `YAxisDirection` is
`data-tchmi-y-axis-direction`.

### SubstrateMap

**Shared with the tile and the chart:** `GridData`, `E142MapData`, `E142MapDataJson` and
`MapTimestamp` mean the same on all three controls. `MapTimestamp` is described under
[SubstrateMapWidget](#substratemapwidget).

#### Identity attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `SubstrateId` | `data-tchmi-substrate-id` | string \| null | `null` | Identifier shown in the identity area — a label drawn outside the canvas, so it stays upright and in place under any `MapRotation`. `null` hides the identity area. |
| `SubstrateIdentityPosition` | `data-tchmi-substrate-identity-position` | string | `below` | Where the identity label sits relative to the map: `above`, `below` or `none`. `none` hides it even when `SubstrateId` is set. |

#### Item, label and demo attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `ShowDemoItems` | `data-tchmi-show-demo-items` | boolean | `true` | Draw a placeholder demo substrate and items for design-time preview. Demo content appears **only** when no `Outline`, `OutlinePreset` or `Items` are bound (see [Outline precedence](#outline-precedence)). Set `false` in production. |
| `ShowLabels` | `data-tchmi-show-labels` | boolean | `true` | Toggle the [Labels](#labels) drawn over the substrate. |
| `Items` | `data-tchmi-items` | array \| null | `null` | Item layout for the substrate: id, optional name/layer/orientation/status, opaque `user_data`, and one or more geometries per item. Authored in the DATA frame. See [Items](#items). |
| `Labels` | `data-tchmi-labels` | array \| null | `null` | Text labels drawn over the substrate, authored in the DATA frame. Each label is a box whose text is fitted to it. See [Labels](#labels). |

#### Status and color attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `ItemStatusAssignments` | `data-tchmi-item-status-assignments` | array \| null | `null` | Per-item status overrides, `[{ item_id, status }]`. Each entry overrides the status embedded in the matching item; the result is colored through `StatusColorMapping`. |
| `StatusColorMapping` | `data-tchmi-status-color-mapping` | object \| null | `null` | Maps a status or bin string to a CSS color. A status with no entry falls back to the theme's unknown-status color. Applies to the BASE layer only. |
| `BinQualityAliases` | `data-tchmi-bin-quality-aliases` | object \| null | `null` | Maps an author's `BinQuality` token onto `pass` or `fail`. E142 reserves **only** `Pass` and `Fail`; every other value is application-defined, so `Reject` or `Schlecht` is legal and unreadable here until you say what it means. See [Bin quality](#bin-quality). |
| `BinSeverityPriority` | `data-tchmi-bin-severity-priority` | array \| null | `null` | Bin codes in severity order, **most severe first**, for the ordering the ladder cannot infer. A code the document calls `pass` is never promoted by it. See [Severity](#severity). |

#### Outline attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `Outline` | `data-tchmi-outline` | object \| null | `null` | The substrate outline: one closed shape authored in the SUBSTRATE frame, filled with the body color. Takes precedence over `OutlinePreset`. |
| `OutlinePreset` | `data-tchmi-outline-preset` | string | `none` | Built-in SEMI substrate outline by key — `si-6in-p100`, `si-12in`, `solar-m10`, `glass-gen4` and others. `none` selects no preset. |
| `SecondaryFlatDirection` | `data-tchmi-secondary-flat-direction` | string \| null | `null` | Placement of the secondary flat relative to the primary, for disc-flats presets: `cw` or `ccw` as seen on screen. Ignored by notch and single-flat presets. |
| `NotchExaggeration` | `data-tchmi-notch-exaggeration` | number \| null | `null` | Visual magnification of the true notch depth for disc-notch presets; `1` is to scale, lower values are clamped. Ignored when `Outline` is bound. |

#### Origin attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `OriginLocation` | `data-tchmi-origin-location` | string | `center` | Anchor on `BBOX_S`: `center`, `top-left`, `bottom-left`, `top-right`, `bottom-right`. **`top` = +y edge, `left` = -x edge** of the bounding box (in S, +y up). |
| `OriginOffsetX` | `data-tchmi-origin-offset-x` | number | `0` | Extra translation along the **substrate +x** axis, added to the anchor. Meters × `OriginOffsetPrefix`. |
| `OriginOffsetY` | `data-tchmi-origin-offset-y` | number | `0` | Extra translation along the **substrate +y** axis (up), added to the anchor. Meters × `OriginOffsetPrefix`. |
| `OriginOffsetPrefix` | `data-tchmi-origin-offset-prefix` | string | `milli` | Metric prefix (`yocto`..`none`) scaling the meter-based offsets. `milli` reads the offsets in millimeters. |
| `OriginRotation` | `data-tchmi-origin-rotation` | number | `0` | Rotation of D's axes about the data origin, **degrees, CCW-positive** in S (and CCW on screen). Rotates the ensemble about the **anchor**, not the substrate center. |
| `YAxisDirection` | `data-tchmi-y-axis-direction` | string | `up` | `up` or `down`. `down` mirrors D's y axis (vision-system convention: +y grows downward). |
| `ShowOriginMarker` | `data-tchmi-show-origin-marker` | boolean | `false` | Draw a diagnostic **origin marker** — a crosshair at the data origin plus `+x`/`+y` axis stubs (the `+y` head doubled, so the axes read without color). See [Origin marker](#origin-marker). |

#### View attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `MapRotation` | `data-tchmi-map-rotation` | number | `0` | View rotation of the whole construct about the substrate origin, **degrees, CCW-positive on screen**. `0` leaves the view unrotated. |
| `ViewTransform` | `data-tchmi-view-transform` | number[] \| null | — | An affine transform `[a,b,c,d,e,f]`, post-multiplied onto the view. **Geometry only.** See [Injecting a transform](#injecting-a-transform). |
| `MapScale` | `data-tchmi-map-scale` | number \| null | — | **Read-only.** CSS px per millimeter in the frame last drawn. See [Injecting a transform](#injecting-a-transform). |
| `ViewSubstrateSide` | `data-tchmi-view-substrate-side` | string | `follow-map` | Which face to render from: `follow-map` (no mirror), `TopSide`, `BottomSide` (see [Substrate side](#substrate-side)). A VIEW transform, like `MapRotation`. |
| `MapSubstrateSide` | `data-tchmi-map-substrate-side` | string \| null | `null` | **Read-only.** The rendered map's `SubstrateSide`. Always `TopSide` on the `GridData` path, which has no side field. |

#### E142 input attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `GridData` | `data-tchmi-grid-data` | object \| null | `null` | Compact GridData v1 document. Mutually exclusive with `E142MapData` / `E142TransferData`. |
| `E142MapData` | `data-tchmi-e142-map-data` | string \| null | `null` | E142.1 MapData XML document. Mutually exclusive with `E142MapDataJson` / `E142TransferData` / `GridData`. |
| `E142MapDataJson` | `data-tchmi-e142-map-data-json` | object \| string \| null | `null` | The **same** E142.1 MapData document in its JSON representation - one model, one set of rules, so it renders identically to the XML form. Bind a typed symbol, not a string. Mutually exclusive with the other map inputs. |
| `E142TransferData` | `data-tchmi-e142-transfer-data` | string \| number[] \| null | `null` | E142.4 (Stream-21) reassembled item bytes: base64 string or byte-value array. Decoded to XML, then the `E142MapData` path. Mutually exclusive with the other two. |
| `E142OverlayName` | `data-tchmi-e142-overlay-name` | string \| null | `null` | Overlay `MapName` to render; `null` = first renderable BinCodeMap. XML / transfer paths only. |
| `E142SubstrateId` | `data-tchmi-e142-substrate-id` | string \| null | `null` | Narrows to a `SubstrateMap` by `@SubstrateId`; `null` does not filter. Applied FIRST — see [Choosing a map](#choosing-a-map-in-a-multi-substrate-document). |
| `E142LayoutSpecifier` | `data-tchmi-e142-layout-specifier` | string \| null | `null` | Narrows to a `SubstrateMap` by `@LayoutSpecifier`; `null` does not filter. Applied second. |
| `E142OverlayVersion` | `data-tchmi-e142-overlay-version` | string \| null | `null` | Narrows the overlay by `@MapVersion`. The empty string is NOT the same as `null`: it selects overlays that state no version. Setting it without `E142OverlayName` is an error. |
| `E142Overlays` | `data-tchmi-e142-overlays` | array \| null | `null` | Ordered list of overlays to compose — one base plus decorations, `{ name, version?, role? }`. Mutually exclusive with `E142OverlayName`; the list wins. |
| `E142DeviceDataOverlayName` | `data-tchmi-e142-device-data-overlay-name` | string \| null | `null` | Which `DeviceDataMap` overlay supplies the per-cell readings; `null` takes the first that carries device data. Separate from `E142OverlayName` because an overlay carries one kind or the other, never both. |
| `E142FallbackStepSizeX` | `data-tchmi-e142-fallback-step-size-x` | number \| null | `null` | Fallback column pitch (mm) for a scale-less map; needs Y too (see [Sizing](#sizing-and-fit)). |
| `E142FallbackStepSizeY` | `data-tchmi-e142-fallback-step-size-y` | number \| null | `null` | Fallback row pitch (mm) for a scale-less map; needs X too. |
| `E142OrientationOffset` | `data-tchmi-e142-orientation-offset` | number | `0` | Degrees added to the map's Orientation before placement, CW-positive (see [Orientation](#orientation-the-zero-reference)). |
| `E142AlignToReferenceDevices` | `data-tchmi-e142-align-to-reference-devices` | boolean | `false` | Opt-in reference-device registration (see [Reference-device alignment](#reference-device-alignment)). When on, the placement is shifted so reference-device positions are met. XML path only. |

#### E142 output attributes

Read-only: the control writes them.

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `E142LastError` | `data-tchmi-e142-last-error` | string \| null | `null` | **Read-only.** Last ingestion error (code + detail), or `null` when clean. |
| `MapSubstrateId` | `data-tchmi-map-substrate-id` | string \| null | `null` | **Read-only.** Substrate id from the active map; also drives the identity area when `SubstrateId` is unset. |
| `MapLotId` | `data-tchmi-map-lot-id` | string \| null | `null` | **Read-only.** Lot id from the active map's substrate, or `null`. |
| `MapGoodDevices` | `data-tchmi-map-good-devices` | number \| null | `null` | **Read-only.** Good-device count from the active map's substrate, or `null`. |
| `MapAliasIds` | `data-tchmi-map-alias-ids` | array \| null | `null` | **Read-only.** The substrate's `AliasIds`, `[{ type, value }]`. `Type` is an open vocabulary and is carried verbatim. |
| `MapCarrierType` | `data-tchmi-map-carrier-type` | string \| null | `null` | **Read-only.** `Substrate/CarrierType` from the active map, or `null`. |
| `MapCarrierId` | `data-tchmi-map-carrier-id` | string \| null | `null` | **Read-only.** `Substrate/CarrierId`. Typed `LotIdType` (maxLength 80), not `MaterialIdType`. |
| `MapSlotNumber` | `data-tchmi-map-slot-number` | number \| null | `null` | **Read-only.** `Substrate/SlotNumber`. `xs:nonNegativeInteger`, so **0 is a legal value** and is not the same as `null`. |
| `MapSubstrateNumber` | `data-tchmi-map-substrate-number` | number \| null | `null` | **Read-only.** `Substrate/SubstrateNumber`. Also `xs:nonNegativeInteger`; 0 is legal. |
| `MapSubstrateCount` | `data-tchmi-map-substrate-count` | number \| null | `null` | **Read-only.** How many `SubstrateMap` elements the bound document has, before filtering (see [Choosing a map](#choosing-a-map-in-a-multi-substrate-document)). Clears on a parse failure; survives a selection failure. |

#### Aggregation and touch attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `AggregationFactor` | `data-tchmi-aggregation-factor` | number \| null | — | **Read-only.** Cells per device pixel by **area** in the frame last drawn — the number for *"1 px = 6 dies"*. See [Severity](#severity). |
| `AggregationMode` | `data-tchmi-aggregation-mode` | string \| null | — | **Read-only.** Which reduction drew the last frame: `None`, or `PointSample` when cells are smaller than a pixel. See [Severity](#severity). |
| `AggregationReducer` | `data-tchmi-aggregation-reducer` | string | `Auto` | Which reduction an aggregated tile uses. `Auto` **measures** each frame's saturation and selects for the next; `MaxSeverity` or `FailFraction` force it. See [Choosing the reduction](#choosing-the-reduction). |
| `TouchTargetSize` | `data-tchmi-touch-target-size` | number | `40` | The smallest area a tap should select, in CSS px. `0` turns grouping off and is the only value that does; every other value below 24 clamps and warns. Hit resolution only — painting is unaffected. See [Touch targets](#touch-targets). |

#### Filter attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `SpatialFilter` | `data-tchmi-spatial-filter` | `None \| Median \| Min \| Max \| Box \| Gauss` | `None` | `Median` takes the most common palette index in the neighborhood; `Min`/`Max` are erosion and dilation over severity rank; `Box`/`Gauss` average a scalar field and give a **density map, not a bin map**. |
| `SpatialFilterRadius` | `data-tchmi-spatial-filter-radius` | number, 0…8 | `1` | Radius in **device** pixels. Zero disables the filter, so a slider can turn it off. |
| `FieldView` | `data-tchmi-field-view` | `Bins \| FailDensity \| ValueField` | `Bins` | What the tile shows, and therefore what a filter would operate on. |
| `FieldGamma` | `data-tchmi-field-gamma` | number | `0.4` | Curve applied to a scalar field before coloring, so the low end is not one indistinguishable band. Ignored when `FieldView` is `Bins`. |
| `HighlightFromSeverity` | `data-tchmi-highlight-from-severity` | number \| null | `null` | Bins at or above this rank keep their color **exactly**; everything below drops to chroma 0 at its own lightness. **Gray, not hidden** — a hidden cell is indistinguishable from a null cell, and *there is nothing here* is not the same as *there is something here that does not concern you right now*. Where a pale bin would mute to something indistinguishable from the empty substrate, its lightness is pushed away instead: separation wins over fidelity, because the point of graying is that the cell still says something is there. |
| `ReferenceGridData` | `data-tchmi-reference-grid-data` | `SubstrateMapGridData` \| null | `null` | A **golden map** to compare against. An ordinary grid, deliberately: run `toGridData()` on a wafer that came out right and bind the result straight back — the loop closes with no new format. Ignored entirely while `ReferenceMode` is `Off`. **The lattice must match exactly**: nothing is interpolated, and a reference of a different geometry switches the comparison off and reports `E142_REFERENCE_GEOMETRY_MISMATCH` naming both dimensions. |
| `ReferenceMode` | `data-tchmi-reference-mode` | `Off \| Difference \| NewOnly` | `Off` | `Difference` keeps the color of every cell whose bin **differs** from the reference and grays the rest. `NewOnly` keeps only cells that got **worse** — the question after a rework step. The two agree against a clean reference, where every failure is new; they part when the reference already carries failures that are now repaired. **Needs one device pixel per cell or more**: below that the map is aggregated by severity and there is no per-cell color to carry. |

#### Selection attributes

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `SelectionMode` | `data-tchmi-selection-mode` | string | `single` | `single` keeps exact single-select semantics; `multi` toggles membership on click. See [Selection](#selection-and-the-onitemselected-event). |

Read-only selection outputs — the control writes them:

| Attribute               | HTML attribute | Type                                                                    | Meaning |
| --- | ----------------------- | ----------------------------------------------------------------------- | ------- |
| `SelectedItemId`        | `data-tchmi-selected-item-id` | number \| null                                                          | `item_id` of the last interacted element; `null` after a clear. |
| `SelectedItemStatus`    | `data-tchmi-selected-item-status` | string \| null                                                          | Its status; `null` after a clear. |
| `SelectedItemName`      | `data-tchmi-selected-item-name` | string \| null                                                          | Its name; `null` after a clear. |
| `SelectedItemUserData`  | `data-tchmi-selected-item-user-data` | string \| number \| null                                                | Its `user_data`; `null` for grid cells or when unset. |
| `SelectedItems`         | `data-tchmi-selected-items` | Array<{ `kind`, `item_id`, `status`, `name`, `user_data` }>             | The full current selection; most useful in `multi` mode. `'cell'` entries additionally carry `binQuality`, the signed logical `mapX` / `mapY`, and `deviceId` when a `DeviceIdMap` is present. |

### SubstrateMapWidget

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `GridData` | `data-tchmi-grid-data` | `SubstrateMapGridData` \| null | `null` | Identical to the map's attribute of the same name, in type, schema and meaning — a tile and a map bound to one symbol must agree about what it carries. |
| `E142MapData` | `data-tchmi-e142-map-data` | string \| null | `null` | The E142 XML, as the map takes it. |
| `E142MapDataJson` | `data-tchmi-e142-map-data-json` | `SubstrateMapE142MapDataJson` \| null | `null` | The E142 JSON document, as the map takes it. |
| `ShowSubstrateId` | `data-tchmi-show-substrate-id` | boolean | `false` | Show the substrate id above the map. Off by default: a dashboard usually labels its own tiles, and two labels is one too many. |
| `ShowYield` | `data-tchmi-show-yield` | boolean | `false` | Show the pass fraction. Counted over the dies that were **tested**, so a half-processed wafer does not read as half-failed. |
| `StaleAfterSeconds` | `data-tchmi-stale-after-seconds` | number \| null | `null` | How long a map may go without an update before the tile marks it stale; `null` never marks. **A dashboard tile is the one place a frozen value is genuinely dangerous** — it looks exactly like a healthy one. |
| `MapTimestamp` | `data-tchmi-map-timestamp` | string \| null | `null` | When the map was **measured**, if you can supply it. Bound and the tile labels its age `measured`; absent and it labels the age `received`. Accepts the SEMI form `YYYYMMDDhhmmsscc` **[Primary source]** and ISO 8601; a value with no timezone is read as local time **[Inference]**. |
| `E142LastError` | `data-tchmi-e142-last-error` | string \| null | `null` | Set when a bound map cannot be read; cleared when one can. Because the tile keeps showing the last map that **did** render, this is the only signal the feed has gone bad. Writable, so a view action can clear it after acknowledgement. |
| `ShowBinHistogram` | `data-tchmi-show-bin-histogram` | boolean | `false` | A small bin histogram along the bottom. Answers *which failure mode* at a glance; `SubstrateMapBinChart` is the place to read one properly. |

### SubstrateMapBinChart

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `GridData` | `data-tchmi-grid-data` | `SubstrateMapGridData` \| null | `null` | The map to count. Identical to `SubstrateMap`'s attribute of the same name. |
| `E142MapData` | `data-tchmi-e142-map-data` | string \| null | `null` | The E142 XML, as the map takes it. |
| `E142MapDataJson` | `data-tchmi-e142-map-data-json` | `SubstrateMapE142MapDataJson` \| null | `null` | The E142 JSON document. |
| `ChartStyle` | `data-tchmi-chart-style` | `Bars \| Share` | `Bars` | Which presentation to draw. |
| `ChartSort` | `data-tchmi-chart-sort` | `CountDescending \| Code` | `CountDescending` | Category order. Biggest first is what a chart is for; ordering by code is ordering by an accident of the sort program's numbering. `Code` exists for comparing two charts side by side. |
| `CategoryCap` | `data-tchmi-category-cap` | number | `10` | How many categories before the rest become `Other`. Matches the categorical palette's own cap, so a chart never shows a bar in a color the map could not have used. |
| `MapTimestamp` | `data-tchmi-map-timestamp` | string \| null | `null` | When the map was **measured**, if you can supply it. Identical to the tile's attribute of the same name, so one symbol drives both. Bound, the header says `measured`; absent, `received`. |

### SubstrateMapFilterBar

Four attributes, all of them the map's own — `SpatialFilter`, `SpatialFilterRadius`, `FieldView` and
`HighlightFromSeverity` — with the same names, types and schemas, so one symbol binds to both. They
are described with the map's [filter attributes](#filter-attributes); what the bar does with them is
in [Driving the filters from a bar](#driving-the-filters-from-a-bar).

### SubstrateMapBase, inherited by the map, the tile and the chart

Declared on the base, so every control that draws a map has them. The filter bar draws none and does
not.

| Attribute | HTML attribute | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `NoDataImage` | `data-tchmi-no-data-image` | string \| null | `null` → the shipped `NoData.svg` | Image for "no data". Any format the browser renders. Scaled to **contain** the drawing area and centered; an image with a different aspect ratio is letterboxed, never stretched. Recommended at least **512 px on the long edge at a ratio near 6:5** — the shipped SVG is 252 × 213.3, and a raster rendered larger than its own size looks soft on a 4K panel. |
| `NoDataImageDark` | `data-tchmi-no-data-image-dark` | string \| null | `null` → the shipped dark variant | The same for Base-Dark. A separate file rather than a CSS filter: `filter: invert()` rotates hue and turns a blue accent orange, while the shipped variant mirrors lightness in OKLCH and keeps every hue. |
| `NoDataText` | `data-tchmi-no-data-text` | string \| null | `null` | One line under the image. `null` draws no line at all rather than an empty one. |

---
## Theming

Colors and fonts are read at render time from CSS custom properties on the control,
each with a hard-coded fallback baked into the control. The shipped values live in
`Themes/Base/Style.css` (light) and `Themes/Base-Dark/Style.css` (dark); override any
of them in your own theme to restyle the control.

| Variable                              | Controls |
| ------------------------------------- | -------- |
| `--substratemap-background`           | Canvas background behind the substrate. |
| `--substratemap-body-color`           | Substrate outline fill (the body). |
| `--substratemap-edge-color`           | Substrate outline stroke (the edge). |
| `--substratemap-selection-color`      | Selection highlight (the ring on selected Items and cells) and the origin marker. |
| `--substratemap-status-unknown`       | Fallback fill for a status (or grid-cell quality) not otherwise resolved. |
| `--substratemap-bin-pass`             | Per-quality default fill for a grid cell whose bin quality is `pass` and whose bin code is not named by `StatusColorMapping`. |
| `--substratemap-bin-fail`             | Per-quality default fill for a grid cell whose bin quality is `fail` and whose bin code is not named by `StatusColorMapping`. |
| `--substratemap-identity-font-family` | Font family of the substrate-identity label. |
| `--substratemap-identity-font-size`   | Font size of the substrate-identity label. |
| `--substratemap-identity-font-weight` | Font weight of the substrate-identity label. |
| `--substratemap-identity-color`       | Text color of the substrate-identity label. |
| `--substratemap-label-font-family`    | Font family of the on-canvas item labels. |
| `--substratemap-label-font-size`      | Font size of the on-canvas item labels. |
| `--substratemap-label-font-weight`    | Font weight of the on-canvas item labels. |
| `--substratemap-label-font-color`     | Text color of the on-canvas item labels. |

## Diagnostic codes

Every warning this package logs begins with a code. Search a TwinCAT log for the code and
the line that raised it is the one you have found; the message after the colon names the
attribute, value or document element involved.

<!-- DIAGNOSTICS:BEGIN -->
**29 codes.** Generated from the sources; every one is emitted at the head of a
log message, so searching a TwinCAT log for the code finds the line that raised it.
The message itself names the attribute, value or element involved; the two columns
below say what usually causes it and what to do about it.

| Code | Raised by | Likely cause | What to do |
|---|---|---|---|
| `E142_AGGREGATION_REDUCER_IGNORED` | SubstrateMap | A valueField overlay owns the fill, and `AggregationReducer` reduces bin severity — two rules for one color. | Drop the valueField role, or accept that the reducer does nothing while it is bound. Both are legitimate; the map will not guess. |
| `E142_BIN_QUALITY_UNMAPPED` | SubstrateMap | A `BinCode` declares a `BinQuality` that is neither `Pass` nor `Fail`, the only two E142 reserves. | Fix the producing system. The cell is drawn as unknown, so a map full of unknowns with this warning means a whole vocabulary is wrong, not one bin. |
| `E142_BIN_SEVERITY_PRIORITY_IGNORED` | SubstrateMap | A code in the priority list has a `BinQuality` that resolves to pass, and a pass cannot outrank a fail. | Either correct the document's `BinQuality`, or remove the code from the list. The list is ignored entirely while this holds — not just that entry. |
| `E142_BIN_SEVERITY_PRIORITY_UNUSED` | SubstrateMap | `BinSeverityPriority` names a bin code the bound document does not contain. | Harmless if the list is shared across recipes. If it is not, the code is a typo or the wrong document is bound. |
| `E142_DEVICEDATA_ADDRESS_CONFLICT` | SubstrateMap | A `<DeviceData>` record carries a LID and an X/Y that name different cells. | Fix the producer. As with transfers, the map places neither: a record that contradicts itself has no position. |
| `E142_DEVICEDATA_OVERLAY_NOT_FOUND` | SubstrateMap | No `DeviceDataMap` overlay carries the requested name. The message lists the ones that do. | Take a name from that list, or leave the attribute unset to use the first available. |
| `E142_DEVICEDATA_UNPLACEABLE` | SubstrateMap | A `<DeviceData>` record resolved to no cell of this grid. | Usually the wrong document pair. Check the substrate id and the layout match the map's. |
| `E142_DEVICEID_ADDRESS_CONFLICT` | SubstrateMap | A `DeviceIdMap` `<Id>` entry carries a LID and an X/Y that name different cells. | Fix the producer. The entry is dropped rather than guessed at. |
| `E142_DEVICEID_UNPLACEABLE` | SubstrateMap | A `DeviceIdMap` `<Id>` entry resolved to no cell of this grid. | Check the id map is the one for this substrate. Device ids are per-layout and do not transfer between them. |
| `E142_FILTER_NOT_APPLICABLE` | SubstrateMap | The chosen `SpatialFilter` has no meaning on the chosen `FieldView` — averaging filters need a scalar field, ordering filters need ranked bins. | Change one of the two. The filter bar grays the illegal pairs and says why in its tooltip; this warning is what a direct attribute write gets instead. |
| `E142_JSON_BINARY_VERSION_TOO_OLD` | E142Json | The document uses the binary payload form but declares a `$version` from before it existed. | Raise `$version` in the producer. The payload is parsed anyway; the declaration is what is wrong. |
| `E142_JSON_UNKNOWN_MEMBER` | E142Json | The document contains member names this format does not define. They are listed in the message. | Usually a typo — a misspelled member is silently ignored rather than applied, so a setting that seems not to work will appear here. |
| `E142_JSON_VERSION_AHEAD` | E142Json | The document declares a `$version` newer than this engine implements. | Parsed anyway — a later envelope adds members and unknown ones are ignored. Update the package if the document relies on something new. |
| `E142_LID_DUPLICATE` | SubstrateMap | The document names a location more than once. The first cell carrying each repeated LID is kept. | Check the producing system's addressing. A duplicate LID usually means two records were merged without re-keying. |
| `E142_MAP_INPUT_OVERRIDDEN` | SubstrateMap | Two of the three map inputs were written; the most recent wins and the other is now dead. | Bind one. If both are bound deliberately — a live feed and a fallback — clear the one you are not using to `null` rather than leaving it stale. |
| `E142_OVERLAYS_DECORATION_NOT_FOUND` | SubstrateMap | An overlay named as decoration is not in the document. | Check the spelling, or remove the entry. Decorations are optional by design, so a missing one is a configuration error rather than a data error. |
| `E142_OVERLAYS_ENTRY_INVALID` | SubstrateMap | An `E142Overlays` entry has no usable `@MapName`, which is half of the key that finds an overlay. | Give every entry a name. An entry without one cannot be matched to anything and is dropped. |
| `E142_OVERLAYS_MULTIPLE_BASE` | SubstrateMap | More than one overlay claims role `base`, and one overlay owns the cell fill. | Choose one. The others are probably `decoration` — that role draws over the base instead of replacing it. |
| `E142_OVERLAYS_MULTIPLE_VALUE_FIELD` | SubstrateMap | More than one overlay claims role `valueField`, and a fill has one meaning. | Choose one. A second measurement wants a second map beside the first, not a second fill in the same cells. |
| `E142_OVERLAYS_OVERRIDES_SINGLE` | SubstrateMap | `E142Overlays` and `E142OverlayName`/`E142OverlayVersion` are both bound — two ways of selecting one overlay. | Use one. `E142Overlays` is the richer form; the name/version pair is the shorthand for a single overlay. |
| `E142_OVERLAYS_VALUE_FIELD_NOT_FOUND` | SubstrateMap | The overlay named as the value field is not a renderable `BinCodeMap` in this substrate map. | Check the name and version against the document. An overlay with no `BinCodeMap` carries no values to color by. |
| `E142_REFERENCE_GEOMETRY_MISMATCH` | SubstrateMap | The reference map and the bound map are different sizes, so no cell corresponds to another. | Bind a reference from the same layout. Comparing a 5-inch to a 6-inch map is not a resolution problem, it is a different substrate. |
| `E142_REFERENCE_NOT_APPLICABLE` | SubstrateMap | `ReferenceMode` and a value field both color the cell, and only one can. | Unbind the value field, or set `ReferenceMode` to `None`. Which one depends on whether you are comparing lots or reading a measurement. |
| `E142_TOUCH_TARGET_CLAMPED` | SubstrateMap | `TouchTargetSize` was set below the WCAG 2.2 floor for a touch target. | Raise the value, or leave it: the map has already clamped it and is drawing at the floor. Only silence the warning by asking for a legal size. |
| `E142_TRANSFER_ADDRESS_CONFLICT` | SubstrateMap | A `<T>` element carries a TID and a TX/TY that name different cells — the document disagrees with itself. | Fix the producer. The map trusts neither: an element that cannot say where it is does not get placed. |
| `E142_TRANSFER_TARGET_COLLISION` | SubstrateMap | Two transfers target the same cell. | Later transfers to a cell are dropped. If they are meant to be a sequence, the map shows a snapshot and needs one document per state. |
| `E142_TRANSFER_UNPLACEABLE` | SubstrateMap | A `<T>` element resolved to no cell — its TID is not one the map names, and its TX/TY is outside the grid. | Check that the transfer document and the map document describe the same substrate. This is the usual symptom of a mismatched pair. |
| `E142_VIEW_TRANSFORM_DEGENERATE` | SubstrateMap | The matrix has a zero determinant, so it collapses the map to a line or a point. | Check `a*d - b*c`. A zero row or column, or a scale of 0, is the usual cause — often a rotation built with `sin`/`cos` in degrees where radians were meant. |
| `E142_VIEW_TRANSFORM_INVALID` | SubstrateMap | `ViewTransform` is not six finite numbers — usually a short array, a string, or a `NaN` from an unbound symbol. | Bind six numbers `[a, b, c, d, e, f]`. If the source is a PLC symbol, check it is initialized: an unwritten REAL arrives as `NaN`. |
<!-- DIAGNOSTICS:END -->
