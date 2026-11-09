import React, { useState } from "react";
import type { Connection } from "@xyflow/react";
import { Campaign, CampaignNode, CampaignConnection, CampaignTreeNode, SetupNode, YES_EDGE } from "@/entities/journey/model/types";
import {
  treeToGraph,
  graphToTree,
  alignNodes,
  getBranchOptions,
  ChannelPlacementMode,
  InvalidJourneyGraphError,
} from "@/entities/journey/model/utils";
import {
  addNode,
  connect,
  deleteNode,
  insertNode,
  updateNodeConfig,
  type ChannelPlacement,
  type JourneyGraph,
} from "@/entities/journey/model/graphEdits";
import { newCampaignId } from "@/entities/journey/model/campaignId";
import Sidebar, { SidebarItem } from "./Sidebar";
import Canvas from "./Canvas";
import NodeEditor, { type BuilderPickers } from "./NodeEditor";
import type { NodeConfig } from "./node-editors/editorTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

const NEW_JOURNEY: SetupNode = {
  type: "setup",
  id: "setup-node",
  label: "Setup",
  description: "Define journey settings",
  triggerEventName: "login_success",
  next: { type: "end" },
};

interface CampaignBuilderProps {
  campaign: Campaign | null;
  onSave: (campaign: Campaign, publish?: boolean) => void;
  onBack: () => void;
  onClone?: (campaign: Campaign) => void;
  stats?: Record<string, number>;
  /** True while the last refresh of the node counts failed. The canvas keeps the last counts. */
  statsFailed?: boolean;
  pickers: BuilderPickers;
}

