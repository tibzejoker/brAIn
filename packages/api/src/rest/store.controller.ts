import { Body, Controller, Get, HttpException, HttpStatus, Post } from "@nestjs/common";
import {
  BrainService,
  type StoreCandidate,
  type StoreInstallResult, type StoreNodeStatus, type StoreRegistry,
} from "@brain/core";

interface InstallBody { package_name: string }

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
    const result = await this.brain.store.install(body.package_name);
    if (result.status === "failed") {
      throw new HttpException(result.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return result;
  }
}
