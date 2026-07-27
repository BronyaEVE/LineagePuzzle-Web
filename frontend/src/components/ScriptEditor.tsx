import React from "react";
import { Button, Card, Space, Input } from "antd";

interface Props {
  value: string;
  onChange: (val: string) => void;
  onAnalyze: () => void;
  loading: boolean;
}

const { TextArea } = Input;

const ScriptEditor: React.FC<Props> = ({ value, onChange, onAnalyze, loading }) => {
  return (
    <Card
      title="DML 脚本"
      size="small"
      extra={
        <Space>
          <Button type="primary" onClick={onAnalyze} loading={loading} disabled={!value.trim()}>
            分析血缘
          </Button>
        </Space>
      }
    >
      <TextArea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴 DML 脚本（INSERT / CREATE TABLE AS / UPDATE / DELETE / MERGE），支持多条语句和 ${param} 占位符…"
        autoSize={{ minRows: 10, maxRows: 18 }}
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 13,
        }}
      />
    </Card>
  );
};

export default ScriptEditor;
