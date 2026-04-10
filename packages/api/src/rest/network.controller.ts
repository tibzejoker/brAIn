import { Controller, Get, Post, Body, Query, HttpException, HttpStatus } from "@nestjs/common";
import { BrainService, type HistoryEntry } from "@brain/core";
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
  constructor(private readonly brain: BrainService) {}

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
  async seed(@Body("file") file?: string): Promise<{ seeded: number }> {
    const seedPath = file ?? process.env.BRAIN_SEED_FILE ?? "./seed.yaml";
    try {
      const seeded = await this.brain.seed(seedPath);
      return { seeded };
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
}
