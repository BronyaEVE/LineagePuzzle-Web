import React from "react";
import { Card, Tag, List, Typography, Empty } from "antd";
import {
  PlusCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  SwapOutlined,
  MergeOutlined,
  BuildOutlined,
} from "@ant-design/icons";
import type { StatementGroup } from "../types";

const { Text } = Typography;

interface Props {
  statementGroup: StatementGroup | null;
  highlightSeq: number | null;
  onStatementClick: (seq: number) => void;
}

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  CREATE: { color: "gold", icon: <BuildOutlined /> },
  INSERT: { color: "green", icon: <PlusCircleOutlined /> },
  UPDATE: { color: "blue", icon: <EditOutlined /> },
  DELETE: { color: "red", icon: <DeleteOutlined /> },
  MERGE: { color: "purple", icon: <MergeOutlined /> },
  UNKNOWN: { color: "default", icon: <SwapOutlined /> },
};

const StatementPanel: React.FC<Props> = ({ statementGroup, highlightSeq, onStatementClick }) => {
  if (!statementGroup || !statementGroup.statements.length) {
    return (
      <Card title="语句分段" size="small" style={{ height: "100%" }}>
        <Empty description="暂无语句" />
      </Card>
    );
  }

  return (
    <Card
      title={`语句分段 (${statementGroup.statements.length} 条)`}
      size="small"
      style={{ height: "100%", overflow: "auto" }}
    >
      <List
        size="small"
        dataSource={statementGroup.statements}
        renderItem={(stmt) => {
          const cfg = TYPE_CONFIG[stmt.type] || TYPE_CONFIG.UNKNOWN;
          const isHighlighted = highlightSeq === stmt.seq;
          return (
            <List.Item
              onClick={() => onStatementClick(stmt.seq)}
              style={{
                cursor: "pointer",
                background: isHighlighted ? "#e6f7ff" : undefined,
                borderLeft: isHighlighted ? "3px solid #1890ff" : "3px solid transparent",
                padding: "6px 8px",
                transition: "background 0.2s",
              }}
            >
              <div style={{ width: "100%" }}>
                <div style={{ marginBottom: 4 }}>
                  <Tag color={cfg.color} icon={cfg.icon}>
                    #{stmt.seq} {stmt.type}
                  </Tag>
                </div>
                <Text
                  code
                  style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {stmt.text.length > 200 ? stmt.text.slice(0, 200) + "..." : stmt.text}
                </Text>
                {stmt.tables_referenced.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      引用表: {stmt.tables_referenced.join(", ")}
                    </Text>
                  </div>
                )}
                {(stmt.tables_created.length > 0 || stmt.tables_modified.length > 0) && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {[...stmt.tables_created.map((t) => `创建:${t}`), ...stmt.tables_modified.map((t) => `写入:${t}`)].join(", ")}
                    </Text>
                  </div>
                )}
              </div>
            </List.Item>
          );
        }}
      />
    </Card>
  );
};

export default StatementPanel;
