import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ConfigProvider, Layout, Button, Modal, message, Tag, Space, Popconfirm, Segmented, Spin, Result } from "antd";
import { PlusOutlined, SettingOutlined, DownloadOutlined, UploadOutlined, TagsOutlined } from "@ant-design/icons";
import { ensureEngine, onStatus } from "./engine/workerClient";
import type { EngineStage } from "./engine/config";
import ScriptList from "./components/ScriptList";
import ScriptEditor from "./components/ScriptEditor";
import DatabaseConfigForm from "./components/DatabaseConfig";
import StatementPanel from "./components/StatementPanel";
import LineageGraph from "./components/LineageGraph";
import type { FocusTarget } from "./components/LineageGraph";
import SearchBox, { type SearchTarget } from "./components/SearchBox";
import PreprocessRulesConfig from "./components/PreprocessRulesConfig";
import TagSchemaConfig from "./components/TagSchemaConfig";
import BatchImport from "./components/BatchImport";
import {
  submitAnalysis, listScripts, getScript, deleteScript,
  renameScript, getGlobalGraph, getPreprocessRules, setPreprocessRules,
  exportData, importData,
  getTagSchema, setTagSchema as apiSetTagSchema,
  setScriptTags as apiSetScriptTags, batchSetScriptTags,
} from "./api/client";
import type {
  DatabaseConfig as DatabaseConfigType, AnalysisResult,
  ScriptSummary, GlobalGraph, PreprocessRule,
  TagSchema, TagDimension,
} from "./types";
import { GLOBAL_ID } from "./types";

const { Header, Content } = Layout;

/** 从 catch 块的 unknown 值安全提取错误消息，兜底返回默认文案。 */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? (e.message || fallback) : fallback;
}

