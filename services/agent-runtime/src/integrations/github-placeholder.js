function getGitHubPlaceholder() {
  return {
    connected: false,
    provider: "github",
    status: "placeholder",
    nextStep: "Connect GitHub OAuth or app credentials before opening issues, commits, or pull requests."
  };
}

module.exports = { getGitHubPlaceholder };

