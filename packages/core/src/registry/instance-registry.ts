import { type NodeInfo, type NodeState } from "@brain/sdk";
import EventEmitter from "eventemitter3";

export class InstanceRegistry extends EventEmitter {
  private readonly instances = new Map<string, NodeInfo>();

  add(node: NodeInfo): void {
    this.instances.set(node.id, node);
    this.emit("node:added", node);
  }

  remove(nodeId: string): NodeInfo | undefined {
    const node = this.instances.get(nodeId);
    if (node) {
      this.instances.delete(nodeId);
      this.emit("node:removed", node);
    }
    return node;
  }

  get(nodeId: string): NodeInfo | undefined {
    return this.instances.get(nodeId);
  }

  updateState(nodeId: string, state: NodeState): void {
    const node = this.instances.get(nodeId);
    if (!node) return;

    const from = node.state;
    node.state = state;
    this.emit("node:state_changed", { nodeId, from, to: state });
  }

  list(filter?: {
    state?: NodeState | "all";
    tags?: string[];
    transport?: string;
    spawned_by?: string;
    type?: string;
  }): NodeInfo[] {
    let result = Array.from(this.instances.values());

    if (filter?.state && filter.state !== "all") {
      result = result.filter((n) => n.state === filter.state);
    }
    const tags = filter?.tags;
    if (tags?.length) {
      result = result.filter((n) =>
        tags.some((tag) => n.tags.includes(tag)),
      );
    }
    if (filter?.transport) {
      result = result.filter((n) => n.transport === filter.transport);
    }
    if (filter?.spawned_by) {
      result = result.filter((n) => n.spawned_by === filter.spawned_by);
    }
    if (filter?.type) {
      result = result.filter((n) => n.type === filter.type);
    }

    return result;
  }

  find(query: string): NodeInfo[] {
    const q = query.toLowerCase();
    return Array.from(this.instances.values()).filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)) ||
        n.type.toLowerCase().includes(q),
    );
  }

  get count(): number {
    return this.instances.size;
  }
}
