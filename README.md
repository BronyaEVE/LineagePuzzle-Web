# LineagePuzzle-Web

> SQL 数据血缘可视化工具 —— **网页版**（Pyodide 在浏览器跑 sqlglot，零后端即开即用）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Deploy](https://github.com/BronyaEVE/LineagePuzzle-Web/actions/workflows/deploy.yml/badge.svg)](https://github.com/BronyaEVE/LineagePuzzle-Web/actions/workflows/deploy.yml)

## 🌐 在线体验

两个镜像，任选其一（Cloudflare 全球 CDN 通常更快更稳）：

- **Cloudflare Pages**（推荐）：👉 [https://lineage-puzzle-web.pages.dev/](https://lineage-puzzle-web.pages.dev/)
- **GitHub Pages**：👉 [https://bronyaeve.github.io/LineagePuzzle-Web/](https://bronyaeve.github.io/LineagePuzzle-Web/)

打开即用，无需安装。首次加载约 10-15 秒（从 CDN 下载 Pyodide ~6MB + sqlglot），之后浏览器缓存，二次访问很快。

这是 [LineagePuzzle](https://github.com/BronyaEVE/LineagePuzzle) 的网页版分支。桌面版是 Python(FastAPI+sqlglot) 后端 + React 前端的本地部署工具；网页版把**后端 SQL 血缘分析逻辑搬进了浏览器**——用 Pyodide（WebAssembly 版 CPython）在浏览器里直接跑 sqlglot，无需部署任何后端、无需服务器。

## ✨ 特性

- **零后端**：打开网页即用，不需要部署服务器、不需要租云主机
- **零隐私泄露**：SQL 脚本全程在浏览器内解析，不上传到任何服务器
- **列级血缘**：表级 + 列级血缘（`amount * qty` 多源列、`SUM(x)` 表达式转换）
- **全局图谱**：多脚本累积血缘、影响分析路径、标签筛选
- **Pyodide + sqlglot**：复用桌面版验证过的 sqlglot 解析引擎，输出 1:1 一致

## 🚀 快速开始（开发者）

```bash
git clone https://github.com/BronyaEVE/LineagePuzzle-Web.git
cd LineagePuzzle-Web/frontend
npm install
npm run dev
```

打开 `http://localhost:5173`，首次加载约 5-10 秒（从 CDN 下载 Pyodide ~6MB + sqlglot/pydantic），之后浏览器会缓存。

> **首次加载说明**：Pyodide 运行时（WASM）从 jsDelivr CDN 加载，需要联网。页面会显示加载进度。二次访问因 HTTP 缓存会明显加快。

## 🏗️ 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 8 + Ant Design 6 + ReactFlow |
| 浏览器内 Python | Pyodide 0.29.4（CPython 3.13 WASM）|
| SQL 解析 | sqlglot 30.x（纯 Python，micropip 安装）|
| 数据模型 | pydantic v2（Pyodide 预编译 wasm wheel）|
| Worker | Web Worker（避免主线程卡顿）|

## 📂 项目结构

```
LineagePuzzle-Web/
├── frontend/                  # React 前端（复用桌面版组件）
│   └── src/
│       ├── components/        # 血缘图、脚本列表等组件（与桌面版一致）
│       ├── engine/            # Pyodide 引擎封装
│       │   ├── worker.ts      # Web Worker：加载 Pyodide + sqlglot，执行分析
│       │   ├── workerClient.ts # 主线程封装：单例 + 消息 promise 化
│       │   ├── memoryStore.ts  # 内存 store（替代后端 store.py）
│       │   └── config.ts      # Pyodide CDN 配置
│       └── api/client.ts      # API 客户端（重写为调 Pyodide + 内存 store）
└── pyodide_code/              # 搬进浏览器的 Python 代码（从桌面版 backend/ 改造）
    ├── analyzer.py            # 分析编排入口（analyze / analyze_to_dict）
    ├── lineage_extractor.py   # 表级血缘
    ├── column_lineage.py      # 列级血缘（含子查询穿透）
    ├── preprocessor.py        # 预处理（正则清洗）
    ├── splitter.py            # 语句拆分
    ├── normalize.py           # 表名归一化
    └── models/                # pydantic 数据模型
```

## 🔧 架构

```
浏览器
  ├─ 主线程（React UI）
  │    └─ workerClient.analyze() ──postMessage──┐
  │                                             │
  └─ Web Worker（Pyodide） ◄───────────────────┘
       ├─ loadPyodide (WASM CPython 3.13)
       ├─ micropip.install("sqlglot")
       ├─ loadPackage("pydantic")
       ├─ 注入 lineage 包源码（?raw 打进 bundle）
       └─ analyze_to_dict(sql) → toJs → postMessage 回主线程
```

**关键设计**：
- Python 源码通过 Vite `?raw` 导入打进 JS bundle，注入 Pyodide 虚拟 FS（无需额外 HTTP 请求）
- sqlglot 是纯 Python wheel（719KB），Pyodide 直接 micropip 安装
- 数据在内存（不持久化），刷新即重置

## 📋 与桌面版的差异

| | 桌面版 (LineagePuzzle) | 网页版 (LineagePuzzle-Web) |
|---|---|---|
| 后端 | FastAPI + uvicorn | 无（Pyodide 在浏览器） |
| SQL 解析 | sqlglot[c]（mypyc C 扩展，快 4-5x） | sqlglot 纯 Python（Pyodide 不支持 C 扩展） |
| 部署 | 下载 exe / 便携包 | 打开网址即用 |
| 数据持久化 | JSON 文件 | 内存（刷新重置） |
| 在线 PG 校验 | 支持 | 不支持（浏览器无法连 DB） |
| 影响分析 | networkx（完整） | 待移植（MVP 暂 stub） |

## ⚠️ 当前状态（MVP）

已完成：
- ✅ Pyodide + sqlglot 在浏览器跑血缘分析（与桌面版输出 1:1 一致）
- ✅ 粘贴 SQL → 表级 + 列级血缘图
- ✅ 多脚本累积、全局图谱、删除/重命名
- ✅ 标签维度、预处理规则配置

待完成（后续迭代）：
- ⬜ 影响分析图算法（networkx → JS BFS/all-simple-paths）
- ⬜ Cloudflare Pages 部署 + CI
- ⬜ 加载进度细化、Service Worker 离线缓存

## 📄 License

MIT
