import { useState, useCallback } from "react";
import { Header } from "./components/Header";
import { Menu, type MenuView } from "./components/Menu";
import { NetworkGraph, type EdgeSelection } from "./components/NetworkGraph/NetworkGraph";
import { NodePanel } from "./components/NodePanel";
import { EdgePanel } from "./components/EdgePanel";
import { MessageLog } from "./components/MessageLog";
import { NodeCreator } from "./components/NodeCreator";
import { HistoryPanel } from "./components/HistoryPanel";
import { SeedManager } from "./components/SeedManager";
import { useNetwork } from "./hooks/useNetwork";
import { useMessages } from "./hooks/useMessages";
import { useNodeTypes } from "./hooks/useNodeTypes";
import { useSelectedNode } from "./hooks/useSelectedNode";
import { useMessageFlows } from "./hooks/useMessageFlows";

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
      <Header nodes={nodes} onSpawnClick={handleSpawnClick} />

      <div className="flex-1 flex overflow-hidden">
        <Menu active={activeView} onChange={setActiveView} />

        {/* Main content area */}
        {activeView === "graph" && (
          <>
            <div className="flex-1">
              <NetworkGraph
                nodes={nodes}
                flows={flows}
                onNodeSelect={handleNodeSelect}
                onEdgeSelect={handleEdgeSelect}
                selectedNodeId={selectedNode?.id ?? null}
              />
            </div>

            {selectedNode && (
              <NodePanel
                node={selectedNode}
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

        {activeView === "seeds" && <SeedManager onApplied={handleSeedApplied} />}
      </div>

      {activeView === "graph" && (
        <MessageLog
          messages={messages}
          topicFilter={topicFilter}
          onTopicFilterChange={setTopicFilter}
          minCriticality={minCriticality}
          onMinCriticalityChange={setMinCriticality}
        />
      )}

      <NodeCreator
        types={types}
        existingNodeCount={nodes.length}
        open={creatorOpen}
        onClose={handleCreatorClose}
        onSpawned={handleSpawned}
      />
    </div>
  );
}
