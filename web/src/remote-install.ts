// Keep downloads and source review on the same immutable installer commit.
export const REMOTE_INSTALL_REVISION = "d0d35e92f3c8903690e47dff052e090572a9e088";
export const REMOTE_INSTALL_URL = `https://api.github.com/repos/gerayking/Mingle/contents/scripts/install-remote.sh?ref=${REMOTE_INSTALL_REVISION}`;
export const REMOTE_INSTALL_SOURCE = `https://github.com/gerayking/Mingle/blob/${REMOTE_INSTALL_REVISION}/scripts/install-remote.sh`;
export const REMOTE_INSTALL_COMMAND = [
  "(",
  "  set -eu",
  "  script=$(mktemp)",
  "  trap 'rm -f \"$script\"' 0",
  "  curl -fLS --proto '=https' --proto-redir '=https' \\",
  "    -H 'Accept: application/vnd.github.raw+json' \\",
  `    '${REMOTE_INSTALL_URL}' -o "$script"`,
  '  sh "$script"',
  ")",
].join("\n");
