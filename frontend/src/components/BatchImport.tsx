import React, { useState } from "react";
import { Upload, Button, Space, Typography, List, Tag, Checkbox, Popover, message } from "antd";
import { InboxOutlined, DeleteOutlined, FileTextOutlined, TagOutlined } from "@ant-design/icons";
import { unzipSync, strFromU8 } from "fflate";
import type { AnalysisResult, DatabaseConfig, TagSchema } from "../types";
import { submitBatchAnalysis } from "../api/client";

const { Dragger } = Upload;

/**
 * 待分析的 SQL 文件（已读取内容，zip 已解压）。
 * content 是纯文本 SQL，name 是文件名（含 .sql 后缀）。
 */
interface SqlFile {
  name: string;
  content: string;
}

interface Props {
  /** DB 配置，对批量分析和手动粘贴两种模式共用 */
  dbConfig: DatabaseConfig;
  /** 批量分析成功后的回调（App 用来关闭 Modal + 刷新列表） */
  onSuccess: () => void;
  /** 标签维度定义表（用于批量上传时给整批统一打标）。 */
  tagSchema: TagSchema;
}

/**
 * 批量导入 SQL 文件组件。
 *
 * 支持两种输入：
 *   1. 多选 .sql 文件（浏览器原生 multiple）
 *   2. .zip 压缩包（含多个 .sql，用 fflate 在前端解压）
 *
 * 解压/读取后，文件以 {name, content} 纯文本形式收集到本地 state，
 * 提交时一次性 JSON 发给后端 /analyze-batch，每个文件产出独立脚本。
 *
 * 设计要点：
 *   - Dragger 的 beforeUpload 返回 false，阻止 antd 自动上传（我们只要文件对象）
 *   - zip 用 fflate.unzipSync 同步解压（浏览器已读为 Uint8Array）
 *   - 同名文件覆盖（去重），避免重复导入
 *   - 非 .sql 文件（zip 内或直接选）被忽略
 */
