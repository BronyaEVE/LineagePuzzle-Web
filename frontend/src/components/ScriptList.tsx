import React from "react";
import { Card, List, Typography, Button, Popconfirm, Input, Empty, Tag, Checkbox, Popover, message } from "antd";
import {
  DeleteOutlined, EditOutlined, FileTextOutlined, GlobalOutlined,
  TagOutlined, FilterOutlined, CheckSquareOutlined,
} from "@ant-design/icons";
import type { ScriptSummary, TagSchema } from "../types";
import { GLOBAL_ID } from "../types";

const { Text } = Typography;

interface Props {
  scripts: ScriptSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** 全局图谱的节点/边数（用于虚拟项显示统计） */
  tableCount?: number;
  edgeCount?: number;
  /** 标签维度定义表（管理员维护）。空时筛选器不展示可选项。 */
  tagSchema: TagSchema;
  /** 当前选中的筛选标签（扁平集合）。 */
  selectedTags: string[];
  onSelectedTagsChange: (tags: string[]) => void;
  /** 命中筛选的脚本 id 集合（由 App 计算，用于列表项灰显判断）。 */
  hitScriptIds: Set<string>;
  /** 是否全局视图（筛选器仅在全局视图生效，单脚本视图灰显）。 */
  isGlobalView: boolean;
  /** 给单个脚本打标（全量替换）。 */
  onSetScriptTags: (id: string, tags: string[]) => void;
  /** 批量给多个脚本打同一组标签。 */
  onBatchSetTags: (ids: string[], tags: string[]) => void;
}

