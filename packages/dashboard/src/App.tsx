import { useState, useEffect, useCallback } from "react";
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
import { getDevMode, setDevMode, tickAll } from "./api/client";
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
  const [devMode, setDevModeState] = useState(false);

  // Load initial dev mode state
  useEffect(() => {
    getDevMode()
      .then((r) => { setDevModeState(r.enabled); })
      .catch(() => { /* silent */ });

    const socket = getSocket();
    const handler = (data: { enabled: boolean }): void => {
      setDevModeState(data.enabled);
    };
    socket.on("devmode:changed", handler);
    return (): void => { socket.off("devmode:changed", handler); };
  }, []);

  const handleDevModeToggle = useCallback((): void => {
    const next = !devMode;
    setDevMode(next)
      .then((r) => { setDevModeState(r.enabled); })
      .catch(() => { /* silent */ });
  }, [devMode]);

  const handleTickAll = useCallback((): void => {
    tickAll().catch(() => { /* silent */ });
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
        devMode={devMode}
        onSpawnClick={handleSpawnClick}
        onDevModeToggle={handleDevModeToggle}
        onTickAll={handleTickAll}
      />

      <div className="flex-1 flex overflow-hidden">
        <Menu active={activeView} onChange={setActiveView} />

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
                devMode={devMode}
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
