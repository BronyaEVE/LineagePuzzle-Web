import React, { useState, useEffect, useRef } from "react";
import { Input, Button, Typography, Space, Switch, Tag, Tooltip } from "antd";
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined, LockOutlined } from "@ant-design/icons";
import type { PreprocessRule } from "../types";

/**
 * 预处理规则配置组件（动态表格行）。
 *
 * 管理 PreprocessRule[] 列表，分析前按数组顺序执行 re.sub(pattern, replacement)。
 * 参数映射（${param} → 值）已降级为一种 builtin 规则，用户可增减自定义清洗规则。
 *
 * 设计要点（复用 ParamMappingConfig 的断回环模式）：
 * 组件内部用 rows[] 持有编辑状态，而非直接受控于父组件。
 * lastEmittedRef 记录最近 emit 值，避免编辑回流触发重置。
 */
interface Props {
  value: PreprocessRule[];
  onChange: (val: PreprocessRule[]) => void;
}

// 前端正则校验：非法正则高亮（与后端 re.compile 校验对齐）
function isValidRegex(pattern: string): boolean {
  if (!pattern) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const PreprocessRulesConfig: React.FC<Props> = ({ value, onChange }) => {
  const [rows, setRows] = useState<PreprocessRule[]>([]);
  const lastEmittedRef = useRef<string>("");

  const valueKey = JSON.stringify(value);
  useEffect(() => {
    if (valueKey === lastEmittedRef.current) return;
    setRows(value.map((r) => ({ ...r })));
    lastEmittedRef.current = valueKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const syncChange = (newRows: PreprocessRule[]) => {
    setRows(newRows);
    const serialized = JSON.stringify(newRows);
    lastEmittedRef.current = serialized;
    onChange(newRows);
  };

  const updateRow = (index: number, patch: Partial<PreprocessRule>) => {
    syncChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    const newRule: PreprocessRule = {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: "",
      pattern: "",
      replacement: "",
      enabled: true,
      builtin: false,
      locked: false,
    };
    syncChange([...rows, newRule]);
  };

  const removeRow = (index: number) => {
    syncChange(rows.filter((_, i) => i !== index));
  };

  const invalidCount = rows.filter((r) => r.pattern && !isValidRegex(r.pattern)).length;

  return (
    <div>
      <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
        💡 配置分析前的文本预处理规则。每条规则按顺序执行 <code>正则替换</code>。
        参数映射（<code>{"${param}"}</code>→值）也在这里，作为一种内置规则。
        例如：<code>pattern={"--[^\\n]*"} replacement=""</code> 去单行注释。
      </Typography.Text>

      {rows.map((row, idx) => {
        const regexInvalid = row.pattern !== "" && !isValidRegex(row.pattern);
        return (
          <div
            key={row.id}
            style={{
              marginBottom: 8, padding: "8px 10px",
              background: row.locked ? "#fff7e6" : (row.builtin ? "#fafafa" : "#f6ffed"),
              border: `1px solid ${row.locked ? "#ffd591" : (row.builtin ? "#f0f0f0" : "#b7eb8f")}`,
              borderRadius: 4,
            }}
          >
            <Space style={{ display: "flex", marginBottom: 6 }} align="center">
              <Switch
                size="small"
                checked={row.enabled}
                onChange={(checked) => updateRow(idx, { enabled: checked })}
              />
              {row.locked && (
                <Tag color="orange" style={{ fontSize: 11 }} icon={<LockOutlined />}>锁定</Tag>
              )}
              {row.builtin && !row.locked && <Tag color="blue" style={{ fontSize: 11 }}>内置</Tag>}
              <Input
                placeholder="规则名称（如：去单行注释）"
                style={{ flex: 1, minWidth: 180 }}
                value={row.name}
                onChange={(e) => updateRow(idx, { name: e.target.value })}
              />
              {row.locked ? (
                <Tooltip title="核心规则不可删除（可开关）">
                  <Button type="text" size="small" disabled icon={<LockOutlined />} />
                </Tooltip>
              ) : (
                <Tooltip title="删除规则">
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => removeRow(idx)}
                  />
                </Tooltip>
              )}
            </Space>
            <Space style={{ display: "flex", alignItems: "flex-start" }} align="start">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input.TextArea
                  placeholder="正则表达式（如：--\[^\n\]*）"
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 12,
                    borderColor: regexInvalid ? "#ff4d4f" : undefined,
                  }}
                  value={row.pattern}
                  onChange={(e) => updateRow(idx, { pattern: e.target.value })}
                  status={regexInvalid ? "error" : undefined}
                />
                {regexInvalid && (
                  <Typography.Text type="danger" style={{ fontSize: 11 }}>
                    ⚠️ 无效正则，保存时会被过滤
                  </Typography.Text>
                )}
              </div>
              <span style={{ color: "#999", paddingTop: 4 }}>→</span>
              <Input.TextArea
                placeholder="替换为（支持 $1 $2，留空即删除）"
                autoSize={{ minRows: 1, maxRows: 3 }}
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                  flex: 1,
                  minWidth: 0,
                }}
                value={row.replacement}
                onChange={(e) => updateRow(idx, { replacement: e.target.value })}
              />
            </Space>
          </div>
        );
      })}

      <Button
        type="dashed"
        onClick={addRow}
        icon={<PlusOutlined />}
        style={{ width: "100%", marginTop: 8 }}
      >
        添加规则
      </Button>

      {rows.length === 0 && (
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 12, fontSize: 12 }}>
          （当前无规则。未配置的 {"${param}"} 会自动用参数名作标识符。）
        </Typography.Text>
      )}
      {invalidCount > 0 && (
        <Typography.Text type="warning" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          ⚠️ {invalidCount} 条规则的正则无效，保存时会被过滤
        </Typography.Text>
      )}
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 11 }}>
        <ThunderboltOutlined /> 规则按列表顺序执行；内置规则（参数映射）以蓝色标记
      </Typography.Text>
    </div>
  );
};

export default PreprocessRulesConfig;
