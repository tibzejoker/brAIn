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

export function installFromStore(packageName: string): Promise<StoreInstallResult> {
  return request("/store/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
