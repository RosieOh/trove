# Homebrew cask for a personal tap (RosieOh/homebrew-tap → Casks/trove.rb).
# `scripts/update-cask.mjs <version>` fills in `version` and both `sha256` values from the
# release assets. Until builds are notarized, users install with `--no-quarantine`
# (see docs/release.md); a notarized build drops that note.
cask "trove" do
  arch arm: "arm64", intel: "x64"

  version "0.6.0-beta.3"
  sha256 arm:   "REPLACE_WITH_ARM64_DMG_SHA256",
         intel: "REPLACE_WITH_X64_DMG_SHA256"

  url "https://github.com/RosieOh/trove/releases/download/v#{version}/Trove-#{version}-mac-#{arch}.dmg"
  name "Trove"
  desc "Local search and archive for Claude Code history"
  homepage "https://github.com/RosieOh/trove"

  livecheck do
    url :url
    strategy :github_releases
  end

  depends_on macos: ">= :monterey"

  app "Trove.app"

  # The vault DB and its backups are the only copy of archived sessions: `zap` lists them so
  # `brew uninstall --zap` is a deliberate choice, never part of a plain uninstall.
  zap trash: [
    "~/Library/Application Support/Trove",
    "~/Library/Preferences/dev.trove.app.plist",
    "~/Library/Saved Application State/dev.trove.app.savedState",
  ]
end
