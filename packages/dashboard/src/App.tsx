import { useState, useEffect, useCallback } from "react";
import { BackgroundFX } from "./components/BackgroundFX";
import { Header } from "./components/Header";
import { Menu } from "./components/Menu";
import { NetworkGraph, type EdgeSelection } from "./components/NetworkGraph/NetworkGraph";
import { NodePanel } from "./components/NodePanel";
import { EdgePanel } from "./components/EdgePanel";
import { MessageLog } from "./components/MessageLog";
import { NodeCreator } from "./components/NodeCreator";
import { HistoryPanel } from "./components/HistoryPanel";
import { MarketplacePanel } from "./components/MarketplacePanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { LLMSettingsPanel } from "./components/LLMSettingsPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { NodeUiModal } from "./components/NodeUiModal";
import { useNetwork } from "./hooks/useNetwork";
import { useMessages } from "./hooks/useMessages";
import { useNodeTypes } from "./hooks/useNodeTypes";
import { useSelectedNode } from "./hooks/useSelectedNode";
import { useMessageFlows } from "./hooks/useMessageFlows";
import { useUrlRouting } from "./hooks/useUrlRouting";
import { getSocket } from "./api/socket";
import { getTransport } from "./api/client";
import { setApiToken, setSelfHubId, setSelfCanvasPos, setSelfBrokerMode } from "./api/request";

