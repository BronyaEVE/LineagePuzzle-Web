"""列级血缘提取（v2.2）。

基于 sqlglot AST 静态解析，从 DML 语句中提取「目标列 ← 源列」的映射。
与表级血缘解耦：表级血缘照常生成（保底），列级是增强层。
SELECT * 等无法解析的构造降级为空 column_mappings（不影响表级边）。

能力边界（详见 DESIGN.v2 §6.4）：
  ✅ 显式列 INSERT INTO t(a,b) SELECT x,y
  ✅ JOIN + 别名  o.id, c.name
  ✅ 聚合/表达式  SUM(amount), price*qty
  ✅ CTAS         CREATE TABLE t AS SELECT a,b
  ✅ 子查询穿透   SELECT ... FROM (SELECT ...) sub  [v2.2 新增]
  ✅ 嵌套子查询   FROM (SELECT ... FROM (SELECT ...) d2) d1 [v2.2]
  ✅ JOIN + 子查询混合  FROM (SELECT...) sub JOIN tbl t [v2.2]
  ⚠️ 无显式目标列  target 退化用 projection 列名/别名
  ❌ SELECT *     无表结构，降级（留空 column_mappings）
  ❌ CTE 列定义展开  source_table 标记为 cte 名，不递归
"""
from __future__ import annotations

import sqlglot
from sqlglot import exp

from .models.lineage import ColumnMapping
from .models.statement import Statement


def _qualified_name_from_table(table_expr: exp.Table) -> str:
    """复用 lineage_extractor 的全限定名重建逻辑（避免循环 import）。

    sqlglot 的 table.name 只返回纯表名，schema 在 table.db。
    db 为空时裸表名补 public。
    """
    from .normalize import normalize_table_name

    table_name = table_expr.name
    schema = table_expr.db
    raw = f"{schema}.{table_name}" if schema else table_name
    return normalize_table_name(raw)


# ---------------------------------------------------------------------------
# 派生表（Subquery in FROM）穿透解析  [v2.2]
# ---------------------------------------------------------------------------

def _collect_select_sources(
    sel: exp.Select,
) -> tuple[list[tuple[str, str]], list[tuple[str, exp.Select]]]:
    """收集一个 SELECT 层的源，区分「物理表」和「派生表（子查询）」。

    只看当前层 FROM + JOIN，不递归进子查询内部（内部由调用方递归处理）。

    返回:
        physical: [(alias_or_name, qualified_table_name), ...]
        derived:  [(alias, inner_select_node), ...]
    """
    physical: list[tuple[str, str]] = []
    derived: list[tuple[str, exp.Select]] = []

    def _handle_source(node):
        # node 可能是 Table（物理表）或 Subquery（派生表）
        if isinstance(node, exp.Table):
            qname = _qualified_name_from_table(node)
            alias = node.alias if node.alias else node.name
            physical.append((alias, qname))
        elif isinstance(node, exp.Subquery):
            alias = node.alias or ""
            inner = node.this
            if isinstance(inner, exp.Select):
                derived.append((alias, inner))

    # FROM 子句（sqlglot 29.x 用 from_ 键，兼容旧版 from）
    fr = sel.args.get("from_") or sel.args.get("from")
    if fr is not None:
        _handle_source(fr.this)

    # JOIN 子句
    joins = sel.args.get("joins") or []
    for j in joins:
        if j is not None:
            _handle_source(j.this)

    return physical, derived


def _projection_output_name(proj: exp.Expression) -> str:
    """派生表内 projection 的「输出列名」。

    - Alias 节点（COUNT(*) AS cnt）：输出名是 .alias → 'cnt'
    - 纯 Column（customer_id）：输出名是列名 → 'customer_id'
    """
    alias = getattr(proj, "alias", None)
    if alias:
        return alias
    return proj.alias_or_name


def _absorb_derived_col(
    derived_ctx: dict[str, dict[str, list[tuple[str, list[str], str]]]],
    derived_alias: str,
    out_col: str,
    by_table: dict[str, list[str]],
) -> None:
    """把派生表某输出列的穿透源并入 by_table。

    若该列在派生表中是 COUNT(*)/常量等（源为空），则跳过——不污染物理源。
    """
    col_defs = derived_ctx.get(derived_alias, {})
    sources = col_defs.get(out_col, [])
    for src_table, src_cols, _ in sources:
        if src_table and src_cols:
            by_table.setdefault(src_table, [])
            for c in src_cols:
                if c not in by_table[src_table]:
                    by_table[src_table].append(c)


