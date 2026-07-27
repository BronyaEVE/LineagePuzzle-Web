/**
 * Pyodide 引擎主线程封装。
 *
 * - 单例 Worker（整个应用只加载一次 Pyodide）
 * - ensureEngine() 返回就绪 promise（幂等，并发调用安全）
 * - analyze() 发消息给 Worker，await promise 拿结果
 * - 状态订阅（onStatus）供 UI 显示加载阶段
 */
import type { AnalysisResult, PreprocessRule } from "../types";
import type { EngineStage } from "./config";

type StatusListener = (stage: EngineStage, message?: string) => void;

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const statusListeners = new Set<StatusListener>();

/** 订阅引擎加载状态变化（供 UI 显示进度）。返回取消订阅函数。 */
export function onStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function emitStatus(stage: EngineStage, message?: string): void {
  statusListeners.forEach((l) => l(stage, message));
}

/** 启动 Worker（幂等）。第一次调用会触发 Pyodide 加载。 */
export function ensureEngine(): Promise<void> {
  if (readyPromise) return readyPromise;

  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

  readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  worker.addEventListener("message", (e: MessageEvent) => {
    const data = e.data ?? {};

    // 状态消息（加载阶段上报）
    if (data.type === "status") {
      emitStatus(data.stage, data.message);
      if (data.stage === "ready") {
        readyResolve?.();
      } else if (data.stage === "error") {
        readyReject?.(new Error(data.message || "引擎加载失败"));
      }
      return;
    }

    // analyze 响应消息
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)!;
      pending.delete(data.id);
      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result);
      }
    }
  });

  worker.addEventListener("error", (e: ErrorEvent) => {
    const err = new Error(e.message || "Worker 错误");
    readyReject?.(err);
    // 通知所有 pending 请求失败
    pending.forEach(({ reject }) => reject(err));
    pending.clear();
  });

  return readyPromise;
}

/** 分析 SQL（在 Worker 里跑 sqlglot）。必须先 ensureEngine() 就绪。 */
export async function analyze(
  script: string,
  rules: PreprocessRule[] = []
): Promise<AnalysisResult> {
  if (!worker) {
    throw new Error("引擎未初始化，请先调用 ensureEngine()");
  }
  await ensureEngine();

  const id = ++msgId;
  return new Promise<AnalysisResult>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, type: "analyze", payload: { script, rules } });
  });
}

/** 引擎是否已就绪（同步判断，不触发加载）。 */
export function isEngineReady(): boolean {
  return readyPromise !== null && worker !== null;
}
