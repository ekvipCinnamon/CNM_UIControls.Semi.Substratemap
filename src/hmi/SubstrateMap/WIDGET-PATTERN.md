# WIDGET-PATTERN.md

**How to give a control a dashboard widget.**

Written from the delivered code in this package, not from the specification that asked for it. Where
the two disagree, the code is what shipped.

The goal behind it: every control in the house eventually gets a widget, so dashboards become
possible. A convention does not spread from one instance — it spreads from something written down.

**The parts that turned out to be wrong here are the parts most worth passing on**, so the mistakes
are in the text rather than in an appendix. Each one cost a task to find.

---

## 1. What a widget is, in numbers

Measured in this package:

| Control | Attributes | Lines of TS | Extends |
|---|---:|---:|---|
| `SubstrateMap` — the full control | 68 | 5131 | `SubstrateMapBase` |
| `SubstrateMapWidget` — the tile | **9** | **1066** | `SubstrateMapBase` |
| `SubstrateMapBinChart` — the chart | **7** | **997** | `SubstrateMapBase` |
| `SubstrateMapFilterBar` — the driver | **4** | **523** | `TcHmiControl` |

**A widget is an order of magnitude smaller than the control it summarises.** If yours is not, it is
not a widget — it is a second copy of the control with a smaller default size, and it will need every
fix the original needs, twice.

Keep the attribute count in single digits. Nine was reachable for a tile that shows a map, an
identity, a yield figure, an age and a histogram flag. If you are at fifteen, something on the list
belongs to the full control.

---

## 2. Extend the base. Do not wrap the control.

The temptation is to build the widget out of the control you already have: hold one, forward the
attributes you want, hide the rest.

**Do not.** Forwarding means two attribute lists to keep in step forever, and the first attribute
anyone forgets is silently missing rather than a compile error.

Extend whatever base the control extends. Here that is `SubstrateMapBase`, which owns the canvas, the
device-pixel sizing, the `ResizeObserver`, the theme read, the teardown and the empty state. A tile
gets all of it and pays for none of it.

### Extend the base only if you draw the same kind of thing

`SubstrateMapFilterBar` extends `TcHmiControl` instead, because it renders no map. Inheriting canvas
sizing and a resize observer for a row of `<select>` elements is machinery it would pay for on every
frame and never use.

**The test is not "is it related" but "does it draw what the base draws".**

---

## 3. The hooks, and which ones you must fill

The base in this package exposes seven extension points. The split between *abstract* and *default* is
a judgement worth copying:

| Hook | Kind | Filled by |
|---|---|---|
| `__syncScene()` | abstract | all three |
| `__composeIdentity()` | abstract | all three |
| `__raiseSelected(payload)` | abstract | all three |
| `__drawOverlay(ctx, w, h, colors)` | default: nothing | tile, chart |
| `__hasContent()` | default: `__sceneGrid !== null` | chart |
| `__hasLastKnown()` | default: `false` | tile |
| `__staleAfterSecondsForTimer()` | default: `null` | tile |

**Abstract when omission is a bug; default when omission is the common case.**

`__composeIdentity` is abstract because every control has an answer and forgetting to give one is a
defect — an unlabelled control is a defect nobody notices. `__drawOverlay` is a default because three
of four controls want nothing drawn over the finished frame, and an abstract hook would make each of
them write an empty method to say so.

Getting this backwards costs either noise or silence, and silence is the expensive one.

---

## 4. Consume the parent's pipeline. Do not reimplement it.

A widget shows the same data as the control. Every number it derives independently is a number that
can disagree.

In this package the widget:

- builds its `GridModel` through the **same normaliser, builder and placement function** the control
  uses;
- takes its colours from `binStatistics`, which carries the colour **the render path paints**;
- lets the base **measure saturation and choose the reducer**, and names no reducer anywhere in its
  own source.

### Two failures worth the space

**A plausible reimplementation is still a reimplementation.** The tile first passed a *unit placement*
to `buildGridModel`, reasoning that a tile fills its box and has nothing for a placement to express.
The reasoning was coherent. A placement is not about fit — it is about which way is up. The tile drew
the wafer flipped and offset: 27 885 of 33 655 pixels differed under an identical matrix, while the
cells and the bin table were **byte-identical**. Everything about the data agreed and the geometry did
not.

**A shortcut both sides take looks like agreement.** The chart omitted the categorical colour fallback
that the map applies. Its assertion — *every colour matches the map's colour for the same code* —
passed, because the fixture declared `Pass` and `Fail`, quality colouring wins whenever a quality is
present, and both sides took the same shortcut. A map with eight unqualified codes rendered eight
distinct colours on the wafer and eight identical greys in the bars. **A picture found it; no
assertion did.**

If you assert that two things agree, also assert **how many distinct values there were to agree on**.

---

## 5. Registration is more places than you think

A control is not registered by existing. In this package it takes **six**:

