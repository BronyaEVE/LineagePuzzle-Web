# -*- coding: utf-8 -*-
"""LineagePuzzle 网页版 Python 血缘分析包（跑在 Pyodide 里）。

入口：from lineage.analyzer import analyze, analyze_to_dict
"""
from .analyzer import analyze, analyze_to_dict

__all__ = ["analyze", "analyze_to_dict"]
