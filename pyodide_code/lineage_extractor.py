from __future__ import annotations

import uuid

import sqlglot

from .models.lineage import (
    ColumnMapping,
    ExtractionMethod,
    Lineage,
    OperationType,
    TableType,
)
from .models.statement import Statement, StatementType
from .normalize import normalize_table_name


def _qualified_name_from_table(table_expr: sqlglot.exp.Table) -> str:
    """从 sqlglot Table 节点重建全限定名。

    sqlglot 的 `table.name` 只返回纯表名（不含 schema），schema 信息存在 `table.db`。
    这里优先用 `db + '.' + name` 重建，db 为空时裸表名补默认 schema `public`，
    最后经 normalize_table_name 统一规范化。

    例:
      Table(db="public", name="orders") → "public.orders"
      Table(db="", name="orders")       → "public.orders"
      Table(db="reporting", name="orders") → "reporting.orders"
    """
    table_name = table_expr.name
    schema = table_expr.db
    if schema:
        raw = f"{schema}.{table_name}"
    else:
        raw = table_name
    return normalize_table_name(raw)


def _extract_tables_via_ast(stmt_text: str) -> tuple[list[str], list[str], list[str]]:
    """使用 sqlglot 静态解析 SQL AST，提取表名。

    返回 (referenced_tables, created_tables, modified_tables)
    所有表名经过归一化处理（规范化为 `schema.table` 全限定名，裸表名补 public）。
    """
    referenced: list[str] = []
    created: list[str] = []
    modified: list[str] = []

    try:
        parsed = sqlglot.parse_one(stmt_text, read="postgres")
    except Exception:
        return referenced, created, modified

    # 提取所有引用的表（规范化为全限定名，保留 schema 区分同名表）
    for table in parsed.find_all(sqlglot.exp.Table):
        name = _qualified_name_from_table(table)
        if name and name not in referenced:
            referenced.append(name)

    # 判断语句类型并分类
    if isinstance(parsed, sqlglot.exp.Create):
        table_expr = parsed.find(sqlglot.exp.Table)
        if table_expr:
            name = _qualified_name_from_table(table_expr)
            if name in referenced:
                referenced.remove(name)
            if name not in created:
                created.append(name)
    elif isinstance(parsed, sqlglot.exp.Insert):
        table_expr = parsed.find(sqlglot.exp.Table)
        if table_expr:
            name = _qualified_name_from_table(table_expr)
            if name in referenced:
                referenced.remove(name)
            if name not in modified:
                modified.append(name)
    elif isinstance(parsed, sqlglot.exp.Update):
        table_expr = parsed.find(sqlglot.exp.Table)
        if table_expr:
            name = _qualified_name_from_table(table_expr)
            if name in referenced:
                referenced.remove(name)
            if name not in modified:
                modified.append(name)
    elif isinstance(parsed, sqlglot.exp.Delete):
        table_expr = parsed.find(sqlglot.exp.Table)
        if table_expr:
            name = _qualified_name_from_table(table_expr)
            if name in referenced:
                referenced.remove(name)
            if name not in modified:
                modified.append(name)

    return referenced, created, modified


def extract_lineages(
    statements: list[Statement],
) -> tuple[list[Lineage], dict[str, TableType]]:
    """从语句列表中提取血缘关系（基于 sqlglot AST 静态解析）。

    DESIGN.v2 §5.5：AST 为唯一血缘提取来源，确定性强、无外部依赖、可离线运行。
    数据库连接（如有）仅用于校验表存在性与补充列信息，不影响血缘结果。

    参数:
        statements: 拆分后的语句列表

    返回:
        (lineages, table_type_map)
        table_type_map: {table_name: TableType} 记录每个表的类型
    """
    lineages: list[Lineage] = []
    table_type_map: dict[str, TableType] = {}

    for stmt in statements:
        # 通过 AST 填充语句的表引用信息
        ref, created, modified = _extract_tables_via_ast(stmt.text)
        stmt.tables_referenced = ref
        stmt.tables_created = created
        stmt.tables_modified = modified

        # 标记表类型
        for t in created:
            table_type_map.setdefault(t, TableType.INTERMEDIATE)
        for t in modified:
            if t not in table_type_map:
                table_type_map[t] = TableType.TARGET
        for t in ref:
            if t not in table_type_map:
                table_type_map[t] = TableType.SOURCE

        # 基于 AST 提取血缘
        _extract_from_ast(stmt, lineages)

    return lineages, table_type_map


def _extract_from_ast(stmt: Statement, lineages: list[Lineage]) -> None:
    """基于静态 AST 解析提取血缘关系。"""
    from .column_lineage import extract_column_mappings

    source_tables = stmt.tables_referenced
    target_tables = stmt.tables_created + stmt.tables_modified

    op_type = _stmt_type_to_op(stmt.type)

    # 提取列级映射（一条语句一组，所有表级边共享）
    # 列级是增强层：失败/降级时返回空列表，不影响表级血缘
    column_mappings = extract_column_mappings(stmt)

    # 有源表和目标表：为每个 (src, tgt) 组合生成一条边
    for src in source_tables:
        for tgt in target_tables:
            lineages.append(
                Lineage(
                    lineage_id=str(uuid.uuid4()),
                    source_table=src,
                    target_table=tgt,
                    operation_type=op_type,
                    extraction_method=ExtractionMethod.STATIC_ANALYSIS,
                    statement_seq=stmt.seq,
                    dml_statement=stmt.text,
                    column_mappings=column_mappings,
                )
            )
    # 单个目标表但没有源表（如 UPDATE SET 常量）也记录目标
    if not source_tables and target_tables:
        for tgt in target_tables:
            lineages.append(
                Lineage(
                    lineage_id=str(uuid.uuid4()),
                    source_table="",
                    target_table=tgt,
                    operation_type=op_type,
                    extraction_method=ExtractionMethod.STATIC_ANALYSIS,
                    statement_seq=stmt.seq,
                    dml_statement=stmt.text,
                    column_mappings=column_mappings,
                )
            )


def _stmt_type_to_op(stmt_type: StatementType) -> OperationType:
    mapping = {
        StatementType.CREATE: OperationType.CREATE,
        StatementType.INSERT: OperationType.INSERT,
        StatementType.UPDATE: OperationType.UPDATE,
        StatementType.DELETE: OperationType.DELETE,
        StatementType.MERGE: OperationType.MERGE,
    }
    return mapping.get(stmt_type, OperationType.INSERT)
