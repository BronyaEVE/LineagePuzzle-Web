import React, { useMemo, useState, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type ReactFlowInstance,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Card, Empty, Tooltip, Drawer, Tag, Typography, Button, message } from "antd";
import { ColumnWidthOutlined, ColumnHeightOutlined, FileImageOutlined, FileOutlined } from "@ant-design/icons";
import { toPng } from "html-to-image";
import type { GlobalGraph, GlobalEdge, Visualization, ColumnMapping } from "../types";
import { GLOBAL_ID } from "../types";
import { impactAnalysis as fetchImpactAnalysis } from "../api/client";

const NODE_COLORS: Record<string, string> = {
  source: "#52c41a",
  intermediate: "#faad14",
  target: "#1890ff",
};

const NODE_BORDER_COLORS: Record<string, string> = {
  source: "#389e0d",
  intermediate: "#d48806",
  target: "#096dd9",
};

const NODE_H = 40;
// 节点宽度自适应：短表名收缩到最小，超长表名上限封顶 + 省略号
// MIN_W 留足余量给边缘的折叠按钮（14px），避免按钮占比过大遮挡视觉
const NODE_MIN_W = 150;
const NODE_MAX_W = 260;

// 布局参数（TB 和 LR 几何语义不同，分开定义避免混用导致重叠）：
//   TB（垂直）：层间沿 y 轴（垂直），层内沿 x 轴（水平）→ 层内按节点【宽度】算间距
//   LR（水平）：层间沿 x 轴（水平），层内沿 y 轴（垂直）→ 层内按节点【高度】算间距
// 注意：折叠按钮凸出节点边缘 7px，层间距需留够净空给按钮 + 箭头 + 边标签。
const LAYER_GAP_TB = 120;   // TB 层与层之间的垂直间距（y 轴）— 给箭头标签留空间
const INTRA_GAP_TB = 40;    // TB 层内节点之间的水平间隙（x 轴，节点边到边）
const LAYER_GAP_LR = 280;   // LR 层与层之间的水平间距（x 轴，需 ≥ 节点宽度 + 箭头空间）
const INTRA_GAP_LR = 20;    // LR 层内节点之间的垂直间隙（y 轴，节点边到边）

type LayoutDir = "TB" | "LR";

/**
 * 节点样式：宽度自适应（fit-content）但有上下限。
 * 短名（orders）收缩到 NODE_MIN_W；长名（staging.tmp_order_detail）
 * 增长到 NODE_MAX_W 封顶，label 用 ellipsis 截断。
 * label 文字包一层带 overflow 的 span，超出 maxWidth 显示省略号。
 */
// 表名显示截断阈值：超过则在 schema 名后省略，保证节点宽度可控
// 完整名仍存在 node.data.fullName，避免 CSS ellipsis 在 React Flow
// 嵌套结构里失效导致节点撑破 maxWidth 进而重叠
const LABEL_MAX_CHARS = 24;

function truncateLabel(label: string): string {
  if (label.length <= LABEL_MAX_CHARS) return label;
  // schema.table 格式：保留 schema + 前几个字符 + 省略号
  const dotIdx = label.indexOf(".");
  if (dotIdx > 0 && dotIdx < LABEL_MAX_CHARS - 3) {
    const schema = label.slice(0, dotIdx + 1);
    const rest = label.slice(dotIdx + 1, LABEL_MAX_CHARS - schema.length - 1);
    return `${schema}${rest}…`;
  }
  return label.slice(0, LABEL_MAX_CHARS - 1) + "…";
}

function nodeStyle(nodeType: string): React.CSSProperties {
  return {
    background: NODE_COLORS[nodeType] || "#d9d9d9",
    border: `2px solid ${NODE_BORDER_COLORS[nodeType] || "#8c8c8c"}`,
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    minWidth: NODE_MIN_W,
    maxWidth: NODE_MAX_W,
    width: "fit-content",
    textAlign: "center" as const,
    // 不设 overflow:hidden —— 折叠按钮需要露在节点边框外（连线接触处）。
    // inline style 的 overflow:hidden 优先级高于 CSS class 的 !important，会裁切按钮。
    // 表名截断改由 truncateLabel() 在 JS 层处理（已实现）。
    whiteSpace: "nowrap",
  };
}

function autoLayout(nodes: Node[], edges: Edge[], dir: LayoutDir): Node[] {
  if (nodes.length === 0) return nodes;
  const isVertical = dir === "TB";

  const outEdges: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};
  for (const n of nodes) { outEdges[n.id] = []; inDegree[n.id] = 0; }
  for (const e of edges) {
    if (outEdges[e.source]) outEdges[e.source].push(e.target);
    if (inDegree[e.target] !== undefined) inDegree[e.target]++;
  }

  const layers: string[][] = [];
  const assigned = new Set<string>();
  let queue = nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  if (queue.length === 0) queue = nodes.map((n) => n.id);

  while (queue.length > 0) {
    layers.push([...queue]);
    for (const id of queue) assigned.add(id);
    const next: string[] = [];
    for (const id of queue) {
      for (const target of outEdges[id]) {
        if (!assigned.has(target)) {
          inDegree[target]--;
          if (inDegree[target] <= 0) next.push(target);
        }
      }
    }
    queue = [...new Set(next)];
  }
  const remaining = nodes.filter((n) => !assigned.has(n.id)).map((n) => n.id);
  if (remaining.length > 0) layers.push(remaining);

  // 层间间距（层与层之间）：TB 沿 y 轴，LR 沿 x 轴
  const layerGap = isVertical ? LAYER_GAP_TB : LAYER_GAP_LR;
  // 层内间距（同层节点之间）：TB 沿 x 轴（水平，按宽度），LR 沿 y 轴（垂直，按高度）
  const intraGap = isVertical ? INTRA_GAP_TB : INTRA_GAP_LR;
  // 层内排列方向的节点占位尺寸。布局时拿不到实际渲染宽度（DOM 未 measure），
  // 用近似平均值（MIN 和 MAX 的中点）。TB 大部分节点接近 MIN_W，
  // 用 MAX_W 会导致同层节点间距过大（中间留大空隙）。
  const intraSize = isVertical ? Math.round((NODE_MIN_W + NODE_MAX_W) / 2) : NODE_H;
  const posMap: Record<string, { x: number; y: number }> = {};

  layers.forEach((layer, li) => {
    // TB：offset 是 x（层内水平排列），y 是层间距
    // LR：offset 是 y（层内垂直排列），x 是层间距
    const span = layer.length * (intraSize + intraGap) - intraGap;
    const start = -span / 2;
    layer.forEach((id, ni) => {
      const offset = start + ni * (intraSize + intraGap);
      if (isVertical) {
        posMap[id] = { x: offset, y: li * layerGap };
      } else {
        posMap[id] = { x: li * layerGap, y: offset };
      }
    });
  });

  return nodes.map((node) => ({
    ...node,
    position: posMap[node.id] || { x: 0, y: 0 },
    sourcePosition: isVertical ? Position.Bottom : Position.Right,
    targetPosition: isVertical ? Position.Top : Position.Left,
  }));
}

