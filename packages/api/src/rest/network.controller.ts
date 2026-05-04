import { Controller, Get, Post, Body, Query, Param, HttpException, HttpStatus } from "@nestjs/common";
import { BrainService, BrokerService, type HistoryEntry, type ProviderStatus, type CLIStatus } from "@brain/core";
import { type Message, type NodeInfo, type NodeState } from "@brain/sdk";

interface NodeSnapshot extends Omit<NodeInfo, "subscriptions"> {
  subscriptions: Array<{ id: string; pattern: string }>;
}

interface NetworkSnapshot {
  node_count: number;
  nodes: NodeSnapshot[];
}

@Controller("network")
export class NetworkController {
  constructor(
    private readonly brain: BrainService,
    private readonly broker: BrokerService,
  ) {}

  @Get()
  snapshot(
    @Query("state") state?: string,
    @Query("tags") tags?: string,
  ): NetworkSnapshot {
    const nodes = this.brain.getNetworkSnapshot({
      state: (state ?? "all") as NodeState | "all",
      tags: tags ? tags.split(",") : undefined,
    });

    return {
      node_count: nodes.length,
      nodes: nodes.map((n) => ({
        ...n,
        subscriptions: this.brain.bus.getSubscriptions(n.id),
        unread_count: this.brain.bus.getUnreadCount(n.id),
      })),
    };
  }

  @Get("messages")
  messages(
    @Query("topic") topic?: string,
    @Query("from") from?: string,
    @Query("last") last?: string,
    @Query("min_criticality") minCriticality?: string,
  ): Message[] {
    return this.brain.bus.getMessageHistory({
      topic,
      from,
      last: last ? parseInt(last, 10) : undefined,
      min_criticality: minCriticality
        ? parseInt(minCriticality, 10)
        : undefined,
    });
  }

  /**
   * Walk the causal chain for a given trace_id. Returns every message
   * that shares the trace, oldest first — used by the dashboard to
   * render conversation flows and by debug tools to replay an
   * interaction. 404 if no message in the in-memory history carries
   * that trace.
   */
  @Get("traces/:trace_id")
  trace(@Param("trace_id") traceId: string): Message[] {
    const chain = this.brain.bus.getTrace(traceId);
    if (chain.length === 0) {
      throw new HttpException(`trace not found: ${traceId}`, HttpStatus.NOT_FOUND);
    }
    return chain;
  }

  /**
   * Re-publish every message of a past trace as fresh emissions —
   * "replay this scenario". Each new message gets a new id and the
   * causal `parent_id` chain is rewritten under a new `trace_id`,
   * with `metadata.replayed_from` pointing back at the original.
   * 404 if the trace fell out of the bus history (sliding window).
   * `interval_ms` query param spaces emissions out for visualisation.
   */
  @Post("traces/:trace_id/replay")
  async replay(
    @Param("trace_id") traceId: string,
    @Query("interval_ms") intervalMs?: string,
  ): Promise<{ replayed: number; new_trace_id: string }> {
    const interval = intervalMs ? Math.max(0, parseInt(intervalMs, 10)) : undefined;
    const result = await this.brain.replayTrace(traceId, { intervalMs: interval });
    if (result.replayed === 0 || !result.new_trace_id) {
      throw new HttpException(`trace not found or empty: ${traceId}`, HttpStatus.NOT_FOUND);
    }
    return { replayed: result.replayed, new_trace_id: result.new_trace_id };
  }

  @Get("history")
  history(
    @Query("last") last?: string,
    @Query("action") action?: string,
    @Query("node_id") nodeId?: string,
    @Query("since") since?: string,
  ): HistoryEntry[] {
    return this.brain.getNetworkHistory({
      last: last ? parseInt(last, 10) : undefined,
      action: action as HistoryEntry["action"] | undefined,
      node_id: nodeId,
      since: since ? parseInt(since, 10) : undefined,
    });
  }

  @Post("seed")
  async seed(
    @Body("file") file?: string,
    @Body("merge") merge?: boolean,
  ): Promise<{ spawned: number; skipped: number; killed: number; installed: string[] }> {
    const seedPath = file ?? process.env.BRAIN_SEED_FILE ?? "./seed.yaml";
    try {
      return await this.brain.seed(seedPath, { merge });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post("reset")
  reset(): { killed: number } {
    const killed = this.brain.killAll();
    this.brain.resetDb();
    return { killed };
  }

  @Get("providers")
  providers(): { llm: ProviderStatus[]; cli: CLIStatus[] } {
    return this.brain.getProviderStatuses();
  }

  @Get("devmode")
  getDevMode(): { enabled: boolean } {
    return { enabled: this.brain.isDevMode() };
  }

  /**
   * Surface the bus broker info for the dashboard. The framework
   * always runs on NATS now (embedded by default), so the
   * Distributed tab can show the URL the user would point a remote
   * `brain-agent` at and tell whether the broker is local
   * (auto-spawned) or external (BRAIN_NATS_URL provided).
   */
  @Get("transport")
  transport(): { url: string | null; mode: "embedded" | "external" } {
    return { url: this.broker.getUrl(), mode: this.broker.getMode() };
  }

  @Post("devmode")
  setDevMode(@Body("enabled") enabled: boolean): { enabled: boolean } {
    this.brain.setDevMode(enabled);
    return { enabled: this.brain.isDevMode() };
  }

  @Post("tick")
  tickAll(): { ticked: number } {
    return { ticked: this.brain.tickAll() };
  }
}
