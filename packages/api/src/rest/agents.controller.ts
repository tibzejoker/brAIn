import { Controller, Get } from "@nestjs/common";
import { BrainService, resolveHubId, getDb, type AgentAnnouncement } from "@brain/core";

@Controller("agents")
export class AgentsController {
  constructor(private readonly brain: BrainService) {}

  /**
   * Live snapshot of brain-agents currently announcing themselves on
   * the bus. Empty when the bus is in-memory or no agent is running.
   * Each entry carries `agent_id`, `host`, `pid`, `started_at`,
   * `types[]`, and `ts` (last announcement wall-clock).
   *
   * Excludes OURSELVES: in external mode the API announces its own
   * presence on the bus so peers can target it, but it receives that
   * announcement back too — we already appear as the "Local" host, so
   * listing ourselves again would render an empty duplicate agent card.
   */
  @Get()
  list(): AgentAnnouncement[] {
    const self = resolveHubId(getDb());
    return this.brain.agents.list().filter((a) => a.agent_id !== self);
  }
}
