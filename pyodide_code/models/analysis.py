from datetime import datetime

from pydantic import BaseModel, Field

from .lineage import ColumnMapping, Lineage, TableInfo
from .statement import StatementGroup


class DatabaseInfo(BaseModel):
    tables_from_db: list[TableInfo] = Field(default_factory=list)
    tables_from_script: list[TableInfo] = Field(default_factory=list)


class VisNode(BaseModel):
    id: str
    label: str
    type: str  # source / intermediate / target


class VisEdge(BaseModel):
    source: str
    target: str
    label: str
    statement_seq: int
    # 列级血缘映射（DESIGN.v2 §6.4）：点边时展示目标列←源列
    # 纯表级边/SELECT * 降级时为空数组
    column_mappings: list[ColumnMapping] = Field(default_factory=list)


class Visualization(BaseModel):
    nodes: list[VisNode] = Field(default_factory=list)
    edges: list[VisEdge] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    analysis_id: str
    name: str = ""
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime | None = None
    input_script: str = ""
    database_info: DatabaseInfo = Field(default_factory=DatabaseInfo)
    statement_group: StatementGroup | None = None
    lineages: list[Lineage] = Field(default_factory=list)
    visualization: Visualization = Field(default_factory=Visualization)
    # DESIGN.v2 §4.3：标记本次分析用了哪种模式
    #   ast_only             —— 无 DB 连接，纯 AST 提取
    #   ast_with_db_validation —— 有 DB 连接，AST 提取 + 表结构校验/列补充
    extraction_mode: str = "ast_only"
    # 扁平多标签：脚本所属的分类标签（如 ["C层", "个人借据"]）。
    # 维度信息外置在 tag_schema.json，脚本本身不存维度结构，保证维度增删不影响脚本数据。
    # 旧脚本无此字段时反序列化为空数组（pydantic 默认值兜底，向后兼容）。
    tags: list[str] = Field(default_factory=list)


class ScriptSummary(BaseModel):
    analysis_id: str
    name: str
    created_at: datetime
    statement_count: int = 0
    table_count: int = 0
    # 扁平标签数组，用于列表展示 + 筛选器命中判断
    tags: list[str] = Field(default_factory=list)


class GlobalEdge(BaseModel):
    edge_id: str
    source: str
    target: str
    operation: str
    script_id: str
    statement_seq: int
    created_at: str = ""
    # 列级血缘映射（持久化在 edges.jsonl，全局图点边时展示）
    # 旧数据无此字段时反序列化为空数组（pydantic 默认值兜底，向后兼容）
    column_mappings: list[ColumnMapping] = Field(default_factory=list)


class GlobalGraph(BaseModel):
    nodes: list[VisNode] = Field(default_factory=list)
    edges: list[GlobalEdge] = Field(default_factory=list)
