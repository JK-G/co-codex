// What a session may reach. The sandbox is fixed when Codex starts a thread, so co-codex reads
// the policy Codex reports back and warns when a task looks like it needs the network.

export const SANDBOXES = ["danger-full-access", "workspace-write", "read-only"];

// The thread/start (or thread/resume) reply's sandbox policy as { sandbox, network }.
// Without a policy in the reply (older Codex) the requested mode stands and network is unknown.
export function sandboxOf(policy, requested = null) {
  switch (policy?.type) {
    case "dangerFullAccess": return { sandbox: "danger-full-access", network: true };
    case "workspaceWrite": return { sandbox: "workspace-write", network: !!policy.networkAccess };
    case "readOnly": return { sandbox: "read-only", network: !!policy.networkAccess };
    case "externalSandbox": return { sandbox: "external", network: policy.networkAccess === "enabled" };
    default: return { sandbox: requested, network: requested === "danger-full-access" ? true : null };
  }
}

// The thread/start overrides for --network: workspace-write plus network access, through the
// same config key Codex reads from config.toml ([sandbox_workspace_write] network_access).
export const networkConfig = () => ({ config: { sandbox_workspace_write: { network_access: true } } });

// Command-like phrases that mean a task goes online, English and Polish. Only commands and
// deploy phrasing: a brief that mentions a "Download now" button or an "install screen" is not
// a networked task. Letter-aware edges, since \b does not know Polish letters.
const PHRASES = [
  "(?:npm|pnpm|yarn)\\s+(?:install|i|add|publish)", "pip3?\\s+install", "cargo\\s+install", "git\\s+(?:push|pull|clone)",
  "curl", "wget", "deploy\\s+(?:to|the)", "wdr[oó][zż]\\p{L}*", "codex\\s+sites", "sites\\s+project", "publish\\s+(?:to|the\\s+site)",
];
const NETWORK_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${PHRASES.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
export function networkHints(text) {
  const hits = new Set();
  for (const [phrase] of String(text ?? "").matchAll(NETWORK_RE)) hits.add(phrase.replace(/\s+/g, " ").toLowerCase());
  return [...hits];
}
