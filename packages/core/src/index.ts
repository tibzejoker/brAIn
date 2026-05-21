export { BrainService } from "./brain.service";
export { BusService, NatsBusService, Mailbox, matchTopic } from "./bus";
export type { IBusService, NatsBusOptions, BusHistoryOptions, BusMailboxView, BusSubscription, SubscribeOptions } from "./bus";
export {
  BrokerService,
  readBrokerPrefs, writeBrokerPrefs,
  readExternalBrokerPrefs, writeExternalBrokerPrefs, clearExternalBrokerPrefs,
} from "./broker";
export type { BrokerOptions, BrokerMode, BrokerPrefs, ExternalBrokerPrefs } from "./broker";
export {
  TypeRegistry, InstanceRegistry,
  TypeValidatorService, DynamicTypeScanner,
  computeWorkspaceHashes, hashDir, readState,
} from "./registry";
export type {
  ValidationResult, ValidationPhase, BrainState, ValidatorOptions,
  DynamicScannerOptions, WorkspaceHashes,
} from "./registry";
export { AuthorityService } from "./authority";
export { NodeRunner, IdleThrottle } from "./runner";
export type { LogEntry } from "./runner";
// Per-node data root (<dataRoot>/nodes). Nodes that persist outside their
// own ctx.dataDir (shared SQLite, OAuth token stores) resolve the data root
// from this so they land next to brain.db instead of in process.cwd().
export { getNodeDataRoot } from "./runner/context-builder";
export { logger, createNodeLogger } from "./logger";
export { getDb, closeDb, getSetting, setSetting, deleteSetting } from "./db";
export type { HistoryEntry, HistoryAction } from "./db";
export { loadSeedFile, scanSeedsDirectory } from "./seed";
export type { SeedInfo, ValidationError } from "./seed";
export {
  LLMRegistry, CLIRegistry, generateText,
  LLMConfigStore, LLMFacade,
  stripReasoningTags, extractReasoningText,
  parseTolerantJson, repairTruncatedJson,
} from "./llm";
export type {
  ProviderStatus, CLIStatus, LLMConfig, ProviderCredentials,
  TextOptions, ToolOptions, ResolutionTrace, UsageEvent,
} from "./llm";
export { startChildServer } from "./child-server";
export type { ChildServerOptions, ChildServerHandle } from "./child-server";
export {
  AgentDirectory, AGENT_ANNOUNCE_TOPIC, AGENT_ANNOUNCE_DEFAULT_MS,
  startAgentPresence,
} from "./agents";
export type { AgentAnnouncement, AgentDirectoryOptions, AgentPresenceOptions, AgentPresenceHandle } from "./agents";
export {
  NETWORK_SNAPSHOT_TOPIC, NETWORK_BYE_TOPIC, NETWORK_SNAPSHOT_DEFAULT_MS,
  NETWORK_LAYOUT_TOPIC, NETWORK_CURSOR_TOPIC,
  resolveHubId, resolveHubLabel, buildHubRef,
  NetworkDirectory, startNetworkPublisher,
  UriConnector, ConnectorRegistry, createDefaultConnectorRegistry,
} from "./network";
export type {
  NetworkSnapshot, NetworkBye, NetworkDirectoryOptions,
  NetworkPublisherOptions, NetworkPublisherHandle,
  LayoutUpdate, CursorUpdate,
  JoinDescriptor, PeerConnector,
} from "./network";
export { StoreService } from "./store";
export type {
  StoreRegistry, StoreRepo, StoreNode, StoreNodeStatus, StoreInstallResult,
  StoreCandidate, StoreSeed,
} from "./store";
export {
  MCPBridge, toolsForNode, federatedTools, resolveNode,
  META_TOOLS,
  META_TOOL_LIST_NODES,
  META_TOOL_LIST_NODE_TOOLS,
  META_TOOL_CALL_NODE_TOOL,
  buildMetaToolHandlers,
} from "./mcp";
export type {
  MCPTool, ResolveResult,
  MetaTool, MetaToolHandlers,
  ListNodesEntry, ListNodeToolsResult,
  CallNodeToolResult, CallNodeToolOk, CallNodeToolErr,
} from "./mcp";