export default function CampaignBuilder({
  campaign,
  onSave,
  onBack,
  onClone,
  stats,
  statsFailed = false,
  pickers,
}: CampaignBuilderProps) {
  // The page mounts one builder per campaign, so the props seed the state once.
  const [initialGraph] = useState(() => treeToGraph(campaign?.root ?? NEW_JOURNEY));
  const [nodes, setNodes] = useState<CampaignNode[]>(initialGraph.nodes);
  const [connections, setConnections] = useState<CampaignConnection[]>(initialGraph.connections);
  const [name, setName] = useState(campaign?.name ?? "New Marketing Campaign");
  const [description, setDescription] = useState(
    campaign?.description ?? "Automatically triggered messaging based on user actions.",
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Insertion state
  const [isInserting, setIsInserting] = useState(false);
  const [insertConnection, setInsertConnection] = useState<{ from: string; to: string } | null>(null);
  const [pendingChannel, setPendingChannel] = useState<SidebarItem | null>(null);
  const [channelOriginPath, setChannelOriginPath] = useState<string>(YES_EDGE);
  const [channelPlacementMode, setChannelPlacementMode] = useState<ChannelPlacementMode>("parallel");

  // AI State
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);


  const handleAIGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setIsGenerating(true);
    try {
      const res = await fetch("/api/generate-journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt })
      });
      const data = await res.json();
      
      // The route returns a validated journey, or an error message meant for the marketer.
      if (res.ok) {
        const graph = treeToGraph(data);
        setNodes(graph.nodes);
        setConnections(graph.connections);
        setIsAiModalOpen(false);
        setAiPrompt("");
      } else {
        alert(typeof data.error === "string" ? data.error : "Error generating journey.");
      }
    } catch (err) {
      console.error(err);
      alert("Error generating journey.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAlign = () => {
    setNodes((current) => alignNodes(current, connections));
  };

  // An edit lays out the graph in the same update, so that no later change is overwritten.
  const applyGraphEdit = (next: JourneyGraph) => {
    setNodes(alignNodes(next.nodes, next.connections));
    setConnections(next.connections);
  };

  const addNodeFromSidebar = (item: SidebarItem, placement?: ChannelPlacement) => {
    const added = addNode({ nodes, connections }, { item, stamp: Date.now(), placement });
    applyGraphEdit(added.graph);
    setSelectedNodeId(added.nodeId);
  };

  // Branch nodes need an explicit path and topology choice before adding a channel.
  const handleAddNodeFromSidebar = (item: SidebarItem) => {
    const selectedSource = nodes.find((node) => node.id === selectedNodeId);
    if (
      item.type === "engagement" &&
      selectedSource &&
      ["check", "segment", "watch"].includes(selectedSource.type)
    ) {
      const firstPath = getBranchOptions(selectedSource)[0]?.value || YES_EDGE;
      setPendingChannel(item);
      setChannelOriginPath(firstPath);
      setChannelPlacementMode("parallel");
      return;
    }
    addNodeFromSidebar(item);
  };

  // User clicked '+' on a connector line
  const handleAddNodeBetween = (fromId: string, toId: string) => {
    setInsertConnection({ from: fromId, to: toId });
    setIsInserting(true);
  };

  // Confirm inserting node between A and B
  const handleConfirmInsert = (item: SidebarItem) => {
    if (!insertConnection) return;
    const { from, to } = insertConnection;

    const inserted = insertNode({ nodes, connections }, { from, to, item, stamp: Date.now() });
    if (!inserted) return;

    applyGraphEdit(inserted.graph);
    setSelectedNodeId(inserted.nodeId);

    // Clean up modal states
    setIsInserting(false);
    setInsertConnection(null);
  };

  const handleNodeDragStop = (id: string, position: { x: number; y: number }) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, position } : n))
    );
  };

  const handleUpdateNode = (config: NodeConfig, newLabel?: string) => {
    if (!selectedNodeId) return;

    const updated = updateNodeConfig(
      { nodes, connections },
      { nodeId: selectedNodeId, config, label: newLabel, stamp: Date.now() },
    );
    if (!updated) return;

    if (updated.pathsChanged) {
      applyGraphEdit(updated.graph);
    } else {
      setNodes(updated.graph.nodes);
      setConnections(updated.graph.connections);
    }
  };

  const handleDeleteNode = (id: string) => {
    const next = deleteNode({ nodes, connections }, id);
    if (!next) return;
    applyGraphEdit(next);
    setSelectedNodeId(null);
  };

  const handleSaveCampaign = (publish: boolean = false) => {
    if (!name.trim()) {
      alert("Campaign Name is required.");
      return;
    }

    let rootTree: CampaignTreeNode;
    try {
      rootTree = graphToTree(nodes, connections);
    } catch (error) {
      if (!(error instanceof InvalidJourneyGraphError)) throw error;
      alert(error.message);
      return;
    }

    const savedCampaign: Campaign = {
      id: campaign?.id || newCampaignId(),
      name,
      description,
      status: publish ? "active" : "draft",
      root: rootTree,
      created_at: campaign?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    onSave(savedCampaign, publish);
  };

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const isReadOnly = campaign ? (campaign.status === "active" || campaign.status === "paused") : false;

  const handleConnect = (params: Connection) => {
    const next = connect({ nodes, connections }, params);
    if (next) applyGraphEdit(next);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* Builder Top Control Bar */}
      <div className="px-8 py-4 border-b border-border bg-card shrink-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 space-y-2 max-w-xl">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isReadOnly}
            className="text-lg font-bold border-none px-0 shadow-none focus-visible:ring-0 h-8 disabled:opacity-100"
            placeholder="Campaign Name"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isReadOnly}
            rows={1}
            className="text-xs text-muted-foreground border-none p-0 min-h-0 resize-none shadow-none focus-visible:ring-0 leading-normal disabled:opacity-100"
            placeholder="Add campaign details..."
          />
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {isReadOnly ? (
            <>
              <div className="flex items-center gap-1.5 border border-border/60 rounded-lg px-2.5 py-1 bg-amber-500/10 text-amber-500 font-bold text-xs select-none">
                <span>🔒</span> Read-Only (Published)
              </div>
              <div className="flex items-center gap-1.5 border border-border rounded-lg px-2.5 py-1 bg-background text-xs font-semibold capitalize">
                Status: <span className="text-foreground font-bold">{campaign?.status}</span>
              </div>
              <Button onClick={onBack} variant="outline" size="sm">
                Back
              </Button>
              {onClone && campaign && (
                <Button
                  onClick={() => onClone(campaign)}
                  variant="default"
                  size="sm"
                  className="bg-violet-600 hover:bg-violet-700 text-white cursor-pointer"
                >
                  Clone to Edit
                </Button>
              )}
            </>
          ) : (
            <>
              {/* Pause and resume live on the campaign list. Here a campaign is a draft until it is published. */}
              <Badge variant="outline" size="lg">Draft</Badge>

              <Button onClick={onBack} variant="outline" size="sm">
                Cancel
              </Button>
              <Button 
                onClick={() => setIsAiModalOpen(true)}
                variant="outline" 
                size="sm"
                className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
              >
                ✨ AI Generate
              </Button>
              <div className="flex items-center shrink-0">
                <Button
                  onClick={() => handleSaveCampaign(false)}
                  className="bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold h-8 px-3 rounded-l-lg rounded-r-none border-r border-violet-700/50 cursor-pointer shadow-xs select-none"
                >
                  💾 Save Draft
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger className="inline-flex items-center justify-center w-8 h-8 rounded-r-lg rounded-l-none bg-violet-600 hover:bg-violet-700 text-white cursor-pointer shadow-xs select-none">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleSaveCampaign(true)} className="cursor-pointer flex items-center gap-2 p-2 font-bold text-violet-600 dark:text-violet-400">
                      🚀 Publish Campaign (to DB)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Builder Panel */}
      <div className="flex-1 flex overflow-hidden relative">
        {!isReadOnly && <Sidebar onAddNode={handleAddNodeFromSidebar} />}

        <Canvas
          nodes={nodes}
          connections={connections}
          selectedNodeId={selectedNodeId}
          onSelectNode={(id) => setSelectedNodeId(id)}
          onAddNodeBetween={handleAddNodeBetween}
          onAlign={handleAlign}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          readOnly={isReadOnly}
          stats={stats}
          statsFailed={statsFailed}
        />

        {selectedNode && (
          <NodeEditor
            key={selectedNode.id}
            node={selectedNode}
            pickers={pickers}
            onUpdate={handleUpdateNode}
            onClose={() => setSelectedNodeId(null)}
            onDeleteNode={handleDeleteNode}
            readOnly={isReadOnly}
          />
        )}
      </div>

      <Dialog
        open={pendingChannel !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChannel(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Place {pendingChannel?.label}</DialogTitle>
            <DialogDescription>
              Choose which outcome owns this channel and whether it runs alongside or before the existing path.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-6">
            <section className="space-y-3">
              <div>
                <h4 className="text-sm font-semibold">Origin path</h4>
                <p className="text-xs text-muted-foreground">The edge keeps this path&apos;s color and routing semantics.</p>
              </div>
              <RadioGroup
                aria-label="Origin path"
                value={channelOriginPath}
                onValueChange={(value) => setChannelOriginPath(String(value))}
                className="grid grid-cols-2 gap-3"
              >
                {selectedNode && getBranchOptions(selectedNode).map((option) => (
                  <Label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 has-data-checked:border-primary has-data-checked:bg-primary/5"
                  >
                    <Radio value={option.value} />
                    <span
                      className={`size-2.5 rounded-full ${
                        option.tone === "success"
                          ? "bg-emerald-500"
                          : option.tone === "danger"
                            ? "bg-rose-500"
                            : option.tone === "branch"
                              ? "bg-sky-500"
                              : "bg-slate-400"
                      }`}
                    />
                    <span className="text-sm font-semibold">{option.label}</span>
                  </Label>
                ))}
              </RadioGroup>
            </section>

            <section className="space-y-3">
              <div>
                <h4 className="text-sm font-semibold">Execution shape</h4>
                <p className="text-xs text-muted-foreground">This changes graph topology, not only its appearance.</p>
              </div>
              <RadioGroup
                aria-label="Execution shape"
                value={channelPlacementMode}
                onValueChange={(value) => setChannelPlacementMode(value as ChannelPlacementMode)}
                className="grid gap-3 sm:grid-cols-2"
              >
                <Label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-data-checked:border-primary has-data-checked:bg-primary/5">
                  <Radio value="parallel" />
                  <span>
                    <span className="block text-sm font-semibold">Parallel on this path</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      Add another sibling channel directly from the selected outcome.
                    </span>
                    <span className="mt-3 flex items-center gap-1 text-[10px] font-semibold text-primary">
                      PATH ─┬─ CHANNEL
                      <br />
                      <span className="pl-10">└─ EXISTING</span>
                    </span>
                  </span>
                </Label>
                <Label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-data-checked:border-primary has-data-checked:bg-primary/5">
                  <Radio value="sequence" />
                  <span>
                    <span className="block text-sm font-semibold">First in sequence</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      Insert this channel before everything already on the selected outcome.
                    </span>
                    <span className="mt-3 block text-[10px] font-semibold text-primary">
                      PATH ─ CHANNEL ─ EXISTING
                    </span>
                  </span>
                </Label>
              </RadioGroup>
            </section>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingChannel(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!pendingChannel || !selectedNode) return;
                addNodeFromSidebar(pendingChannel, {
                  sourceId: selectedNode.id,
                  branchType: channelOriginPath,
                  mode: channelPlacementMode,
                });
                setPendingChannel(null);
              }}
            >
              Add to path
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Insert Node Selector Modal overlay */}
      {isInserting && (
        <div className="absolute inset-0 bg-background/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-5 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-md font-bold text-foreground">Insert Predicate Element</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Select a block to insert in the flow sequence</p>
              </div>
              <button
                onClick={() => {
                  setIsInserting(false);
                  setInsertConnection(null);
                }}
                className="p-1.5 hover:bg-accent rounded text-muted-foreground"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-4 h-4"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <Sidebar
                onAddNode={(item) => {
                  handleConfirmInsert(item);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* AI Generator Modal */}
      {isAiModalOpen && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-foreground">✨ Generate Journey with AI</h3>
              <button onClick={() => setIsAiModalOpen(false)} className="text-muted-foreground hover:text-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {isGenerating ? (
              <div className="py-12 flex flex-col items-center justify-center space-y-4">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600"></div>
                <p className="text-indigo-600 font-medium animate-pulse">✨ AI is building your journey...</p>
              </div>
            ) : (
              <>
                <Textarea 
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. If user adds to cart but doesn't checkout in 15 minutes, send a reminder email."
                  className="min-h-[120px] mb-4 text-sm"
                />
                <div className="flex justify-end gap-3">
                  <Button variant="outline" onClick={() => setIsAiModalOpen(false)}>Cancel</Button>
                  <Button className="bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer" onClick={handleAIGenerate}>Generate</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
