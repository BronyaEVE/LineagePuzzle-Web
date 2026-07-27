from enum import Enum

from pydantic import BaseModel, Field


class TableType(str, Enum):
    SOURCE = "source"
    INTERMEDIATE = "intermediate"
    TARGET = "target"


class ColumnInfo(BaseModel):
    name: str
    type: str = "UNKNOWN"


class TableInfo(BaseModel):
    schema_name: str = "public"
    table_name: str
    table_type: TableType = TableType.SOURCE
    source: str = Field(
        "database",
        description="database: 从 INFORMATION_SCHEMA 读取; script_created: 从脚本 CREATE 语句解析",
    )
    columns: list[ColumnInfo] = Field(default_factory=list)


class ExtractionMethod(str, Enum):
    # DESIGN.v2 §5.5：AST 为唯一血缘提取来源，不再使用执行计划
    STATIC_ANALYSIS = "static_analysis"


class OperationType(str, Enum):
    CREATE = "CREATE"
    INSERT = "INSERT"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    MERGE = "MERGE"


class ColumnMapping(BaseModel):
    """列级血缘映射：一个目标列 ← 一个源表的一个或多个源列。

    DESIGN.v2 §6.4 列级血缘 v2.1：
      - 显式写法 INSERT INTO t(a,b) SELECT x,y 能完整解析
      - 表达式 price*qty 会拆成多条（每个物理源列一条），transformation 记表达式原文
      - SELECT * 无法解析（无表结构），降级为表级边，column_mappings 留空

    target_table/target_column: 目标表全限定名 + 目标列名
    source_table: 源表全限定名（常量时为空字符串）
    source_columns: 源列名列表（表达式可能引用多列，单列时为 [col]）
    transformation: 变换表达式（SUM(x)、price*qty 等）；纯列引用时为 None
    """
    target_table: str
    target_column: str
    source_table: str = ""
    source_columns: list[str] = Field(default_factory=list)
    transformation: str | None = None


class Lineage(BaseModel):
    lineage_id: str
    source_table: str
    target_table: str
    operation_type: OperationType
    extraction_method: ExtractionMethod = ExtractionMethod.STATIC_ANALYSIS
    statement_seq: int
    column_mappings: list[ColumnMapping] = Field(default_factory=list)
    dml_statement: str = ""
