import re


# PL/pgSQL 控制结构关键字 —— DO block 内部这些行不是 DML，需在提取时丢弃
# （IF/LOOP/FOR/WHILE 等流程控制内的 DML 仍可能被保留，但绝大多数生产脚本只在
#   直线流程里写 DML，足够覆盖）
_PL_CONTROL_KEYWORDS = re.compile(
    r"^\s*(BEGIN|END|EXCEPTION|WHEN|THEN|RAISE|IF|THEN|ELSE|ELSIF|LOOP|FOR|WHILE|"
    r"RETURN|PERFORM|EXECUTE|DECLARE|LANGUAGE|NULL)\b",
    re.IGNORECASE,
)

# 匹配 DO $$...$$ / DO $tag$...$tag$  —— PostgreSQL 匿名块（dollar-quote）
# 用反向引用 \1 确保开头和结尾的 tag 一致（$$ 或 $body$ 等）
_DO_BLOCK_PATTERN = re.compile(
    r"DO\s+(\$\w*\$)([\s\S]*?)\1\s*;",
    re.IGNORECASE,
)


def extract_dml_from_do_blocks(text: str) -> str:
    """把 DO $$ ... $$ 匿名块替换成内部的 DML 语句。

    生产脚本常用 DO $$ BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE ... END $$;
    包裹 DML 做异常处理。sqlglot 无法解析 PL/pgSQL（降级为 Command，表血缘丢失）。

    做法：用 dollar-quote 边界把 DO block 内容抠出来，按行过滤掉
    PL/pgSQL 控制关键字（BEGIN/END/EXCEPTION/RAISE 等），只保留真正的 DML。
    这样后续 splitter / lineage_extractor 像处理裸 SQL 一样处理它们。

    局限：EXECUTE 'INSERT...' 这种动态 SQL 内的表名是运行时拼接的，
    静态分析无法识别（EXECUTE 行会被丢弃）。生产脚本绝大多数是静态 DML。

    支持 $$ 和 $tag$（如 $body$、$func$）两种 dollar-quote 形式。
    """
    def repl(m: re.Match) -> str:
        body = m.group(2)
        kept: list[str] = []
        for line in body.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if _PL_CONTROL_KEYWORDS.match(line):
                continue
            kept.append(stripped)
        return "\n".join(kept)

    return _DO_BLOCK_PATTERN.sub(repl, text)


def apply_rules(text: str, rules: list[dict] | None) -> str:
    """对文本按规则列表顺序逐条执行正则替换。

    rules: 预处理规则列表，每条 {pattern, replacement, enabled, ...}。
    仅执行 enabled=True 的规则，按数组顺序依次 re.sub。
    非法正则在 store.set_preprocess_rules 时已被过滤，这里不重复校验。

    规则示例（内置参数映射，由旧 param_mapping 迁移而来）：
      pattern=r"\\${icl_schema}", replacement="ods"
      → ${icl_schema}.orders → ods.orders
    """
    if not rules:
        return text
    for r in rules:
        if not r.get("enabled", True):
            continue
        pattern = r.get("pattern", "")
        replacement = r.get("replacement", "")
        if not pattern:
            continue
        try:
            text = re.sub(pattern, replacement, text)
        except re.error:
            # 非法正则跳过（理论上 set_preprocess_rules 已过滤，这里兜底）
            continue
    return text


def replace_params(text: str, mapping: dict[str, str] | None = None) -> str:
    """[已废弃] 把 SQL 里的 ${param} 占位符替换成实际值。

    保留向后兼容。新代码应通过 apply_rules + 参数映射规则实现同样效果。
    """
    if not mapping:
        mapping = {}

    def repl(m: re.Match) -> str:
        name = m.group(1)
        return mapping.get(name, name)   # 注意:无映射时回退到参数名本身

    # \w+ 匹配参数名（字母数字下划线）；${schema}_${env} 各自匹配，拼接成单标识符
    return re.sub(r"\$\{(\w+)\}", repl, text)


def preprocess(script: str, rules: list[dict] | None = None,
               param_mapping: dict[str, str] | None = None) -> str:
    """对 DML 脚本进行预处理：规则替换、去注释、DO block 提取、事务关键字补分号、去多余空格、去空白行。

    三阶段流水线：
      阶段 A（可配置）：apply_rules 按规则列表顺序执行正则替换（含参数映射规则）
      阶段 B（固定核心）：去注释（受 locked 规则开关控制）→ DO block 提取 → 事务补分号 → 压缩空格

    rules: 预处理规则列表（来自 store.get_preprocess_rules）。None 时跳过阶段 A。
    param_mapping: [已废弃] 旧参数映射，仅为向后兼容保留。

    去注释的开关：阶段 A 的 apply_rules 已经执行了 locked 去注释规则（如果 enabled）。
    阶段 B 不再重复执行去注释——避免双重处理。但如果 rules=None（旧调用方式），
    阶段 B 仍然兜底去注释。

    注意：不会移除 CREATE TABLE / CREATE TEMP TABLE 语句。
    注意：不碰 END 关键字（CASE WHEN...END vs 事务块 END 无法区分）。
    """
    # 阶段 A：可配置规则替换（含 locked 去注释规则，如果 enabled）
    if rules is not None:
        text = apply_rules(script, rules)
    elif param_mapping is not None:
        text = replace_params(script, param_mapping)
        # 旧调用方式：阶段 B 兜底去注释
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
        text = re.sub(r"--[^\n]*", "", text)
    else:
        text = script
        # 无规则：阶段 B 兜底去注释
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
        text = re.sub(r"--[^\n]*", "", text)

    # 兜底：未匹配的 ${param} 占位符替换成参数名本身（当合法标识符用）。
    text = re.sub(r"\$\{(\w+)\}", r"\1", text)

    # 阶段 B：固定核心（不可配置）
    # 1. 从 DO $$...$$ 匿名块提取 DML（去掉外壳 + PL/pgSQL 控制关键字）
    text = extract_dml_from_do_blocks(text)
    # 2. 给行首事务关键字补分号
    text = re.sub(
        r"(?im)^(?=\s*(?:BEGIN(?:\s+TRANSACTION)?|START\s+TRANSACTION|COMMIT|ROLLBACK)\b)([^;\n]*)$",
        lambda m: m.group(1) if ";" in m.group(1) else m.group(1).rstrip() + ";",
        text,
    )
    # 3. 压缩连续空格（保留换行，方便后续按行处理）
    text = re.sub(r"[^\S\n]+", " ", text)
    # 4. 去除每行首尾空白
    lines = [line.strip() for line in text.splitlines()]
    # 5. 移除空行
    lines = [line for line in lines if line]
    return "\n".join(lines)
