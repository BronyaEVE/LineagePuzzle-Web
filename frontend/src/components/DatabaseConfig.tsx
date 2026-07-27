import React from "react";
import { Form, Input, InputNumber, Collapse, Typography } from "antd";
import type { DatabaseConfig as DatabaseConfigType } from "../types";

interface Props {
  value: DatabaseConfigType;
  onChange: (val: DatabaseConfigType) => void;
}

const DatabaseConfigForm: React.FC<Props> = ({ value, onChange }) => {
  const handleChange = (field: keyof DatabaseConfigType, val: string | number) => {
    onChange({ ...value, [field]: val });
  };

  return (
    <Collapse
      // 默认折叠：用户不展开即走离线模式（纯 AST 分析）
      defaultActiveKey={[]}
      size="small"
      style={{ marginBottom: 12 }}
      items={[
        {
          key: "db",
          label: "高级选项：数据库连接（可选）",
          children: (
            <>
              <Typography.Text
                type="secondary"
                style={{ display: "block", marginBottom: 8 }}
              >
                💡 不填写则使用离线模式（纯 AST 分析，不连接数据库）。如需校验表是否存在、补充列信息，请填写并连接数据库。
              </Typography.Text>
              <Form layout="inline" size="small">
                <Form.Item label="主机">
                  <Input
                    value={value.host}
                    onChange={(e) => handleChange("host", e.target.value)}
                    style={{ width: 120 }}
                  />
                </Form.Item>
                <Form.Item label="端口">
                  <InputNumber
                    value={value.port}
                    onChange={(v) => handleChange("port", v ?? 5432)}
                    style={{ width: 80 }}
                  />
                </Form.Item>
                <Form.Item label="数据库">
                  <Input
                    value={value.database}
                    onChange={(e) => handleChange("database", e.target.value)}
                    style={{ width: 120 }}
                  />
                </Form.Item>
                <Form.Item label="用户名">
                  <Input
                    value={value.username}
                    onChange={(e) => handleChange("username", e.target.value)}
                    style={{ width: 100 }}
                  />
                </Form.Item>
                <Form.Item label="密码">
                  <Input.Password
                    value={value.password}
                    onChange={(e) => handleChange("password", e.target.value)}
                    style={{ width: 100 }}
                  />
                </Form.Item>
              </Form>
            </>
          ),
        },
      ]}
    />
  );
};

export default DatabaseConfigForm;
