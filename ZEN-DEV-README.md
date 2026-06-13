# Zen dev build — Windows setup notes

Repo must live at a SHORT path (`C:\_Dev\zen-browser`) — Firefox rejects a source path
longer than 62 chars on Windows (deep object paths would exceed MAX_PATH 260). The original
location under `Nextcloud_Personal\Documents\GitHub\…` was 69 chars and failed `configure`.

## Prerequisites (already installed on this machine)
- VS Build Tools 2022 + MSVC C++ (14.44), Windows 11 SDK 10.0.26100, C++ ATL
- Rust (rustup) 1.96 with x86_64-pc-windows-msvc
- MozillaBuild 4.2.1 at `C:\mozilla-build`
- `mach bootstrap` done — toolchains live in `C:\Users\Blake\.mozbuild` (survive repo moves)
- Defender exclusions added for `C:\_Dev\zen-browser` + `…\engine`

## Build environment gotchas
- `python3` in PowerShell hits a Microsoft Store stub. A real shim was created at
  `C:\Users\Blake\AppData\Local\Programs\Python\Python313\python3.exe`. Keep that dir first on PATH.
- 7-Zip must be on PATH for `surfer download` (`C:\Program Files\7-Zip`).
- mach goes QUIET (hides build errors) if it sees a coding agent. Clear these env vars before building:
  `CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE`.
- engine git is set to `core.autocrlf=false` / `core.eol=lf` (set locally in `engine/.git/config`).

## Building (surfer's `npm run build` ./mach dispatch is BROKEN on Windows — drive mach directly)
From `C:\_Dev\zen-browser`:
```powershell
# 1. (re)generate mozconfig only — surfer exits before its broken dispatch
$env:SURFER_MOZCONFIG_ONLY='1'; npm run build; Remove-Item Env:\SURFER_MOZCONFIG_ONLY
# 2. compile + run
cd engine
python3 ./mach build
python3 ./mach run --noprofile
```
`C:\_Dev\zen-build-run.ps1` automates all of the above with the right environment.

First clean build ≈ 30–45 min on this CPU. Incremental rebuilds after code changes ≈ 1–5 min.
