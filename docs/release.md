# Release process

Trove ships as signed installers attached to a **GitHub Release**, which
also doubles as the [`electron-updater`](../electron/updater.ts) feed. There are
two ways to produce a release: the automated CI pipeline (recommended) and a
manual local build.

## Automated release (recommended)

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which builds on `macos-latest` (Apple Silicon and Intel `dmg`/`zip`), `windows-latest` (x64 NSIS) and
`ubuntu-latest` (x64 AppImage/deb) in parallel
and publishes every artifact to a single GitHub Release.

```bash
node scripts/assemble-changelog.mjs 0.7.0   # move changes/*.md into CHANGELOG.md as [0.7.0]
git add CHANGELOG.md changes
git commit -m "DOCS : 0.7.0 변경 기록을 모은다."
npm version 0.7.0          # bump package.json + create the v0.7.0 commit and tag
git push --follow-tags     # push the commit and the tag
```

The first command is the only time a release's fragments are read together, so read the new
section in `CHANGELOG.md` before committing and add an intro line if it needs one. It stops
without changing anything if a fragment is malformed, the version already has a section, or
nothing is pending. The commit comes first because `npm version` refuses a dirty tree.

What the workflow does per OS:

1. `npm ci`.
2. `npm run typecheck && npm run lint && npm test && npm run test:db` — a broken tag never ships.
3. `vite build` — the renderer, main, preload and worker bundles (`dist/`, `dist-electron/`).
4. `electron-builder --<platform> --publish always` — packages those bundles, uploads
   installers and the `latest*.yml` update metadata to the Release.

The Release is created as a **draft**; review it and hit publish. `latest-mac.yml`
/ `latest.yml` must be attached (they are, by the step above) or auto-update
won't see the new version.

### Pre-releases

A version with a pre-release part (`npm version 0.6.0-beta.1`) is published the same way.
electron-builder creates the GitHub Release as a **draft**. Once all three jobs have
uploaded, add the notes and publish it as a pre-release:

```bash
gh release edit v0.6.0-beta.1 --prerelease --draft=false \
  --notes-file docs/release-notes/v0.6.0-beta.1.md
```

Keep the notes in `docs/release-notes/` so every release's text is in the repository.

### Dry run

Before tagging, check that all three platforms still package:

```bash
gh workflow run release.yml -f publish=never   # or Actions → Release → Run workflow
```

A manual run defaults to `publish: never`. It builds the installers on macOS, Windows and
Linux and lists them in the job log. It creates no Release and uploads nothing, not even
an Actions artifact, because on a public repository an artifact is a download anyone can
fetch. `publish: always` publishes to a draft Release like a tag does.

## Manual local build

```bash
npm install
npm run build              # local artifacts only, no upload
```

To build **and** publish to GitHub Releases from your machine:

```bash
export GH_TOKEN=<token with repo scope>
npm run release            # electron-builder --publish always
```

Note: a local build only produces installers for the OS you run it on — macOS
notarization in particular requires building on a Mac. Use the CI pipeline for a
full three-platform release.

Artifacts (in `release/`), named `${productName}-${version}-${os}-${arch}.${ext}`:

- macOS — `.dmg` + `.zip` (zip is what electron-updater consumes)
- Windows — NSIS `.exe`
- Linux — `.AppImage` + `.deb`

## Before the first release

- App icons are still missing from `build/` (see `build/README.md`); without them the installer uses Electron's default icon.
- Whether to sign (and pay for it) depends on the distribution decision in [roadmap.md](roadmap.md). An unsigned GitHub *pre-release* is the zero-cost way to test demand.

## Signing & notarization

Unsigned builds still work but trigger **Gatekeeper** (macOS) and **SmartScreen**
(Windows) warnings, and **auto-update only runs on signed macOS builds**. The
workflow reads credentials from repository secrets; when they are absent the
build succeeds unsigned and notarization is skipped automatically.

| Secret | Platform | Purpose |
|--------|----------|---------|
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | macOS | Developer ID Application cert (base64 `.p12`) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS | Notarization (`notarize: true` is already set) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows | Code-signing cert (optional) |

See [`build/README.md`](../build/README.md) for how to obtain and export each
one, plus the app icons electron-builder expects.

## Auto-update

`electron-updater` checks the GitHub Release feed on a packaged, signed build. It is the app's only network request and can be turned off in Settings ([ADR-0005](decisions/0005-update-check-network-exception.md)).
Downloads happen in the background but **installing is always the user's choice**
(see [`electron/updater.ts`](../electron/updater.ts)) — a surprise restart
mid-search would lose the user's place. In dev or unsigned builds the updater is
skipped entirely.

## Homebrew Cask (outline)

1. Publish a signed DMG on **GitHub Releases** with a stable tag (`v0.1.0`).
2. Fork [Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask) and add
   `Casks/claude-vault.rb` with `version`, `sha256`, and `url` pointing to the asset.
3. Follow the [Homebrew Cask contribution guide](https://docs.brew.sh/Adding-Software-to-Homebrew#casks).
4. Until the cask is merged, users install via the DMG download from Releases.

## Versioning

Semantic versioning. The git tag must match `package.json` `version` — `npm version`
keeps them in sync automatically.
