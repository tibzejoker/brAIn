import { Controller, Get } from "@nestjs/common";
import { BrainService, type AgentAnnouncement } from "@brain/core";

@Controller("agents")
export class AgentsController {
  constructor(private readonly brain: BrainService) {}

  /**
   * Live snapshot of brain-agents currently announcing themselves on
   * the bus. Empty when the bus is in-memory or no agent is running.
   * Each entry carries `agent_id`, `host`, `pid`, `started_at`,
   * `types[]`, and `ts` (last announcement wall-clock).
   */
  @Get()
  list(): AgentAnnouncement[] {
    return this.brain.agents.list();
  }
}
