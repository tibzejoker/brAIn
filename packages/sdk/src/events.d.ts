import type { Message, NodeInfo, NodeState } from "./types";
export type BrainEvent = {
    type: "node.spawned";
    node: NodeInfo;
} | {
    type: "node.killed";
    nodeId: string;
    reason?: string;
} | {
    type: "node.state_changed";
    nodeId: string;
    from: NodeState;
    to: NodeState;
} | {
    type: "message.published";
    message: Message;
} | {
    type: "type.registered";
    typeName: string;
} | {
    type: "type.unregistered";
    typeName: string;
} | {
    type: "node.preempted";
    nodeId: string;
    by_message: Message;
};
//# sourceMappingURL=events.d.ts.map