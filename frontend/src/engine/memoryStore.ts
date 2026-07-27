/**
 * 内存 Store —— 网页版的数据层（替代后端 store.py）。
 *
 * 网页版「不持久化」策略：数据全在内存，刷新即重置。
 * 这是 store.py 的内存等价物：
 *   - scripts: Map<id, AnalysisResult>   ← scripts/*.json
 *   - globalEdges: GlobalEdge[]           ← edges.jsonl（累积）
 *   - preprocessRules / tagSchema         ← *.json 配置文件
 *
 * 单线程 + 无并发，不需要 filelock。所有函数同步操作。
 */
import type {
  AnalysisResult,
  GlobalEdge,
  GlobalGraph,
  PreprocessRule,
  ScriptSummary,
  TagSchema,
  VisNode,
} from "../types";

// === 核心数据 ===
const scripts = new Map<string, AnalysisResult>();
const globalEdges: GlobalEdge[] = [];

// === 配置数据（内存默认值）===
let preprocessRules: PreprocessRule[] = [];
let tagSchema: TagSchema = { dimensions: [] };

let edgeSeq = 0; // 生成 edge_id 用

// ============================================================
// 脚本 CRUD（对应 store.py save_script / get_script / delete_script）
// ============================================================

/** 保存（或覆盖）脚本 + 累积全局边。对应 store.py:save_script。 */
export function saveScript(result: AnalysisResult): AnalysisResult {
  // 自动命名（与 store.py:144 一致）
  if (!result.name) {
    const d = new Date(result.created_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    result.name = `脚本_${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // 覆盖时先删该脚本的全局边（与 store.py replace_script_edges 语义一致）
  removeEdgesForScript(result.analysis_id);

  scripts.set(result.analysis_id, result);
  appendEdgesForScript(result);
  return result;
}

export function getScript(id: string): AnalysisResult | undefined {
  return scripts.get(id);
}

export function deleteScript(id: string): boolean {
  if (!scripts.has(id)) return false;
  scripts.delete(id);
  removeEdgesForScript(id);
  return true;
}

export function renameScript(id: string, name: string): boolean {
  const s = scripts.get(id);
  if (!s) return false;
  s.name = name;
  return true;
}

/** 列表摘要（对应 store.py:list_scripts），按 created_at 倒序。 */
export function listScripts(): ScriptSummary[] {
  return Array.from(scripts.values())
    .map((r) => ({
      analysis_id: r.analysis_id,
      name: r.name,
      created_at: r.created_at,
      statement_count: r.statement_group?.statements.length ?? 0,
      table_count: countTablesInScript(r),
      tags: r.tags ?? [],
    }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function countTablesInScript(r: AnalysisResult): number {
  const names = new Set<string>();
  for (const e of r.visualization.edges) {
    names.add(e.source);
    names.add(e.target);
  }
  return names.size;
}

// ============================================================
// 全局图谱（对应 store.py:get_global_graph）
// ============================================================

/** 累积的全局血缘图。节点角色由边推导（source/intermediate/target）。 */
export function getGlobalGraph(): GlobalGraph {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const e of globalEdges) {
    sources.add(e.source);
    targets.add(e.target);
  }

  const nodeMap = new Map<string, VisNode>();
  // 所有出现过的表都作为节点
  for (const name of new Set([...sources, ...targets])) {
    const isSrc = sources.has(name);
    const isTgt = targets.has(name);
    let ntype: VisNode["type"];
    if (isSrc && isTgt) ntype = "intermediate";
    else if (isSrc) ntype = "source";
    else ntype = "target";
    nodeMap.set(name, { id: name, label: name, type: ntype });
  }

  return { nodes: Array.from(nodeMap.values()), edges: [...globalEdges] };
}

// ============================================================
// 全局边的累积 / 清理（对应 store.py:_append_edges_for_script）
// ============================================================

/** 把脚本产生的血缘边转成 GlobalEdge 累积进 globalEdges。 */
function appendEdgesForScript(result: AnalysisResult): void {
  const now = new Date().toISOString();
  for (const lin of result.lineages) {
    if (!lin.source_table) continue;
    globalEdges.push({
      edge_id: `ge-${++edgeSeq}`,
      source: lin.source_table,
      target: lin.target_table,
      operation: lin.operation_type,
      script_id: result.analysis_id,
      statement_seq: lin.statement_seq,
      created_at: now,
      column_mappings: lin.column_mappings,
    });
  }
}

/** 移除某脚本的所有全局边（删除/覆盖脚本时调用）。 */
function removeEdgesForScript(scriptId: string): void {
  for (let i = globalEdges.length - 1; i >= 0; i--) {
    if (globalEdges[i].script_id === scriptId) {
      globalEdges.splice(i, 1);
    }
  }
}

// ============================================================
// 配置：预处理规则 + 标签维度（对应 store.py 的配置读写）
// ============================================================

export function getPreprocessRules(): PreprocessRule[] {
  return [...preprocessRules];
}

export function setPreprocessRules(rules: PreprocessRule[]): PreprocessRule[] {
  preprocessRules = [...rules];
  return [...preprocessRules];
}

export function getTagSchema(): TagSchema {
  return tagSchema;
}

export function setTagSchema(schema: TagSchema): TagSchema {
  tagSchema = { dimensions: schema.dimensions };
  return tagSchema;
}

/** 更新单个脚本的 tags（本地 patch，不重算边）。 */
export function setScriptTags(scriptId: string, tags: string[]): AnalysisResult | undefined {
  const s = scripts.get(scriptId);
  if (!s) return undefined;
  s.tags = [...tags];
  return s;
}

/** 批量打标。返回成功/失败列表（对应 store.py:batch_set_script_tags）。 */
export function batchSetScriptTags(
  scriptIds: string[],
  tags: string[]
): { updated: string[]; failed: { id: string; reason: string }[] } {
  const updated: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const id of scriptIds) {
    if (scripts.has(id)) {
      scripts.get(id)!.tags = [...tags];
      updated.push(id);
    } else {
      failed.push({ id, reason: "脚本不存在" });
    }
  }
  return { updated, failed };
}

// ============================================================
// 导入 / 导出（对应 store.py 的全量备份）
// ============================================================

export function exportAll(): Record<string, unknown> {
  return {
    scripts: Array.from(scripts.values()),
    global_edges: globalEdges,
    preprocess_rules: preprocessRules,
    tag_schema: tagSchema,
  };
}

export function importAll(data: Record<string, unknown>): void {
  scripts.clear();
  globalEdges.length = 0;

  const importedScripts = (data.scripts as AnalysisResult[]) ?? [];
  for (const s of importedScripts) {
    scripts.set(s.analysis_id, s);
  }
  const importedEdges = (data.global_edges as GlobalEdge[]) ?? [];
  globalEdges.push(...importedEdges);

  if (Array.isArray(data.preprocess_rules)) {
    preprocessRules = data.preprocess_rules as PreprocessRule[];
  }
  if (data.tag_schema && typeof data.tag_schema === "object") {
    tagSchema = data.tag_schema as TagSchema;
  }
}

// === 测试/重置用 ===
export function _reset(): void {
  scripts.clear();
  globalEdges.length = 0;
  preprocessRules = [];
  tagSchema = { dimensions: [] };
  edgeSeq = 0;
}
