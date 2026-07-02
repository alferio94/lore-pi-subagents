import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const APPROVED_CHILD_MCP_ADAPTER_PACKAGE_NAME = "pi-mcp-adapter";
export const APPROVED_CHILD_MCP_ADAPTER_RELATIVE_PACKAGE_DIR = path.join(
  ".pi",
  "agent",
  "git",
  "github.com",
  "nicobailon",
  "pi-mcp-adapter",
);

interface PiPackageManifest {
  name?: unknown;
  pi?: {
    extensions?: unknown;
  };
}

export function resolveApprovedChildMcpAdapterExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const packageDir = resolveAdapterPackageDir(env);
  const manifestPath = path.join(packageDir, "package.json");
  let manifest: PiPackageManifest;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PiPackageManifest;
  } catch {
    return [];
  }

  if (manifest.name !== APPROVED_CHILD_MCP_ADAPTER_PACKAGE_NAME) {
    return [];
  }

  if (!Array.isArray(manifest.pi?.extensions)) {
    return [];
  }

  return normalizeExtensionEntries(packageDir, manifest.pi.extensions);
}

function resolveAdapterPackageDir(env: NodeJS.ProcessEnv): string {
  const homeDir = env.HOME || os.homedir();
  return path.join(homeDir, APPROVED_CHILD_MCP_ADAPTER_RELATIVE_PACKAGE_DIR);
}

function normalizeExtensionEntries(packageDir: string, entries: unknown[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(packageDir, trimmed);
    const relative = path.relative(packageDir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }

    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }

    if (seen.has(candidate)) continue;
    seen.add(candidate);
    resolved.push(candidate);
  }

  return resolved;
}
