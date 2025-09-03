import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import type { CompletionRequest } from '../types';

export interface ContinuationContext {
  originalRequest: CompletionRequest;
  acceptedText: string;
  acceptedLength: number;
  acceptedRatio: number;
  triggerType: string;
  position: vscode.Position;
  document: vscode.TextDocument;
  timestamp: number;
}

export interface ContinuationStrategy {
  name: string;
  shouldTrigger(context: ContinuationContext): boolean;
  getPriority(): number;
  getDebounceDelay(): number;
  buildRequest(context: ContinuationContext): Partial<CompletionRequest>;
}

/**
 * 管理补全续写逻辑
 * 基于用户的部分接受行为智能触发续写
 */
export class ContinuationManager {
  private logger: Logger;
  private strategies: ContinuationStrategy[] = [];
  private continuationHistory = new Map<string, number>(); // 文件路径 -> 最后续写时间
  private readonly MAX_CONTINUATION_RATE = 3; // 每分钟最大续写次数
  private readonly CONTINUATION_COOLDOWN = 20000; // 20秒冷却期

  constructor() {
    this.logger = Logger.getInstance();
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // 注册续写策略
    this.strategies = [
      new HighAcceptanceRatioStrategy(),
      new ContextAwareContinuationStrategy(),
      new WordBoundaryContinuationStrategy()
    ];

    // 按优先级排序
    this.strategies.sort((a, b) => b.getPriority() - a.getPriority());
    
    this.logger.debug(`🔄 续写管理器初始化完成，注册了 ${this.strategies.length} 个策略`);
  }

  /**
   * 评估是否应该触发续写
   */
  shouldTriggerContinuation(
    item: vscode.InlineCompletionItem,
    info: any, // PartialAcceptInfo
    document: vscode.TextDocument,
    originalRequest?: CompletionRequest
  ): { shouldTrigger: boolean; strategy?: ContinuationStrategy; delay?: number } {
    const config = ConfigManager.getConfig();
    const features = (config as any).features || {};
    
    // 检查功能开关
    if (!features.continuationGeneration) {
      return { shouldTrigger: false };
    }

    // 检查续写频率限制
    const filePath = document.uri.toString();
    const now = Date.now();
    const lastContinuation = this.continuationHistory.get(filePath) || 0;
    
    if (now - lastContinuation < this.CONTINUATION_COOLDOWN) {
      this.logger.debug(`🚫 续写冷却期内: ${now - lastContinuation}ms < ${this.CONTINUATION_COOLDOWN}ms`);
      return { shouldTrigger: false };
    }

    // 构建续写上下文
    const acceptedLength = info.acceptedLength || 0;
    const totalLength = item.insertText.toString().length;
    const acceptedText = item.insertText.toString().substring(0, acceptedLength);
    const acceptedRatio = totalLength > 0 ? acceptedLength / totalLength : 0;

    // 找到当前光标位置（部分接受后的位置）
    const position = this.calculateNewPosition(document, item, acceptedLength);

    const context: ContinuationContext = {
      originalRequest: originalRequest || this.buildDefaultRequest(document, position),
      acceptedText,
      acceptedLength,
      acceptedRatio,
      triggerType: info.kind || 'unknown',
      position,
      document,
      timestamp: now
    };

    // 评估策略
    for (const strategy of this.strategies) {
      if (strategy.shouldTrigger(context)) {
        this.logger.info(`✅ 续写策略触发: ${strategy.name}`);
        this.logger.info(`   📏 接受比例: ${acceptedRatio.toFixed(2)}`);
        this.logger.info(`   📝 接受内容: "${acceptedText.slice(-20)}"`);
        
        return {
          shouldTrigger: true,
          strategy,
          delay: strategy.getDebounceDelay()
        };
      }
    }

    this.logger.debug(`🚫 所有续写策略均不满足条件`);
    return { shouldTrigger: false };
  }

  /**
   * 构建续写请求
   */
  buildContinuationRequest(
    context: ContinuationContext,
    strategy: ContinuationStrategy
  ): CompletionRequest {
    // 基于策略构建请求
    const strategyRequest = strategy.buildRequest(context);
    
    // 合并原始请求和策略请求
    const continuationRequest: CompletionRequest = {
      ...context.originalRequest,
      ...strategyRequest,
      cursorPosition: {
        line: context.position.line,
        column: context.position.character
      }
    };

    // 更新文件内容到当前状态
    continuationRequest.currentFile.contents = context.document.getText();
    
    // 添加续写标记
    (continuationRequest as any).isContinuation = true;
    (continuationRequest as any).continuationContext = {
      acceptedText: context.acceptedText,
      acceptedRatio: context.acceptedRatio,
      strategy: strategy.name
    };

    this.logger.debug(`🔄 构建续写请求: 策略=${strategy.name}, 位置=${context.position.line}:${context.position.character}`);
    
    return continuationRequest;
  }

  /**
   * 记录续写触发
   */
  recordContinuationTrigger(document: vscode.TextDocument): void {
    const filePath = document.uri.toString();
    this.continuationHistory.set(filePath, Date.now());
    
    // 清理过期记录
    this.cleanupExpiredHistory();
  }

