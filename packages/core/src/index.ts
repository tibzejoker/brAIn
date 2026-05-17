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
