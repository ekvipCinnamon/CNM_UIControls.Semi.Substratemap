# Decision record — `SubstrateSide` and the coordinate mirror

**Task 33. No code changed.** This note records what the figures actually show, what follows from
them, and — more importantly — what does *not*.

Sources rasterised and read directly (not paraphrased from captions or from the OCR text layer):

| Figure | Page | Command |
|---|---|---|
| R2-16, R2-17 | 41 | `pdftoppm -jpeg -r 400 -f 41 -l 41 pdf/Scan-SEMI-E142-0225.pdf` |
| A2-1 (strip `OriginLocation`) | **23** | `pdftoppm -jpeg -r 400 -f 23 -l 23 …` |
| A3-1 (JEDEC tray) | 25 | `pdftoppm -jpeg -r 150 -f 25 -l 25 …` |

Page numbers were derived by counting form feeds in `pdf/txt/`, then confirmed by looking at the
rendered page. Note the task brief says Figure A2-1 is in Appendix 2 — it is, on page 23. The
reference to "Figure A2-1" on page 9 is a forward reference from the body text, not the figure.

---

## 1. What R2-17 actually shows

Two wafer diagrams, side by side, under the caption *"Example Where Translation Is Required as
SubstrateSide Differs"*.

**Both wafers are drawn identically as physical objects.** Each is a circle with the notch at the
**bottom**. Neither is rotated, and neither outline is redrawn — the difference between the two
panels is entirely in the coordinate annotation laid over the same shape.

| | left panel | right panel |
|---|---|---|
| wafer outline | circle, notch at bottom | circle, notch at bottom — *identical* |
| shaded origin cell | **upper-left** of the device array | **upper-right** of the device array |
| X arrow | points **right** | points **left** |
| Y arrow | points **down** | points **down** |

So the two frames differ by **reversal of X, with Y unchanged**: a mirror about the **vertical**
axis.

Each panel carries a block of attribute text above it (`SubstrateId`, `SubstrateSide`,
`OriginLocation`, `AxisDirection`). At 400 dpi the scan renders these legibly enough to identify
them as attribute assignments and to read `SubstrateSide = TopSide` / `BottomSide`, but the
`OriginLocation` and `AxisDirection` values are at the edge of what this scan resolves. **I have not
transcribed those two values as quotations**; the geometry above is read from the drawing itself —
the shaded cell and the arrowheads — which is unambiguous at this resolution.

### The contrast with R2-16 is what makes R2-17 readable

R2-16, immediately above, is captioned *"Example Where Translation Is Required as OriginLocation
Differs"*. (Both figures are translation-required cases; they isolate different causes.)

| | R2-16 left | R2-16 right |
|---|---|---|
| origin cell | upper-left | **lower-left** |
| X arrow | right | right |
| Y arrow | down | **up** |

R2-16's difference is a **Y** reversal; R2-17's is an **X** reversal. The pair is constructed so
that one figure varies `OriginLocation` and the other varies `SubstrateSide`, and they move
different axes. That is deliberate and it is the strongest evidence in the document about which axis
a side change is associated with.

---

## 2. Which axis, and does the figure settle it?

**The mirror in the figure runs about the vertical axis: X reverses, Y is preserved.**

Grading, split because the two questions have different answers:

- **What R2-17 depicts — `[A]`.** The shaded origin cell and the arrowheads are unambiguous in the
 rendered figure. There is no inference involved in stating that the left frame is upper-left /
 X-right and the right frame is upper-right / X-left over an identically drawn wafer.

- **Whether a *consumer* should therefore apply an X-mirror of its own when `SubstrateSide =
 BottomSide` — `[B]`, and I think the answer is actually "no".**

This second point is the substance of the note and the reason it is worth writing before any code.

**The figure shows the mirror expressed through `OriginLocation` and `AxisDirection`, which are
explicit attributes of the document.** The right-hand map does not say "I am the bottom side, infer a
flip" — it *states* an origin corner and an axis direction that already encode the flipped frame.
The parser reads those attributes and produces the mirrored placement without knowing anything about
sides.

Nothing in the schema couples the three. `SubstrateSide`, `OriginLocation` and `AxisDirection` are
three independent attributes of `SubstrateMapType`; a document may legally declare
`SubstrateSide="BottomSide"` with `OriginLocation="UpperLeft"` and `AxisDirection="DownRight"` —
byte-for-byte the left panel's frame — and `xmllint` accepts it. R2-17 is captioned *"Example"*, and
it is an example of what a *producer* should write, not a rule the reader may apply unilaterally.

**Consequence: a control that mirrored the grid on seeing `BottomSide` would double-flip any
document shaped like R2-17's right-hand panel** — the very document the standard offers as the model
of correct practice. The frame attributes would flip it once, and the control would flip it again.

So the decision this note records is: **`SubstrateSide` is descriptive, not transformative.** It says
which physical face the map addresses. The coordinate consequences of that face are carried by
`OriginLocation` and `AxisDirection`, and the control must apply those and nothing more.

---

## 3. How Appendix 2's combined codes bear on it

Appendix 2 (A2-1.4) defines `OriginLocation` for strips as **combined corner + side** codes:

```
1 = Upper right (UR) top side 6 = Upper right (UR) bottom side
2 = Upper left (UL) top side 7 = Upper left (UL) bottom side
3 = Lower left (LL) top side 8 = Lower left (LL) bottom side
4 = Lower right (LR) top side 9 = Lower right (LR) bottom side
```