function App() {
  // === 引擎加载状态（Pyodide + sqlglot 在 Web Worker 加载，首次约 4-5s）===
  const [engineStatus, setEngineStatus] = useState<"loading" | "ready" | "error">("loading");
  const [engineStage, setEngineStage] = useState<EngineStage>("loading-wasm");
  const [engineMessage, setEngineMessage] = useState<string>("");

  useEffect(() => {
    // 订阅加载阶段（更新文案）
    const unsub = onStatus((stage, msg) => {
      setEngineStage(stage);
      if (msg) setEngineMessage(msg);
    });
    // 触发引擎加载
    ensureEngine()
      .then(() => setEngineStatus("ready"))
      .catch((e: unknown) => {
        setEngineMessage(e instanceof Error ? e.message : String(e));
        setEngineStatus("error");
      });
    return unsub;
  }, []);

  // === 状态 ===
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [globalGraph, setGlobalGraph] = useState<GlobalGraph | null>(null);
  const [selectedScriptId, setSelectedScriptId] = useState<string>(GLOBAL_ID);
  const [selectedResult, setSelectedResult] = useState<AnalysisResult | null>(null);
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);

  // 搜索框选中后聚焦目标（传给 LineageGraph 执行 fitView + 高亮）
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // 新建分析弹窗的输入模式：手动粘贴 SQL / 批量导入文件
  const [analyzeMode, setAnalyzeMode] = useState<"manual" | "batch">("manual");
  const [loading, setLoading] = useState(false);

  // 新建分析的表单状态
  const [script, setScript] = useState("");
  const [dbConfig, setDbConfig] = useState<DatabaseConfigType>({
    host: "localhost", port: 5432, database: "", username: "", password: "",
  });

  // 预处理规则配置（参数映射 + 自定义清洗，统一为正则替换规则）
  // preprocessRules 是本地编辑草稿；保存时调 setPreprocessRules（API）推送到后端
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [preprocessRules, setPreprocessRulesDraft] = useState<PreprocessRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  // 标签维度定义 + 选中筛选标签（扁平集合）。
  // 维度信息外置在 tagSchema，脚本只存扁平 tags 数组，筛选时按维度分组做命中判断。
  const [tagSchema, setTagSchema] = useState<TagSchema>({ dimensions: [] });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // 标签维度设置弹窗的编辑草稿 + 开关
  const [tagSchemaModalOpen, setTagSchemaModalOpen] = useState(false);
  const [tagSchemaDraft, setTagSchemaDraft] = useState<TagDimension[]>([]);
  const [tagSchemaSaving, setTagSchemaSaving] = useState(false);

  // === 加载数据 ===
  const refreshAll = useCallback(async () => {
    try {
      const [s, g, ts] = await Promise.all([listScripts(), getGlobalGraph(), getTagSchema()]);
      setScripts(s);
      setGlobalGraph(g);
      setTagSchema(ts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "加载数据失败";
      message.error(msg);
    }
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // 选中脚本的请求竞态防护：每次点击递增 token，只有最新请求的响应会被采纳
  const selectTokenRef = useRef(0);
  // 搜索聚焦 token：每次搜索选中递增，附加到 FocusTarget 上保证 effect 重跑，
  // 解决连续两次搜同一目标（值相同）时不重新聚焦的问题。
  const focusTokenRef = useRef(0);

  // === 选中脚本 ===
  // id 为 GLOBAL_ID 时显示全局图（不拉脚本详情）；否则拉对应脚本。
  // selectedScriptId 永不为 null：初始值 GLOBAL_ID（全局图）。
  const handleSelectScript = useCallback(async (id: string) => {
    const targetId = id || GLOBAL_ID; // 兜底：旧调用传 null 时当全局
    setSelectedScriptId(targetId);
    setHighlightSeq(null);
    setFocusTarget(null);
    // 立即清空旧结果，避免切换过程中显示上一个脚本的数据（视觉错乱）
    setSelectedResult(null);
    if (targetId === GLOBAL_ID) {
      return; // 全局图不需要拉脚本详情
    }
    const myToken = ++selectTokenRef.current;
    try {
      const result = await getScript(targetId);
      // 过期响应丢弃：用户可能已点了另一个脚本
      if (myToken !== selectTokenRef.current) return;
      setSelectedResult(result);
    } catch (e: unknown) {
      if (myToken !== selectTokenRef.current) return;
      const msg = e instanceof Error ? e.message : "加载脚本失败";
      message.error(msg);
      // 加载失败，回滚到全局图
      setSelectedScriptId(GLOBAL_ID);
    }
  }, []);

  // === 新建分析 ===
  const handleAnalyze = async () => {
    setLoading(true);
    try {
      // 库名为空 → 离线模式（纯 AST 分析，不连数据库）
      // 库名是连库的最小必要条件（host 有默认 localhost，但库名必须用户指定）
      const hasDbConfig = Boolean(dbConfig.database?.trim());
      const result = await submitAnalysis({
        script,
        database_config: hasDbConfig ? dbConfig : null,
      });
      message.success(
        result.extraction_mode === "ast_only"
          ? "分析完成（离线模式）"
          : "分析完成（已连接数据库校验）"
      );
      setScript("");
      setModalOpen(false);
      await refreshAll();
    } catch (e: unknown) {
      message.error(errMsg(e, "分析失败"));
    } finally {
      setLoading(false);
    }
  };

  // === 删除脚本 ===
  const handleDelete = async (id: string) => {
    try {
      await deleteScript(id);
      message.success("已删除");
      if (selectedScriptId === id) {
        setSelectedScriptId(GLOBAL_ID);
        setSelectedResult(null);
      }
      await refreshAll();
    } catch (e: unknown) {
      message.error(errMsg(e, "删除脚本失败"));
    }
  };

  // === 重命名 ===
  const handleRename = async (id: string, name: string) => {
    try {
      await renameScript(id, name);
      await refreshAll();
    } catch (e: unknown) {
      message.error(errMsg(e, "重命名失败"));
    }
  };

  // === 标签：单个脚本打标 ===
  const handleSetScriptTags = async (id: string, tags: string[]) => {
    try {
      await apiSetScriptTags(id, tags);
      // 本地更新 scripts 的 tags（避免整页 refresh）
      setScripts((prev) => prev.map((s) => s.analysis_id === id ? { ...s, tags } : s));
    } catch (e: unknown) {
      message.error(errMsg(e, "打标签失败"));
    }
  };

  // === 标签：批量打标 ===
  const handleBatchSetTags = async (ids: string[], tags: string[]) => {
    try {
      const result = await batchSetScriptTags(ids, tags);
      // 本地更新命中的脚本 tags
      const updatedSet = new Set(result.updated);
      setScripts((prev) => prev.map((s) => updatedSet.has(s.analysis_id) ? { ...s, tags } : s));
      if (result.failed.length > 0) {
        message.warning(`${result.updated.length} 个成功，${result.failed.length} 个失败`);
      } else {
        message.success(`已为 ${result.updated.length} 个脚本打标`);
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "批量打标失败"));
    }
  };

  // isGlobalView 提前定义（hitScriptIds 和后续 JSX 都依赖它）
  const isGlobalView = selectedScriptId === GLOBAL_ID;

  // 筛选命中脚本 id 集合（语义丙：维度内 OR、维度间 AND）。
  // 仅在全局视图且有筛选标签时计算；无筛选时返回空 Set（调用方据此判断「不筛选」）。
  // 实现思路：把选中的扁平标签按维度分组（查 tagSchema 得到每个标签所属维度），
  // 对每个维度，脚本须含该维度下任意一个选中标签；所有维度都满足才命中。
  const hitScriptIds = useMemo(() => {
    if (!isGlobalView || selectedTags.length === 0) return new Set<string>();
    // 标签值 → 所属维度名（一个标签值只属一个维度；若跨维度重名，取第一个）
    const tagToDim = new Map<string, string>();
    for (const dim of tagSchema.dimensions) {
      for (const v of dim.values) {
        if (!tagToDim.has(v)) tagToDim.set(v, dim.name);
      }
    }
    // 选中的标签按维度分组
    const selectedByDim = new Map<string, Set<string>>();
    for (const t of selectedTags) {
      const dim = tagToDim.get(t);
      if (!dim) continue; // 孤儿标签（维度已删），忽略
      let set = selectedByDim.get(dim);
      if (!set) { set = new Set(); selectedByDim.set(dim, set); }
      set.add(t);
    }
    const requiredDims = [...selectedByDim.keys()];
    if (requiredDims.length === 0) return new Set<string>();
    const hit = new Set<string>();
    for (const s of scripts) {
      // 每个维度内：脚本的 tags 与该维度选中标签有交集即满足
      const allDimsSatisfied = requiredDims.every((dim) => {
        const wanted = selectedByDim.get(dim)!;
        return s.tags.some((t) => wanted.has(t));
      });
      if (allDimsSatisfied) hit.add(s.analysis_id);
    }
    return hit;
  }, [scripts, selectedTags, tagSchema, isGlobalView]);

  // === 预处理规则：打开时拉取，保存时推送 ===
  const handleOpenRules = async () => {
    setRulesModalOpen(true);
    try {
      const rules = await getPreprocessRules();
      setPreprocessRulesDraft(rules);
    } catch (e: unknown) {
      message.error(errMsg(e, "获取预处理规则失败"));
    }
  };

  const handleSaveRules = async () => {
    setRulesLoading(true);
    try {
      await setPreprocessRules(preprocessRules);
      message.success({
        content: "预处理规则已保存。重新分析脚本后，新规则才会生效（已有脚本的节点不会自动更新）",
        duration: 5,
      });
      setRulesModalOpen(false);
    } catch (e: unknown) {
      message.error(errMsg(e, "保存预处理规则失败"));
    } finally {
      setRulesLoading(false);
    }
  };

  // === 标签维度定义：打开时拉取当前 schema 作为草稿，保存时推送 ===
  const handleOpenTagSchema = async () => {
    setTagSchemaModalOpen(true);
    // 用已加载的 tagSchema 作为草稿初值（App 启动时已 refreshAll 拉过）
    setTagSchemaDraft(tagSchema.dimensions.map((d) => ({ ...d, values: [...d.values] })));
    // 兜底：再拉一次最新值（避免本地 tagSchema 是旧缓存）
    try {
      const fresh = await getTagSchema();
      setTagSchemaDraft(fresh.dimensions.map((d) => ({ ...d, values: [...d.values] })));
    } catch (e: unknown) {
      // 拉取失败不阻塞，用本地缓存值
    }
  };

  const handleSaveTagSchema = async () => {
    setTagSchemaSaving(true);
    try {
      const updated = await apiSetTagSchema({ dimensions: tagSchemaDraft });
      setTagSchema(updated);
      // 维度变更后，已有但失效的筛选标签（孤儿）清掉，避免命中集合异常
      const validTags = new Set<string>();
      for (const dim of updated.dimensions) for (const v of dim.values) validTags.add(v);
      setSelectedTags((prev) => prev.filter((t) => validTags.has(t)));
      message.success("标签维度已保存");
      setTagSchemaModalOpen(false);
    } catch (e: unknown) {
      message.error(errMsg(e, "保存标签维度失败"));
    } finally {
      setTagSchemaSaving(false);
    }
  };

  // === 导入导出 ===
  const handleExport = async () => {
    try {
      const data = await exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `lineage-export-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success("导出成功");
    } catch (e: unknown) {
      message.error(errMsg(e, "导出失败"));
    }
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await importData(payload);
      message.success("导入成功，数据已覆盖");
      await refreshAll();
    } catch (e: unknown) {
      message.error(errMsg(e, "导入失败，请检查文件格式"));
    }
  };

  // === 状态栏统计 ===
  const tableCount = globalGraph?.nodes.length ?? 0;
  const edgeCount = globalGraph?.edges.length ?? 0;
  const scriptCount = scripts.length;

  // 搜索框的节点/边数据（useMemo 化，避免每次渲染重建数组击穿 SearchBox 内部 useMemo）。
  // 边加 _edgeId 前缀（e- 脚本视图 / ge- 全局视图），与 LineageGraph 实际渲染的边 id 一致。
  // isGlobalView 已在前面（hitScriptIds useMemo 前）定义，此处复用。
  const searchNodes = useMemo(
    () => (isGlobalView ? globalGraph?.nodes : selectedResult?.visualization.nodes) || [],
    [isGlobalView, selectedResult, globalGraph],
  );
  const searchEdges = useMemo(
    () =>
      (isGlobalView
        ? globalGraph?.edges?.map((e, i) => ({ ...e, _edgeId: `ge-${i}` }))
        : selectedResult?.visualization.edges?.map((e, i) => ({ ...e, _edgeId: `e-${i}` }))) || [],
    [isGlobalView, selectedResult, globalGraph],
  );

  // === 引擎加载/错误守卫：就绪前不渲染主界面 ===
  if (engineStatus === "loading") {
    const stageText: Record<EngineStage, string> = {
      "loading-wasm": "正在下载分析引擎（Pyodide 运行时，约 6MB）...",
      "installing-sqlglot": "正在安装 SQL 解析器（sqlglot）...",
      "installing-pydantic": "正在安装数据模型库（pydantic）...",
      "injecting-code": "正在加载血缘分析代码...",
      "ready": "即将就绪",
      "error": "加载失败",
    };
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
        <Spin size="large" />
        <div style={{ fontSize: 16, color: "#1890ff", fontWeight: 500 }}>LineagePuzzle 网页版</div>
        <div style={{ color: "#888" }}>{stageText[engineStage]}</div>
        <div style={{ color: "#bbb", fontSize: 12 }}>首次加载约需 5-10 秒，之后浏览器会缓存</div>
      </div>
    );
  }

  if (engineStatus === "error") {
    return (
      <Result
        status="error"
        title="分析引擎加载失败"
        subTitle={engineMessage || "无法加载 Pyodide 运行时，请检查网络连接后刷新重试"}
        extra={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>}
      />
    );
  }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: "#1890ff" } }}>
      <Layout style={{ minHeight: "100vh" }}>
        <Header style={{ background: "#001529", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ color: "#fff", fontSize: 18, fontWeight: 600 }}>
            LineagePuzzle
          </div>
          <Space>
            <Button
              icon={<DownloadOutlined />}
              onClick={handleExport}
              style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}
            >
              导出
            </Button>
            <Popconfirm
              title="导入会覆盖当前所有数据"
              description="确定继续吗？"
              onConfirm={() => {
                // 触发隐藏的 file input
                document.getElementById("import-file-input")?.click();
              }}
              okText="确定覆盖"
              cancelText="取消"
            >
              <Button
                icon={<UploadOutlined />}
                style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}
              >
                导入
              </Button>
            </Popconfirm>
            {/* 隐藏的文件选择器，由 Popconfirm 确认后触发 */}
            <input
              id="import-file-input"
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await handleImport(f);
                e.target.value = "";  // 重置，允许重复选同一文件
              }}
            />
            <SearchBox
              nodes={searchNodes}
              edges={searchEdges}
              onSelectTarget={(t: SearchTarget) => {
                // 递增 token：即使连续两次搜同一目标，新 FocusTarget 引用不同，
                // effect [focusTarget] 也会重跑，避免「重复搜索无反馈」。
                const focusToken = ++focusTokenRef.current;
                setFocusTarget({
                  type: t.type,
                  id: t.id,
                  focusToken,
                  edgeIds: t.edgeIds,
                });
              }}
            />
            <Button
              icon={<SettingOutlined />}
              onClick={handleOpenRules}
              style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}
            >
              预处理规则
            </Button>
            <Button
              icon={<TagsOutlined />}
              onClick={handleOpenTagSchema}
              style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}
            >
              标签维度
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setModalOpen(true)}
            >
              新建分析
            </Button>
          </Space>
        </Header>

        <Content style={{ padding: 12, background: "#f5f5f5", flex: 1 }}>
          <div style={{ display: "flex", gap: 12, height: "calc(100vh - 100px)" }}>
            {/* 左栏：脚本列表 */}
            <div style={{ width: 240, flexShrink: 0 }}>
              <ScriptList
                scripts={scripts}
                selectedId={selectedScriptId}
                onSelect={handleSelectScript}
                onDelete={handleDelete}
                onRename={handleRename}
                tableCount={tableCount}
                edgeCount={edgeCount}
                tagSchema={tagSchema}
                selectedTags={selectedTags}
                onSelectedTagsChange={setSelectedTags}
                hitScriptIds={hitScriptIds}
                isGlobalView={isGlobalView}
                onSetScriptTags={handleSetScriptTags}
                onBatchSetTags={handleBatchSetTags}
              />
            </div>

            {/* 中栏：全局血缘图 */}
            <div style={{ flex: 1 }}>
              <LineageGraph
                globalGraph={globalGraph}
                visualization={selectedResult?.visualization ?? null}
                highlightScriptId={selectedScriptId}
                highlightSeq={highlightSeq}
                onEdgeSelectSeq={setHighlightSeq}
                focusTarget={focusTarget}
                // 标签筛选：仅全局视图 + 有筛选标签时传命中脚本集合，否则 null（不过滤）
                tagFilteredScriptIds={isGlobalView && selectedTags.length > 0 ? hitScriptIds : null}
              />
            </div>

            {/* 右栏：语句分段 */}
            <div style={{ width: 320, flexShrink: 0 }}>
              <StatementPanel
                statementGroup={selectedResult?.statement_group ?? null}
                highlightSeq={highlightSeq}
                onStatementClick={setHighlightSeq}
              />
            </div>
          </div>

          {/* 状态栏 */}
          <div style={{
            marginTop: 8, padding: "6px 12px", background: "#fff",
            borderRadius: 4, fontSize: 12, color: "#666",
            display: "flex", gap: 16,
          }}>
            <Tag color="green">{tableCount} 张表</Tag>
            <Tag color="blue">{edgeCount} 条血缘</Tag>
            <Tag color="orange">{scriptCount} 个脚本</Tag>
          </div>
        </Content>
      </Layout>

      {/* 新建分析弹窗 */}
      <Modal
        title="新建分析"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={800}
        destroyOnHidden
      >
        {/* DB 配置对两种输入模式共用 */}
        <DatabaseConfigForm value={dbConfig} onChange={setDbConfig} />

        {/* 输入模式切换：手动粘贴 / 批量导入 */}
        <div style={{ margin: "12px 0 8px" }}>
          <Segmented
            value={analyzeMode}
            onChange={(v) => setAnalyzeMode(v as "manual" | "batch")}
            options={[
              { label: "手动粘贴 SQL", value: "manual" },
              { label: "批量导入文件", value: "batch" },
            ]}
            block
          />
        </div>

        {analyzeMode === "manual" ? (
          <ScriptEditor
            value={script}
            onChange={setScript}
            onAnalyze={handleAnalyze}
            loading={loading}
          />
        ) : (
          <BatchImport
            dbConfig={dbConfig}
            tagSchema={tagSchema}
            onSuccess={async () => {
              setModalOpen(false);
              await refreshAll();
            }}
          />
        )}
      </Modal>

      {/* 预处理规则弹窗 */}
      <Modal
        title="预处理规则配置"
        open={rulesModalOpen}
        onCancel={() => setRulesModalOpen(false)}
        onOk={handleSaveRules}
        confirmLoading={rulesLoading}
        okText="保存"
        cancelText="取消"
        width={760}
        destroyOnHidden
      >
        <PreprocessRulesConfig value={preprocessRules} onChange={setPreprocessRulesDraft} />
      </Modal>

      {/* 标签维度定义弹窗（管理员维护维度名 + 可选标签值）*/}
      <Modal
        title="标签维度定义"
        open={tagSchemaModalOpen}
        onCancel={() => setTagSchemaModalOpen(false)}
        onOk={handleSaveTagSchema}
        confirmLoading={tagSchemaSaving}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        <TagSchemaConfig value={tagSchemaDraft} onChange={setTagSchemaDraft} />
      </Modal>
    </ConfigProvider>
  );
}

export default App;
