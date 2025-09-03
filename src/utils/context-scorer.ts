import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';

export interface ContextItem {
  filePath: string;
  content: string;
  score: number;
  reason: string;
  lineRange?: { start: number; end: number };
  relatedSymbols?: string[];
}

export interface ScoringFactors {
  fileType: number;
  proximity: number;
  recentActivity: number;
  symbolRelevance: number;
  importRelationship: number;
  sameDirectory: number;
  fileSize: number;
  languageMatch: number;
}

/**
 * 上下文评分系统
 * 智能评估文件和代码片段对当前补全的相关性
 */
export class ContextScorer {
  private logger: Logger;
  private recentFiles = new Map<string, number>(); // 文件路径 -> 最后访问时间
  private symbolCache = new Map<string, Set<string>>(); // 文件路径 -> 符号集合
  private importGraph = new Map<string, Set<string>>(); // 文件路径 -> 导入的文件集合

  constructor() {
    this.logger = Logger.getInstance();
    this.initializeFileTracking();
  }

  /**
   * 初始化文件跟踪
   */
  private initializeFileTracking(): void {
    // 监听文件打开事件
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        this.recordFileActivity(editor.document.uri.toString());
      }
    });

    // 监听文件保存事件
    vscode.workspace.onDidSaveTextDocument((document) => {
      this.recordFileActivity(document.uri.toString());
      this.invalidateSymbolCache(document.uri.toString());
    });
  }

  /**
   * 记录文件活动
   */
  private recordFileActivity(filePath: string): void {
    this.recentFiles.set(filePath, Date.now());
    
    // 清理过期记录（保留最近24小时）
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [path, time] of this.recentFiles.entries()) {
      if (time < dayAgo) {
        this.recentFiles.delete(path);
      }
    }
  }

  /**
   * 评估上下文项的相关性分数
   */
  scoreContextItem(
    item: { filePath: string; content: string },
    currentFile: string,
    currentPosition: vscode.Position,
    currentDocument?: vscode.TextDocument
  ): ContextItem {
    const factors = this.calculateScoringFactors(
      item.filePath,
      currentFile,
      currentPosition,
      currentDocument
    );

    // 计算综合分数
    const score = this.calculateWeightedScore(factors);
    
    // 生成评分原因
    const reason = this.generateScoringReason(factors);

    // 提取相关符号
    const relatedSymbols = this.extractSymbols(item.content);

    return {
      filePath: item.filePath,
      content: item.content,
      score,
      reason,
      relatedSymbols
    };
  }

  /**
   * 计算评分因子
   */
  private calculateScoringFactors(
    itemPath: string,
    currentFile: string,
    currentPosition: vscode.Position,
    currentDocument?: vscode.TextDocument
  ): ScoringFactors {
    const factors: ScoringFactors = {
      fileType: 0,
      proximity: 0,
      recentActivity: 0,
      symbolRelevance: 0,
      importRelationship: 0,
      sameDirectory: 0,
      fileSize: 0,
      languageMatch: 0
    };

    // 1. 文件类型相关性 (0-1)
    factors.fileType = this.calculateFileTypeRelevance(itemPath, currentFile);

    // 2. 目录距离 (0-1)
    factors.proximity = this.calculateDirectoryProximity(itemPath, currentFile);

    // 3. 最近活动 (0-1)
    factors.recentActivity = this.calculateRecentActivityScore(itemPath);

    // 4. 符号相关性 (0-1)
    if (currentDocument) {
      factors.symbolRelevance = this.calculateSymbolRelevance(
        itemPath,
        currentDocument,
        currentPosition
      );
    }

    // 5. 导入关系 (0-1)
    factors.importRelationship = this.calculateImportRelationship(itemPath, currentFile);

    // 6. 同目录奖励 (0-1)
    factors.sameDirectory = path.dirname(itemPath) === path.dirname(currentFile) ? 1 : 0;

    // 7. 文件大小因子 (0-1) - 中等大小的文件分数更高
    factors.fileSize = this.calculateFileSizeFactor(itemPath);

    // 8. 语言匹配 (0-1)
    factors.languageMatch = this.calculateLanguageMatch(itemPath, currentFile);

    return factors;
  }

  /**
   * 计算加权总分
   */
  private calculateWeightedScore(factors: ScoringFactors): number {
    const weights = {
      fileType: 0.15,
      proximity: 0.12,
      recentActivity: 0.20,
      symbolRelevance: 0.25,
      importRelationship: 0.15,
      sameDirectory: 0.05,
      fileSize: 0.03,
      languageMatch: 0.05
    };

    let score = 0;
    for (const [factor, value] of Object.entries(factors)) {
      score += value * (weights[factor as keyof typeof weights] || 0);
    }

    // 确保分数在 0-1 范围内
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 生成评分原因说明
   */
  private generateScoringReason(factors: ScoringFactors): string {
    const reasons: string[] = [];

    if (factors.importRelationship > 0.7) {
      reasons.push('强导入关系');
    }
    if (factors.symbolRelevance > 0.6) {
      reasons.push('符号高度相关');
    }
    if (factors.recentActivity > 0.8) {
      reasons.push('最近活跃文件');
    }
    if (factors.sameDirectory === 1) {
      reasons.push('同目录文件');
    }
    if (factors.languageMatch > 0.9) {
      reasons.push('相同语言');
    }
    if (factors.fileType > 0.8) {
      reasons.push('相关文件类型');
    }

    return reasons.length > 0 ? reasons.join(', ') : '基础相关性';
  }

  /**
   * 计算文件类型相关性
   */
  private calculateFileTypeRelevance(itemPath: string, currentFile: string): number {
    const itemExt = path.extname(itemPath).toLowerCase();
    const currentExt = path.extname(currentFile).toLowerCase();

    // 完全匹配
    if (itemExt === currentExt) {
      return 1.0;
    }

    // 相关语言匹配
    const relatedExtensions: { [key: string]: string[] } = {
      '.ts': ['.tsx', '.js', '.jsx', '.d.ts'],
      '.tsx': ['.ts', '.jsx', '.js'],
      '.js': ['.jsx', '.ts', '.tsx'],
      '.jsx': ['.js', '.tsx', '.ts'],
      '.py': ['.pyx', '.pyi'],
      '.cpp': ['.cc', '.cxx', '.c', '.h', '.hpp'],
      '.c': ['.h', '.cpp', '.cc'],
      '.h': ['.c', '.cpp', '.cc', '.hpp'],
      '.java': ['.kt'],
      '.kt': ['.java'],
      '.cs': ['.fs', '.vb'],
      '.go': ['.mod'],
      '.rs': ['.toml'],
      '.vue': ['.js', '.ts'],
      '.svelte': ['.js', '.ts']
    };

    const related = relatedExtensions[currentExt] || [];
    if (related.includes(itemExt)) {
      return 0.8;
    }

    // 配置文件相关性
    const configFiles = ['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config'];
    if (configFiles.includes(itemExt) && configFiles.includes(currentExt)) {
      return 0.6;
    }

    // 文档文件相关性
    const docFiles = ['.md', '.txt', '.rst', '.adoc'];
    if (docFiles.includes(itemExt) && docFiles.includes(currentExt)) {
      return 0.4;
    }

    return 0.2;
  }

  /**
   * 计算目录距离
   */
  private calculateDirectoryProximity(itemPath: string, currentFile: string): number {
    const itemDir = path.dirname(itemPath);
    const currentDir = path.dirname(currentFile);

    if (itemDir === currentDir) {
      return 1.0;
    }

    // 计算目录层级差异
    const itemParts = itemDir.split(path.sep);
    const currentParts = currentDir.split(path.sep);
    
    let commonLength = 0;
    const minLength = Math.min(itemParts.length, currentParts.length);
    
    for (let i = 0; i < minLength; i++) {
      if (itemParts[i] === currentParts[i]) {
        commonLength++;
      } else {
        break;
      }
    }

    const maxLength = Math.max(itemParts.length, currentParts.length);
    const proximity = commonLength / maxLength;

    return Math.max(0, proximity);
  }

  /**
   * 计算最近活动分数
   */
  private calculateRecentActivityScore(filePath: string): number {
    const lastActivity = this.recentFiles.get(filePath);
    if (!lastActivity) {
      return 0;
    }

    const now = Date.now();
    const ageMs = now - lastActivity;
    
    // 最近5分钟内 = 1.0
    // 最近1小时内 = 0.8
    // 最近6小时内 = 0.6
    // 最近24小时内 = 0.3
    // 更早 = 0.1
    
    if (ageMs < 5 * 60 * 1000) return 1.0;
    if (ageMs < 60 * 60 * 1000) return 0.8;
    if (ageMs < 6 * 60 * 60 * 1000) return 0.6;
    if (ageMs < 24 * 60 * 60 * 1000) return 0.3;
    
    return 0.1;
  }

  /**
   * 计算符号相关性
   */
  private calculateSymbolRelevance(
    itemPath: string,
    currentDocument: vscode.TextDocument,
    currentPosition: vscode.Position
  ): number {
    // 获取当前光标周围的上下文
    const currentLine = currentDocument.lineAt(currentPosition);
    const contextRange = new vscode.Range(
      Math.max(0, currentPosition.line - 5),
      0,
      Math.min(currentDocument.lineCount - 1, currentPosition.line + 5),
      0
    );
    const contextText = currentDocument.getText(contextRange);
    
    // 提取当前上下文中的符号
    const currentSymbols = this.extractSymbols(contextText);
    
    // 获取目标文件的符号
    const itemSymbols = this.getFileSymbols(itemPath);
    
    if (currentSymbols.size === 0 || itemSymbols.size === 0) {
      return 0;
    }

    // 计算符号交集
    let intersection = 0;
    for (const symbol of currentSymbols) {
      if (itemSymbols.has(symbol)) {
        intersection++;
      }
    }

    // 计算 Jaccard 相似度
    const union = currentSymbols.size + itemSymbols.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 计算导入关系
   */
  private calculateImportRelationship(itemPath: string, currentFile: string): number {
    // 检查当前文件是否导入了目标文件
    const currentImports = this.getFileImports(currentFile);
    if (currentImports.has(itemPath)) {
      return 1.0;
    }

    // 检查目标文件是否导入了当前文件
    const itemImports = this.getFileImports(itemPath);
    if (itemImports.has(currentFile)) {
      return 0.8;
    }

    // 检查是否有共同的导入
    let commonImports = 0;
    for (const imp of currentImports) {
      if (itemImports.has(imp)) {
        commonImports++;
      }
    }

    if (commonImports > 0) {
      const totalImports = currentImports.size + itemImports.size;
      return totalImports > 0 ? (commonImports * 2) / totalImports : 0;
    }

    return 0;
  }

  /**
   * 计算文件大小因子
   */
  private calculateFileSizeFactor(filePath: string): number {
    try {
      const stat = require('fs').statSync(filePath);
      const sizeKB = stat.size / 1024;
      
      // 优选 5-50KB 的文件
      if (sizeKB >= 5 && sizeKB <= 50) {
        return 1.0;
      }
      
      // 1-5KB 或 50-200KB
      if ((sizeKB >= 1 && sizeKB < 5) || (sizeKB > 50 && sizeKB <= 200)) {
        return 0.8;
      }
      
      // 200KB-1MB
      if (sizeKB > 200 && sizeKB <= 1024) {
        return 0.5;
      }
      
      // 太小或太大的文件
      return 0.2;
    } catch {
      return 0.5; // 默认值
    }
  }

  /**
   * 计算语言匹配度
   */
  private calculateLanguageMatch(itemPath: string, currentFile: string): number {
    const itemExt = path.extname(itemPath).toLowerCase();
    const currentExt = path.extname(currentFile).toLowerCase();
    
    // 语言族匹配
    const languageFamilies: { [key: string]: string[] } = {
      'javascript': ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'],
      'python': ['.py', '.pyx', '.pyi'],
      'c_family': ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
      'java': ['.java', '.kt', '.scala'],
      'dotnet': ['.cs', '.fs', '.vb'],
      'web': ['.html', '.css', '.scss', '.sass', '.less'],
      'data': ['.json', '.yaml', '.yml', '.xml', '.toml'],
      'shell': ['.sh', '.bash', '.zsh', '.fish'],
      'config': ['.conf', '.config', '.ini', '.properties']
    };

    for (const family of Object.values(languageFamilies)) {
      if (family.includes(itemExt) && family.includes(currentExt)) {
        return itemExt === currentExt ? 1.0 : 0.8;
      }
    }

    return itemExt === currentExt ? 1.0 : 0.1;
  }

  /**
   * 提取文本中的符号
   */
  private extractSymbols(text: string): Set<string> {
    const symbols = new Set<string>();
    
    // 匹配标识符（函数名、类名、变量名等）
    const identifierRegex = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;
    let match;
    
    while ((match = identifierRegex.exec(text)) !== null) {
      const symbol = match[0];
      // 过滤掉常见关键字和短符号
      if (symbol.length >= 3 && !this.isCommonKeyword(symbol)) {
        symbols.add(symbol);
      }
    }
    
    return symbols;
  }

  /**
   * 获取文件的符号缓存
   */
  private getFileSymbols(filePath: string): Set<string> {
    let symbols = this.symbolCache.get(filePath);
    if (!symbols) {
      symbols = this.extractFileSymbols(filePath);
      this.symbolCache.set(filePath, symbols);
    }
    return symbols;
  }

  /**
   * 从文件中提取符号
   */
  private extractFileSymbols(filePath: string): Set<string> {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
      return this.extractSymbols(content);
    } catch {
      return new Set();
    }
  }

  /**
   * 获取文件的导入关系
   */
  private getFileImports(filePath: string): Set<string> {
    let imports = this.importGraph.get(filePath);
    if (!imports) {
      imports = this.extractFileImports(filePath);
      this.importGraph.set(filePath, imports);
    }
    return imports;
  }

  /**
   * 从文件中提取导入关系
   */
  private extractFileImports(filePath: string): Set<string> {
    const imports = new Set<string>();
    
    try {
      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
      
      // 匹配不同语言的导入语句
      const importPatterns = [
        /import\s+.*?\s+from\s+['"`]([^'"`]+)['"`]/g, // ES6 imports
        /require\(['"`]([^'"`]+)['"`]\)/g, // CommonJS requires
        /^\s*#include\s*[<"]([^>"]+)[>"]/gm, // C/C++ includes
        /^\s*import\s+([a-zA-Z0-9_.]+)/gm, // Python imports
        /^\s*from\s+([a-zA-Z0-9_.]+)\s+import/gm, // Python from imports
        /^\s*using\s+([a-zA-Z0-9_.]+);?/gm, // C# usings
        /^\s*package\s+([a-zA-Z0-9_.]+);?/gm // Java/Kotlin packages
      ];

      for (const pattern of importPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          imports.add(match[1]);
        }
      }
    } catch {
      // 忽略文件读取错误
    }
    
    return imports;
  }

  /**
   * 检查是否为常见关键字
   */
  private isCommonKeyword(word: string): boolean {
    const commonKeywords = new Set([
      'const', 'let', 'var', 'function', 'class', 'interface', 'type',
      'import', 'export', 'from', 'default', 'if', 'else', 'for', 'while',
      'return', 'true', 'false', 'null', 'undefined', 'this', 'super',
      'public', 'private', 'protected', 'static', 'async', 'await',
      'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof',
      'instanceof', 'in', 'of', 'break', 'continue', 'switch', 'case',
      'default', 'do', 'with', 'void', 'extends', 'implements'
    ]);
    
    return commonKeywords.has(word.toLowerCase());
  }

  /**
   * 使符号缓存失效
   */
  private invalidateSymbolCache(filePath: string): void {
    this.symbolCache.delete(filePath);
    this.importGraph.delete(filePath);
  }

  /**
   * 清理缓存
   */
  cleanup(): void {
    // 清理过期的缓存项
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30分钟
    
    for (const [filePath] of this.symbolCache) {
      const lastActivity = this.recentFiles.get(filePath) || 0;
      if (now - lastActivity > maxAge) {
        this.invalidateSymbolCache(filePath);
      }
    }
  }

  /**
   * 获取评分统计信息
   */
  getStats() {
    return {
      recentFiles: this.recentFiles.size,
      symbolCache: this.symbolCache.size,
      importGraph: this.importGraph.size
    };
  }
}