"""表名归一化工具。

将表名规范化为 `schema.table` 全限定名形式，作为全局注册表的唯一主键。
裸表名（不带 schema 前缀）一律视为 public schema。

大小写处理（PostgreSQL 语义）:
  - 不带引号的标识符 → 折叠成小写（ORDERS == orders，PG 默认行为）
  - 带引号的标识符 "Orders" → 保留原大小写（PG 里只有 "Orders" 能精确匹配）

规则:
  - "orders"              → "public.orders"    （裸表名补 public，折叠小写）
  - "ORDERS"              → "public.orders"    （不带引号，折叠小写）
  - "public.orders"       → "public.orders"
  - "mydb.public.orders"  → "public.orders"    （catalog 去掉）
  - "reporting.fact_sales"→ "reporting.fact_sales"
  - '"Orders"'            → "public.Orders"    （带引号，保留大小写）
  - '"public"."Orders"'   → "public.Orders"
  - "a.b.c.d.target"      → "d.target"
  - ""                    → ""

这样设计是为了区分 public.orders 与 reporting.orders 等跨 schema 同名表，
避免在全局注册表中互相覆盖。
"""
from __future__ import annotations

DEFAULT_SCHEMA = "public"


def normalize_table_name(name: str) -> str:
    """将表名归一化为 `schema.table` 全限定名形式。

    裸表名（不含 schema 前缀）补默认 schema `public`。
    带完整前缀的取最后两段（schema.table），catalog/database 前缀被丢弃。
    不带引号的标识符折叠成小写（PostgreSQL 语义），带引号的保留大小写。
    """
    if not name:
        return ""

    # 去除首尾空白
    name = name.strip()

    # 按点号拆分（正确处理引号内的点号）
    parts = _split_identifier(name)

    # 去除每段的引号，并记录是否带引号（决定大小写折叠）
    # parts 已是 str；这里需要带引号信息，所以重跑一次拆分 + 去引号
    normalized_parts: list[str] = []
    for p in parts:
        unquoted, was_quoted = _unquote_with_flag(p)
        if not unquoted:
            continue
        # PostgreSQL 语义：不带引号的标识符折叠成小写
        if not was_quoted:
            unquoted = unquoted.lower()
        normalized_parts.append(unquoted)

    if not normalized_parts:
        return ""

    # 取最后两段作为 schema.table
    if len(normalized_parts) >= 2:
        schema, table = normalized_parts[-2], normalized_parts[-1]
    else:
        schema, table = DEFAULT_SCHEMA, normalized_parts[-1]

    return f"{schema}.{table}"


def _split_identifier(name: str) -> list[str]:
    """按点号拆分标识符，正确处理引号内的点号。

    例: 'mydb."public.schema".orders' → ['mydb', '"public.schema"', 'orders']
    """
    parts: list[str] = []
    current = []
    in_quotes = False

    for ch in name:
        if ch == '"':
            in_quotes = not in_quotes
            current.append(ch)
        elif ch == '.' and not in_quotes:
            parts.append(''.join(current))
            current = []
        else:
            current.append(ch)

    if current:
        parts.append(''.join(current))

    return parts


def _unquote_with_flag(identifier: str) -> tuple[str, bool]:
    """去除 SQL 标识符两侧的引号，并返回是否曾被引号包裹。

    返回 (unquoted_name, was_quoted)：
      '"Orders"' → ('Orders', True)   带引号，保留大小写
      'orders'   → ('orders', False)  不带引号，调用方应折叠小写
    """
    if len(identifier) >= 2 and identifier[0] == '"' and identifier[-1] == '"':
        return identifier[1:-1], True
    return identifier, False


def _unquote(identifier: str) -> str:
    """[兼容] 去除 SQL 标识符两侧的引号（不区分是否带引号，不折叠大小写）。

    保留向后兼容。新代码应使用 _unquote_with_flag。
    """
    if len(identifier) >= 2 and identifier[0] == '"' and identifier[-1] == '"':
        return identifier[1:-1]
    return identifier
