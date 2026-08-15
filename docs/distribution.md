# Distribution and updates

Wayfinder prereleases are immutable standalone executables attached to GitHub Releases. A
prerelease tag such as `v0.1.0-rc.1` runs the full test, type, and formatting gates before
building these targets:

- macOS arm64 and x64
- Linux arm64 and baseline x64
- Windows arm64 and baseline x64

The release also contains `checksums.txt`, an SPDX JSON software bill of materials, and a
GitHub artifact provenance attestation. Native runners execute the matching x64 or arm64
binary and verify its embedded version, doctor command, completions, and man page before the
release job can run. Cross-compiled targets remain covered by compilation and the shared test
suite; their final native acceptance belongs in the disposable cross-platform acceptance pass.

## Install

The POSIX and PowerShell installers select an asset from the operating system and architecture,
download it over HTTPS, and verify its SHA-256 digest against the release checksum manifest
before replacing an existing executable. They do not require Bun.

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/JarenKempton/wayfinder-cli/main/scripts/install.sh | \
  WAYFINDER_VERSION=0.1.0-rc.1 sh
```

```powershell
$env:WAYFINDER_VERSION = '0.1.0-rc.1'
irm https://raw.githubusercontent.com/JarenKempton/wayfinder-cli/main/scripts/install.ps1 | iex
```

Prerelease installation requires `WAYFINDER_VERSION` (without a leading `v`) because GitHub's
`releases/latest` route excludes prereleases. Set
`WAYFINDER_INSTALL_DIR` to choose the destination. The installers refuse an unsupported
platform, a missing checksum, or a digest mismatch and leave the existing executable intact.

## Shell integration

Generate completion definitions directly from the installed executable:

```sh
wayfinder completions bash > ~/.local/share/bash-completion/completions/wayfinder
wayfinder completions zsh > "${fpath[1]}/_wayfinder"
wayfinder completions fish > ~/.config/fish/completions/wayfinder.fish
```

View the manual without installing a generated file:

```sh
wayfinder man | man -l -
```

## Update behavior

Wayfinder performs a bounded release metadata check after an interactive command and writes an update notice
to stderr only when a newer version is known. Normal command output remains stable. It never
downloads or installs an update automatically. Set `WAYFINDER_NO_UPDATE_CHECK=1` for offline or
managed environments. Network failures are silent and never fail the requested command.

## Maintainer prerelease procedure

1. Confirm the release commit passes `bun test`, `bun run typecheck`, and `bun run check`.
2. Create a SemVer prerelease tag whose version matches the intended embedded version.
3. Push the tag. The workflow builds, smoke-tests, hashes, inventories, and attests artifacts.
4. Verify provenance with GitHub CLI and verify the downloaded digest against `checksums.txt`.
5. Run the installer and command smoke suite on disposable macOS, Linux, and Windows hosts.

Publishing a tag or GitHub Release is a maintainer action; local builds do not publish anything.
