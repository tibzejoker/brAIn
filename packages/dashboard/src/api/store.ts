/**
 * Marketplace / store endpoints. Split from client.ts to keep that
 * file under the 300-line lint cap and so anything store-related is
 * findable in one place.
 */
import { request } from "./request";

export interface StoreNodeStatus {
  name: string;
  package_name: string;
  repo: string;
  subpath: string;
  version: string;
  description: string;
  tags?: string[];
  has_ui?: boolean;
  needs_python?: boolean;
  needs_ollama?: boolean;
  installed: boolean;
  install_path: string | null;
}

export interface StoreInstallResult {
  status: "installed" | "already_present" | "failed";
  message: string;
  cloned_to: string | null;
  re_scanned_types: number;
}

export interface StoreCandidate {
  type_name: string;
  package_name: string;
  workspace: string;
  description: string;
  tags: string[];
  has_ui: boolean;
  created_by?: string;
  created_at?: string;
  registry_entry: {
    name: string;
    package_name: string;
    version: string;
    tags?: string[];
    description: string;
    has_ui?: boolean;
  };
}

export interface InstalledNodeUpdate {
  name: string;
  repo: string;
  localSha: string | null;
  pinnedSha: string;
  updateAvailable: boolean;
}

export function getStoreNodes(): Promise<StoreNodeStatus[]> {
  return request("/store/nodes");
}

export function installFromStore(
  packageName: string,
  opts?: { update?: boolean },
): Promise<StoreInstallResult> {
  // No explicit content-type here: the `request` wrapper already sets
  // `Content-Type: application/json`. Passing it again (different casing)
  // makes fetch emit a doubled `application/json, application/json` header
  // that NestJS's body-parser refuses to parse → `package_name required`.
  return request("/store/install", {
    method: "POST",
    body: JSON.stringify({ package_name: packageName, update: opts?.update }),
  });
}

export interface StoreUninstallResult {
  status: "uninstalled" | "not_installed" | "failed";
  message: string;
  removed_path: string | null;
  removed_types: number;
}

export function uninstallFromStore(packageName: string): Promise<StoreUninstallResult> {
  return request("/store/uninstall", {
    method: "POST",
    body: JSON.stringify({ package_name: packageName }),
  });
}

export function getStoreCandidates(): Promise<StoreCandidate[]> {
  return request("/store/candidates");
}

export function refreshStore(): Promise<{ updated: boolean; message: string }> {
  return request("/store/refresh", { method: "POST" });
}

export function getStoreUpstreamStatus(): Promise<{ updateAvailable: boolean; localSha: string | null; remoteSha: string | null }> {
  return request("/store/upstream-status");
}

export function getInstalledUpdates(): Promise<InstalledNodeUpdate[]> {
  return request("/store/installed-updates");
}

// === Marketplace seeds ===

export interface MarketplaceSeed {
  name: string;
  description: string;
  repo: string;
  subpath: string;
  ref: string;
  checksum: string;
  tags?: string[];
  needs?: string[];
  /** Concrete node list the seed will spawn (real names + types, not just needs[]). */
  nodes?: Array<{ name: string; type: string }>;
  installed: boolean;
}

export function getMarketplaceSeeds(): Promise<MarketplaceSeed[]> {
  return request("/store/seeds");
}

export function installMarketplaceSeed(name: string): Promise<{ status: string; message: string; path?: string }> {
  return request(`/store/seeds/${encodeURIComponent(name)}/install`, { method: "POST" });
}
