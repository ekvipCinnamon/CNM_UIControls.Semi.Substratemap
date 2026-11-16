# TwinCAT HMI Framework – Typ-Stub (für Claude-Testinstanzen)

Dies ist **kein Mock**, sondern das Original-Paket
`Beckhoff.TwinCAT.HMI.Framework 14.5.1`, reduziert auf seine
TypeScript-Deklarationsschicht (`*.d.ts`). 2,4 MB statt 153 MB, bei
identischem Typ-Kontrakt — jeder Compilerfehler, der hiermit auftritt,
tritt auch im echten Build auf, und umgekehrt.

## Verwendung

Beide Archive ins **selbe Verzeichnis** entpacken, sodass diese Struktur
entsteht:

```
<root>/
├── Controls/            (aus WaferMap.tar)
├── Helpers/             (aus WaferMap.tar)
├── Packages/            (aus diesem Stub)
├── package.json         (aus diesem Stub)
└── typecheck.sh         (aus diesem Stub)
```

Dann:

```bash
npm install          # installiert exakt typescript@5.9.2
./typecheck.sh       # prüft alle sechs Projekte (--noEmit)
./typecheck.sh --emit  # echter Build inkl. .js/.d.ts/.map (wie noEmitOnError im HMI-Build)
```

Einzelnes Control:

```bash
npx tsc -p Controls/WaferMap/tsconfig.json --noEmit
```

## Warum das dem MSBuild-Build entspricht

`Microsoft.TypeScript.MSBuild 5.9.2` bettet denselben Compiler ein
(tsc 5.9.2) und konsumiert dieselben `tsconfig.json`-Dateien. Die
TwinCAT-Engineering-Umgebung generiert `tsconfig.json` aus
`tsconfig.tpl.json`, indem sie `$(Beckhoff.TwinCAT.HMI.Framework).InstallPath`
durch den NuGet-Installationspfad ersetzt — die im WaferMap-Archiv
mitgelieferten `tsconfig.json` sind bereits aufgelöst und zeigen auf
`../../Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1/runtimes/native1.12-tchmi/`.
Genau dort liegt dieser Stub.

## Inhalt / bewusste Auslassungen

Enthalten: alle 103 `.d.ts` des Framework-Pakets (globaler `TcHmi`-Namespace,
`dist/API/*`, System-Controls wie `TcHmiControl`, JQuery-Typen) sowie die
Beckhoff-Lizenztexte (`Legal/`).

Nicht enthalten (vom TypeScript-Build nicht referenziert):
- sämtliches Runtime-JS, CSS, Icons, Themes, Schemata, `.nupkg`
- die Pakete `Controls`, `BaseTemplate`, `Functions`,
  `Server.Engineering` — keine der sechs `tsconfig.json` referenziert sie.

Konsequenz: Testbar ist alles auf Typ-/Compile-Ebene. **Nicht** testbar
sind Laufzeitverhalten im Browser, `Description.json`/Schema-Validierung
und Server-Anbindung — dafür bräuchte es die HMI-Runtime, nicht dieses
Archiv.

## Eine Abweichung vom Original

`Lib/jQuery/` wurde zu `Lib/JQuery/` umbenannt. Beckhoffs
`dist/index/TcHmi.d.ts` → `Lib/jquery.d.ts` referenziert
`JQuery/JQuery.d.ts` (großes J); auf NTFS löst das auf, auf
case-sensitiven Dateisystemen (Linux-Sandbox) nicht — Symptom:
`TS2304: Cannot find name 'JQuery'` in jedem Control. Die Umbenennung
ist die einzige Änderung an Paketinhalten; keine Datei wurde inhaltlich
modifiziert.

## Lizenz

Die `.d.ts`-Dateien sind Beckhoff-proprietär (siehe
`Packages/.../Legal/License.txt`). Nur intern für Entwicklung/Test
verwenden, nicht weiterverteilen.
