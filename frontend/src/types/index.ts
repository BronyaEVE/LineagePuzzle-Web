// === Request Types ===

/** 全局图谱的虚拟脚本 ID。
 * 全局图不对应某个具体脚本，作为脚本列表里的虚拟置顶项存在。
 * selectedScriptId === GLOBAL_ID 时显示全局图，否则显示对应脚本图。
 * App 层拦截此 ID，走 getGlobalGraph 而非 getScript。
 */
export const GLOBAL_ID = "__global__";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface AnalyzeRequest {
  script: string;
  // DESIGN.v2 §7.1：可选。不提供时纯 AST 模式（ast_only）分析，不连接数据库
  database_config: DatabaseConfig | null;
}

export interface CorrectStatementRequest {
  corrected_text: string;
  tables_referenced: string[];
  tables_modified: string[];
}

/** 单条预处理规则（正则替换）。
 * 把「参数映射」和「自定义清洗」统一为规则。分析前按数组顺序执行 re.sub(pattern, replacement)。
 */
export interface PreprocessRule {
  id: string;
  name: string;
  pattern: string;        // Python 正则（后端 re.sub 用）
  replacement: string;    // 替换文本，支持 $1 $2 反向引用
  enabled: boolean;
  builtin: boolean;       // 内置规则（参数映射迁移而来，或系统预置）
  locked: boolean;        // 锁定规则（核心清洗，可开关但不可删除）
}

// === Response Types ===

export type StatementType = "CREATE" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "UNKNOWN";
export type TableType = "source" | "intermediate" | "target";
export type ExtractionMethod = "static_analysis";
export type OperationType = "CREATE" | "INSERT" | "UPDATE" | "DELETE" | "MERGE";

export interface Statement {
  seq: number;
  type: StatementType;
  text: string;
  tables_referenced: string[];
  tables_created: string[];
  tables_modified: string[];
}

export interface StatementGroup {
  group_id: string;
  original_script: string;
  preprocessed_script: string;
  statements: Statement[];
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  schema_name: string;
  table_name: string;
  table_type: TableType;
  source: string;
  columns: ColumnInfo[];
}

export interface ColumnMapping {
  target_table: string;
  target_column: string;
  source_table: string;
  source_columns: string[];  // 表达式可能多源列，如 price*qty → ["price","qty"]
  transformation: string | null;  // SUM(x)、price*qty；纯列引用为 null
}

export interface Lineage {
  lineage_id: string;
  source_table: string;
  target_table: string;
  operation_type: OperationType;
  extraction_method: ExtractionMethod;
  statement_seq: number;
  column_mappings: ColumnMapping[];
  dml_statement: string;
}

export interface DatabaseInfo {
  tables_from_db: TableInfo[];
  tables_from_script: TableInfo[];
}

export interface VisNode {
  id: string;
  label: string;
  type: TableType;
}

export interface VisEdge {
  source: string;
  target: string;
  label: string;
  statement_seq: number;
  // 列级血缘映射（DESIGN.v2 §6.4）：点边时展示目标列←源列
  column_mappings?: ColumnMapping[];
}

export interface Visualization {
  nodes: VisNode[];
  edges: VisEdge[];
}

export interface AnalysisResult {
  analysis_id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  input_script: string;
  database_info: DatabaseInfo;
  statement_group: StatementGroup | null;
  lineages: Lineage[];
  visualization: Visualization;
  // DESIGN.v2 §4.3：ast_only | ast_with_db_validation
  extraction_mode: "ast_only" | "ast_with_db_validation";
  // 扁平多标签：脚本所属的分类标签（如 ["C层","个人借据"]）。
  // 维度归属由 tag_schema 查得，脚本本身不存维度结构。
  tags: string[];
}

// === 脚本管理 ===

export interface ScriptSummary {
  analysis_id: string;
  name: string;
  created_at: string;
  statement_count: number;
  table_count: number;
  // 扁平标签数组，列表展示 + 筛选器命中判断
  tags: string[];
}

// === 全局图谱 ===

export interface GlobalEdge {
  edge_id: string;
  source: string;
  target: string;
  operation: string;
  script_id: string;
  statement_seq: number;
  created_at: string;
  // 列级血缘映射（持久化在 edges.jsonl，点边时展示）
  column_mappings?: ColumnMapping[];
}

export interface GlobalGraph {
  nodes: VisNode[];
  edges: GlobalEdge[];
}

// === 影响分析 ===

export interface ImpactAnalysis {
  table: string;
  downstream: string[];
  upstream: string[];
  downstream_count: number;
  upstream_count: number;
  // v2.3：返回全部路径（list[list[str]]），菱形依赖下会有多条平行路径。
  // 旧版只返回最短路径会漏掉中间环节边（A→B→C 且 A→C 时漏 A→B）。
  paths: Record<string, string[][]>;           // {下游表: [[路径1], [路径2], ...]}
  upstream_paths: Record<string, string[][]>;  // {上游表: [[路径1], [路径2], ...]}
  paths_truncated: boolean;  // 是否因路径过多触发上限裁剪（true 表示只返回了部分）
  has_cycle: boolean;
  error?: string;
}

// === 标签维度定义（管理员维护，脚本筛选器依赖此定义）===

/** 单个标签维度。维度名和标签值完全由用户定义，代码不预设。 */
export interface TagDimension {
  name: string;            // 维度名，如「数仓层」「业务线」
  values: string[];        // 该维度下的可选标签值，如 ["O层","C层","D层"]
}

/** 标签维度定义表。部署后默认空，由管理员通过设置面板填充。 */
export interface TagSchema {
  dimensions: TagDimension[];
}

/** 批量打标的响应：成功的脚本 id 列表 + 失败的（id+原因）。 */
export interface BatchSetTagsResult {
  updated: string[];
  failed: { id: string; reason: string }[];
}