  /**
   * 计算部分接受后的新光标位置
   */
  private calculateNewPosition(
    document: vscode.TextDocument,
    item: vscode.InlineCompletionItem,
    acceptedLength: number
  ): vscode.Position {
    const range = item.range;
    if (!range) {
      // 插入模式，需要计算接受文本后的位置
      const acceptedText = item.insertText.toString().substring(0, acceptedLength);
      const lines = acceptedText.split('\n');
      
      if (lines.length === 1) {
        // 单行，在同一行添加字符
        return new vscode.Position(range?.start.line || 0, (range?.start.character || 0) + acceptedLength);
      } else {
        // 多行，计算最后一行的位置
        const lastLineLength = lines[lines.length - 1].length;
        return new vscode.Position(
          (range?.start.line || 0) + lines.length - 1,
          lastLineLength
        );
      }
    } else {
      // 范围替换模式，计算替换后的位置
      const acceptedText = item.insertText.toString().substring(0, acceptedLength);
      const lines = acceptedText.split('\n');
      
      if (lines.length === 1) {
        return new vscode.Position(range.start.line, range.start.character + acceptedLength);
      } else {
        const lastLineLength = lines[lines.length - 1].length;
        return new vscode.Position(
          range.start.line + lines.length - 1,
          lastLineLength
        );
      }
    }
  }

  /**
   * 构建默认请求（当没有原始请求时）
   */
  private buildDefaultRequest(document: vscode.TextDocument, position: vscode.Position): CompletionRequest {
    return {
      currentFile: {
        path: vscode.workspace.asRelativePath(document.uri),
        content: document.getText(),
        sha256: '' // 将由调用方填充
      },
      cursorPosition: {
        line: position.line,
        column: position.character
      }
    };
  }

  /**
   * 清理过期的续写历史记录
   */
  private cleanupExpiredHistory(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    
    for (const [filePath, timestamp] of this.continuationHistory.entries()) {
      if (now - timestamp > maxAge) {
        this.continuationHistory.delete(filePath);
      }
    }
  }

  /**
   * 获取续写统计信息
   */
  getStats() {
    return {
      activeFiles: this.continuationHistory.size,
      strategies: this.strategies.map(s => ({
        name: s.name,
        priority: s.getPriority()
      }))
    };
  }
}

/**
 * 高接受率续写策略
 * 当用户接受了大部分内容时触发
 */
class HighAcceptanceRatioStrategy implements ContinuationStrategy {
  name = 'high-acceptance-ratio';

  shouldTrigger(context: ContinuationContext): boolean {
    // 接受比例 > 60% 且接受内容足够长
    return context.acceptedRatio > 0.6 && context.acceptedLength > 10;
  }

  getPriority(): number {
    return 100;
  }

  getDebounceDelay(): number {
    return 150; // 150ms延迟
  }

  buildRequest(context: ContinuationContext): Partial<CompletionRequest> {
    return {
      // 添加上下文提示
      context: `Previous completion accepted: "${context.acceptedText.slice(-50)}"`
    };
  }
}

/**
 * 上下文感知续写策略
 * 基于代码上下文决定是否续写
 */
class ContextAwareContinuationStrategy implements ContinuationStrategy {
  name = 'context-aware';

  shouldTrigger(context: ContinuationContext): boolean {
    const { acceptedText, acceptedRatio, position, document } = context;
    
    // 基本条件：接受比例 > 40%
    if (acceptedRatio <= 0.4) {
      return false;
    }

    // 检查是否在有意义的上下文中
    const line = document.lineAt(position.line);
    const beforeText = line.text.substring(0, position.character);
    
    // 检查是否以完整的语法结构结束
    const meaningfulEndings = [
      /\{\s*$/, // 在大括号后
      /;\s*$/, // 在分号后
      /,\s*$/, // 在逗号后
      /\)\s*$/, // 在括号后
      /\]\s*$/, // 在方括号后
      /=\s*$/, // 在等号后
      /::\s*$/, // 在作用域解析符后
      /\.\s*$/, // 在点号后
      /->\s*$/ // 在箭头后
    ];

    return meaningfulEndings.some(pattern => pattern.test(beforeText + acceptedText));
  }

  getPriority(): number {
    return 80;
  }

  getDebounceDelay(): number {
    return 200;
  }

  buildRequest(context: ContinuationContext): Partial<CompletionRequest> {
    return {
      context: `Context-aware continuation after: "${context.acceptedText.slice(-30)}"`
    };
  }
}

/**
 * 词边界续写策略
 * 当接受的内容以完整的词结束时触发
 */
class WordBoundaryContinuationStrategy implements ContinuationStrategy {
  name = 'word-boundary';

  shouldTrigger(context: ContinuationContext): boolean {
    const { acceptedText, acceptedRatio } = context;
    
    // 基本条件：接受比例 > 50%
    if (acceptedRatio <= 0.5) {
      return false;
    }

    // 检查是否以完整的词结束
    return /\w\s*$/.test(acceptedText) && acceptedText.trim().length > 5;
  }

  getPriority(): number {
    return 60;
  }

  getDebounceDelay(): number {
    return 250;
  }

  buildRequest(context: ContinuationContext): Partial<CompletionRequest> {
    return {
      context: `Word boundary continuation: "${context.acceptedText.split(/\s+/).slice(-3).join(' ')}"`
    };
  }
}