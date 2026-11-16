# Contributing

<!-- TOC:BEGIN -->
**Contents**

- [Prerequisites](#prerequisites)
- [The tree you develop in is assembled](#the-tree-you-develop-in-is-assembled)
- [Restore, build, test](#restore-build-test)
- [The three kinds of tsconfig](#the-three-kinds-of-tsconfig)
- [Where the `.nupkg` comes from](#where-the-nupkg-comes-from)
- [Generated files](#generated-files)
- [What the gates will tell you](#what-the-gates-will-tell-you)
- [Adding a control](#adding-a-control)
<!-- TOC:END -->

## Prerequisites

| | why |
|---|---|
| **Node 20 or newer** — 22 is what this is developed on | the suites run on `node --test`, and `npm run coverage` needs `--experimental-test-coverage`, which arrived in 20. The sources use lookbehind assertions and `??=`. |
| **TwinCAT XAE (TE2000)** | only to open the engineering project and to produce the `.nupkg`. Nothing in the test corpus needs it — the engine computes without the framework, and the suites stand in for the one global its bridges touch ([ARCHITECTURE.md](ARCHITECTURE.md#the-engine)). |

No global npm packages. Everything else comes from `npm install`.

---

## The tree you develop in is assembled

**This matters before anything else works.** The repository keeps the product and the tests apart:

```
src/hmi/SubstrateMap/     Controls, Helpers, Schema, the nuspec, the engineering project
src/hmi/Tests/            package.json, tools, FrameworkStub, and Helpers/SubstrateMapEngine/tests
```

The suites import `../../../Controls/…`, which from `src/hmi/Tests/Helpers/SubstrateMapEngine/tests/`
resolves to `src/hmi/Tests/Controls/` — **and that directory does not exist in the repository.** The
scripts in `package.json` likewise name `Controls/…` and `Helpers/…` relative to `src/hmi/Tests`.

So a working tree is the two halves overlaid. Make one:

```bash
cd src/hmi/Tests
ln -s ../SubstrateMap/Controls  Controls
ln -s ../SubstrateMap/Schema    Schema
ln -s ../SubstrateMap/Helpers/SubstrateMapEngine/*.ts  Helpers/SubstrateMapEngine/
```

On Windows, junctions rather than symlinks, from an elevated prompt:

```cmd
cd src\hmi\Tests
mklink /J Controls ..\SubstrateMap\Controls
mklink /J Schema   ..\SubstrateMap\Schema
```

`tools/check-as-shipped.mjs` performs the same assembly from the three delivery archives, which is why
it is the only check that can answer *"does this work as a package"* rather than *"does this work
here"*.

---

## Restore, build, test

Three commands, in this order, from the assembled tree:

```bash
npm install                 # restore
npm run tsconfig            # write the tsconfig.json files from their templates
bash typecheck.sh --emit    # build: type-check every project and emit the .js
npm run gate                # the gates
```

**`npm run gate` is the one that matters.** It type-checks every project, runs the test suites, the
consistency checkers and the linter, and it measures coverage while it tests. If it is green, the
change is shippable; if it is not, the failing check names the file and the reason. The lists are in
`package.json`; they are not repeated here, because a count in prose goes stale the day a check is
added.

Useful subsets while working:

| command | what it does |
|---|---|
| `npm test` | the suites alone — seconds, not minutes |
| `npm run lint` | ESLint over `tools/` and the suites, which have no type checking |
| `npm run check` | the consistency checkers without the suites |
| `npm run negatives` | breaks the code on purpose and requires each gate to catch its own case |

`npm run negatives` is slow and is not part of `gate`. Run it when you have **added or changed a
check**, because it is the only thing that proves a new check can fail.

---

## The three kinds of tsconfig

| file | tracked? | what it is |
|---|---|---|
| `tsconfig.tpl.json` | **yes** | the source of truth. Version-agnostic: it names the framework as `$(Beckhoff.TwinCAT.HMI.Framework).InstallPath`. |
| `tsconfig.json` | **no** | generated. The same file with that token replaced by the restored package's real, **versioned** path. |
| `tsconfig.base.json` | **yes** | the compiler options every project shares, so `strict` and the module settings are stated once. Every template `extends` it. |

The TwinCAT build performs that substitution, so ignoring `tsconfig.json` is right — it is build
output, and committing it would pin a framework version into the repository and produce a diff on every
upgrade.

**But the engineering tool is not the only thing that reads it.** `typecheck.sh` and every
`tsc -p …/tsconfig.json` in `npm run gate` read the generated file, and none of them writes it. On a
fresh clone that is the state a colleague lands in: XAE builds, the gate does not.

`npm run tsconfig` performs the same substitution without XAE. It finds the restored framework under
`Packages/` rather than assuming a version, and its output is byte-identical to the engineering tool's
for all seven projects.

**On Linux it also mends the framework.** The package's `Lib/jquery.d.ts` references
`JQuery/JQueryStatic.d.ts`; the directory it ships is `jQuery`. Windows does not tell the two apart,
Linux does, and the build then reports `Cannot find name 'JQuery'` in every control - a message that
names the wrong thing. `npm run tsconfig` follows the package's reference chain and, where a target
exists only under another letter case, adds a link with the name the reference wants. The shipped
directory is not renamed, because the runtime loads it by its shipped name. On Windows and macOS there
is nothing to link and the step does nothing.

`npm run doctor` walks the same chain without changing anything, and names a link that is due. The
root cause is Beckhoff's: the reference and the directory disagree in their own package.

---

## Where the `.nupkg` comes from

Building `SubstrateMap.hmiextproj` in TwinCAT XAE produces it. The project names
`SubstrateMap.nuspec`, and the nuspec is where the package id, the version, the dependency versions,
the icon and the file list live.

**Two things bite here, and both are gated now.** Every literal path the nuspec names must exist —
`<icon>images/logo.png</icon>` pointed at a file that was never committed, and `nuget pack` fails on
that. And every file the nuspec ships under `Controls`, `Helpers` or `Schema` must also be listed in
the `.hmiextproj`, or Visual Studio will not build it into the package.

`npm run check` catches both before the IDE does.

---

## Generated files

Several files are written by a tool and checked by the gate. **Edit the tool, not the file:**

| file | tool |
|---|---|
| the diagnostics table in `README.md` | `tools/diagnostic-register.mjs` |
| the `.localization` files | `tools/localization.mjs` |
| the diagrams in `ARCHITECTURE.md` | `tools/architecture.mjs` |
| the sequences in `API.md` | `tools/api-sequences.mjs` |
| the table of contents in each of the five documents | `tools/toc.mjs` |
| the six-column grid in `Desktop.view` | `tools/relayout-desktop.mjs` |
| `Helpers/SubstrateMapEngine/tests/README.md` | `tools/tests-readme.mjs` |

Each takes `--check` and the gate runs it that way. A hand-edit fails, with the command that would fix
it.

---

## What the gates will tell you

You do not need to remember the rules; the checks state them when they fire. The ones that surprise
people most often:

- **an attribute must be declared and read.** Declaring it in `Description.json`, storing it in a
  setter and never using it is a defect this package has shipped once.
- **a shipped document may only name paths the package carries**, and a shipped source may not cite
  the design history — those records are not distributed.
- **a control that does not select must say so.** `__selectionMode = 'none'` turns the pointer path
  off; suppressing only the drawing leaves a control maintaining a selection nobody is told about.
- **the overlay draws in CSS pixels and must set that transform itself.** A canvas arrives with
  whatever the last draw left on it, and at `devicePixelRatio` 1 a wrong transform is invisible.

---

## Adding a control

Copy the smallest existing one — `SubstrateMapFilterBar`, which extends `TcHmiControl` directly and
imports nothing from the engine. Then run `npm run gate` and let it list what is missing: the manifest
entry, the toolbox category, the descriptor, the template, the localization keys and the project
listing are each checked separately and each names itself.