export function App(): React.ReactElement {
  const { nodes, refresh: refreshNetwork } = useNetwork();
  const {
    messages,
    topicFilter,
    setTopicFilter,
    minCriticality,
    setMinCriticality,
    showInfra,
    setShowInfra,
  } = useMessages();
  const { types } = useNodeTypes();
  const { node: selectedNode, select: selectNode, refresh: refreshNode } = useSelectedNode();
  const flows = useMessageFlows(nodes);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<EdgeSelection | null>(null);
  // URL-backed navigation: activeView + the fullscreen node overlay are
  // mirrored into the path so reload/back/forward/bookmark all work.
  const { view: activeView, nodeId: uiNodeId, setView: setActiveView, openNode, closeNode } = useUrlRouting();
  // Mobile-only: drawer state for the left Menu rail. Desktop ignores
  // this — the Menu renders inline at md+.
  const [menuOpen, setMenuOpen] = useState(false);
  const handleMenuToggle = useCallback((): void => { setMenuOpen((v) => !v); }, []);
  const handleMenuClose = useCallback((): void => { setMenuOpen(false); }, []);

  const handleOpenNodeUi = useCallback((nodeId: string): void => {
    openNode(nodeId);
  }, [openNode]);

  const handleCloseNodeUi = useCallback((): void => {
    closeNode();
  }, [closeNode]);

  useEffect(() => {
    // Keep the socket warm even though we no longer subscribe to devmode
    // here. Other panels still consume it.
    getSocket();
    // Pick up THIS hub's broker token so same-origin mutations carry the
    // Authorization header the BrokerTokenGuard expects (embedded mode).
    void getTransport().then((t) => { setApiToken(t.token); setSelfHubId(t.hub_id); setSelfCanvasPos(t.canvas_pos ?? undefined); setSelfBrokerMode(t.mode); }).catch(() => { /* offline boot */ });
  }, []);

  const handleSpawnClick = useCallback((): void => {
    setCreatorOpen(true);
  }, []);

  const handleCreatorClose = useCallback((): void => {
    setCreatorOpen(false);
  }, []);

  const handleSpawned = useCallback((): void => {
    refreshNetwork();
  }, [refreshNetwork]);

  const handleNodeAction = useCallback((): void => {
    refreshNode();
    refreshNetwork();
  }, [refreshNode, refreshNetwork]);

  const handleNodeClose = useCallback((): void => {
    selectNode(null);
  }, [selectNode]);

  const handleNodeSelect = useCallback(
    (id: string | null): void => {
      selectNode(id);
      setSelectedEdge(null);
    },
    [selectNode],
  );

  const handleEdgeSelect = useCallback((edge: EdgeSelection | null): void => {
    setSelectedEdge(edge);
    selectNode(null);
  }, [selectNode]);

  const handleEdgeClose = useCallback((): void => {
    setSelectedEdge(null);
  }, []);

  const handleSeedApplied = useCallback((): void => {
    refreshNetwork();
  }, [refreshNetwork]);

  // A node/edge panel is open on mobile → render it as a full-screen
  // bottom-sheet over the graph. Desktop keeps the side-by-side layout.
  const mobileOverlayOpen = activeView === "graph" && (selectedNode !== null || selectedEdge !== null);

  return (
    <div className="h-screen flex flex-col relative z-10">
      <BackgroundFX />
      <Header
        onSpawnClick={handleSpawnClick}
        onMenuToggle={handleMenuToggle}
      />

      <div className="flex-1 flex overflow-hidden relative">
        <Menu
          active={activeView}
          onChange={setActiveView}
          mobileOpen={menuOpen}
          onMobileClose={handleMenuClose}
        />

        {activeView === "graph" && (
          <>
            <div className="flex-1 min-w-0">
              <NetworkGraph
                nodes={nodes}
                flows={flows}
                types={types}
                onNodeSelect={handleNodeSelect}
                onEdgeSelect={handleEdgeSelect}
                onOpenNodeUi={handleOpenNodeUi}
                selectedNodeId={selectedNode?.id ?? null}
                onWiringChanged={refreshNetwork}
              />
            </div>

            {selectedNode && (
              <div
                className={`
                  ${mobileOverlayOpen ? "fixed inset-0 z-30" : ""}
                  md:static md:inset-auto md:z-auto
                  flex
                `}
              >
                <NodePanel
                  node={selectedNode}
                  hasUi={types.find((t) => t.name === selectedNode.type)?.has_ui ?? false}
                  onOpenUi={() => { handleOpenNodeUi(selectedNode.id); }}
                  onClose={handleNodeClose}
                  onAction={handleNodeAction}
                />
              </div>
            )}

            {selectedEdge && (
              <div
                className={`
                  ${mobileOverlayOpen ? "fixed inset-0 z-30" : ""}
                  md:static md:inset-auto md:z-auto
                  flex
                `}
              >
                <EdgePanel
                  sourceId={selectedEdge.sourceId}
                  targetId={selectedEdge.targetId}
                  topics={selectedEdge.topics}
                  subPortName={selectedEdge.subPortName}
                  nodes={nodes}
                  onClose={handleEdgeClose}
                  onWiringChanged={refreshNetwork}
                />
              </div>
            )}
          </>
        )}

        {activeView === "history" && <HistoryPanel />}

        {activeView === "marketplace" && <MarketplacePanel onChanged={handleSeedApplied} />}

        {activeView === "skills" && <SkillsPanel />}

        {activeView === "agents" && <AgentsPanel />}

        {activeView === "llm" && <LLMSettingsPanel />}
      </div>

      {activeView === "graph" && (
        <MessageLog
          messages={messages}
          nodeNames={new Map(nodes.map((n) => [n.id, n.name]))}
          topicFilter={topicFilter}
          onTopicFilterChange={setTopicFilter}
          minCriticality={minCriticality}
          onMinCriticalityChange={setMinCriticality}
          showInfra={showInfra}
          onShowInfraChange={setShowInfra}
        />
      )}

      <NodeCreator
        types={types}
        nodes={nodes}
        open={creatorOpen}
        onClose={handleCreatorClose}
        onSpawned={handleSpawned}
      />

      {uiNodeId && (
        <NodeUiModal
          nodeId={uiNodeId}
          nodeName={nodes.find((n) => n.id === uiNodeId)?.name ?? "Node"}
          ownerHub={nodes.find((n) => n.id === uiNodeId)?.owner_hub}
          onClose={handleCloseNodeUi}
        />
      )}
    </div>
  );
}
