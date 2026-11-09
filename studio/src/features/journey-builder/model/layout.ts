import type { JourneyGraph } from "@/entities/journey/model/graphEdits";
import { NO_EDGE, YES_EDGE, type CampaignConnection } from "@/entities/journey/model/types";

// The canvas lays steps out for the marketer, top to bottom: one row per level, one lane per leaf.

export const CARD = { width: 220, height: 70, endHeight: 56 } as const;
const LANE = 250;
const ROW = 120;
const TOP = 28;
const SIDE = 16;

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
}

export interface PlacedEdge extends CampaignConnection {
  /** The SVG path from the parent's bottom to the child's top. */
  d: string;
  /** Where the + button sits, on the child's side of the edge. */
  plus: { x: number; y: number };
  /** Where the branch label sits, or null when the parent has one path. */
  tag: { x: number; y: number } | null;
}

export interface Layout {
  nodes: Map<string, PlacedNode>;
  edges: PlacedEdge[];
  width: number;
  height: number;
}

function rank(connection: CampaignConnection): number {
  if (connection.type === YES_EDGE) return 0;
  if (connection.type === NO_EDGE) return 2;
  return 1;
}

export function layoutGraph(graph: JourneyGraph): Layout {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const children = new Map<string, CampaignConnection[]>();
  for (const c of graph.connections) {
    if (!ids.has(c.to)) continue;
    children.set(c.from, [...(children.get(c.from) ?? []), c].sort((a, b) => rank(a) - rank(b)));
  }

  const lanes = new Map<string, number>();
  const width = (id: string): number => {
    const known = lanes.get(id);
    if (known !== undefined) return known;
    const total = Math.max(1, (children.get(id) ?? []).reduce((sum, c) => sum + width(c.to), 0));
    lanes.set(id, total);
    return total;
  };

  const nodes = new Map<string, PlacedNode>();
  let depthMax = 0;
  const place = (id: string, depth: number, firstLane: number) => {
    if (nodes.has(id)) return;
    const span = width(id);
    nodes.set(id, { id, x: SIDE + (firstLane + span / 2) * LANE - CARD.width / 2, y: TOP + depth * ROW });
    depthMax = Math.max(depthMax, depth);
    let lane = firstLane;
    for (const c of children.get(id) ?? []) {
      place(c.to, depth + 1, lane);
      lane += width(c.to);
    }
  };

  const root = graph.nodes.find((n) => n.type === "setup")?.id;
  const totalLanes = root ? width(root) : 0;
  if (root) place(root, 0, 0);

  const edges: PlacedEdge[] = [];
  for (const [from, outgoing] of children) {
    const parent = nodes.get(from);
    if (!parent) continue;
    const px = parent.x + CARD.width / 2;
    const py = parent.y + CARD.height;
    const mid = py + (ROW - CARD.height) / 2 - 4;
    for (const c of outgoing) {
      const child = nodes.get(c.to);
      if (!child) continue;
      const cx = child.x + CARD.width / 2;
      edges.push({
        ...c,
        d: cx === px ? `M${px} ${py}V${child.y}` : `M${px} ${py}V${mid}H${cx}V${child.y}`,
        plus: { x: cx, y: cx === px ? child.y - 14 : (mid + child.y) / 2 + 2 },
        tag: outgoing.length > 1 || c.type !== YES_EDGE ? { x: cx === px ? cx : (px + cx) / 2, y: cx === px ? py + 12 : mid } : null,
      });
    }
  }

  return { nodes, edges, width: SIDE * 2 + totalLanes * LANE, height: TOP + (depthMax + 1) * ROW };
}
