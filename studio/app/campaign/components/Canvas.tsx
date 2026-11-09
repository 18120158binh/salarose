import React, { useCallback, useMemo, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Node,
  Edge,
  Connection,
  ReactFlowInstance,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CampaignNode, CampaignConnection, NO_EDGE, YES_EDGE } from "@/entities/journey/model/types";
import { canConnect, type BranchConfig } from "@/entities/journey/model/utils";
import CustomNode from "./CustomNode";
import CustomEdge from "./CustomEdge";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface CanvasProps {
  nodes: CampaignNode[];
  connections: CampaignConnection[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onAddNodeBetween: (fromId: string, toId: string) => void;
  onAlign: () => void;
  onNodeDragStop: (id: string, position: { x: number; y: number }) => void;
  onConnect?: (params: Connection) => void;
  readOnly?: boolean;
  stats?: Record<string, number>;
  statsFailed?: boolean;
}

export default function Canvas({
  nodes,
  connections,
  selectedNodeId,
  onSelectNode,
  onAddNodeBetween,
  onAlign,
  onNodeDragStop,
  onConnect,
  readOnly = false,
  stats,
  statsFailed = false,
}: CanvasProps) {
  // Register custom node and edge types
  const nodeTypes = useMemo(() => ({ customNode: CustomNode }), []);
  const edgeTypes = useMemo(() => ({ customEdge: CustomEdge }), []);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    Node,
    Edge
  > | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isValidConnection = useCallback(
    (connection: Edge | Connection) =>
      canConnect(nodes, connections, connection.source, connection.target),
    [nodes, connections]
  );

  // Sync incoming nodes prop to React Flow local nodes state
  useEffect(() => {
    const formattedNodes = nodes.map((node) => {
      const userCount = stats ? (stats[node.id] || 0) : 0;
      return {
        id: node.id,
        type: "customNode",
        position: node.position,
        data: {
          node,
          isSelected: selectedNodeId === node.id,
          onSelect: onSelectNode,
          userCount: userCount,
        },
      };
    });
    setRfNodes(formattedNodes);
  }, [nodes, selectedNodeId, onSelectNode, stats, setRfNodes]);

  // Sync incoming connections prop to React Flow local edges state
  useEffect(() => {
    const formattedEdges = connections.map((conn) => {
      const isRequired = conn.type === YES_EDGE || conn.type === "next" || !conn.type;
      const isUndefined = conn.type === NO_EDGE;
      const isBranch = !isRequired && !isUndefined; // i.e. branchKey
      const sourceNode = nodes.find((n) => n.id === conn.from);
      const isDelayOnly =
        sourceNode?.type === "watch" && sourceNode.config.watchType === "DelayPath";
      
      let color = "#94a3b8"; // default slate gray for sequence flow
      let sourceHandle = "yes";
      let pathLabel: string | undefined;

      if (sourceNode && ["check", "segment", "watch"].includes(sourceNode.type)) {
        if (isDelayOnly) {
          pathLabel = "Next";
        } else if (isBranch) {
          color = "#0ea5e9"; // sky blue for multi-branch
          sourceHandle = conn.type;
          pathLabel =
            (sourceNode.config.branches as BranchConfig[] | undefined)?.find((branch) => branch.branchKey === conn.type)?.label ||
            conn.type;
        } else {
          // Green for success/yes, Rose for timeout/no
          color = isRequired ? "#10b981" : "#f43f5e";
          sourceHandle = isRequired ? "yes" : "no";
          pathLabel = sourceNode.type === "watch"
            ? (isRequired ? "Success" : "Timeout")
            : (isRequired ? "Yes" : "No");
        }
      }
      
      return {
        id: `edge-${conn.from}-${conn.to}-${conn.type || 'next'}`,
        type: "customEdge",
        source: conn.from,
        sourceHandle: sourceHandle,
        target: conn.to,
        style: {
          stroke: color,
          strokeWidth: 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: color,
        },
        data: {
          fromId: conn.from,
          toId: conn.to,
          onAddNodeBetween: readOnly ? undefined : onAddNodeBetween,
          label: pathLabel,
        },
      };
    });
    setRfEdges(formattedEdges);
  }, [connections, nodes, onAddNodeBetween, setRfEdges, readOnly]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (
      !canvas
      || !flowInstance
      || rfNodes.length === 0
      || typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        void flowInstance.fitView({ padding: 0.3, duration: 200 });
      }, 100);
    });
    observer.observe(canvas);

    return () => {
      clearTimeout(fitTimer);
      observer.disconnect();
    };
  }, [flowInstance, rfNodes.length]);

  return (
    <div
      ref={canvasRef}
      className="flex-1 relative border-t border-border select-none h-full bg-slate-50/50 dark:bg-background"
      style={{ minHeight: "500px" }}
    >
      {/* React Flow Viewport */}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onInit={setFlowInstance}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        isValidConnection={isValidConnection}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.5}
        maxZoom={1.5}
        deleteKeyCode={null}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={true}
        onNodeDragStop={(_, node) => {
          onNodeDragStop(node.id, { x: node.position.x, y: node.position.y });
        }}
        proOptions={{ hideAttribution: true }}
      >
        {/* Dynamic theme adaptive Background Grid */}
        <Background
          bgColor="transparent"
          color="currentColor"
          className="text-muted-foreground/15 dark:text-border/20"
          gap={20}
          size={1}
        />
        
        {/* Controls (Zoom In/Out, Fit view) */}
        <Controls className="!bg-card !border !border-border !shadow-sm !rounded-lg [&_button]:!bg-transparent [&_button]:!border-none [&_button]:!text-foreground hover:[&_button]:!bg-accent" />
      </ReactFlow>

      {statsFailed && (
        <Alert variant="warning" className="absolute top-4 left-10 z-30 w-auto max-w-sm py-2 shadow-sm">
          <AlertDescription className="text-xs">
            User counts could not refresh. The canvas shows the last counts and retries every 5 seconds.
          </AlertDescription>
        </Alert>
      )}

      {/* Goals Sidebar Ribbon */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center z-10 select-none pointer-events-none">
        <div className="bg-violet-600 text-white rounded-r-md px-1.5 py-4 flex flex-col items-center gap-1 shadow-md hover:bg-violet-700 transition-colors cursor-pointer pointer-events-auto">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
            className="w-3.5 h-3.5 mb-1"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-[10px] font-bold tracking-widest uppercase" style={{ writingMode: "vertical-lr" }}>
            GOALS
          </span>
        </div>
      </div>

      {/* Legend & Align Controls Overlay */}
      <div className="absolute top-4 right-4 flex items-center gap-4 bg-background/90 backdrop-blur-sm border border-border p-2 rounded-lg shadow-sm z-30 select-none">
        {/* Legends */}
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-400 dark:bg-slate-500 shrink-0"></span>
            <span>Sequence flow</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0"></span>
            <span>Success / Yes path</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0"></span>
            <span>Timeout / No path</span>
          </div>
        </div>

        {!readOnly && (
          <>
            <div className="h-4 w-px bg-border"></div>

            {/* Align Button */}
            <button
              type="button"
              onClick={() => onAlign()}
              className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 border border-primary/20 hover:border-primary/40 bg-primary/5 hover:bg-primary/10 rounded-md text-primary transition-all cursor-pointer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-3.5 h-3.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v16.5m16.5-16.5v16.5M12 3.75v16.5m-5.625-8.25h11.25" />
              </svg>
              Align
            </button>
          </>
        )}
      </div>
    </div>
  );
}
