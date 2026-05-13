import { useState, useEffect, useCallback } from "react";
import { Header } from "./components/Header";
import { Menu, type MenuView } from "./components/Menu";
import { NetworkGraph, type EdgeSelection } from "./components/NetworkGraph/NetworkGraph";
import { NodePanel } from "./components/NodePanel";
import { EdgePanel } from "./components/EdgePanel";
import { MessageLog } from "./components/MessageLog";
import { NodeCreator } from "./components/NodeCreator";
import { HistoryPanel } from "./components/HistoryPanel";
import { MarketplacePanel } from "./components/MarketplacePanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { LLMSettingsPanel } from "./components/LLMSettingsPanel";
import { NodeUiModal } from "./components/NodeUiModal";
import { useNetwork } from "./hooks/useNetwork";
import { useMessages } from "./hooks/useMessages";
import { useNodeTypes } from "./hooks/useNodeTypes";
import { useSelectedNode } from "./hooks/useSelectedNode";
import { useMessageFlows } from "./hooks/useMessageFlows";
import { getSocket } from "./api/socket";

export function App(): React.ReactElement {
  const { nodes, refresh: refreshNetwork } = useNetwork();
  const {
    messages,
    topicFilter,
    setTopicFilter,
    minCriticality,
    setMinCriticality,
  } = useMessages();
  const { types } = useNodeTypes();
  const { node: selectedNode, select: selectNode, refresh: refreshNode } = useSelectedNode();
  const flows = useMessageFlows(nodes);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<EdgeSelection | null>(null);
  const [activeView, setActiveView] = useState<MenuView>("graph");
  const [uiNodeId, setUiNodeId] = useState<string | null>(null);

  const handleOpenNodeUi = useCallback((nodeId: string): void => {
    setUiNodeId(nodeId);
  }, []);

  const handleCloseNodeUi = useCallback((): void => {
    setUiNodeId(null);
  }, []);

  useEffect(() => {
    // Keep the socket warm even though we no longer subscribe to devmode
    // here. Other panels still consume it.
    getSocket();
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

  return (
    <div className="h-screen flex flex-col">
      <Header
        nodes={nodes}
        onSpawnClick={handleSpawnClick}
      />

      <div className="flex-1 flex overflow-hidden">
        <Menu active={activeView} onChange={setActiveView} />

        {activeView === "graph" && (
          <>
            <div className="flex-1">
              <NetworkGraph
                nodes={nodes}
                flows={flows}
                types={types}
                onNodeSelect={handleNodeSelect}
                onEdgeSelect={handleEdgeSelect}
                onOpenNodeUi={handleOpenNodeUi}
                selectedNodeId={selectedNode?.id ?? null}
              />
            </div>

            {selectedNode && (
              <NodePanel
                node={selectedNode}
                hasUi={types.find((t) => t.name === selectedNode.type)?.has_ui ?? false}
                onOpenUi={() => { handleOpenNodeUi(selectedNode.id); }}
                onClose={handleNodeClose}
                onAction={handleNodeAction}
              />
            )}

            {selectedEdge && (
              <EdgePanel
                sourceId={selectedEdge.sourceId}
                targetId={selectedEdge.targetId}
                topics={selectedEdge.topics}
                nodes={nodes}
                onClose={handleEdgeClose}
              />
            )}
          </>
        )}

        {activeView === "history" && <HistoryPanel />}

        {activeView === "marketplace" && <MarketplacePanel onChanged={handleSeedApplied} />}

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
          onClose={handleCloseNodeUi}
        />
      )}
    </div>
  );
}