const ScriptList: React.FC<Props> = ({
  scripts, selectedId, onSelect, onDelete, onRename,
  tableCount, edgeCount,
  tagSchema, selectedTags, onSelectedTagsChange, hitScriptIds, isGlobalView,
  onSetScriptTags, onBatchSetTags,
}) => {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  // 批量选择模式：勾选中的脚本 id 集合
  const [batchMode, setBatchMode] = React.useState(false);
  const [batchSelected, setBatchSelected] = React.useState<Set<string>>(new Set());
  // 单条打标的 Popover 临时草稿（打开时拷贝当前 tags，确认时提交）
  const [tagDraftId, setTagDraftId] = React.useState<string | null>(null);
  const [tagDraft, setTagDraft] = React.useState<string[]>([]);
  // 批量打标的 Popover 临时草稿
  const [batchTagDraft, setBatchTagDraft] = React.useState<string[]>([]);

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const confirmRename = () => {
    if (editingId && editName.trim()) {
      onRename(editingId, editName.trim());
    }
    setEditingId(null);
  };

  // 切换筛选标签选中态
  const toggleFilterTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onSelectedTagsChange(selectedTags.filter((t) => t !== tag));
    } else {
      onSelectedTagsChange([...selectedTags, tag]);
    }
  };

  // 单条打标 Popover 内容：按维度分组展示所有可选标签，勾选当前草稿
  const renderTagEditor = (draft: string[], setDraft: (t: string[]) => void) => {
    if (tagSchema.dimensions.length === 0) {
      return (
        <div style={{ width: 220, padding: "8px 4px", color: "#999", fontSize: 12 }}>
          暂无标签维度。请先在「设置 → 标签维度」中定义维度和标签值。
        </div>
      );
    }
    return (
      <div style={{ width: 240, maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
        {tagSchema.dimensions.map((dim) => (
          <div key={dim.name} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4, fontWeight: 600 }}>{dim.name}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
              {dim.values.map((v) => (
                <Checkbox
                  key={v}
                  checked={draft.includes(v)}
                  onChange={(e) => {
                    if (e.target.checked) setDraft([...draft, v]);
                    else setDraft(draft.filter((t) => t !== v));
                  }}
                  style={{ fontSize: 12 }}
                >
                  {v}
                </Checkbox>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // 筛选器 Popover：按维度分组，复选框勾选触发筛选
  const renderFilterContent = () => {
    if (tagSchema.dimensions.length === 0) {
      return (
        <div style={{ width: 220, padding: "8px 4px", color: "#999", fontSize: 12 }}>
          暂无标签维度。请先在「设置 → 标签维度」中定义维度和标签值。
        </div>
      );
    }
    return (
      <div style={{ width: 240, maxHeight: 360, overflowY: "auto", padding: "4px 0" }}>
        {tagSchema.dimensions.map((dim) => (
          <div key={dim.name} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4, fontWeight: 600 }}>{dim.name}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
              {dim.values.map((v) => (
                <Checkbox
                  key={v}
                  checked={selectedTags.includes(v)}
                  onChange={() => toggleFilterTag(v)}
                  style={{ fontSize: 12 }}
                >
                  {v}
                </Checkbox>
              ))}
            </div>
          </div>
        ))}
        {selectedTags.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #f0f0f0" }}>
            <Button size="small" type="link" onClick={() => onSelectedTagsChange([])}>
              清除筛选
            </Button>
          </div>
        )}
      </div>
    );
  };

  // 全局图谱虚拟项（置顶，不可删除/重命名）
  const renderGlobalItem = () => {
    const isSelected = selectedId === GLOBAL_ID;
    return (
      <List.Item
        onClick={() => onSelect(GLOBAL_ID)}
        style={{
          cursor: "pointer",
          background: isSelected ? "#e6f7ff" : "#fafafa",
          borderLeft: isSelected ? "3px solid #1890ff" : "3px solid #1890ff",
          padding: "8px 12px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <div style={{ width: "100%" }}>
          <div style={{ marginBottom: 4 }}>
            <GlobalOutlined style={{ marginRight: 4, color: "#1890ff" }} />
            <Text strong style={{ fontSize: 13 }}>全局图谱</Text>
            <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>置顶</Tag>
          </div>
          {(tableCount !== undefined || edgeCount !== undefined) && (
            <div>
              {tableCount !== undefined && <Tag color="green" style={{ fontSize: 11 }}>{tableCount} 张表</Tag>}
              {edgeCount !== undefined && <Tag color="blue" style={{ fontSize: 11 }}>{edgeCount} 条血缘</Tag>}
            </div>
          )}
        </div>
      </List.Item>
    );
  };

  // 退出批量模式时清空选择
  const exitBatchMode = () => {
    setBatchMode(false);
    setBatchSelected(new Set());
    setBatchTagDraft([]);
  };

  const batchToggle = (id: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchTagConfirm = () => {
    if (batchSelected.size === 0) {
      message.warning("请先勾选要打标的脚本");
      return;
    }
    onBatchSetTags([...batchSelected], batchTagDraft);
    exitBatchMode();
  };

  return (
    <Card
      title={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>脚本列表 ({scripts.length})</span>
          <Button
            size="small"
            type="text"
            icon={<CheckSquareOutlined />}
            onClick={() => batchMode ? exitBatchMode() : setBatchMode(true)}
            title={batchMode ? "退出批量模式" : "批量打标"}
            style={{ color: batchMode ? "#1890ff" : "#999", fontSize: 12 }}
          >
            {batchMode ? "完成" : "批量"}
          </Button>
        </div>
      }
      size="small"
      style={{ height: "100%", overflow: "auto" }}
      styles={{ body: { padding: 0 } }}
    >
      {/* 标签筛选器：仅在全局视图生效，单脚本视图灰显 */}
      {tagSchema.dimensions.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #f0f0f0",
            background: "#fafafa",
            opacity: isGlobalView ? 1 : 0.5,
          }}
          title={isGlobalView ? undefined : "切换到全局视图后生效"}
        >
          <Popover content={renderFilterContent()} trigger="click" placement="bottomLeft">
            <Button size="small" icon={<FilterOutlined />} style={{ width: "100%", justifyContent: "flex-start" }}>
              标签筛选{selectedTags.length > 0 ? ` (${selectedTags.length})` : ""}
            </Button>
          </Popover>
          {selectedTags.length > 0 && (
            <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 2 }}>
              {selectedTags.map((t) => (
                <Tag
                  key={t}
                  color="purple"
                  closable
                  onClose={() => toggleFilterTag(t)}
                  style={{ fontSize: 10, margin: 0 }}
                >
                  {t}
                </Tag>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 批量打标操作栏（仅批量模式显示） */}
      {batchMode && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0", background: "#e6f7ff" }}>
          <Text style={{ fontSize: 12, marginRight: 8 }}>已选 {batchSelected.size} 个</Text>
          <Popover
            content={renderTagEditor(batchTagDraft, setBatchTagDraft)}
            trigger="click"
            placement="bottomLeft"
            title="为选中脚本打标签（全量替换）"
          >
            <Button size="small" type="primary" icon={<TagOutlined />}>打标签</Button>
          </Popover>
          <Button size="small" style={{ marginLeft: 8 }} onClick={handleBatchTagConfirm}>确认</Button>
        </div>
      )}

      {/* 全局图谱虚拟项（始终置顶） */}
      {renderGlobalItem()}

      {scripts.length === 0 ? (
        <Empty description="暂无脚本" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
      ) : (
        <List
          size="small"
          dataSource={scripts}
          renderItem={(item) => {
            const isSelected = selectedId === item.analysis_id;
            const isEditing = editingId === item.analysis_id;
            // 筛选命中判断：全局视图 + 有筛选条件时，未命中的灰显（不隐藏）
            const hasFilter = isGlobalView && selectedTags.length > 0;
            const isHit = hitScriptIds.has(item.analysis_id);
            const dimmed = hasFilter && !isHit;

            // 批量模式：每项前加 Checkbox
            const batchCheckbox = batchMode ? (
              <Checkbox
                checked={batchSelected.has(item.analysis_id)}
                onChange={() => batchToggle(item.analysis_id)}
                onClick={(e) => e.stopPropagation()}
                style={{ marginRight: 8 }}
              />
            ) : null;

            return (
              <List.Item
                onClick={() => !isEditing && !batchMode && onSelect(item.analysis_id)}
                style={{
                  cursor: isEditing || batchMode ? "default" : "pointer",
                  background: isSelected ? "#e6f7ff" : undefined,
                  borderLeft: isSelected ? "3px solid #1890ff" : "3px solid transparent",
                  padding: "8px 12px",
                  opacity: dimmed ? 0.4 : 1,
                  transition: "background 0.2s, opacity 0.2s",
                }}
                actions={
                  batchMode || isEditing
                    ? undefined
                    : [
                        // 打标签按钮
                        <Popover
                          key="tags"
                          content={renderTagEditor(tagDraft, setTagDraft)}
                          trigger="click"
                          placement="bottomLeft"
                          title="编辑标签"
                          onOpenChange={(open) => {
                            if (open) {
                              setTagDraftId(item.analysis_id);
                              setTagDraft([...item.tags]);
                            } else if (tagDraftId === item.analysis_id) {
                              // 关闭时提交（仅当有变化时）
                              onSetScriptTags(item.analysis_id, tagDraft);
                              setTagDraftId(null);
                            }
                          }}
                        >
                          <Button
                            type="text"
                            size="small"
                            icon={<TagOutlined />}
                            onClick={(e) => e.stopPropagation()}
                            title="编辑标签"
                          />
                        </Popover>,
                        <Button
                          key="rename"
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(item.analysis_id, item.name);
                          }}
                        />,
                        <Popconfirm
                          key="delete"
                          title="确定删除该脚本？"
                          onConfirm={(e) => {
                            e?.stopPropagation();
                            onDelete(item.analysis_id);
                          }}
                          onCancel={(e) => e?.stopPropagation()}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Popconfirm>,
                      ]
                }
              >
                <div style={{ width: "100%", display: "flex", alignItems: "flex-start" }}>
                  {batchCheckbox}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <Input
                        size="small"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onPressEnter={confirmRename}
                        onBlur={confirmRename}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <div style={{ marginBottom: 4 }}>
                          <FileTextOutlined style={{ marginRight: 4, color: "#1890ff" }} />
                          <Text strong style={{ fontSize: 13 }}>{item.name}</Text>
                        </div>
                        <div>
                          <Tag color="blue" style={{ fontSize: 11 }}>{item.statement_count} 条语句</Tag>
                          <Tag color="green" style={{ fontSize: 11 }}>{item.table_count} 张表</Tag>
                        </div>
                        {item.tags && item.tags.length > 0 && (
                          <div style={{ marginTop: 2, display: "flex", flexWrap: "wrap", gap: 2 }}>
                            {item.tags.map((t) => (
                              <Tag key={t} color="purple" style={{ fontSize: 10, margin: 0 }}>{t}</Tag>
                            ))}
                          </div>
                        )}
                        <div style={{ marginTop: 2 }}>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {new Date(item.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                          </Text>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
};

export default ScriptList;
