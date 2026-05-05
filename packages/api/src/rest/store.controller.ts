import { Body, Controller, Get, HttpException, HttpStatus, Param, Post } from "@nestjs/common";
import * as path from "node:path";
import {
  BrainService,
  type StoreCandidate,
  type StoreInstallResult, type StoreNodeStatus, type StoreRegistry, type StoreSeed,
} from "@brain/core";

interface InstallBody { package_name: string; update?: boolean }

@Controller("store")
export class StoreController {
  constructor(private readonly brain: BrainService) {}

  /** Raw registry (cached 60s upstream). */
  @Get("index")
  async index(): Promise<StoreRegistry> {
    try {
      return await this.brain.store.fetchRegistry();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException(`store unreachable: ${msg}`, HttpStatus.BAD_GATEWAY);
    }
  }

  /** Registry decorated with installation status (true if the parent repo
   *  is checked out as a sibling and the subpath has a valid config.json). */
  @Get("nodes")
  async nodes(): Promise<StoreNodeStatus[]> {
    try {
      return await this.brain.store.listWithStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException(`store unreachable: ${msg}`, HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Locally-built dynamic node types — what the developer node has
   * authored — that are candidates for being added to the public
   * store. Each entry includes a ready-made `registry_entry` the
   * user can paste into a PR against `brAIn-store/registry.json`.
   */
  @Get("candidates")
  candidates(): StoreCandidate[] {
    return this.brain.store.listCandidates();
  }

  /** Clone the parent repo of a node (if absent), refresh the type registry. */
  @Post("install")
  async install(@Body() body: InstallBody): Promise<StoreInstallResult> {
    if (!body.package_name) {
      throw new HttpException("package_name required", HttpStatus.BAD_REQUEST);
    }
    const result = await this.brain.store.install(body.package_name, { update: body.update });
    if (result.status === "failed") {
      throw new HttpException(result.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return result;
  }

  /**
   * Pull the local marketplace clone (`git pull`) and bust the
   * registry cache. Triggered by the dashboard's refresh button.
   */
  @Post("refresh")
  refresh(): { updated: boolean; message: string } {
    return this.brain.store.refreshLocalStore();
  }

  /**
   * Cheap "is the marketplace ahead?" check. `git fetch` + diff.
   * Lets the dashboard show an "update available" badge without
   * actually pulling.
   */
  @Get("upstream-status")
  upstreamStatus(): { updateAvailable: boolean; localSha: string | null; remoteSha: string | null } {
    return this.brain.store.marketplaceHasUpdate();
  }

  /**
   * Per-installed-repo update status: true when the local checkout's
   * HEAD differs from the registry's pinned ref. Surfaces as
   * "node X has a new version" hints in the dashboard.
   */
  @Get("installed-updates")
  async installedUpdates(): Promise<Array<{ name: string; repo: string; localSha: string | null; pinnedSha: string; updateAvailable: boolean }>> {
    return await this.brain.store.installedNodeUpdates();
  }

  /**
   * Marketplace seeds with installed-locally status. The dashboard
   * merges these with the local-only seeds returned by /network/seeds.
   */
  @Get("seeds")
  async seeds(): Promise<Array<StoreSeed & { installed: boolean }>> {
    const seedsDir = path.resolve(process.cwd(), "..", "..", "seeds");
    return await this.brain.store.listSeeds(seedsDir);
  }

  /**
   * Pull a marketplace seed YAML (verified against its checksum)
   * and write it to the local seeds/ directory. Idempotent —
   * overwrites on re-install when the registry bumps the ref.
   */
  @Post("seeds/:name/install")
  async installSeed(@Param("name") name: string): Promise<{ status: string; message: string; path?: string }> {
    const seedsDir = path.resolve(process.cwd(), "..", "..", "seeds");
    const r = await this.brain.store.installSeed(name, seedsDir);
    if (r.status === "failed") {
      throw new HttpException(r.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return r;
  }
}
