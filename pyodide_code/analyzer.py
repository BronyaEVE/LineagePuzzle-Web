from __future__ import annotations

import uuid
from datetime import datetime

from .models.analysis import AnalysisResult, DatabaseInfo, VisEdge, VisNode, Visualization
from .models.lineage import ColumnInfo, TableInfo, TableType
from .models.statement import StatementGroup
from .lineage_extractor import extract_lineages
from .preprocessor import preprocess
from .splitter import split_statements


def analyze(script: str, preprocess_rules: list | None = None) -> AnalysisResult:
    """完整分析编排：预处理 → 拆分 → 血缘提取（AST）→ 结果组装。

    网页版（Pyodide）改造：移除了 DB 校验分支（浏览器无法连接数据库）和
    对 store.py 的依赖（预处理规则改为参数传入）。血缘提取统一走 sqlglot AST。

    preprocess_rules 由前端管理（localStorage / 内存），None 时用空 list（不做正则预处理）。
    """
    # 步骤1+2: 预处理（含参数映射规则 + 自定义清洗规则）和拆分
    cleaned = preprocess(script, rules=preprocess_rules or [])
    group = split_statements(cleaned, original_script=script)

    # 步骤3: 提取血缘关系（纯 AST，不依赖 DB）
    lineages, table_type_map = extract_lineages(group.statements)

    # 网页版固定 ast_only（无 DB 校验）
    db_tables: list[TableInfo] = []
    extraction_mode = "ast_only"

    # 补充脚本中新建表的信息
    script_tables = _build_script_tables(group, table_type_map)

    # 步骤5: 组装可视化数据
    visualization = _build_visualization(lineages, table_type_map)

    return AnalysisResult(
        analysis_id=str(uuid.uuid4()),
        created_at=datetime.now(),
        input_script=script,
        database_info=DatabaseInfo(
            tables_from_db=db_tables,
            tables_from_script=script_tables,
        ),
        statement_group=group,
        lineages=lineages,
        visualization=visualization,
        extraction_mode=extraction_mode,
    )


def analyze_to_dict(script: str, preprocess_rules: list | None = None) -> dict:
    """analyze() 的 Pyodide 友好包装：返回纯 dict（供 JS toJs 消费）。

    pydantic 模型实例在 Pyodide 里 toJs 会变成 PyProxy，先 model_dump() 成 dict
    再返回，JS 侧用 toJs({dict_converter: Object.fromEntries}) 转普通对象。
    datetime 会序列化成 ISO 字符串（model_dump(mode="json")）。

    preprocess_rules 来自 JS（经 globals.set 传入），可能是 list of JsProxy/Map
    而非纯 dict。这里统一 to_py 规整成 list[dict]，避免下游 apply_rules 调
    r.get("enabled") 时 AttributeError: get。
    """
    rules = _normalize_rules(preprocess_rules)
    result = analyze(script, rules)
    return result.model_dump(mode="json")


def _normalize_rules(rules) -> list:
    """把 JS 传入的规则列表规整成纯 Python list[dict]。

    JS Object 经 Pyodide globals.set 可能保持为 JsProxy（无 .get 方法），
    这里强制走 to_py（深拷贝成原生 Python 类型）。
    """
    if not rules:
        return []
    # rules 可能是 JsProxy（Array），先整体转成 Python list
    try:
        rules = rules.to_py()
    except AttributeError:
        pass  # 已经是 Python list
    result = []
    for r in rules:
        if hasattr(r, "to_py"):
            r = r.to_py()
        # dict 直接用；其他类型尝试 dict() 转换（Map → dict）
        if isinstance(r, dict):
            result.append(r)
        else:
            try:
                result.append(dict(r))
            except (TypeError, ValueError):
                continue
    return result


def _build_script_tables(
    group: StatementGroup, table_type_map: dict[str, TableType]
) -> list[TableInfo]:
    """从脚本 CREATE 语句中构建新表信息。"""
    script_tables: list[TableInfo] = []
    for stmt in group.statements:
        for table_name in stmt.tables_created:
            script_tables.append(
                TableInfo(
                    table_name=table_name,
                    table_type=table_type_map.get(table_name, TableType.INTERMEDIATE),
                    source="script_created",
                    columns=[],  # 列信息在数据库中可查询时补充
                )
            )
    return script_tables


def _build_visualization(
    lineages: list, table_type_map: dict[str, TableType]
) -> Visualization:
    """根据血缘关系构建可视化节点和边。"""
    node_set: dict[str, VisNode] = {}
    edges: list[VisEdge] = []

    for lin in lineages:
        if lin.source_table and lin.source_table not in node_set:
            node_set[lin.source_table] = VisNode(
                id=lin.source_table,
                label=lin.source_table,
                type=table_type_map.get(lin.source_table, TableType.SOURCE),
            )
        if lin.target_table not in node_set:
            node_set[lin.target_table] = VisNode(
                id=lin.target_table,
                label=lin.target_table,
                type=table_type_map.get(lin.target_table, TableType.TARGET),
            )
        edges.append(
            VisEdge(
                source=lin.source_table or "",
                target=lin.target_table,
                label=lin.operation_type.value,
                statement_seq=lin.statement_seq,
                column_mappings=lin.column_mappings,
            )
        )

    return Visualization(nodes=list(node_set.values()), edges=edges)