def _resolve_projection_sources(
    proj: exp.Expression,
    alias_map: dict[str, str],
    single_source: str,
    derived_ctx: dict[str, dict[str, list[tuple[str, list[str], str]]]],
    single_derived_alias: str = "",
) -> list[tuple[str, list[str], str]]:
    """解析单个 projection 表达式的源列，穿透派生表到物理表。

    返回 [(src_table, [src_cols], transform), ...]，按源表分组。

    派生表穿透：若列引用来自某派生表别名（在 derived_ctx 中），
    用该派生表对应输出列的定义替换。若该输出列在派生表中无物理源
    （如 COUNT(*) 产生的 cnt），则不产生源（源表为空）。

    无前缀列的回退优先级：
      1. single_source：仅一个物理源表 → 归到该表
      2. single_derived_alias：仅一个派生源表 → 穿透该派生表列上下文
    """
    real_expr = proj.this if isinstance(proj, exp.Alias) else proj
    is_simple = isinstance(real_expr, exp.Column)
    transform = None if is_simple else real_expr.sql()

    source_cols = list(real_expr.find_all(exp.Column))
    if not source_cols:
        # 常量/聚合（如 COUNT(*)）：无物理源列
        return [("", [], transform)]

    by_table: dict[str, list[str]] = {}
    for c in source_cols:
        tbl_alias = c.table
        if tbl_alias:
            # 先查物理表
            if tbl_alias in alias_map:
                by_table.setdefault(alias_map[tbl_alias], []).append(c.name)
            # 再查派生表（穿透）
            elif tbl_alias in derived_ctx:
                _absorb_derived_col(derived_ctx, tbl_alias, c.name, by_table)
            else:
                by_table.setdefault(tbl_alias, []).append(c.name)
        elif single_source:
            # 无前缀 + 单物理源表 → 回退到该表
            by_table.setdefault(single_source, []).append(c.name)
        elif single_derived_alias:
            # 无前缀 + 单派生源表 → 穿透该派生表
            _absorb_derived_col(derived_ctx, single_derived_alias, c.name, by_table)
        else:
            by_table.setdefault("", []).append(c.name)

    return [(t, cols, transform) for t, cols in by_table.items()]


def _build_derived_context(
    derived: list[tuple[str, exp.Select]],
) -> dict[str, dict[str, list[tuple[str, list[str], str]]]]:
    """递归构建派生表的列定义上下文。

    对每个派生表 (alias, inner_select)，解析其每个输出列，得到：
        {derived_alias: {out_col: [(src_table, [src_cols], transform), ...]}}

    src_table 为空字符串表示该列来自常量/聚合且无具体物理源列
    （如 COUNT(*) AS cnt → out_col 'cnt' 的源列为空）。

    递归处理嵌套派生表。
    """
    context: dict[str, dict[str, list[tuple[str, list[str], str]]]] = {}
    for alias, inner in derived:
        inner_phys, inner_derived = _collect_select_sources(inner)
        inner_alias_map = {a: q for a, q in inner_phys}
        inner_single = inner_phys[0][1] if len(inner_phys) == 1 else ""
        inner_derived_ctx = _build_derived_context(inner_derived)
        # 无前缀列 + 仅一个派生源表 → 回退到该派生表
        inner_single_derived = inner_derived[0][0] if len(inner_derived) == 1 else ""

        col_defs: dict[str, list[tuple[str, list[str], str]]] = {}
        for proj in inner.expressions:
            out_name = _projection_output_name(proj)
            sources = _resolve_projection_sources(
                proj, inner_alias_map, inner_single,
                inner_derived_ctx, inner_single_derived,
            )
            col_defs[out_name] = sources
        context[alias] = col_defs

    return context


