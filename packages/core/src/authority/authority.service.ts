import { type NodeInfo, AuthorityLevel } from "@brain/sdk";

export type AuthAction =
  | "spawn_node"
  | "kill_node"
  | "wake_node"
  | "stop_node"
  | "start_node"
  | "rewire"
  | "set_authority"
  | "inspect_network"
  | "find_nodes"
  | "inspect_node"
  | "trace_message"
  | "list_node_types"
  | "register_node_type"
  | "unregister_node_type";

const BASIC_ACTIONS = new Set<AuthAction>([]);

const ELEVATED_ACTIONS = new Set<AuthAction>([
  "spawn_node",
  "kill_node",
  "wake_node",
  "stop_node",
  "start_node",
  "rewire",
  "inspect_network",
  "find_nodes",
  "inspect_node",
  "trace_message",
  "list_node_types",
]);

const ROOT_ACTIONS = new Set<AuthAction>([
  ...ELEVATED_ACTIONS,
  "set_authority",
  "register_node_type",
  "unregister_node_type",
]);

export class AuthorityService {
  canPerform(
    caller: NodeInfo,
    action: AuthAction,
    target?: NodeInfo,
  ): boolean {
    // Check if caller's level allows the action
    const allowed = this.getAllowedActions(caller.authority_level);
    if (!allowed.has(action)) return false;

    // Actions that target another node require strictly lower authority
    if (target && this.isTargetedAction(action)) {
      if (target.authority_level >= caller.authority_level) return false;
    }

    // spawn_node: child authority must be < caller
    // (this is checked by the orchestrator with the requested authority_level)

    // root cannot kill itself
    if (action === "kill_node" && target && target.id === caller.id) {
      return false;
    }

    return true;
  }

  getMaxChildAuthority(caller: NodeInfo): AuthorityLevel {
    if (caller.authority_level === AuthorityLevel.ROOT) {
      return AuthorityLevel.ELEVATED;
    }
    if (caller.authority_level === AuthorityLevel.ELEVATED) {
      return AuthorityLevel.BASIC;
    }
    return AuthorityLevel.BASIC;
  }

  private getAllowedActions(level: AuthorityLevel): Set<AuthAction> {
    switch (level) {
      case AuthorityLevel.ROOT:
        return ROOT_ACTIONS;
      case AuthorityLevel.ELEVATED:
        return ELEVATED_ACTIONS;
      case AuthorityLevel.BASIC:
        return BASIC_ACTIONS;
      default:
        return BASIC_ACTIONS;
    }
  }

  private isTargetedAction(action: AuthAction): boolean {
    return [
      "kill_node",
      "wake_node",
      "stop_node",
      "start_node",
      "rewire",
    ].includes(action);
  }
}
