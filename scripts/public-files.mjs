const rootFiles = new Set([
  ".gitignore",
  ".gitattributes",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "workroom.config.example.json",
]);

// Fail closed: new file types and top-level locations need an explicit review.
export function publicFileProblem(path) {
  if (
    !path ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return "invalid archive path";
  if (
    /(^|\/)(?:\.data|node_modules|dist|coverage|prototypes|\.impeccable|\.agents|\.codex|\.claude|\.idea|\.vscode)(\/|$)/i.test(
      path,
    ) ||
    (/(?:^|\/)(?:DESIGN|PRODUCT|AGENTS)\.md$/i.test(path) &&
      path !== "docs/agents.md") ||
    /(?:screenshot|visual[-_]?qa|prototype|mockup|design)/i.test(path)
  )
    return "local state or design material";
  if (rootFiles.has(path)) return;
  if (/^(client|server|shared|tests)\/[\w./-]+\.(ts|tsx|css|html)$/.test(path))
    return;
  if (/^scripts\/[\w-]+\.mjs$/.test(path)) return;
  if (/^docs\/[\w./-]+\.md$/.test(path)) return;
  if (
    /^\.github\/(workflows\/[\w-]+\.ya?ml|dependabot\.ya?ml|CODEOWNERS)$/.test(
      path,
    )
  )
    return;
  if (
    /^public\/logos\/(jira|gitlab|outlook|servicenow)\.svg$/.test(path) ||
    path === "public/logos/SOURCES.md"
  )
    return;
  return "file is outside the reviewed public source allowlist";
}

export function publicTextProblem(text, path = "") {
  if (
    /\/(?:Users|home)\/[^/\s"'`]+\//.test(text) ||
    /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/.test(text)
  )
    return "machine-specific home path";
  if (
    /(?:^|\/)package(?:-lock)?\.json$/.test(path) &&
    /(?:file|link):(?:\.\.?\/|\/)/.test(text)
  )
    return "local file dependency";
}