1. the control folder itself — descriptor, template, stylesheet, tsconfig
2. `Manifest.json` — a `Control` entry under `modules`
3. the Visual Studio project — one `Content` entry per shippable file
4. the descriptor gate's control list
5. the README gate's descriptor list
6. the `tsc` line, in the build script **and** in the per-task gate list

Miss any and the failure is silent in a specific way: a control absent from `modules` **does not appear
in the engineering tool at all**, and one absent from the gate script is never typechecked. Both fail
on somebody else's machine.

### The check that could not check itself

Items 4 and 5 were **hard-coded lists**, and a list cannot catch its own omission: removing a control's
line stops it being checked and every gate stays green. Measured — four registrations removed one at a
time, four times nothing went red.

The fix is to **discover** rather than list. Both tools now read `Controls/*/Description.json` from the
filesystem, and a third direction checks the two sites nothing else reads.

The same shape appeared a third time in the mutation harness, whose emit loop held three project paths
while five existed — so mutating the fifth control's source never rebuilt it and four cases reported
MISSED against stale output.

**Any list of the things you check is a list that will fall behind the things there are.**

---

## 6. The four states a widget must distinguish

A widget shows little or nothing far more often than the full control does — it is small, it is on a
dashboard, and its feed is somebody else's problem. These are not interchangeable:

| State | When | What to show |
|---|---|---|
| `data` | bound and readable | the data |
| `stale` | the feed stopped, and something rendered before | **the last thing that worked**, with its age |
| `demo` | nothing bound, sample content switched on | the sample, **marked as a sample** |
| `nodata` | nothing bound, no sample | an image that says so |

Fixed precedence, top to bottom.

**A fifth case is not on the list and matters most:** data that arrived and is *empty*. A map of only
null cells is `data` — something came — and saying *nothing was bound* would hide a real problem. The
chart says `1600 cells, none carries a bin`, and the **count** is what makes it actionable.

### Do not draw an empty coordinate system

A chart with no data must not draw bare axes. An empty axis says *zero* — a measurement of nothing —
and nobody made that claim. Draw the explanatory image instead.

### Two mistakes here

**The chart reported `nodata` with bars on screen**, for one task, and the base drew the no-data image
underneath them: a picture saying *there is nothing here* behind a picture of the something. The base
asked *is a scene grid pushed?*, and a chart counts a lattice it never pushes. The fix was one hook.

**The assertion that missed it tested the easy half.** It checked `nodata` for an *unbound* chart and
never asked what a *bound* one said. **A state machine needs its states asserted as a set**, because
each one alone is satisfiable by a constant.

---

## 7. A widget that cannot say how old its data is should not be built

This is the rule that justifies the rest.

A dashboard tile is the one place a frozen value is genuinely dangerous. It looks exactly like a
healthy one — same colours, same shape — and **nobody clicks a tile**, so there is no interaction to
reveal it. The full control gets looked at; a tile gets glanced at.

So a widget shows, unconditionally and with no attribute to switch it off:

- **when** the data is from — a local time with its timezone abbreviation, because an operator does
  not convert UTC in their head;
- **which clock** that came from — *measured* if the payload carried a timestamp, *received* if it is
  merely when it arrived. These are different facts, and a map that arrived a second ago may describe
  a wafer measured this morning.

### Staleness is the absence of an event, and that is the whole difficulty

Everything else in a control is observer-driven: data by binding, size by `ResizeObserver`, theme by
the framework. **There is no timer, and there should not be** — except here.

**You cannot observe something not happening.** This package shipped a stale-marking feature whose
warning was drawn during a render, and a render happens on new data — so on a dashboard where a feed
had died, nothing triggered one. *The warning that a feed is dead could only appear while the feed was
alive.*

The assertion that missed it constructed two tiles, one pre-aged, and rendered both on the spot. Every
word of it was true and the feature did not work. **An assertion that constructs the end state cannot
discover that nothing reaches it.** Let a clock run.

### Derive the check rate; do not pick one

A takt time of fifteen minutes per substrate and a printer at 1.2 seconds are three orders of
magnitude apart. Polling every second is waste on the first and useless on the second, and no constant
serves both.

**The author has already told you the timescale** by setting the staleness threshold:

```
interval = clamp(threshold / 10, 1 s, 60 s)
```

| Takt | Threshold | Interval | Late by at most |
|---|---|---|---|
| 15 min | 900 s | 60 s (ceiling) | 6.7 % |
| 15 s | 45 s | 4.5 s | 10 % |
| 1.2 s | 5 s | 1 s (floor) | 20 % |

**Nothing runs when no threshold is set**, so the cost lands only where the feature was asked for. No
new attribute — the one the author must set anyway carries the information.

---

## 8. A widget is a dead end unless it can be left

A tile that shows a wafer and offers no way to open it is worse than no tile: it raises a question it
cannot answer.

