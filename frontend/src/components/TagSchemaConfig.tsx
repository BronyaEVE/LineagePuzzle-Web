import React, { useState, useEffect, useRef } from "react";
import { Input, Button, Typography, Space, Tag, Tooltip, Empty } from "antd";
import { PlusOutlined, DeleteOutlined, TagsOutlined } from "@ant-design/icons";
import type { TagDimension } from "../types";

/**
 * 标签维度定义配置组件（管理员维护）。
 *
 * 管理 TagDimension[] 列表（维度名 + 该维度下的可选标签值）。
 * 脚本只存扁平 tags 数组，维度信息纯外置——这里的改动不影响已打标的脚本，
 * 只影响筛选器和打标浮层里展示的可选项。
 *
 * 复用断回环模式（同 PreprocessRulesConfig）：内部 rows[] 持有编辑状态，
 * lastEmittedRef 记录最近 emit 值，避免编辑回流触发重置。
 */
interface Props {
  value: TagDimension[];
  onChange: (val: TagDimension[]) => void;
}

const TagSchemaConfig: React.FC<Props> = ({ value, onChange }) => {
  const [rows, setRows] = useState<TagDimension[]>([]);
  const lastEmittedRef = useRef<string>("");

  const valueKey = JSON.stringify(value);
  useEffect(() => {
    if (valueKey === lastEmittedRef.current) return;
    setRows(value.map((d) => ({ ...d, values: [...d.values] })));
    lastEmittedRef.current = valueKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const syncChange = (newRows: TagDimension[]) => {
    setRows(newRows);
    const serialized = JSON.stringify(newRows);
    lastEmittedRef.current = serialized;
    onChange(newRows);
  };

  // 维度行操作
  const addDimension = () => {
    syncChange([...rows, { name: "", values: [] }]);
  };
  const updateDimensionName = (idx: number, name: string) => {
    const next = rows.map((r, i) => i === idx ? { ...r, name } : r);
    syncChange(next);
  };
  const removeDimension = (idx: number) => {
    syncChange(rows.filter((_, i) => i !== idx));
  };

  // 标签值操作（按回车或逗号添加，单个删除）
  const [valueInput, setValueInput] = useState<Record<number, string>>({});
  const addValue = (idx: number) => {
    const raw = (valueInput[idx] || "").trim();
    if (!raw) return;
    // 支持逗号/顿号批量添加
    const parts = raw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const next = rows.map((r, i) => {
      if (i !== idx) return r;
      const existing = new Set(r.values);
      const merged = [...r.values];
      for (const p of parts) {
        if (!existing.has(p)) {
          merged.push(p);
          existing.add(p);
        }
      }
      return { ...r, values: merged };
    });
    syncChange(next);
    setValueInput((prev) => ({ ...prev, [idx]: "" }));
  };
  const removeValue = (dimIdx: number, value: string) => {
    const next = rows.map((r, i) =>
      i === dimIdx ? { ...r, values: r.values.filter((v) => v !== value) } : r
    );
    syncChange(next);
  };

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        定义脚本分类的维度（如「数仓层」「业务线」）和每个维度下的可选标签值。
        脚本只存扁平标签，维度定义改动不影响已打标的脚本，只影响筛选器和打标浮层展示的可选项。
      </Typography.Paragraph>

      {rows.length === 0 && (
        <Empty
          description="暂无维度，点击下方添加"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ margin: "16px 0" }}
        />
      )}

      {rows.map((dim, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #f0f0f0",
            borderRadius: 4,
            padding: 12,
            marginBottom: 8,
          }}
        >
          <Space style={{ width: "100%", marginBottom: 8 }} align="center">
            <TagsOutlined style={{ color: "#722ed1" }} />
            <Input
              size="small"
              placeholder="维度名（如 数仓层 / 业务线 / 负责人）"
              value={dim.name}
              onChange={(e) => updateDimensionName(idx, e.target.value)}
              style={{ width: 220 }}
              maxLength={50}
            />
            <Tooltip title="删除此维度（不影响已打标的脚本，只是筛选器不再展示它）">
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeDimension(idx)}
              />
            </Tooltip>
          </Space>
          <div style={{ paddingLeft: 24 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
              {dim.values.map((v) => (
                <Tag
                  key={v}
                  color="purple"
                  closable
                  onClose={() => removeValue(idx, v)}
                  style={{ margin: 0 }}
                >
                  {v}
                </Tag>
              ))}
              {dim.values.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  暂无标签值
                </Typography.Text>
              )}
            </div>
            <Space.Compact size="small" style={{ width: "100%" }}>
              <Input
                size="small"
                placeholder="输入标签值，回车或逗号添加（如 O层, C层）"
                value={valueInput[idx] || ""}
                onChange={(e) => setValueInput((prev) => ({ ...prev, [idx]: e.target.value }))}
                onPressEnter={() => addValue(idx)}
                onBlur={() => valueInput[idx] && addValue(idx)}
              />
              <Button size="small" icon={<PlusOutlined />} onClick={() => addValue(idx)}>
                添加
              </Button>
            </Space.Compact>
          </div>
        </div>
      ))}

      <Button type="dashed" icon={<PlusOutlined />} onClick={addDimension} block>
        添加维度
      </Button>
    </div>
  );
};

export default TagSchemaConfig;
