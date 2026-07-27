import re
import uuid

from .models.statement import Statement, StatementGroup, StatementType

# 需要保留的语句类型（CREATE TABLE 会影响后续 DML 血缘）
_KEEP_TYPES = {"CREATE", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH"}

# 匹配语句开头的类型关键字
_TYPE_PATTERN = re.compile(
    r"^\s*(CREATE\s+(TEMP(?:ORARY)?\s+)?TABLE|INSERT|UPDATE|DELETE|MERGE|WITH)\b",
    re.IGNORECASE,
)


def _detect_type(text: str) -> StatementType:
    """检测单条 SQL 语句的类型。"""
    m = _TYPE_PATTERN.match(text)
    if not m:
        return StatementType.UNKNOWN
    keyword = m.group(1).upper()
    if keyword.startswith("CREATE") or keyword.startswith("WITH"):
        # WITH ... AS ... INSERT 归为 INSERT，纯 CTE 暂归 CREATE
        if re.search(r"\bINSERT\b", text, re.IGNORECASE):
            return StatementType.INSERT
        return StatementType.CREATE
    if keyword.startswith("INSERT"):
        return StatementType.INSERT
    if keyword.startswith("UPDATE"):
        return StatementType.UPDATE
    if keyword.startswith("DELETE"):
        return StatementType.DELETE
    if keyword.startswith("MERGE"):
        return StatementType.MERGE
    return StatementType.UNKNOWN


def _should_keep(text: str) -> bool:
    """判断语句是否应保留（过滤纯 DDL 如 ALTER、DROP 等）。"""
    stripped = text.strip().upper()
    # 空语句过滤
    if not stripped:
        return False
    # 保留 CREATE TABLE（含 TEMP）
    if stripped.startswith("CREATE"):
        return True
    # 保留 DML
    for kw in ("INSERT", "UPDATE", "DELETE", "MERGE", "WITH"):
        if stripped.startswith(kw):
            return True
    # 移除 ALTER、DROP、GRANT 等无关语句
    return False


def split_statements(preprocessed_script: str, original_script: str = "") -> StatementGroup:
    """将预处理后的脚本拆分为独立语句列表。

    返回 StatementGroup，包含原始脚本、预处理脚本和按序号排列的语句列表。
    """
    # 按分号分割
    raw_parts = preprocessed_script.split(";")
    statements: list[Statement] = []
    seq = 0

    for part in raw_parts:
        text = part.strip()
        if not _should_keep(text):
            continue
        seq += 1
        stmt_type = _detect_type(text)
        statements.append(
            Statement(
                seq=seq,
                type=stmt_type,
                text=text + ";",
                tables_referenced=[],
                tables_created=[],
                tables_modified=[],
            )
        )

    return StatementGroup(
        group_id=str(uuid.uuid4()),
        original_script=original_script or preprocessed_script,
        preprocessed_script=preprocessed_script,
        statements=statements,
    )
