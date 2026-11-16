#!/usr/bin/env bash
# Type-checks (default) or builds (--emit) every project the gate type-checks,
# against the Framework .d.ts stub in Packages/. Exit code != 0 if any fails.
#
# THE PROJECT LIST IS NOT WRITTEN HERE. It is read out of package.json's `gate`
# script, which is the one place the projects are maintained and which
# check-manifest already asserts is complete for every discovered control.
#
# A second copy is exactly how this file came to name WaferMap, DieMap and
# ComponentMap - three controls that have not existed since the rename - while
# the gate named the correct six. Nothing compared them, so the drift was
# invisible until someone ran the script (F-3, D-223).
#
# LF ONLY. A CRLF `#!/usr/bin/env bash\r` makes the kernel look for an
# interpreter named "bash\r", and `set -u\r` is an invalid option. .gitattributes
# pins *.sh to eol=lf and check-hmiextproj section 6 fails if any .sh carries a
# CR, because unlike .ts or .md a shell script has one legitimate ending and the
# interpreter, not the author, decides it.
set -u
cd "$(dirname "$0")"

MODE="--noEmit"
[ "${1:-}" = "--emit" ] && MODE=""

mapfile -t PROJECTS < <(node -e '
const fs = require("fs");
const gate = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts.gate || "";
const seen = new Set();
for (const m of gate.matchAll(/tsc -p ([^ ]+)\/tsconfig\.json/g)) { seen.add(m[1]); }
process.stdout.write([...seen].join("\n"));
')

if [ "${#PROJECTS[@]}" -eq 0 ] || [ -z "${PROJECTS[0]}" ]; then
    echo "typecheck.sh: no 'tsc -p <project>/tsconfig.json' found in package.json scripts.gate" >&2
    echo "typecheck.sh: refusing to type-check nothing and report success" >&2
    exit 2
fi

FAIL=0
for p in "${PROJECTS[@]}"; do
    printf '%-32s' "$p"
    if OUT=$(npx tsc -p "$p/tsconfig.json" $MODE 2>&1); then
        echo "OK"
    else
        echo "FAIL"
        echo "$OUT" | sed 's/^/    /'
        FAIL=1
    fi
done
exit $FAIL