Raise one event, on a click anywhere, carrying enough to open the full view — the identity, the state,
the age and its source, and a summary in the **same shape** the full control returns, so a handler that
reads one already reads the other.

**No cell-level hit test.** At 200 px a die is a fraction of a pixel and a coordinate read off one is a
guess dressed as a fact. The widget is one target; a dashboard that wants a cell opens the control.

**A widget showing nothing raises nothing.** An event carrying nulls makes every handler check what the
control already knows. A **stale** widget does raise — someone is looking at a wafer and wants to open
it — and the payload says it was stale.

---

## 9. Bind data, not a sibling control

A widget takes **the same data attributes the control takes**, bound by the author. Not a reference to
a sibling by id.

An id coupling points silently at nothing the moment someone moves the control to another page, and the
failure reads as *the widget is empty*. A binding of its own **degrades** — the document is parsed
twice — rather than corrupting. Measured 2026-08 on one machine with a 600 x 600 `Ascii` map:
~3.3 ms per control per data update, so a control, a tile and a chart on one symbol cost ~10 ms when
data changes. Per update, not per frame — and re-measure on your own hardware before treating either
figure as a budget.

One symbol driving several controls is the intended shape. Two things to know:

- **One writer, many readers is fine.** Two controls writing the same symbol is not — last-writer-wins,
  and with two-way bindings a loop.
- **Two symbols can arrive out of order**, so a widget can briefly show new data with an old
  timestamp. Harmless when the age is displayed coarsely; not harmless if you compute something from
  the pair.

---

## 10. Themes: reuse the control's variables

Every colour in a widget is the control's colour. A widget with its own palette means **the same datum
changing colour when it moves from a dashboard to a full view**, which is the one thing a colour-coded
display must never do.

Set the **same CSS variable names to the same values** under the widget's own selector. A per-control
theme model gives you no ancestor to inherit from, so the values are duplicated — and a gate must
compare them, because a duplication two minutes old had already drifted here by five units of grey.

**Colours must agree. Sizes need not** — a 200 px tile deliberately sets a smaller label than a
full-size view. A colour that differs is a lie about the data; a size that differs is a layout
decision. A rule stated as *shared names must agree* is broader than the reason for it.

Add a variable of your own only where the widget genuinely needs one. Here that was exactly one: the
stale marking, which is a **status** signal rather than a data colour. It had been sharing the outline
colour, and re-theming the outline would have silently re-themed the warning.

---

## 11. Mark the widget's state changes outside the data

When a widget needs to say something about itself — stale, degraded, disconnected — **do not tint the
data**.

Every colour in the display is already carrying meaning. A yellowed wafer reads as a yield problem, not
a freshness one. Use a border, a dash, a badge — something outside the data area entirely.

Asserted here as: crossing the stale threshold changes **zero** aggregate pixels and adds exactly one
dashed rectangle.

---

## 12. Reviewing a widget: the picture lies too

Widgets are visual, so at some point you will build a contact sheet and show it to someone. Two things
this package learned the hard way.

**A review artefact has failure modes of its own, and they look exactly like product defects.** Of
eight points raised in one review here, **three were the tool**: a hand-rolled bitmap font read as the
control's typography, an unantialiased rasteriser read as 8-bit rendering, and a fixture using
punctuation codes the sheet's font could not draw read as the legend omitting bin codes. All three were
the tool's own fixture and the tool's own font — recorded one task *after* writing down that this
happens.

**Draw the controls, never your idea of them.** Render through the real control and replay what it
recorded. A sheet that reconstructs the picture from the data agrees with the control exactly when the
two share a misunderstanding — and disagrees for reasons neither control owns, which is worse: one
column here came out a uniform grey disc beside an eight-coloured chart, and the cause was the tool.

**A default fixture exercises the default path.** The bug is on the third path, and nobody writes that
fixture by hand because it looks incomplete.

---

## 13. Checklist

Before calling a widget done:

- [ ] Fewer than ten attributes, and each one earns its place
- [ ] Extends the base, not the control — and only if it draws what the base draws
- [ ] Every derived value comes from the parent's pipeline, not a reimplementation
- [ ] Registered in all six places, and the registration is checked by **discovery**
- [ ] All four states distinguishable, plus *arrived and empty*
- [ ] Shows its age and which clock it came from, unconditionally
- [ ] Wakes to re-check staleness at a rate derived from the threshold, and not at all without one
- [ ] Raises one event carrying enough to open the full view
- [ ] Takes bound data, never a sibling's id
- [ ] Theme variables identical to the control's for every colour
- [ ] State changes marked outside the data area
- [ ] Teardown leaves no observer and no timer — asserted over repeated attach/detach cycles

And the two that are about the tests rather than the widget:

- [ ] Every rule asserted in **both** directions — the positive case is the one that constrains
- [ ] Anything time-dependent asserted by **letting time pass**, not by constructing the end state
