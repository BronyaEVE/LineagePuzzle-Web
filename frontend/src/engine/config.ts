/**
 * Pyodide 引擎配置。
 *
 * indexURL 指向 Pyodide 运行时目录（含 pyodide.asm.wasm / python_stdlib.zip 等）。
 * 默认走 jsDelivr CDN（零配置、浏览器缓存、二次访问快）。
 * 如需离线/本地托管：把 indexURL 改成本地路径（如 "/pyodide/"），
 * 并把 Pyodide 运行时文件复制到该目录。
 */
export const PYODIDE_VERSION = "0.29.4";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Worker 会上报这些阶段，主线程据此显示加载进度。 */
export type EngineStage =
  | "loading-wasm"        // 下载 Pyodide wasm (~6.4MB)
  | "installing-sqlglot"  // micropip 装 sqlglot
  | "installing-pydantic" // micropip 装 pydantic
  | "injecting-code"      // 注入 lineage 包源码
  | "ready"
  | "error";

export interface EngineStatusMessage {
  type: "status";
  stage: EngineStage;
  message?: string;       // 人类可读文案（如错误详情）
}
