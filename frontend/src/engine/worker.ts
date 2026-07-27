/**
 * Pyodide Worker —— 在 Web Worker 线程里加载 Pyodide + sqlglot，执行 SQL 血缘分析。
 *
 * 设计要点：
 * - Python 源码通过 Vite `?raw` 导入打进 JS bundle，init 时写进 Pyodide 虚拟 FS。
 *   这样 .py 随 JS 一起部署，不需要额外 HTTP 请求。
 * - sqlglot / pydantic 用 micropip.install 从 PyPI 装（纯 Python wheel）。
 * - 主线程通过 workerClient.ts 的 postMessage 与本 Worker 通信。
 * - 加载分阶段上报（status 消息），主线程据此显示进度。
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { PYODIDE_INDEX_URL, type EngineStage } from "./config";

// 通过 ?raw 把 Python 源码作为字符串打进 bundle（Vite 特性）
import analyzerPy from "../../../pyodide_code/analyzer.py?raw";
import preprocessorPy from "../../../pyodide_code/preprocessor.py?raw";
import splitterPy from "../../../pyodide_code/splitter.py?raw";
import normalizePy from "../../../pyodide_code/normalize.py?raw";
import lineageExtractorPy from "../../../pyodide_code/lineage_extractor.py?raw";
import columnLineagePy from "../../../pyodide_code/column_lineage.py?raw";
import analysisModelPy from "../../../pyodide_code/models/analysis.py?raw";
import lineageModelPy from "../../../pyodide_code/models/lineage.py?raw";
import statementModelPy from "../../../pyodide_code/models/statement.py?raw";

let pyodide: PyodideInterface | null = null;
let initPromise: Promise<void> | null = null;

/** 上报加载阶段给主线程。 */
function reportStage(stage: EngineStage, message?: string): void {
  (self as unknown as Worker).postMessage({ type: "status", stage, message });
}

/** 把 lineage 包的源码文件写进 Pyodide 虚拟 FS。 */
function injectLineagePackage(py: PyodideInterface): void {
  // 创建包目录结构
  py.FS.mkdirTree("/lineage");
  py.FS.mkdirTree("/lineage/models");
  // 写入各模块
  py.FS.writeFile("/lineage/__init__.py", "from .analyzer import analyze, analyze_to_dict\n");
  py.FS.writeFile("/lineage/analyzer.py", analyzerPy);
  py.FS.writeFile("/lineage/preprocessor.py", preprocessorPy);
  py.FS.writeFile("/lineage/splitter.py", splitterPy);
  py.FS.writeFile("/lineage/normalize.py", normalizePy);
  py.FS.writeFile("/lineage/lineage_extractor.py", lineageExtractorPy);
  py.FS.writeFile("/lineage/column_lineage.py", columnLineagePy);
  py.FS.writeFile("/lineage/models/__init__.py", "");
  py.FS.writeFile("/lineage/models/analysis.py", analysisModelPy);
  py.FS.writeFile("/lineage/models/lineage.py", lineageModelPy);
  py.FS.writeFile("/lineage/models/statement.py", statementModelPy);
}

/** 初始化 Pyodide + sqlglot + lineage 包（单例，只跑一次）。 */
async function init(): Promise<void> {
  if (pyodide) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    reportStage("loading-wasm");
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });

    reportStage("installing-sqlglot");
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install("sqlglot");

    reportStage("installing-pydantic");
    // pydantic 在 Pyodide 官方仓库已有预编译包，可直接 loadPackage（比 micropip 快）
    await pyodide.loadPackage("pydantic");
    // pydantic-core 是 Rust wheel，需 Pyodide 预编译版；loadPackage("pydantic") 已含

    reportStage("injecting-code");
    injectLineagePackage(pyodide);
    // 把根目录加进 sys.path，让 `from lineage.analyzer import ...` 能找到 /lineage 包
    await pyodide.runPythonAsync("import sys; sys.path.insert(0, '/')");
    // 验证包能正常 import
    await pyodide.runPythonAsync("from lineage.analyzer import analyze_to_dict");

    reportStage("ready");
  })();

  return initPromise;
}

// Worker 加载即自动初始化 Pyodide（不等消息触发），保证引擎在后台就预热好。
// 主线程 ensureEngine() 只需等待 ready 状态上报。
init().catch((err: unknown) => {
  reportStage("error", err instanceof Error ? err.message : String(err));
});

// 消息处理
(self as unknown as Worker).onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data ?? {};

  // 等待初始化完成（init 失败时 initPromise 已 reject，这里会抛错）
  try {
    await initPromise;
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (type === "analyze") {
    try {
      const { script, rules } = payload as { script: string; rules: unknown[] };
      // 通过 globals 传参（避免字符串拼接的注入风险）
      pyodide!.globals.set("__lineage_script", script);
      pyodide!.globals.set("__lineage_rules", rules);
      const result = await pyodide!.runPythonAsync(
        "analyze_to_dict(__lineage_script, __lineage_rules)"
      );
      // toJs 深拷贝成 JS 对象，dict 转 Object
      const jsResult = result.toJs({ dict_converter: Object.fromEntries });
      result.destroy();
      (self as unknown as Worker).postMessage({ id, result: jsResult });
    } catch (err) {
      (self as unknown as Worker).postMessage({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 未知消息类型
  (self as unknown as Worker).postMessage({ id, error: `unknown message type: ${type}` });
};

export {}; // 声明模块（worker 独立作用域）
