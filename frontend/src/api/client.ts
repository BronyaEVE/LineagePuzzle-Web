/**
 * 网页版 API 客户端（替代后端 fetch）。
 *
 * 网页版没有后端：分析在浏览器内 Pyodide（Web Worker）跑，数据在内存 store。
 * 本文件保持与原 client.ts 完全相同的函数签名和返回类型，上层组件零改动。
 *
 * 实现分工：
 *   - 分析类（submitAnalysis）→ workerClient.analyze（Pyodide 跑 sqlglot）
 *   - 存储类（listScripts/getScript/...）→ memoryStore（内存 Map）
 *
 * 引擎就绪守卫：所有函数内部 await ensureEngine()，确保 Pyodide 加载完成。
 * refreshAll() 挂载即触发，此时引擎可能还在加载——守卫会等待就绪。
 */
import type {
  AnalysisResult,
  AnalyzeRequest,
  BatchSetTagsResult,
  DatabaseConfig,
  GlobalGraph,
  ImpactAnalysis,
  PreprocessRule,
  ScriptSummary,
  TagSchema,
} from "../types";
import { analyze as engineAnalyze, ensureEngine } from "../engine/workerClient";
import * as store from "../engine/memoryStore";

// ============================================================
// 分析
// ============================================================

export async function submitAnalysis(payload: AnalyzeRequest): Promise<AnalysisResult> {
  await ensureEngine();
  // 网页版只用预处理规则，database_config 忽略（浏览器无法连 DB）
  const result = await engineAnalyze(payload.script, store.getPreprocessRules());
  // 保存到内存 store + 累积全局边
  const saved = store.saveScript(result);
  return saved;
}

/** 批量分析：循环调引擎。dbConfig/tags 网页版支持 tags（统一打标），dbConfig 忽略。 */
export async function submitBatchAnalysis(
  files: { name: string; content: string }[],
  _dbConfig: DatabaseConfig | null,
  tags: string[] = []
): Promise<AnalysisResult[]> {
  await ensureEngine();
  const results: AnalysisResult[] = [];
  const rules = store.getPreprocessRules();
  for (const f of files) {
    try {
      const r = await engineAnalyze(f.content, rules);
      if (tags.length) r.tags = [...tags];
      store.saveScript(r);
      results.push(r);
    } catch (e) {
      // 单个文件失败不中断整批（与后端 analyze-batch 容错一致）
      console.error(`分析失败 ${f.name}:`, e);
    }
  }
  return results;
}

// ============================================================
// 脚本管理
// ============================================================

export async function listScripts(): Promise<ScriptSummary[]> {
  await ensureEngine();
  return store.listScripts();
}

export async function getScript(id: string): Promise<AnalysisResult> {
  await ensureEngine();
  const r = store.getScript(id);
  if (!r) throw new Error("脚本不存在");
  return r;
}

export async function deleteScript(id: string): Promise<void> {
  store.deleteScript(id);
}

export async function renameScript(id: string, name: string): Promise<void> {
  if (!store.renameScript(id, name)) throw new Error("脚本不存在");
}

// ============================================================
// 全局图谱
// ============================================================

export async function getGlobalGraph(): Promise<GlobalGraph> {
  await ensureEngine();
  return store.getGlobalGraph();
}

// ============================================================
// 预处理规则
// ============================================================

export async function getPreprocessRules(): Promise<PreprocessRule[]> {
  await ensureEngine();
  return store.getPreprocessRules();
}

export async function setPreprocessRules(rules: PreprocessRule[]): Promise<PreprocessRule[]> {
  return store.setPreprocessRules(rules);
}

// ============================================================
// 导入导出
// ============================================================

export async function exportData(): Promise<Record<string, unknown>> {
  return store.exportAll();
}

export async function importData(payload: Record<string, unknown>): Promise<void> {
  store.importAll(payload);
}

// ============================================================
// 影响分析（MVP stub：下次会话补图算法）
// ============================================================

export async function impactAnalysis(table: string): Promise<ImpactAnalysis> {
  // 网页版 MVP 暂不实现影响分析（networkx 图算法待移植到 JS）
  // 返回空结果，LineageGraph 会走 .catch 清空高亮的路径
  return {
    table,
    downstream: [],
    upstream: [],
    downstream_count: 0,
    upstream_count: 0,
    paths: {},
    upstream_paths: {},
    paths_truncated: false,
    has_cycle: false,
  };
}

// ============================================================
// 标签维度定义 + 脚本打标
// ============================================================

export async function getTagSchema(): Promise<TagSchema> {
  await ensureEngine();
  return store.getTagSchema();
}

export async function setTagSchema(schema: TagSchema): Promise<TagSchema> {
  return store.setTagSchema(schema);
}

export async function setScriptTags(scriptId: string, tags: string[]): Promise<AnalysisResult> {
  const r = store.setScriptTags(scriptId, tags);
  if (!r) throw new Error("脚本不存在");
  return r;
}

export async function batchSetScriptTags(
  scriptIds: string[],
  tags: string[]
): Promise<BatchSetTagsResult> {
  return store.batchSetScriptTags(scriptIds, tags);
}