def _build_alias_map(parsed: exp.Expression) -> dict[str, str]:
    """构建 {alias 或表名 → 全限定表名} 映射。

    用于把 SELECT projection 里的 column.table（可能是别名）解析回全限定表名。
    - 带 alias 的表: {alias: qualified_name}（如 o → public.orders）
    - 无 alias 的表: {name: qualified_name}
    """
    mapping: dict[str, str] = {}
    for t in parsed.find_all(exp.Table):
        qname = _qualified_name_from_table(t)
        if t.alias:
            mapping[t.alias] = qname
        else:
            mapping[t.name] = qname
    return mapping


def _get_target_table_and_columns(parsed: exp.Expression) -> tuple[str, list[str]]:
    """提取目标表全限定名 + 目标列名列表。

    INSERT INTO t (a,b,c): 从 Schema.expressions（Identifier 列表）取目标列
    INSERT INTO t (无显式列): 返回空列表，后续用 projection 列名/别名对齐
    CREATE TABLE t AS SELECT: 目标列 = projection 列名（CTAS 无显式列声明）
    UPDATE t SET: 单独处理，这里返回 (表名, [])

    返回 (qualified_target_table, [target_col_names])
    """
    target_table = ""
    target_cols: list[str] = []

    if isinstance(parsed, exp.Insert):
        # INSERT 的 this 通常是 Schema（带列声明）或 Table（不带）
        target = parsed.this
        if isinstance(target, exp.Schema):
            # Schema 包裹一个 Table + 列声明
            tbl = target.find(exp.Table)
            if tbl:
                target_table = _qualified_name_from_table(tbl)
            for e in target.expressions:
                if isinstance(e, (exp.Identifier, exp.Column)):
                    target_cols.append(e.name)
        elif isinstance(target, exp.Table):
            target_table = _qualified_name_from_table(target)
            # 无显式列，target_cols 留空
    elif isinstance(parsed, exp.Create):
        tbl = parsed.find(exp.Table)
        if tbl:
            target_table = _qualified_name_from_table(tbl)
        # CTAS 目标列 = projection 列名，留空让调用方用 projection 对齐
    elif isinstance(parsed, exp.Update):
        tbl = parsed.this if isinstance(parsed.this, exp.Table) else parsed.find(exp.Table)
        if isinstance(tbl, exp.Table):
            target_table = _qualified_name_from_table(tbl)

    return target_table, target_cols


def _is_star_projection(proj: exp.Expression) -> bool:
    """判断 projection 是否为 SELECT *（含 t.*）。"""
    if isinstance(proj, exp.Star):
        return True
    # t.* 形式
    if isinstance(proj, exp.Column) and isinstance(proj.this, exp.Star):
        return True
    return False


def _projection_alias_or_name(proj: exp.Expression) -> str:
    """projection 无显式目标列对齐时，用它的别名或列名作 target。"""
    if hasattr(proj, "alias") and proj.alias:
        return proj.alias
    if isinstance(proj, exp.Column):
        return proj.name
    return proj.sql()


def _extract_column_mappings_select(
    parsed: exp.Expression,
    target_table: str,
    target_cols: list[str],
    alias_map: dict[str, str],
) -> list[ColumnMapping]:
    """从 INSERT/CTAS 的 SELECT 部分提取列级映射。

    按位置对齐 target_cols[i] ← projection[i]。
    无显式目标列时，target 用 projection 的列名/别名。
    支持派生表（子查询 in FROM）穿透解析 [v2.2]。
    """
    sel = parsed.find(exp.Select)
    if not sel:
        return []

    # 收集当前 SELECT 层的源（区分物理表/派生表）
    physical, derived = _collect_select_sources(sel)
    # 当前层物理表 alias→qualified
    curr_alias_map: dict[str, str] = {alias: qname for alias, qname in physical}
    # 候选源表（排除目标表），用于单源回退
    candidate_sources = [q for _, q in physical if q != target_table]
    single_source = candidate_sources[0] if len(candidate_sources) == 1 else ""
    # 派生表列上下文（递归解析）
    derived_ctx = _build_derived_context(derived)
    # 无前缀列 + 仅一个派生源表 → 回退到该派生表
    single_derived_alias = derived[0][0] if len(derived) == 1 else ""

    projections = sel.expressions
    mappings: list[ColumnMapping] = []

    for i, proj in enumerate(projections):
        # SELECT * → 无法解析，跳过（降级为表级）
        if _is_star_projection(proj):
            continue

        # 确定目标列名
        if i < len(target_cols):
            tgt_col = target_cols[i]
        else:
            tgt_col = _projection_alias_or_name(proj)

        # 解析源（穿透派生表到物理表）
        sources = _resolve_projection_sources(
            proj, curr_alias_map, single_source,
            derived_ctx, single_derived_alias,
        )

        for src_table, src_cols, transform in sources:
            mappings.append(ColumnMapping(
                target_table=target_table,
                target_column=tgt_col,
                source_table=src_table,
                source_columns=src_cols,
                transformation=transform,
            ))

    return mappings


