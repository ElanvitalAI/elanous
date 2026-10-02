# Draft formula for a self-hosted tap (ElanvitalAI/homebrew-tap). Not published.
# Publishing is an outward action — it waits for the owner's approval (checklist EN11).
# Bump `url` and `sha256` together on every release:
#   curl -sL https://registry.npmjs.org/elanous/-/elanous-<v>.tgz | shasum -a 256
# Name: the formula `elanous` is the CLI. The desktop app (DT1·DT2) goes in the same tap as the cask
# `elanous-desktop` — never a cask named `elanous` (`brew install elanous` would become ambiguous).
class Elanous < Formula
  desc "Local AI agent that takes one sentence through code, tests, review and a PR"
  homepage "https://elanous.ai"
  url "https://registry.npmjs.org/elanous/-/elanous-0.2.7.tgz"
  sha256 "af783a2490b142730c4ff4bf25df675ec50b2743b1ce2a3865db2680d0f8d81a"
  license "Apache-2.0"

  # package.json engines: bun >= 1.3.5
  depends_on "bun"

  def install
    libexec.install Dir["*"]
    cd libexec do
      system formula_opt_bin("bun")/"bun", "install", "--production" # the npm tarball has no lockfile
    end
    (bin/"elanous").write_env_script libexec/"bin/elanous.mjs", PATH: "#{formula_opt_bin("bun")}:$PATH"
    bin.install_symlink bin/"elanous" => "eln"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/elanous --version")
  end
end
