# SubstrateMap

A TwinCAT HMI (TE2000) control package that draws SEMI substrate maps — wafers, panels and the other
SEMI substrate types — from SEMI E142 documents or a compact JSON grid, with selectable, status-colored
dies on the substrate outline.

| | |
|---|---|
| **Package** | `Ekvip.Cinnamon.Semi.SubstrateMap`, version 5.0.0.0 |
| **Toolbox** | `Cinnamon SEMI` |
| **Controls** | `SubstrateMap`, `SubstrateMapWidget`, `SubstrateMapBinChart`, `SubstrateMapFilterBar` |
| **License** | Apache-2.0 — [LICENSE.txt](src/hmi/SubstrateMap/LICENSE.txt) |

**Using the controls?** Start with the [product README](src/hmi/SubstrateMap/README.md). It is the
same document the package ships.

**Changing them?** Start with [CONTRIBUTING.md](src/hmi/SubstrateMap/CONTRIBUTING.md#the-tree-you-develop-in-is-assembled).
The tests do not run from a plain clone: the product and the test harness live in separate
directories, and the working tree is the two overlaid.

---

## Which directory is which

| directory | what it holds |
|---|---|
| `src/hmi/SubstrateMap/` | **The package.** The controls, the rendering engine, the E142 schemas, the nuspec, the engineering project and the documents. Everything a consumer receives comes from here. |
| `src/hmi/Tests/` | **The test harness.** `package.json`, the checkers and generators in `tools/`, the framework stub the type-checks compile against, and the engine's suites and fixture corpus. Never shipped. |
| `src/hmi/Host/` | A TwinCAT HMI project that hosts the controls in views — `Desktop.view`, `GridData.view`, `Items.view`. **Not part of the solution:** add it temporarily when you want to see a control in a live view. |
| `src/doc/reference/` | Reference notes on individual E142 questions, kept beside the code rather than in it. |

## Documents

| document | read it when |
|---|---|
| [README.md](src/hmi/SubstrateMap/README.md) | you bind a control in a view — attributes, events, data formats, examples |
| [CHANGELOG.md](src/hmi/SubstrateMap/CHANGELOG.md) | you upgrade — what changed and what you must do |
| [ARCHITECTURE.md](src/hmi/SubstrateMap/ARCHITECTURE.md) | you need the shape — controls, base, engine, and which depends on which |
| [API.md](src/hmi/SubstrateMap/API.md) | something is wrong — where to set the breakpoint and what is called after it |
| [CONTRIBUTING.md](src/hmi/SubstrateMap/CONTRIBUTING.md) | you build, test or package it yourself |
| [MODEL-API.md](src/hmi/SubstrateMap/Helpers/SubstrateMapEngine/MODEL-API.md) | you call the engine's E142 model directly |
| [JSON-FORMAT.md](src/hmi/SubstrateMap/Schema/E142/JSON-FORMAT.md) | you produce E142 as JSON instead of XML |
| [tests/README.md](src/hmi/Tests/Helpers/SubstrateMapEngine/tests/README.md) | you add or run a test suite |