def _extract_column_mappings_update(
    parsed: exp.Update,
    target_table: str,
    alias_map: dict[str, str],
) -> list[ColumnMapping]:
    """从 UPDATE SET 子句提取列级映射。

    SET total = total * 1.1:
      - total（左）= 目标列
      - total * 1.1（右表达式）的源列 = [total]
      - transformation = total * 1.1
    SET status = 'paid':
      - status = 目标列，源列为空（常量），transformation = 'paid'
    SET tag = CASE WHEN status = 1 THEN 'paid' ELSE 'unpaid' END:
      - tag = 目标列，源列 = [status]（CASE 里的无前缀列回退到 target 表本身）
      - transformation = CASE WHEN ... END

    无前缀列的源表回退（与 SELECT 路径一致）：
      - SET 右边引用了同表列（UPDATE t SET x = y）但没写表前缀时，
        y 归到 target 表本身（self-reference，列级有意义、表级避免自环）
      - UPDATE ... FROM other（postgres 扩展）且 FROM 仅一个表时，
        无前缀列归到 FROM 的表
    """
    mappings: list[ColumnMapping] = []
    set_expr = parsed.args.get("expressions")  # SET 子句是 EQ 表达式列表
    if not set_expr:
        return mappings

    # 收集 FROM 子句的候选源表（postgres UPDATE...FROM 扩展），用于无前缀列回退
    fr = parsed.args.get("from_") or parsed.args.get("from")
    from_tables: list[str] = []
    if fr is not None:
        for t in fr.find_all(exp.Table):
            from_tables.append(_qualified_name_from_table(t))
    # 无前缀列的兜底源表：仅一个 FROM 表 → 该表；否则（含无 FROM）→ target 表本身
    fallback_source = from_tables[0] if len(from_tables) == 1 else target_table

    for eq in set_expr:
        if not isinstance(eq, exp.EQ):
            continue
        # eq.this 是左操作数（被赋值的列），eq.expression 是右表达式
        left = eq.this
        right = eq.expression
        if not isinstance(left, exp.Column):
            continue
        tgt_col = left.name

        source_cols = list(right.find_all(exp.Column))
        is_simple = isinstance(right, exp.Column)
        transform = None if is_simple else right.sql()

        if not source_cols:
            mappings.append(ColumnMapping(
                target_table=target_table,
                target_column=tgt_col,
                source_table="",
                source_columns=[],
                transformation=transform,
            ))
        else:
            by_table: dict[str, list[str]] = {}
            for c in source_cols:
                if c.table:
                    resolved = alias_map.get(c.table, c.table)
                else:
                    # 无前缀列：回退到单源表（FROM 唯一表或 target 表本身）
                    resolved = fallback_source
                by_table.setdefault(resolved, []).append(c.name)
            for src_table, cols in by_table.items():
                mappings.append(ColumnMapping(
                    target_table=target_table,
                    target_column=tgt_col,
                    source_table=src_table,
                    source_columns=cols,
                    transformation=transform,
                ))

    return mappings


def extract_column_mappings(stmt: Statement) -> list[ColumnMapping]:
    """从单条 DML 语句提取列级血缘映射。

    入口函数。无法解析的语句返回空列表（降级为表级血缘，不影响保底）。
    """
    try:
        parsed = sqlglot.parse_one(stmt.text, read="postgres")
    except Exception:
        return []

    alias_map = _build_alias_map(parsed)
    target_table, target_cols = _get_target_table_and_columns(parsed)

    if not target_table:
        return []

    if isinstance(parsed, exp.Update):
        return _extract_column_mappings_update(parsed, target_table, alias_map)

    return _extract_column_mappings_select(parsed, target_table, target_cols, alias_map)