Figure A2-1 draws both: a strip rectangle labelled *top side* with its four corners numbered 1–4,
and a second rectangle labelled *bottom side* with the same four visual corners numbered 6–9. Each
rectangle carries an asymmetric corner feature (a chamfer), and the feature sits on **opposite
horizontal ends** in the two drawings — consistent with the strip having been turned over about its
vertical axis, which is the same mirror R2-17 shows.

Three things follow, and they support the reading above rather than contradicting it:

1. **The corner names are view-dependent.** A2-1.3 states that Figure A2-1 *"defines what is meant by
 top side and hence bottom side. It also defines what is meant by upper, lower and left and
 right."* `quoted from E142-0225` "Upper left" means upper-left **as drawn on the side you are
 looking at**. It is not an absolute frame that a side flip then modifies — it is already relative
 to the side.

2. **Side and corner travel together in one value.** For strips, the factory does not pick a corner
 and separately declare a side; it picks one of eight codes that names both. That is the clearest
 statement in the document that the two are a single choice, and it is exactly why treating
 `SubstrateSide` as an independent transform would double-count.

3. **The gap at 5 is real.** There is no code 5; the numbering jumps 4 → 6. Nothing in the text
 explains it. It separates the top-side block from the bottom-side block, which is at least a
 mnemonic, but I have not found a statement of intent — `[C]` if anyone needs a reason.

Appendix 3 (JEDEC trays, Figure A3-1) lists **only** codes 1–4 — top side. A tray is a pocketed
carrier that is not read from underneath, so the bottom-side half of the vocabulary simply does not
arise. That asymmetry is worth noting because it shows the 1–9 scheme is a per-substrate-type
convention, not a universal one.

---

## 4. What happens to `ReferenceDevice/Position` under the mirror

Table 4 defines it: *"Offset of the center of a reference device in the X and Y directions from the
center of substrate."* `quoted from E142-0225` Type `XYDimensions`, read-only, optional.

The operative words are **"in the X and Y directions"** — the map's own X and Y, the ones
`OriginLocation` and `AxisDirection` define. `Position` is therefore already expressed in the frame
the document declares. Under the R2-17 pair:

- the left map's `Position.X` grows toward the drawing's right;
- the right map's `Position.X` grows toward the drawing's left;

and neither needs adjusting, because each is stated in its own frame. **No transformation is applied
to `Position` on account of `SubstrateSide`.**

The failure mode worth guarding against is *partial* application: mirroring the cell lattice while
leaving `Position` alone (or the reverse) would decouple the reference devices from the grid they
are supposed to register, and the symptom would be a small, plausible-looking misalignment rather
than an obvious error. Since this note concludes that neither is mirrored, the two stay consistent
by construction — but the engine's reference-device alignment
(`registerPlacementToReferenceDevices`) and the placement must always be fed from the same frame.

---

## 5. Rejected alternatives

**(a) Mirror the grid about X (flip Y) when `SubstrateSide = BottomSide`.**
Rejected on the figure. R2-16 is the Y-reversal case and it is captioned as an `OriginLocation`
difference, not a side difference. Choosing Y would contradict the one figure in the document that
isolates `SubstrateSide`.

**(b) Mirror the grid about Y (flip X) when `SubstrateSide = BottomSide`.**
The right axis, the wrong actor. This is the double-flip described in §2: applied on top of a
document that already states `UpperRight`/`DownLeft`, it returns the map to the top-side frame while
labelling it bottom-side. It would appear to work only on documents that declare `BottomSide` with a
*top-side* frame — that is, on non-conforming documents — and would corrupt conforming ones.

**(c) Rotate 180° instead of mirroring.**
Rejected on the drawing. A 180° rotation reverses **both** axes; R2-17 reverses X and leaves Y
pointing down in both panels. It is also physically wrong: turning a wafer over is a reflection, not
a rotation, and a reflection cannot be produced by rotating it in its own plane.

**(d) Infer the flip from the notch position.**
Rejected: both panels draw the notch at the bottom. The figure deliberately does not use the notch
as the carrier of the side information, and E142 has no notch/flat attribute to read.

**(e) Warn when `SubstrateSide = BottomSide` and the frame looks "top-sided".**
Rejected for now, and it is the one worth revisiting. There is no normative basis: any of the four
corners is legal on either side, and Appendix 2's own vocabulary admits all eight combinations. A
warning would fire on documents the schema and the appendices both permit. Recorded here rather than
implemented.

---

## 6. What this decides for the code

- `SubstrateSide` is **carried, not applied**. It round-trips (Tasks 12, 15) and is published to the
 view; it drives no coordinate transformation.
- The mirror a bottom-side map needs is already in `OriginLocation` / `AxisDirection`, which the
 existing frame code applies. Nothing new is required there.
- `ReferenceDevice/Position` is left in the document's frame, unmodified.
- If a later task wants a *rendering* affordance — "show me this map as it would look from the other
 side" — that is a view transform on top of the model, not a change to how the document is read, and
 it should be a separate opt-in attribute so that it cannot be confused with `SubstrateSide`.

**Grade summary:** what the figures depict, `[A]`. That `SubstrateSide` should not itself trigger a
transform, `[B]` — reasoned from the figures plus the independence of the three attributes in the
schema, and not stated in so many words anywhere in the document. The reasoning is above so it can be
attacked; if someone finds prose that says otherwise, this note is what should change first.
