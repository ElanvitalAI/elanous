# Draft formula for a self-hosted tap (ElanvitalAI/homebrew-tap). Not published.
# Publishing is an outward action — it waits for the owner's approval (checklist EN11).
# Bump `url` and `sha256` together on every release:
#   curl -sL https://registry.npmjs.org/elanous/-/elanous-<v>.tgz | shasum -a 256
class Elanous < Formula
  desc "Local AI agent that takes one sentence through plan, code, tests, review and a PR"
  homepage "https://elanous.ai"
  url "https://registry.npmjs.org/elanous/-/elanous-0.2.6.tgz"
  sha256 "93f578162ed1f3123b77f69aa1d7aa7bd8b57284c481c80951dfb5a4be20e61d"
  license "Apache-2.0"

  # package.json engines: bun >= 1.3.5
  depends_on "bun"

  def install
    libexec.install Dir["*"]
    cd libexec do
      system Formula["bun"].opt_bin/"bun", "install", "--production"   # the npm tarball has no lockfile
    end
    (bin/"elanous").write_env_script libexec/"bin/elanous.mjs", PATH: "#{Formula["bun"].opt_bin}:$PATH"
    bin.install_symlink bin/"elanous" => "eln"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/elanous --version")
  end
end