const BatchImport: React.FC<Props> = ({ dbConfig, onSuccess, tagSchema }) => {
  const [files, setFiles] = useState<SqlFile[]>([]);
  const [loading, setLoading] = useState(false);
  // 整批统一打标的草稿（可选）。留空则上传后脚本 tags 为空。
  const [batchTags, setBatchTags] = useState<string[]>([]);

  /** 把新文件并入列表（同名覆盖） */
  const mergeFiles = (incoming: SqlFile[]) => {
    setFiles((prev) => {
      const map = new Map(prev.map((f) => [f.name, f]));
      for (const f of incoming) {
        map.set(f.name, f); // 同名覆盖
      }
      return Array.from(map.values());
    });
  };

  /** 读取一个 .sql File 对象为 SqlFile */
  const readSqlFile = async (file: File): Promise<SqlFile | null> => {
    try {
      const content = await file.text();
      return { name: file.name, content };
    } catch {
      message.warning(`读取 ${file.name} 失败`);
      return null;
    }
  };

  /** 解压 .zip File，提取其中所有 .sql 为 SqlFile[] */
  const readZipFile = async (file: File): Promise<SqlFile[]> => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const entries = unzipSync(buf);
      const result: SqlFile[] = [];
      for (const [path, data] of Object.entries(entries)) {
        // 只取 .sql；跳过目录和非 sql 文件
        if (!path.toLowerCase().endsWith(".sql")) continue;
        // 跳过目录项（以 / 结尾）
        if (path.endsWith("/")) continue;
        // 取文件名（zip 内可能是 a/b/c.sql，用末段）
        const name = path.split("/").pop() || path;
        try {
          result.push({ name, content: strFromU8(data) });
        } catch {
          // 解码失败跳过（可能是二进制）
        }
      }
      if (result.length === 0) {
        message.warning(`${file.name} 中未找到 .sql 文件`);
      }
      return result;
    } catch {
      message.error(`${file.name} 解压失败，可能不是有效的 zip`);
      return [];
    }
  };

  /** 处理 Dragger 选择/拖入的文件（beforeUpload 拦截） */
  const handleBeforeUpload = async (file: File): Promise<boolean> => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".sql")) {
      const sf = await readSqlFile(file);
      if (sf) mergeFiles([sf]);
    } else if (lower.endsWith(".zip")) {
      const sfs = await readZipFile(file);
      if (sfs.length) mergeFiles(sfs);
    } else {
      message.warning(`${file.name} 不是 .sql 或 .zip，已忽略`);
    }
    return false; // 阻止 antd 自动上传
  };

  /** 批量提交分析 */
  const handleSubmit = async () => {
    if (files.length === 0) return;
    setLoading(true);
    const hide = message.loading(`正在分析 ${files.length} 个文件...`, 0);
    try {
      const hasDb = Boolean(dbConfig.database?.trim());
      const results: AnalysisResult[] = await submitBatchAnalysis(
        files,
        hasDb ? dbConfig : null,
        batchTags,
      );
      hide();
      const got = results.length;
      const skipped = files.length - got;
      message.success(
        `成功导入 ${got} 个脚本${skipped > 0 ? `（${skipped} 个失败）` : ""}`,
        4,
      );
      setFiles([]);
      setBatchTags([]);
      onSuccess();
    } catch (e: unknown) {
      hide();
      const msg = e instanceof Error ? e.message : "批量导入失败";
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  return (
    <div>
      <Dragger
        accept=".sql,.zip"
        multiple
        showUploadList={false}
        beforeUpload={handleBeforeUpload}
        style={{ marginBottom: 12, padding: 12 }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此区域导入</p>
        <p className="ant-upload-hint">
          支持多选 <code>.sql</code> 文件，或含多个 .sql 的 <code>.zip</code> 压缩包
        </p>
      </Dragger>

      {files.length > 0 && (
        <>
          <Space style={{ marginBottom: 8, justifyContent: "space-between", width: "100%" }}>
            <Typography.Text strong>
              待分析文件 <Tag color="blue">{files.length}</Tag> 个
            </Typography.Text>
            <Button size="small" onClick={() => setFiles([])}>清空</Button>
          </Space>
          <List
            size="small"
            bordered
            dataSource={files}
            style={{ maxHeight: 240, overflow: "auto", marginBottom: 12 }}
            renderItem={(f) => (
              <List.Item
                actions={[
                  <Button
                    key="del"
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeFile(f.name)}
                  />,
                ]}
              >
                <List.Item.Meta
                  avatar={<FileTextOutlined style={{ color: "#1890ff" }} />}
                  title={<span style={{ fontSize: 13 }}>{f.name}</span>}
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {f.content.length.toLocaleString()} 字符
                    </Typography.Text>
                  }
                />
              </List.Item>
            )}
          />
        </>
      )}

      {/* 可选：整批统一打标。留空则上传后脚本 tags 为空，后续可在列表逐条补。 */}
      {tagSchema.dimensions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Popover
            trigger="click"
            placement="topLeft"
            title="为整批脚本打标签（所有文件统一）"
            content={
              <div style={{ width: 240, maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
                {tagSchema.dimensions.map((dim) => (
                  <div key={dim.name} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4, fontWeight: 600 }}>{dim.name}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
                      {dim.values.map((v) => (
                        <Checkbox
                          key={v}
                          checked={batchTags.includes(v)}
                          onChange={(e) => {
                            if (e.target.checked) setBatchTags([...batchTags, v]);
                            else setBatchTags(batchTags.filter((t) => t !== v));
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
            }
          >
            <Button icon={<TagOutlined />} style={{ width: "100%", justifyContent: "flex-start" }}>
              打标签（可选）{batchTags.length > 0 ? ` ${batchTags.length} 个` : ""}
            </Button>
          </Popover>
          {batchTags.length > 0 && (
            <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 2 }}>
              {batchTags.map((t) => (
                <Tag
                  key={t}
                  color="purple"
                  closable
                  onClose={() => setBatchTags(batchTags.filter((x) => x !== t))}
                  style={{ fontSize: 11, margin: 0 }}
                >
                  {t}
                </Tag>
              ))}
            </div>
          )}
        </div>
      )}

      <Button
        type="primary"
        block
        size="large"
        loading={loading}
        disabled={files.length === 0}
        onClick={handleSubmit}
      >
        {files.length > 0
          ? `开始批量分析（${files.length} 个文件）`
          : "请先导入文件"}
      </Button>
    </div>
  );
};

export default BatchImport;