/**
 * 计算被折叠隐藏的节点集合。
 *
 * collapsedUp 里的节点：递归找全部祖先（上游链路）隐藏。
 * collapsedDown 里的节点：递归找全部后代（下游链路）隐藏。
 * 折叠发起节点本身永远不隐藏（用户要看它）。
 *
 * 菱形依赖安全：visited 集合防止环 / 重复访问；
 * n === 发起节点 时跳过，即使它在别的折叠方向里也不会被误隐藏。
 */
function computeHiddenNodes(
  edges: Edge[],
  collapsedUp: Set<string>,
  collapsedDown: Set<string>,
): Set<string> {
  if (collapsedUp.size === 0 && collapsedDown.size === 0) return new Set();

  // 构建邻接表
  const outMap = new Map<string, string[]>();
  const inMap = new Map<string, string[]>();
  for (const e of edges) {
    if (!outMap.has(e.source)) outMap.set(e.source, []);
    outMap.get(e.source)!.push(e.target);
    if (!inMap.has(e.target)) inMap.set(e.target, []);
    inMap.get(e.target)!.push(e.source);
  }

  const hidden = new Set<string>();

  // 折叠上游：对每个 collapsedUp 节点，DFS 找所有祖先
  for (const nodeId of collapsedUp) {
    const visited = new Set<string>();
    const stack = [...(inMap.get(nodeId) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      // 不隐藏其他折叠发起节点（它们是用户要看的目标）
      if (collapsedUp.has(n) || collapsedDown.has(n)) continue;
      hidden.add(n);
      stack.push(...(inMap.get(n) ?? []));
    }
  }

  // 折叠下游：对每个 collapsedDown 节点，DFS 找所有后代
  for (const nodeId of collapsedDown) {
    const visited = new Set<string>();
    const stack = [...(outMap.get(nodeId) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      if (collapsedUp.has(n) || collapsedDown.has(n)) continue;
      hidden.add(n);
      stack.push(...(outMap.get(n) ?? []));
    }
  }

  return hidden;
}

/** 反查哪些折叠发起点挡住了一个目标节点（用于搜索聚焦时自动展开）。
 *
 * 搜索聚焦的目标节点可能被折叠链隐藏在 hiddenNodes 里。本函数复刻
 * computeHiddenNodes 的逐发起点 DFS，记录每个折叠发起点的隐藏集合，
 * 然后挑出包含目标节点的那几个发起点。移除它们即可让目标重新可见。
 *
 * @param targetIds 需要变可见的节点 id 集合（节点聚焦=自身，边聚焦=两端）
 * @returns { up: 要移除的上游折叠发起点, down: 要移除的下游折叠发起点 }
 */
function findBlockingCollapses(
  edges: Edge[],
  collapsedUp: Set<string>,
  collapsedDown: Set<string>,
  targetIds: Set<string>,
): { up: Set<string>; down: Set<string> } {
  const blockingUp = new Set<string>();
  const blockingDown = new Set<string>();
  if (collapsedUp.size === 0 && collapsedDown.size === 0) {
    return { up: blockingUp, down: blockingDown };
  }
  // 构建邻接表
  const outMap = new Map<string, string[]>();
  const inMap = new Map<string, string[]>();
  for (const e of edges) {
    if (!outMap.has(e.source)) outMap.set(e.source, []);
    outMap.get(e.source)!.push(e.target);
    if (!inMap.has(e.target)) inMap.set(e.target, []);
    inMap.get(e.target)!.push(e.source);
  }
  // 对每个上游折叠发起点，DFS 其祖先；若命中目标，记下发起点
  for (const startId of collapsedUp) {
    const visited = new Set<string>();
    const stack = [...(inMap.get(startId) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      if (targetIds.has(n)) blockingUp.add(startId);
      // 不穿越其他折叠发起节点（与 computeHiddenNodes 的屏障语义一致）
      if (collapsedUp.has(n) || collapsedDown.has(n)) continue;
      stack.push(...(inMap.get(n) ?? []));
    }
  }
  // 对每个下游折叠发起点，DFS 其后代
  for (const startId of collapsedDown) {
    const visited = new Set<string>();
    const stack = [...(outMap.get(startId) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      if (targetIds.has(n)) blockingDown.add(startId);
      if (collapsedUp.has(n) || collapsedDown.has(n)) continue;
      stack.push(...(outMap.get(n) ?? []));
    }
  }
  return { up: blockingUp, down: blockingDown };
}

/** 解析聚焦目标对应的「需要变可见的节点 id 集合」+ 命中的边列表。
 *
 * 三种聚焦类型：
 *  - node: 节点自身
 *  - edge: 单条边的两端
 *  - field: 所有命中边的两端（搜字段名时，多条边可能都含该字段）
 *
 * 返回 null 表示目标在当前视图已失效（边找不到等），调用方应忽略本次聚焦。
 */
function resolveFocusNodeIds(
  target: { type: "node" | "edge" | "field"; id: string; edgeIds?: string[] },
  edges: Edge[],
): { nodeIds: Set<string>; hitEdges: Edge[] } | null {
  if (target.type === "node") {
    return { nodeIds: new Set([target.id]), hitEdges: [] };
  }
  if (target.type === "edge") {
    const found = edges.find((e) => e.id === target.id);
    if (!found) return null;
    return { nodeIds: new Set([found.source, found.target]), hitEdges: [found] };
  }
  // field: 用 SearchBox 聚合时透传的 edgeIds 找命中的边（更可靠）；
  // 兜底用 id（格式 `table.col`）重新扫 column_mappings 匹配（防止 edgeIds 缺失）。
  let hitEdges: Edge[];
  if (target.edgeIds && target.edgeIds.length > 0) {
    const idSet = new Set(target.edgeIds);
    hitEdges = edges.filter((e) => idSet.has(e.id));
  } else {
    const dot = target.id.indexOf(".");
    if (dot < 0) return null; // 不是 table.col 格式，无法兜底匹配
    const tbl = target.id.slice(0, dot);
    const col = target.id.slice(dot + 1);
    hitEdges = edges.filter((e) => {
      const ms = (e.data as { column_mappings?: { target_table?: string; target_column?: string; source_table?: string; source_columns?: string[] }[] } | undefined)?.column_mappings ?? [];
      return ms.some((m) =>
        (m.target_table === tbl && m.target_column === col) ||
        (m.source_table === tbl && (m.source_columns ?? []).includes(col)),
      );
    });
  }
  if (hitEdges.length === 0) return null;
  const nodeIds = new Set<string>();
  for (const e of hitEdges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  return { nodeIds, hitEdges };
}

/** 把影响分析返回的「全部路径」展开成边 id 集合。
 * 后端 v2.3 返回 list[list[str]]（含菱形依赖的平行路径），
 * 例如 A→C 的 upstream_paths["A"] = [["A","C"], ["A","B","C"]]。
 * 展开两层：每个表 → 多条路径 → 每条路径的相邻边。
 */
function buildEdgeSetFromPaths(
  pathsMap: Record<string, string[][]>,
  edgeIndex: Map<string, string>,
): Set<string> {
  const ids = new Set<string>();
  for (const pathList of Object.values(pathsMap)) {
    for (const path of pathList) {
      for (let i = 0; i < path.length - 1; i++) {
        const eid = edgeIndex.get(`${path[i]}→${path[i + 1]}`);
        if (eid) ids.add(eid);
      }
    }
  }
  return ids;
}

/** 自定义节点：在标准节点基础上叠加折叠按钮（入边侧/出边侧）。
 * 按钮位置响应布局方向：TB 时入边按钮在顶部、出边按钮在底部；LR 时在左右。
 * 折叠状态和计数通过 node.data 传入。
 */
interface CollapsibleNodeData {
  label: string;
  fullName?: string;
  nodeType?: string;
  isUpCollapsed?: boolean;
  isDownCollapsed?: boolean;
  hiddenUpCount?: number;
  hiddenDownCount?: number;
  hasInEdges?: boolean;
  hasOutEdges?: boolean;
}

const CollapseButton: React.FC<{
  collapsed: boolean;
  count: number;
  position: "in" | "out";
  isVertical: boolean;
  onClick: () => void;
}> = ({ collapsed, count, position, isVertical, onClick }) => {
  // 按钮位置类名：TB 时 in=顶部 out=底部；LR 时 in=左侧 out=右侧
  const posClass = isVertical
    ? (position === "in" ? "collapse-top" : "collapse-bottom")
    : (position === "in" ? "collapse-left" : "collapse-right");
  const label = collapsed ? (count > 0 ? `+${count}` : "+") : "−";
  return (
    <div
      className={`collapse-btn ${posClass} ${collapsed ? "collapse-active" : ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={collapsed ? `展开${position === "in" ? "上游" : "下游"}（${count} 个节点）` : `折叠${position === "in" ? "上游" : "下游"}链路`}
    >
      {label}
    </div>
  );
};

// Context：传 toggle 函数和布局方向给自定义节点组件（避免 nodeTypes 重建）
const CollapseContext = React.createContext<{
  toggleUp: (id: string) => void;
  toggleDown: (id: string) => void;
  isVertical: boolean;
}>({ toggleUp: () => {}, toggleDown: () => {}, isVertical: true });

const CollapsibleNode: React.FC<{ id: string; data: CollapsibleNodeData }> = ({ id, data }) => {
  const { toggleUp, toggleDown, isVertical } = React.useContext(CollapseContext);
  // Handle 是 ReactFlow 边的连接点。默认节点类型内置 Handle，自定义节点必须手动加，
  // 否则边找不到连接点 → path 不渲染（这正是之前边消失的根因）。
  // target Handle = 入边连接点（上游来），source Handle = 出边连接点（去下游）。
  // 位置随布局方向：TB 时 target=top/source=bottom，LR 时 target=left/source=right。
  const targetPos = isVertical ? Position.Top : Position.Left;
  const sourcePos = isVertical ? Position.Bottom : Position.Right;
  return (
    <div className="collapsible-node">
      <Handle type="target" position={targetPos} style={{ opacity: 0 }} />
      {data.label as string}
      <Handle type="source" position={sourcePos} style={{ opacity: 0 }} />
      {(data.hasInEdges || data.isUpCollapsed) && (
        <CollapseButton
          collapsed={!!data.isUpCollapsed}
          count={data.hiddenUpCount ?? 0}
          position="in"
          isVertical={isVertical}
          onClick={() => toggleUp(id)}
        />
      )}
      {(data.hasOutEdges || data.isDownCollapsed) && (
        <CollapseButton
          collapsed={!!data.isDownCollapsed}
          count={data.hiddenDownCount ?? 0}
          position="out"
          isVertical={isVertical}
          onClick={() => toggleDown(id)}
        />
      )}
    </div>
  );
};

const collapsibleNodeTypes = { collapsible: CollapsibleNode };

/** 搜索/程序化聚焦目标：
 *  - node: 聚焦单个节点（搜表名）
 *  - edge: 聚焦 source+target 两端 + 单边高亮（兼容旧路径，单条边聚焦）
 *  - field: 高亮所有含该字段的边（搜字段名，血缘语义：该字段在哪些流转路径出现）
 *
 * focusToken: 递增计数器。每次搜索选中都生成新 token，保证 effect 重跑——
 * 即使连续两次搜同一个表名（值相同），token 不同也会重新触发聚焦，
 * 解决「重复搜索无反馈」问题。
 */
export interface FocusTarget {
  type: "node" | "edge" | "field";
  id: string;            // node: node.id；edge: 边 id；field: 字段名
  focusToken: number;    // 递增 token，保证重复搜索重新触发
  // field 类型：该字段命中的全部边 id（由 SearchBox 聚合后透传）
  edgeIds?: string[];
}

interface Props {
  globalGraph: GlobalGraph | null;
  visualization: Visualization | null;
  highlightScriptId: string;
  highlightSeq: number | null;
  // 点边时反向高亮对应语句（列级场景：点边→右栏语句高亮）
  onEdgeSelectSeq?: (seq: number | null) => void;
  // 搜索选中后聚焦+高亮（由 App/Header 的搜索框驱动）
  focusTarget?: FocusTarget | null;
  // 标签筛选命中脚本 id 集合。null = 不筛选（显示全部全局边）；
  // 非 null = 全局视图下只渲染 script_id 在此集合中的边 + 这些边的端点节点（边驱动 + 孤立表补显）。
  // 单脚本视图忽略此参数。
  tagFilteredScriptIds?: Set<string> | null;
}

const LineageGraph: React.FC<Props> = ({
  globalGraph, visualization, highlightScriptId, highlightSeq, onEdgeSelectSeq, focusTarget,
  tagFilteredScriptIds,
}) => {
  const [layoutDir, setLayoutDir] = useState<LayoutDir>("TB");
  const isVertical = layoutDir === "TB";
  // React Flow 实例（onInit 时获取，替代 useReactFlow——后者要求在 Provider 内调用，
  // 而 LineageGraph 本身就是渲染 <ReactFlow> 的组件，不是其子组件，直接调 useReactFlow 会白屏）
  const reactFlowRef = React.useRef<ReactFlowInstance | null>(null);
  // 包裹 ReactFlow 的 div，用于 html-to-image 截图（PNG 导出）
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  // 选中的边（点边弹 Drawer 展示列级映射）
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  // 单边高亮 id（点边时只高亮这一条，区别于 seq 高亮——一条 JOIN 语句可能有多条边共享 seq）
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // 展开的节点 id：点击节点时记录，该节点显示完整名（不限长），其他节点保持截断
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  // 折叠状态：collapsedUpstream/collapsedDownstream 各自独立的节点 id 集合
  const [collapsedUpstream, setCollapsedUpstream] = useState<Set<string>>(new Set());
  const [collapsedDownstream, setCollapsedDownstream] = useState<Set<string>>(new Set());
  // 暂存的搜索聚焦目标：当目标被折叠隐藏时，先移除挡路的折叠点（异步重渲染），
  // 再由 pendingFocus effect 在目标变可见后补做 fitView。无暂存时为 null。
  const [pendingFocus, setPendingFocus] = useState<FocusTarget | null>(null);
  // 影响分析高亮的边 id 集合：downstream 橙色、upstream 青色（单击节点触发）
  const [impactDownstreamEdges, setImpactDownstreamEdges] = useState<Set<string>>(new Set());
  const [impactUpstreamEdges, setImpactUpstreamEdges] = useState<Set<string>>(new Set());
  // 字段搜索高亮的边 id 集合：搜字段名时高亮所有含该字段的边（紫色）。
  // 独立于影响分析，避免两者混淆；优先级低于单边选中，高于语句/脚本级。
  const [fieldHighlightEdges, setFieldHighlightEdges] = useState<Set<string>>(new Set());
  // 影响分析请求竞态防护：每次点击节点递增 token，只有最新请求的响应被采纳。
  // 避免快速连点多个节点时，先返回的响应覆盖最终结果。
  const impactTokenRef = useRef(0);
  // 组件是否仍挂载，防止卸载后 setState（请求未完成就切走）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const hasImpactHighlight = impactDownstreamEdges.size > 0 || impactUpstreamEdges.size > 0;
  const hasFieldHighlight = fieldHighlightEdges.size > 0;

  // 当选中脚本时，使用脚本自己的 visualization；否则用全局图
  const { laidNodes, laidEdges } = useMemo(() => {
    // 选了脚本（非全局）→ 用脚本级别的 visualization
    if (highlightScriptId !== GLOBAL_ID && visualization && visualization.nodes.length > 0) {
      const nodes: Node[] = visualization.nodes.map((n) => {
        // expandedNodeId 不进本 useMemo 依赖：展开是纯样式变化，
        // 不应触发全图重新布局（autoLayout 是 O(V+E)）。展开效果由下面的
        // 节点 style effect 单独应用，复用本 useMemo 算出的布局结果。
        return {
          id: n.id,
          type: "collapsible",
          data: { label: truncateLabel(n.label), fullName: n.label, nodeType: n.type },
          position: { x: 0, y: 0 },
          style: nodeStyle(n.type),
        };
      });
      const edges: Edge[] = visualization.edges.map((e, i) => ({
        id: `e-${i}`,
        source: e.source,
        target: e.target,
        label: e.label,
        data: {
          statement_seq: e.statement_seq,
          column_mappings: e.column_mappings || [],  // 列级血缘，点边时展示
        },
        // 默认不动画：SVG 流动动画在节点/边多时是卡顿主因，仅高亮时才 animated
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#8c8c8c", strokeWidth: 2 },
        labelStyle: { fontSize: 11, fontWeight: 600, fill: "#333" },
        labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
        labelBgPadding: [4, 8] as [number, number],
        labelBgBorderRadius: 3,
      }));
      return { laidNodes: autoLayout(nodes, edges, layoutDir), laidEdges: edges };
    }

    // 全局图
    if (!globalGraph || globalGraph.nodes.length === 0) {
      return { laidNodes: [], laidEdges: [] };
    }

    // 标签筛选：全局视图下按命中脚本过滤边（边驱动）。
    // 只保留 script_id 在 tagFilteredScriptIds 中的边，再由这些边推导节点（孤立表补显）。
    // tagFilteredScriptIds 为 null 或单脚本视图时不筛选（走到这里已经是全局视图，故只判 null）。
    const filterSet = tagFilteredScriptIds ?? null;
    const filteredGlobalEdges = filterSet
      ? globalGraph.edges.filter((e) => filterSet.has(e.script_id))
      : globalGraph.edges;
    // 被筛选后保留的节点 = 至少出现在一条保留边的端点上的节点（边驱动）
    const nodeIdsInEdges = new Set<string>();
    for (const e of filteredGlobalEdges) {
      nodeIdsInEdges.add(e.source);
      nodeIdsInEdges.add(e.target);
    }
    const nodes: Node[] = globalGraph.nodes
      .filter((n) => (!filterSet || nodeIdsInEdges.has(n.id)))
      .map((n) => {
        // expandedNodeId 不进本 useMemo 依赖（同上）
        return {
          id: n.id,
          type: "collapsible",
          data: { label: truncateLabel(n.label), fullName: n.label, nodeType: n.type },
          position: { x: 0, y: 0 },
          style: nodeStyle(n.type),
        };
      });
    const edges: Edge[] = filteredGlobalEdges.map((e: GlobalEdge, i: number) => ({
      id: `ge-${i}`,
      source: e.source,
      target: e.target,
      label: e.operation,
      data: {
        script_id: e.script_id,
        statement_seq: e.statement_seq,
        column_mappings: e.column_mappings || [],  // 列级血缘，点边时展示
      },
      // 默认不动画：SVG 流动动画在节点/边多时是卡顿主因，仅高亮时才 animated
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#8c8c8c", strokeWidth: 2 },
      labelStyle: { fontSize: 11, fontWeight: 600, fill: "#333" },
      labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
      labelBgPadding: [4, 8] as [number, number],
      labelBgBorderRadius: 3,
    }));

    return { laidNodes: autoLayout(nodes, edges, layoutDir), laidEdges: edges };
  }, [globalGraph, visualization, highlightScriptId, layoutDir, tagFilteredScriptIds]);

  // 折叠过滤：基于折叠状态计算隐藏节点，再过滤显示的节点/边
  const hiddenNodes = useMemo(
    () => computeHiddenNodes(laidEdges, collapsedUpstream, collapsedDownstream),
    [laidEdges, collapsedUpstream, collapsedDownstream],
  );
  const visibleNodes = useMemo(
    () => laidNodes.filter((n) => !hiddenNodes.has(n.id)),
    [laidNodes, hiddenNodes],
  );
  const visibleEdges = useMemo(
    () => laidEdges.filter((e) => !hiddenNodes.has(e.source) && !hiddenNodes.has(e.target)),
    [laidEdges, hiddenNodes],
  );
  // 各节点的隐藏上游/下游计数（用于按钮显示 +N）
  const hiddenUpCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (collapsedUpstream.size === 0) return counts;
    const inMap = new Map<string, Set<string>>();
    for (const e of laidEdges) {
      if (!inMap.has(e.target)) inMap.set(e.target, new Set());
      inMap.get(e.target)!.add(e.source);
    }
    // 对每个折叠上游的节点，递归数祖先（含被隐藏的）
    for (const nodeId of collapsedUpstream) {
      const visited = new Set<string>();
      const stack = [...(inMap.get(nodeId) ?? [])];
      let count = 0;
      while (stack.length) {
        const n = stack.pop()!;
        if (visited.has(n)) continue;
        visited.add(n);
        count++;
        stack.push(...(inMap.get(n) ?? []));
      }
      counts.set(nodeId, count);
    }
    return counts;
  }, [laidEdges, collapsedUpstream]);
  const hiddenDownCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (collapsedDownstream.size === 0) return counts;
    const outMap = new Map<string, Set<string>>();
    for (const e of laidEdges) {
      if (!outMap.has(e.source)) outMap.set(e.source, new Set());
      outMap.get(e.source)!.add(e.target);
    }
    for (const nodeId of collapsedDownstream) {
      const visited = new Set<string>();
      const stack = [...(outMap.get(nodeId) ?? [])];
      let count = 0;
      while (stack.length) {
        const n = stack.pop()!;
        if (visited.has(n)) continue;
        visited.add(n);
        count++;
        stack.push(...(outMap.get(n) ?? []));
      }
      counts.set(nodeId, count);
    }
    return counts;
  }, [laidEdges, collapsedDownstream]);

  const [nodes, setNodes, onNodesChange] = useNodesState(visibleNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(visibleEdges);

  // 高亮逻辑：单边（点边）> 影响分析（上下游双色）> 语句级（点语句）> 脚本级 > 默认
  //
  // 基于 visibleEdges（折叠后）重算高亮。折叠时高亮的边如果被隐藏，自然消失。
  React.useEffect(() => {
    setEdges(visibleEdges.map((e) => {
      // 最高优先级：点边单条高亮（用 edge.id 定位，避免同 seq 多边被误点亮）
      if (selectedEdgeId !== null) {
        const hl = e.id === selectedEdgeId;
        return {
          ...e, animated: hl,
          style: { ...e.style, stroke: hl ? "#1890ff" : "#d9d9d9", strokeWidth: hl ? 3 : 1.5 },
          labelStyle: { ...e.labelStyle, fill: hl ? "#1890ff" : "#999" },
        };
      }
      // 影响分析高亮：下游橙 #fa8c16，上游青 #13c2c2，无关边灰
      if (hasImpactHighlight) {
        const isDown = impactDownstreamEdges.has(e.id);
        const isUp = impactUpstreamEdges.has(e.id);
        if (isDown) {
          return {
            ...e, animated: true,
            style: { ...e.style, stroke: "#fa8c16", strokeWidth: 3 },
            labelStyle: { ...e.labelStyle, fill: "#fa8c16" },
          };
        }
        if (isUp) {
          return {
            ...e, animated: true,
            style: { ...e.style, stroke: "#13c2c2", strokeWidth: 3 },
            labelStyle: { ...e.labelStyle, fill: "#13c2c2" },
          };
        }
        // 无关边：灰、不流动
        return {
          ...e, animated: false,
          style: { ...e.style, stroke: "#d9d9d9", strokeWidth: 1 },
          labelStyle: { ...e.labelStyle, fill: "#bbb" },
        };
      }
      // 字段搜索高亮：命中的边紫色 #722ed1（与搜索框 ◇ 图标同色），其他灰。
      // 优先级低于单边选中/影响分析，高于语句级/脚本级。
      if (hasFieldHighlight) {
        const hl = fieldHighlightEdges.has(e.id);
        return {
          ...e, animated: hl,
          style: { ...e.style, stroke: hl ? "#722ed1" : "#d9d9d9", strokeWidth: hl ? 3 : 1.5 },
          labelStyle: { ...e.labelStyle, fill: hl ? "#722ed1" : "#999" },
        };
      }
      // 语句级别高亮（右栏点语句：该 seq 的所有边，多条是期望行为）
      if (highlightSeq !== null) {
        const seq = e.data?.statement_seq;
        const hl = seq === highlightSeq;
        return {
          ...e, animated: hl,
          style: { ...e.style, stroke: hl ? "#1890ff" : "#d9d9d9", strokeWidth: hl ? 3 : 1.5 },
          labelStyle: { ...e.labelStyle, fill: hl ? "#1890ff" : "#999" },
        };
      }
      // 全局图：选中脚本时高亮该脚本（script_id）的边，其他灰
      // （方案B后此分支仅在兼容旧逻辑时触发，正常路径下全局视图 highlightScriptId === GLOBAL_ID）
      if (highlightScriptId !== GLOBAL_ID) {
        const sid = (e.data as { script_id?: string } | undefined)?.script_id;
        const hl = sid === highlightScriptId;
        return {
          ...e, animated: hl,
          style: { ...e.style, stroke: hl ? "#1890ff" : "#d9d9d9", strokeWidth: hl ? 2.5 : 1 },
          labelStyle: { ...e.labelStyle, fill: hl ? "#1890ff" : "#bbb" },
        };
      }
      // 默认：全部正常显示（不流动动画，避免边多时卡顿）
      return { ...e, animated: false, style: { ...e.style, stroke: "#8c8c8c", strokeWidth: 2 },
        labelStyle: { ...e.labelStyle, fill: "#333" } };
    }));
  }, [visibleEdges, highlightSeq, highlightScriptId, selectedEdgeId, hasImpactHighlight, impactDownstreamEdges, impactUpstreamEdges, hasFieldHighlight, fieldHighlightEdges, setEdges]);

  // 搜索选中后聚焦+高亮（由 App 的 focusTarget 驱动）。
  // 折叠链可能把目标节点隐藏 → fitView 找不到不可见节点会静默失败。
  // 处理：先解析目标节点 id（resolveFocusNodeIds 统一处理 node/edge/field 三类），
  // 检查是否在 hiddenNodes 中；若被隐藏，移除挡路的折叠发起点让目标重新可见
  // （异步重渲染），并暂存到 pendingFocus，由下方的补做 effect 在目标变可见后
  // 执行 fitView。这样无论折叠与否搜索都能聚焦。
  React.useEffect(() => {
    if (!focusTarget || !reactFlowRef.current) return;
    const resolved = resolveFocusNodeIds(focusTarget, edges);
    if (!resolved) return; // 目标在当前视图已失效（边消失等），忽略
    const { nodeIds: needVisible, hitEdges } = resolved;
    // 反查挡住目标的折叠发起点
    const { up: blockUp, down: blockDown } = findBlockingCollapses(
      laidEdges, collapsedUpstream, collapsedDownstream, needVisible,
    );
    if (blockUp.size > 0 || blockDown.size > 0) {
      // 有挡路折叠点：移除它们，目标会在重渲染后变可见，暂存待补做
      if (blockUp.size > 0) {
        setCollapsedUpstream((prev) => {
          const next = new Set(prev);
          for (const id of blockUp) next.delete(id);
          return next;
        });
      }
      if (blockDown.size > 0) {
        setCollapsedDownstream((prev) => {
          const next = new Set(prev);
          for (const id of blockDown) next.delete(id);
          return next;
        });
      }
      setPendingFocus(focusTarget);
      return;
    }
    // 无挡路折叠点：但目标本身可能因别的原因不可见（理论上不应发生，兜底）
    if ([...needVisible].some((id) => hiddenNodes.has(id))) {
      setPendingFocus(focusTarget);
      return;
    }
    // 目标可见，直接聚焦 + 应用高亮
    const rf = reactFlowRef.current;
    if (focusTarget.type === "node") {
      // 搜表名 = 点节点的效果：fitView + 展开表名 + 影响分析高亮（上下游双色）
      rf.fitView({ nodes: [{ id: focusTarget.id }], padding: 0.5, duration: 400, maxZoom: 1.5 });
      setExpandedNodeId(focusTarget.id);
      setSelectedEdgeId(null);
      setSelectedEdge(null);
      setFieldHighlightEdges(new Set());
      triggerImpactAnalysis(focusTarget.id);
    } else if (focusTarget.type === "edge" && hitEdges.length > 0) {
      const e = hitEdges[0];
      rf.fitView({
        nodes: [{ id: e.source }, { id: e.target }],
        padding: 0.5, duration: 400, maxZoom: 1.5,
      });
      setSelectedEdgeId(e.id);
      setSelectedEdge(e);
      setFieldHighlightEdges(new Set());
    } else if (focusTarget.type === "field") {
      // 字段搜索：高亮所有命中边 + fitView 涵盖这些边的全部端点节点
      rf.fitView({
        nodes: [...needVisible].map((id) => ({ id })),
        padding: 0.5, duration: 400, maxZoom: 1.5,
      });
      setFieldHighlightEdges(new Set(hitEdges.map((e) => e.id)));
      setSelectedEdgeId(null);
      setSelectedEdge(null);
      setExpandedNodeId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  // pendingFocus 补做：折叠点移除后目标变可见，这里在下一轮渲染补做 fitView。
  // 依赖 hiddenNodes（折叠移除后它重算 → 本 effect 重跑）+ pendingFocus 本身。
  React.useEffect(() => {
    if (!pendingFocus || !reactFlowRef.current) return;
    const resolved = resolveFocusNodeIds(pendingFocus, edges);
    if (!resolved) { setPendingFocus(null); return; }
    const { nodeIds: needVisible, hitEdges } = resolved;
    // 目标仍未全部可见（折叠移除可能不够，或边已消失）→ 放弃，避免死循环
    if ([...needVisible].some((id) => hiddenNodes.has(id))) {
      setPendingFocus(null);
      return;
    }
    const rf = reactFlowRef.current;
    // 等一帧让 ReactFlow 完成节点坐标计算（折叠移除后新节点刚加入需要布局）
    const t = window.setTimeout(() => {
      if (pendingFocus.type === "node") {
        // 搜表名 = 点节点效果：fitView + 展开表名 + 影响分析高亮（上下游双色）
        rf.fitView({ nodes: [{ id: pendingFocus.id }], padding: 0.5, duration: 400, maxZoom: 1.5 });
        setExpandedNodeId(pendingFocus.id);
        setSelectedEdgeId(null);
        setSelectedEdge(null);
        setFieldHighlightEdges(new Set());
        triggerImpactAnalysis(pendingFocus.id);
      } else if (pendingFocus.type === "edge" && hitEdges.length > 0) {
        const e = hitEdges[0];
        rf.fitView({
          nodes: [{ id: e.source }, { id: e.target }],
          padding: 0.5, duration: 400, maxZoom: 1.5,
        });
        setSelectedEdgeId(e.id);
        setSelectedEdge(e);
        setFieldHighlightEdges(new Set());
      } else if (pendingFocus.type === "field") {
        rf.fitView({
          nodes: [...needVisible].map((id) => ({ id })),
          padding: 0.5, duration: 400, maxZoom: 1.5,
        });
        setFieldHighlightEdges(new Set(hitEdges.map((e) => e.id)));
        setSelectedEdgeId(null);
        setSelectedEdge(null);
        setExpandedNodeId(null);
      }
      setPendingFocus(null);
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, hiddenNodes]);

  // 节点同步：布局/折叠变化时同步可见节点 + 应用展开样式 + 注入折叠按钮信息。
  // 折叠按钮信息（isUpCollapsed/isDownCollapsed/hiddenUpCount/hiddenDownCount/hasInEdges/hasOutEdges）
  // 通过 node.data 传给自定义节点组件渲染。
  React.useEffect(() => {
    // 构建当前可见边的入/出度索引（判断节点是否有入边/出边，决定按钮显隐）
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const e of visibleEdges) {
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
      outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    }
    setNodes(visibleNodes.map((n) => {
      const expanded = expandedNodeId === n.id;
      const isUpCollapsed = collapsedUpstream.has(n.id);
      const isDownCollapsed = collapsedDownstream.has(n.id);
      const fullName = (n.data as { fullName?: string }).fullName ?? String((n.data as { label?: unknown }).label ?? "");
      return {
        ...n,
        data: {
          ...n.data,
          label: expanded ? fullName : (n.data as { label?: unknown }).label,
          isUpCollapsed,
          isDownCollapsed,
          hiddenUpCount: hiddenUpCounts.get(n.id) ?? 0,
          hiddenDownCount: hiddenDownCounts.get(n.id) ?? 0,
          hasInEdges: (inDeg.get(n.id) ?? 0) > 0 || isUpCollapsed,
          hasOutEdges: (outDeg.get(n.id) ?? 0) > 0 || isDownCollapsed,
        },
        style: expanded
          ? { ...n.style, maxWidth: "none", border: "3px solid #fff", boxShadow: "0 0 8px rgba(255,255,255,0.8)" }
          : n.style,
      };
    }));
  }, [visibleNodes, visibleEdges, expandedNodeId, collapsedUpstream, collapsedDownstream, hiddenUpCounts, hiddenDownCounts, setNodes]);

  // 视图切换清理：切脚本/切全局时，清掉属于上一个图的内部选中态。
  // 否则全局点边（ge-5）后切脚本，selectedEdgeId 仍是 ge-5 匹配不到 e- 边，
  // 高亮 effect 把所有边判为"未选中"导致全灰。同理影响分析的 ge- 边 id。
  React.useEffect(() => {
    setSelectedEdgeId(null);
    setSelectedEdge(null);
    setImpactDownstreamEdges(new Set());
    setImpactUpstreamEdges(new Set());
    setFieldHighlightEdges(new Set());
    setExpandedNodeId(null);
    impactTokenRef.current++; // 作废可能还在途的影响分析请求
    setCollapsedUpstream(new Set());
    setCollapsedDownstream(new Set());
    setPendingFocus(null); // 作废可能暂存的搜索聚焦补做
  }, [highlightScriptId]);

  // 折叠/展开操作（由自定义节点组件的按钮调用）
  const toggleCollapseUp = (nodeId: string) => {
    setCollapsedUpstream((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    // 折叠后清影响分析高亮和字段高亮（高亮的边可能已隐藏）
    setImpactDownstreamEdges(new Set());
    setImpactUpstreamEdges(new Set());
    setFieldHighlightEdges(new Set());
  };
  const toggleCollapseDown = (nodeId: string) => {
    setCollapsedDownstream((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    setImpactDownstreamEdges(new Set());
    setImpactUpstreamEdges(new Set());
    setFieldHighlightEdges(new Set());
  };

  // 触发影响分析：拉取某节点的上下游全部路径 → 高亮对应边（下游橙/上游青）。
  // 抽出来供 onNodeClick 和搜索聚焦（搜表名）复用——搜表名 = 点节点的效果。
  // 竞态防护：每次调用递增 token，响应回来时校验是否仍是最新触发。
  const triggerImpactAnalysis = (nodeId: string) => {
    const myToken = ++impactTokenRef.current;
    fetchImpactAnalysis(nodeId).then((result) => {
      // 过期响应（用户又点了别的节点/又搜了别的）或组件已卸载 → 丢弃
      if (myToken !== impactTokenRef.current || !mountedRef.current) return;
      if (result.error || (!result.downstream.length && !result.upstream.length)) {
        setImpactDownstreamEdges(new Set());
        setImpactUpstreamEdges(new Set());
        return;
      }
      // 建 (src→tgt) → edgeId 索引。
      // 边 id 前缀随视图不同：全局图 ge-${i}，脚本视图 e-${i}。
      // 从 ReactFlow 实例实时取当前渲染的边（而非闭包里的 edges 快照），
      // 保证聚焦 effect 的 setTimeout 补做路径也能拿到折叠展开后的最新边。
      const currentEdges = reactFlowRef.current?.getEdges() ?? edges;
      const edgeIndex = new Map<string, string>();
      currentEdges.forEach((e: Edge) => {
        edgeIndex.set(`${e.source}→${e.target}`, e.id);
      });
      setImpactDownstreamEdges(buildEdgeSetFromPaths(result.paths || {}, edgeIndex));
      setImpactUpstreamEdges(buildEdgeSetFromPaths(result.upstream_paths || {}, edgeIndex));
      // 路径过多被裁剪时提示用户（病态图才会触发，正常数仓不会）
      if (result.paths_truncated) {
        message.warning("血缘路径较多，仅高亮部分链路（受路径数上限保护）");
      }
    }).catch(() => {
      if (myToken !== impactTokenRef.current || !mountedRef.current) return;
      setImpactDownstreamEdges(new Set());
      setImpactUpstreamEdges(new Set());
    });
  };

  const hasData = laidNodes.length > 0;
  const isScriptView = highlightScriptId !== GLOBAL_ID && !!visualization?.nodes.length;

  // === 图形导出 ===
  const handleExportPng = async () => {
    if (!wrapperRef.current) return;
    try {
      // 先重置视口到全图，确保截图覆盖所有节点
      reactFlowRef.current?.fitView({ padding: 0.2, duration: 0 });
      // 等一帧让 React Flow 完成重置
      await new Promise((r) => setTimeout(r, 100));
      const dataUrl = await toPng(wrapperRef.current!, {
        backgroundColor: "#fff",
        filter: (node) => {
          // 排除 React Flow 的控件（Controls/MiniMap），只截图画
          const cls = (node as HTMLElement).className;
          return typeof cls !== "string" || (!cls.includes("react-flow__controls") && !cls.includes("react-flow__minimap"));
        },
      });
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = dataUrl;
      a.download = `lineage-${ts}.png`;
      a.click();
    } catch {
      message.error("导出 PNG 失败");
    }
  };

  const handleExportHtml = () => {
    // 导出自包含 HTML：nodes/edges JSON + React Flow CDN，打开是可缩放只读图
    const data = JSON.stringify({ nodes: laidNodes, edges: laidEdges }, null, 2);
    const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>LineagePuzzle 血缘图</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xyflow/react@12/dist/style.css">
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xyflow/react@12/dist/umd/index.js"></script>
<style>
  body { margin: 0; }
  #app { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="app"></div>
<script>
  var graphData = ${data};
  var e = React.createElement;
  var app = e(XyFlow.ReactFlow,
    { nodes: graphData.nodes, edges: graphData.edges, fitView: true,
      proOptions: { hideAttribution: true } },
    e(XyFlow.Background, { gap: 16 }),
    e(XyFlow.Controls),
    e(XyFlow.MiniMap)
  );
  ReactDOM.createRoot(document.getElementById('app')).render(app);
</script>
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `lineage-${ts}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card
      title={isScriptView ? "脚本血缘图" : "全局血缘图谱"}
      size="small"
      style={{ height: "100%" }}
      extra={
        hasData ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Tooltip title={isVertical ? "切换为水平布局" : "切换为垂直布局"}>
              <button
                onClick={() => setLayoutDir(isVertical ? "LR" : "TB")}
                style={{
                  background: "transparent", border: "1px solid #d9d9d9", borderRadius: 4,
                  padding: "2px 8px", cursor: "pointer", fontSize: 14, color: "#666",
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}
              >
                {isVertical ? <ColumnWidthOutlined /> : <ColumnHeightOutlined />}
                {isVertical ? "水平" : "垂直"}
              </button>
            </Tooltip>
            <Tooltip title="导出为 PNG 图片">
              <Button size="small" icon={<FileImageOutlined />} onClick={handleExportPng}>PNG</Button>
            </Tooltip>
            <Tooltip title="导出为自包含 HTML（可缩放，需联网打开）">
              <Button size="small" icon={<FileOutlined />} onClick={handleExportHtml}>HTML</Button>
            </Tooltip>
          </div>
        ) : null
      }
    >
      {hasData ? (
        <div ref={wrapperRef} style={{ height: "calc(100vh - 160px)", minHeight: 300 }}>
          <CollapseContext.Provider value={{ toggleUp: toggleCollapseUp, toggleDown: toggleCollapseDown, isVertical }}>
          <ReactFlow
            nodes={nodes} edges={edges}
            nodeTypes={collapsibleNodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onInit={(inst) => { reactFlowRef.current = inst; }}
            onNodeClick={(_, node) => {
              // 再次点同一节点：收起表名 + 取消影响分析高亮
              if (expandedNodeId === node.id) {
                setExpandedNodeId(null);
                setImpactDownstreamEdges(new Set());
                setImpactUpstreamEdges(new Set());
                impactTokenRef.current++; // 作废可能还在途的请求
                return;
              }
              // 展开表名 + 点节点触发影响分析 → 清字段搜索高亮，避免两种高亮叠加
              setExpandedNodeId(node.id);
              setFieldHighlightEdges(new Set());
              setSelectedEdgeId(null);
              setSelectedEdge(null);
              triggerImpactAnalysis(node.id);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdge(edge);
              setSelectedEdgeId(edge.id);  // 单边高亮（只这一条，不用 seq 避免 JOIN 多边误亮）
              setFieldHighlightEdges(new Set()); // 清字段搜索高亮，避免取消单边选中后残留
            }}
            fitView fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2} maxZoom={2}
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const t = (n.data as { nodeType?: string })?.nodeType;
                return NODE_COLORS[t || ""] || "#d9d9d9";
              }}
              maskColor="rgba(0,0,0,0.1)"
            />
          </ReactFlow>
          </CollapseContext.Provider>
        </div>
      ) : (
        <Empty description={isScriptView ? "该脚本无血缘数据" : "提交第一个脚本开始构建血缘图谱"} style={{ marginTop: 80 }} />
      )}

      {/* 列级血缘映射抽屉：点边展示目标列←源列 + transform */}
      <Drawer
        title="列级血缘映射"
        open={!!selectedEdge}
        onClose={() => { setSelectedEdge(null); setSelectedEdgeId(null); if (onEdgeSelectSeq) onEdgeSelectSeq(null); }}
        width={440}
        size="default"
      >
        {selectedEdge ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              <strong>{selectedEdge.source}</strong> → <strong>{selectedEdge.target}</strong>
              <span style={{ marginLeft: 8 }}>
                操作：<Tag color="blue">{selectedEdge.label}</Tag>
                语句 #{(selectedEdge.data as { statement_seq?: number })?.statement_seq}
              </span>
            </Typography.Paragraph>
            {(() => {
              const mappings = (selectedEdge.data as { column_mappings?: ColumnMapping[] })?.column_mappings || [];
              if (mappings.length === 0) {
                return (
                  <Empty
                    description="该边无列级映射（可能为 SELECT * 或纯表级血缘）"
                    style={{ marginTop: 40 }}
                  />
                );
              }
              return mappings.map((m, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 12px", marginBottom: 8,
                    background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Tag color="blue">{m.target_column}</Tag>
                    <span style={{ color: "#999" }}>←</span>
                    {m.source_columns.length > 0 ? (
                      m.source_columns.map((c, ci) => (
                        <Tag key={ci} color="green">
                          {m.source_table ? `${m.source_table}.${c}` : c}
                        </Tag>
                      ))
                    ) : (
                      <Tag>常量</Tag>
                    )}
                  </div>
                  {m.transformation && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#fa8c16" }}>
                      变换：{m.transformation}
                    </div>
                  )}
                </div>
              ));
            })()}
          </>
        ) : null}
      </Drawer>
    </Card>
  );
};

export default LineageGraph;
