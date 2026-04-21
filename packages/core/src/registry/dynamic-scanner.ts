import * as fs from "fs";
import * as path from "path";
import EventEmitter from "eventemitter3";
import { logger } from "../logger";
import type { BusService } from "../bus";
import type { TypeRegistry } from "./type-registry";
import { TypeValidatorService, readState, type ValidationResult } from "./type-validator";
import { computeWorkspaceHashes } from "./hashing";

export interface DynamicScannerOptions {
  /** Full path to the dynamic workspaces directory, e.g. nodes/_dynamic */
  dynamicDir: string;
  bus: BusService;
  typeRegistry: TypeRegistry;
  validator?: TypeValidatorService;
  /** Scan interval in ms (default 5000) */
  interval_ms?: number;
  /** How long hashes must remain stable before validation triggers (default 2000) */
  debounce_ms?: number;
  /** Publisher identity on the bus (default "framework.scanner") */
  publisher_id?: string;
}

interface WorkspaceTracker {
  last_observed_build_hash: string;
  observed_at: number;
  validating: boolean;
  last_validated_build_hash?: string;
}

/**
 * Periodic scanner for runtime-generated node workspaces.
 * Watches <dynamicDir>/<slug>/ for build hash changes, triggers validation,
 * and registers successful workspaces into the TypeRegistry. Entirely decoupled
 * from the developer node — nodes are merely authored by it, discovery is ours.
 */
export class DynamicTypeScanner extends EventEmitter {
  private readonly log = logger.child({ svc: "dynamic-scanner" });
  private readonly validator: TypeValidatorService;
  private readonly trackers = new Map<string, WorkspaceTracker>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: DynamicScannerOptions) {
    super();
    this.validator = opts.validator ?? new TypeValidatorService();
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.interval_ms ?? 5000;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan iteration, exposed for tests.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const workspaces = this.listWorkspaces();
      for (const ws of workspaces) {
        await this.handleWorkspace(ws);
      }
    } finally {
      this.running = false;
    }
  }

  private listWorkspaces(): string[] {
    const dir = this.opts.dynamicDir;
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name))
      .filter((p) => fs.existsSync(path.join(p, "config.json")));
  }

  private async handleWorkspace(workspacePath: string): Promise<void> {
    const tracker = this.trackers.get(workspacePath) ?? {
      last_observed_build_hash: "",
      observed_at: 0,
      validating: false,
    };
    this.trackers.set(workspacePath, tracker);

    if (tracker.validating) return;

    const current = computeWorkspaceHashes(workspacePath);
    const state = readState(workspacePath);

    // If already validated against this exact build, ensure it's registered and skip.
    if (state?.ok && state.type_name && state.hashes.build_hash === current.build_hash && current.build_hash !== "") {
      if (!this.opts.typeRegistry.has(state.type_name)) {
        this.register(workspacePath, state.type_name, false);
      }
      tracker.last_validated_build_hash = current.build_hash;
      return;
    }

    // Detect hash change — restart debounce window
    if (current.build_hash !== tracker.last_observed_build_hash) {
      tracker.last_observed_build_hash = current.build_hash;
      tracker.observed_at = Date.now();
      return;
    }

    // Skip if no build artefact yet
    if (current.build_hash === "") return;

    // Skip if we've already failed validation for this exact build (avoid loops)
    if (state && !state.ok && state.hashes.build_hash === current.build_hash) return;

    // Wait for stability window
    const debounce = this.opts.debounce_ms ?? 2000;
    if (Date.now() - tracker.observed_at < debounce) return;

    // Trigger validation
    tracker.validating = true;
    try {
      const result = await this.validator.validate(workspacePath);
      this.emitResult(workspacePath, result);
      if (result.ok && result.type_name) {
        const wasRegistered = this.opts.typeRegistry.has(result.type_name);
        this.register(workspacePath, result.type_name, wasRegistered);
        tracker.last_validated_build_hash = current.build_hash;
      }
    } catch (err) {
      this.log.error({ err, workspace: workspacePath }, "Validator crashed");
    } finally {
      tracker.validating = false;
    }
  }

  private register(workspacePath: string, typeName: string, isUpdate: boolean): void {
    try {
      if (isUpdate) {
        this.clearRequireCache(workspacePath);
        this.opts.typeRegistry.unregister(typeName);
      }
      this.opts.typeRegistry.register(workspacePath);
      const slug = path.basename(workspacePath);
      const topic = isUpdate ? "types.updated" : "types.registered";
      this.publish(topic, {
        slug, type_name: typeName, path: workspacePath, origin: "dynamic",
      });
      this.log.info({ type: typeName, workspace: workspacePath, update: isUpdate }, "Type registered");
      this.emit(isUpdate ? "type:updated" : "type:registered", { typeName, workspacePath });
    } catch (err) {
      this.log.error({ err, workspace: workspacePath }, "Registration failed");
    }
  }

  private emitResult(workspacePath: string, result: ValidationResult): void {
    const slug = path.basename(workspacePath);
    if (result.ok) {
      this.publish("types.validated", {
        slug,
        type_name: result.type_name,
        path: workspacePath,
        build_hash: result.hashes.build_hash,
      });
    } else {
      this.publish("types.validation_failed", {
        slug,
        type_name: result.type_name,
        phase: result.phase,
        errors: result.errors,
      });
    }
  }

  private publish(topic: string, data: Record<string, unknown>): void {
    this.opts.bus.publish({
      from: this.opts.publisher_id ?? "framework.scanner",
      topic,
      type: "text",
      criticality: 2,
      payload: { content: JSON.stringify(data) },
    });
  }

  private clearRequireCache(workspacePath: string): void {
    const resolvedPrefix = path.resolve(workspacePath) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(resolvedPrefix)) {
        delete require.cache[key];
      }
    }
  }
}
