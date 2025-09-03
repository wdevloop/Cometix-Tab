import * as vscode from 'vscode';
import type { CompletionRequest, CompletionResponse, SSEEventType, CompletionState } from '../types';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CursorApiClient } from './api-client';
import { FileManager } from './file-manager';
import { StreamCppResponse } from '../generated/cpp_pb';
import { SmartCompletionDiffer } from '../utils/smart-completion-differ';
import { CompletionContext } from '../types/completion-diff';
import { smartEditDetector, EditOperation } from '../utils/smart-edit-detector';
import { completionTracker } from '../utils/completion-tracker';
import { CompletionStateMachine } from './completion-state-machine';
import { isFeatureEnabled } from '../utils/feature-flags';

export class CursorCompletionProvider implements vscode.InlineCompletionItemProvider {
  private logger: Logger;
  private apiClient: CursorApiClient;
  private fileManager: FileManager;
  private smartDiffer: SmartCompletionDiffer;
  private abortController: AbortController | null = null;
  private lastRequestTime: number = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastDocumentState: { version: number; content: string } | null = null;
  private readonly MIN_REQUEST_INTERVAL = 200; // 最小请求间隔200ms
  private readonly MIN_INPUT_LENGTH = 2; // 最少输入2个字符才触发
  
  // 🔧 智能编辑检测相关
  private documentChangeListener: vscode.Disposable | null = null;
  
  // 🎯 补全结果跟踪
  private completionBindings = new Map<string, { bindingId: string; requestTime: number }>();
  private readonly BINDING_TIMEOUT = 30000; // 30秒后清理过期的绑定
  
  // 🔄 状态机（可选）
  private stateMachine: CompletionStateMachine | null = null;
  
  constructor(apiClient: CursorApiClient, fileManager: FileManager) {
    this.logger = Logger.getInstance();
    this.apiClient = apiClient;
    this.fileManager = fileManager;
    this.smartDiffer = SmartCompletionDiffer.getInstance();
    
    // 🔄 初始化状态机（如果启用）
    const config = ConfigManager.getConfig();
    if (isFeatureEnabled(config, 'newStateMachine')) {
      this.stateMachine = new CompletionStateMachine();
      this.logger.info('🔄 状态机已启用');
    }
    
    // 🔧 设置文档变化监听器用于智能编辑检测
    this.setupDocumentChangeListener();
  }
  
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    
    // 🔧 首先检查扩展是否启用
    const config = ConfigManager.getConfig();
    if (!config.enabled) {
      this.logger.debug('🚫 扩展已禁用，跳过补全');
      return undefined;
    }
    
    // 🔧 检查snooze状态
    if (config.snoozeUntil > Date.now()) {
      this.logger.debug('😴 扩展处于snooze状态，跳过补全');
      return undefined;
    }
    
    // 🧪 检查是否为测试模式调用（通过context中的requestUuid判断）
    const isTestMode = (context as any).requestUuid === 'test-uuid';
    
    if (isTestMode) {
      this.logger.info('🧪 检测到测试模式调用，直接执行补全');
      try {
        return await this.executeCompletion(document, position, context, token, true);
      } catch (error) {
        this.logger.error('❌ 测试模式代码补全执行失败', error as Error);
        return undefined;
      }
    }
    
    return new Promise((resolve) => {
      // 清除之前的防抖计时器
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      
      // 🔧 使用业界最佳实践的智能触发检测
      const smartTriggerCheck = smartEditDetector.shouldTriggerCompletion(document, position);
      const debounceTime = smartTriggerCheck.debounceTime;
      
      this.logger.debug(`🧠 智能触发检查: ${smartTriggerCheck.reason}`);
      this.logger.debug(`🕒 自适应防抖: ${debounceTime}ms, 置信度: ${smartTriggerCheck.confidence?.toFixed(2) || 'N/A'}`);
      
      if (!smartTriggerCheck.shouldTrigger) {
        this.logger.debug('🚫 智能检测器建议不触发补全');
        resolve(undefined);
        return;
      }
      
      // 记录触发时间用于性能分析
      const triggerStartTime = Date.now();
      
      // 设置自适应防抖延迟
      this.debounceTimer = setTimeout(async () => {
        try {
          const result = await this.executeCompletion(document, position, context, token, false);
          
          // 记录补全性能指标
          const responseTime = Date.now() - triggerStartTime;
          
          // 完整的补全生命周期跟踪
          if (result && Array.isArray(result) && result.length > 0) {
            const completionItem = result[0];
            const trackingId = completionTracker.trackCompletion(document, position, completionItem);
            
            // 设置补全生命周期事件回调
            const originalOnAccepted = completionTracker.onCompletionAccepted;
            const originalOnDismissed = completionTracker.onCompletionDismissed;
            
            completionTracker.onCompletionAccepted = (completion) => {
              // 记录性能指标
              smartEditDetector.recordCompletionMetrics(document, responseTime, true);
              this.logger.info(`✅ 补全被接受: ${trackingId}, 响应时间: ${responseTime}ms`);
              
              // 触发分析以优化未来的补全触发
              this.analyzeAcceptedCompletion(completion, document, position);
              
              // 调用原始回调
              originalOnAccepted?.(completion);
            };
            
            completionTracker.onCompletionDismissed = (completion) => {
              // 记录被忽略的补全
              smartEditDetector.recordCompletionMetrics(document, responseTime, false);
              this.logger.debug(`❌ 补全被忽略: ${trackingId}, 生存时间: ${Date.now() - completion.triggerTime}ms`);
              
              // 分析忽略原因以改进策略
              this.analyzeDismissedCompletion(completion, document, position);
              
              // 调用原始回调
              originalOnDismissed?.(completion);
            };
            
            // 记录补全触发信息
            this.logger.debug(`🎯 补全跟踪开始: ${trackingId}, 文本长度: ${completionItem.insertText?.toString().length || 0}`);
          } else {
            // 没有补全结果，记录为失败
            smartEditDetector.recordCompletionMetrics(document, responseTime, false);
          }
          
          resolve(result);
        } catch (error) {
          this.logger.error('❌ 代码补全执行失败', error as Error);
          
          // 记录失败的指标
          const responseTime = Date.now() - triggerStartTime;
          smartEditDetector.recordCompletionMetrics(document, responseTime, false);
          
          resolve(undefined);
        }
      }, debounceTime);
    });
  }
  
  private async executeCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
    isTestMode: boolean = false
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    try {
      this.logger.debug(`🔍 触发代码补全 - 文件: ${document.fileName}, 位置: ${position.line}:${position.character}`);
      
      // 🔄 状态机：开始生成
      this.stateMachine?.beginGenerate();
      
      // 检查是否应该触发补全（测试模式跳过检查）
      if (!isTestMode && !this.shouldTriggerCompletionBasic(document, position)) {
        this.stateMachine?.backToIdle();
        return undefined;
      }
      
      // 检查请求频率限制（测试模式跳过检查）
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (!isTestMode && timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        this.logger.debug(`⏰ 请求过于频繁，跳过 (间隔: ${timeSinceLastRequest}ms < ${this.MIN_REQUEST_INTERVAL}ms)`);
        this.stateMachine?.backToIdle();
        return undefined;
      }
      
      // 取消之前的请求
      if (this.abortController) {
        this.logger.debug('🛑 取消之前的请求');
        this.abortController.abort();
      }
      this.abortController = new AbortController();
      this.lastRequestTime = now;
      
      // 获取当前文件信息
      const currentFile = await this.fileManager.getCurrentFileInfo(document);
      this.logger.debug(`📄 文件信息: 路径=${currentFile.path}, 内容长度=${currentFile.content.length}, SHA256=${currentFile.sha256}`);
      
      // 检查是否为有效的补全场景
      if (currentFile.content.length === 0 && position.line === 0 && position.character === 0) {
        this.logger.debug('📝 空文件，跳过补全');
        return undefined;
      }
      
      // 检查光标是否在文件末尾附近（这是补全的最佳场景）
      const line = document.lineAt(position.line);
      const isAtEndOfLine = position.character >= line.text.length;
      const isNearEndOfFile = position.line >= document.lineCount - 5;
      
      this.logger.debug(`📍 补全上下文: 行末=${isAtEndOfLine}, 文件末尾附近=${isNearEndOfFile}`);
      
      // 获取多文件上下文 - 增强上下文收集以提升补全质量
      this.logger.info('🔍 开始收集多文件上下文...');
      const allContextFiles = await this.fileManager.getMultiFileContext(document, 8); // 增加到8个文件以提升质量
      this.logger.info(`📚 收集到 ${allContextFiles.length} 个上下文文件`);

      // 🔧 修复：安全地排除当前文件
      const currentFilePath = vscode.workspace.asRelativePath(document.uri);
      const additionalFiles = allContextFiles.filter(file => file.path !== currentFilePath);
      this.logger.info(`📋 过滤后的附加文件数: ${additionalFiles.length} (排除当前文件: ${currentFilePath})`);

      // 构建补全请求
      const request: CompletionRequest = {
        currentFile,
        cursorPosition: {
          line: position.line,
          column: position.character
        },
        context: this.getContext(document, position),
        modelName: 'auto', // TODO: 从配置中获取
        debugOutput: true, // 开启调试输出
        // 多文件上下文支持 - 显著提升补全质量
        additionalFiles: additionalFiles
      };
      
      this.logger.debug(`🚀 准备发送补全请求`);
      
      // 请求补全
      const messageStream = await this.apiClient.requestCompletion(request, this.abortController.signal);
      if (!messageStream) {
        this.logger.warn('⚠️  API客户端返回null，无法获取补全');
        return undefined;
      }
      
      // 解析流式响应
      const completion = await this.parseMessageStream(messageStream, token);
      if (!completion || !completion.text) {
        this.logger.debug('📭 没有获得有效的补全内容');
        return undefined;
      }
      
      this.logger.info('✅ 获得补全内容:');
      this.logger.info(completion.text);
      
      // 创建补全项 - 简化范围处理以修复幽灵文本显示问题
      let insertText = completion.text;
      let range: vscode.Range;
      
      // 🔧 CRITICAL FIX: 简化幽灵文本显示逻辑 - 测试是否是范围计算问题
      this.logger.info(`🧪 调试：测试简化的幽灵文本逻辑`);
      this.logger.info(`   📍 当前光标位置: ${position.line}:${position.character}`);
      this.logger.info(`   📄 文档总行数: ${document.lineCount}`);
      
      // 🧪 实验性：强制使用插入模式来测试显示
      if (isTestMode) {
        this.logger.info(`🧪 测试模式：强制使用简单插入模式`);
        const simpleItem = new vscode.InlineCompletionItem(completion.text);
        
        this.logger.info(`🧪 创建简单插入项:`);
        this.logger.info('   📝 完整 insertText:');
        this.logger.info(completion.text);
        this.logger.info(`   📐 range: undefined (插入模式)`);
        
        return [simpleItem];
      }
      
      // 🔧 CRITICAL FIX: VSCode InlineCompletion 限制修复
      // 根据 VSCode API 文档，InlineCompletion 的 range 有严格限制：
      // 1. 范围必须在同一行
      // 2. 范围必须包含当前光标位置
      // 3. 多行范围替换不被支持
      
      if (completion.range && completion.range.startLine !== undefined && completion.range.endLine !== undefined) {
        this.logger.info(`🔄 API指定范围替换: 行${completion.range.startLine}-${completion.range.endLine}`);
        
        // 🔧 关键修复：VSCode 支持多行范围替换！使用正确的范围替换
        this.logger.info(`✅ 实现多行范围替换: 行${completion.range.startLine}-${completion.range.endLine}`);
        
        // 计算正确的范围
        const maxLine = document.lineCount - 1;
        const startLine = Math.max(0, Math.min(completion.range.startLine, maxLine));
        const endLine = Math.max(startLine, Math.min(completion.range.endLine, maxLine));
        
        // 创建正确的范围对象
        const startPos = new vscode.Position(startLine, 0);
        let endPos: vscode.Position;
        
        if (endLine < document.lineCount) {
          const lastLine = document.lineAt(endLine);
          endPos = new vscode.Position(endLine, lastLine.text.length);
        } else {
          const lastDocLine = document.lineCount - 1;
          const lastLineText = document.lineAt(lastDocLine);
          endPos = new vscode.Position(lastDocLine, lastLineText.text.length);
        }
        
        range = new vscode.Range(startPos, endPos);
        
        this.logger.info(`   📍 多行范围替换: ${startPos.line}:${startPos.character} → ${endPos.line}:${endPos.character}`);
        this.logger.info(`   📏 替换行数: ${endLine - startLine + 1} 行`);
        
        
        // 🎯 API 已经提供了精确的范围和内容，直接使用即可
        this.logger.info(`📝 直接使用 API 提供的范围替换内容，无需额外处理`);
      } else {
        // 默认插入模式
        this.logger.info(`📝 使用插入模式 (无API范围)`);
        range = new vscode.Range(position, position);
      }
      
      // 🎯 直接使用 API 提供的补全内容，相信其准确性
      this.logger.info('📝 使用 API 提供的补全内容:');
      this.logger.info(insertText);
      
      const item = new vscode.InlineCompletionItem(insertText, range);
      
      // 🎯 处理光标预测位置（根据API响应日志优化）
      if (completion.cursorPosition) {
        const targetLine = completion.cursorPosition.line;
        const targetColumn = completion.cursorPosition.column;
        
        this.logger.info(`🎯 检测到光标预测位置: 行${targetLine}, 列${targetColumn}`);
        
        // 在VSCode中，通常不需要手动设置光标位置
        // InlineCompletion会自动将光标放置在补全内容的末尾
        // 这里只是记录日志供调试
        this.logger.debug(`   📍 光标将自动定位到补全内容末尾`);
      }
      
      // 详细的调试信息
      this.logger.info(`🎉 创建补全项成功！`);
      this.logger.info(`   📏 文本长度: ${insertText.length}`);
      this.logger.info(`   📍 范围: ${range.start.line}:${range.start.character} → ${range.end.line}:${range.end.character}`);
      this.logger.info(`   🎯 当前光标: ${position.line}:${position.character}`);
      this.logger.info('   📝 完整补全内容:');
      this.logger.info(insertText);
      this.logger.info(`   🔗 模式: ${range.start.isEqual(range.end) ? '插入模式' : '范围替换模式'}`);
      
      // 如果是范围替换模式，记录API指导的替换信息
      if (!range.start.isEqual(range.end) && completion.range) {
        this.logger.info(`   ✨ API范围替换: 行${completion.range.startLine}-${completion.range.endLine}`);
      }
      
      // 记录光标预测信息
      if (completion.cursorPosition) {
        this.logger.info(`   🎯 光标预测: 行${completion.cursorPosition.line}, 列${completion.cursorPosition.column}`);
      } else {
        this.logger.debug(`   📍 无光标预测信息（将使用默认位置）`);
      }
      
      // 🧪 测试：强制使用一个简单的测试补全
      const FORCE_TEST_COMPLETION = false; // 设置为 true 进行测试
      if (FORCE_TEST_COMPLETION) {
        insertText = "// 测试幽灵文本显示";
        range = new vscode.Range(position, position);
        this.logger.info(`🧪 强制测试补全: "${insertText}"`);
      }
      
      // 🔧 CRITICAL: 增强验证补全项的有效性
      if (!insertText || insertText.length === 0) {
        this.logger.warn('⚠️ 补全文本为空，VSCode不会显示幽灵文本');
        return undefined;
      }
      
      if (range.start.isAfter(range.end)) {
        this.logger.error('❌ 无效的范围：起始位置在结束位置之后');
        return undefined;
      }
      
      // 🔧 CRITICAL: 智能边界检查 - 适应范围替换模式
      const maxLine = document.lineCount - 1;
      if (range.start.line < 0 || range.start.line > maxLine) {
        this.logger.error(`❌ 起始行超出边界: ${range.start.line} (max: ${maxLine})`);
        return undefined;
      }
      
      // 对于范围替换模式，允许结束行超出范围但要限制在合理范围内
      if (range.end.line > maxLine) {
        if (!range.start.isEqual(range.end)) {
          // 范围替换模式: 调整结束位置到文档末尾
          const adjustedEnd = new vscode.Position(maxLine, Number.MAX_SAFE_INTEGER);
          range = new vscode.Range(range.start, adjustedEnd);
          this.logger.info(`🔧 调整范围结束位置到文档末尾: ${adjustedEnd.line}`);
        } else {
          // 插入模式: 不允许超出边界
          this.logger.error(`❌ 结束行超出边界: ${range.end.line} (max: ${maxLine})`);
          return undefined;
        }
      }
      
      // 🧪 详细调试：检查VSCode InlineCompletionItem 属性
      const insertTextStr = typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
      this.logger.info(`🔍 创建的 InlineCompletionItem 详细信息:`);
      this.logger.info(`   📝 insertText: "${insertTextStr}" (长度: ${insertTextStr.length})`);
      this.logger.info(`   📐 range: ${item.range ? `${item.range.start.line}:${item.range.start.character}-${item.range.end.line}:${item.range.end.character}` : 'undefined'}`);
      this.logger.info(`   📍 range.isEmpty: ${item.range?.isEmpty}`);
      this.logger.info(`   🆔 item类型: ${item.constructor.name}`);
      
      // 🔧 创建最终的 InlineCompletionItem
      const completionItem = new vscode.InlineCompletionItem(insertText);
      if (completion.range && completion.range.startLine !== undefined && completion.range.endLine !== undefined) {
        completionItem.range = range;
        
        // 🔧 关键修复：使用 API Proposal 字段支持多行范围替换
        (completionItem as any).isInlineEdit = true;  // 标记为内联编辑
        (completionItem as any).showRange = range;    // 显示范围
        (completionItem as any).showInlineEditMenu = true;  // 显示编辑菜单
        
        this.logger.info(`🔧 应用 API Proposal 字段:`);
        this.logger.info(`   🎯 isInlineEdit: true`);
        this.logger.info(`   📍 showRange: ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`);
        this.logger.info(`   📋 showInlineEditMenu: true`);
      }
      
      const itemInsertTextStr = typeof completionItem.insertText === 'string' ? completionItem.insertText : completionItem.insertText.value;
      this.logger.info(`🎯 补全项创建成功:`);
      this.logger.info(`   📝 完整 insertText:`);
      this.logger.info(itemInsertTextStr);
      this.logger.info(`   📐 range: ${completionItem.range ? 'defined' : 'undefined'}`);
      if (completionItem.range) {
        this.logger.info(`       起始: ${completionItem.range.start.line}:${completionItem.range.start.character}`);
        this.logger.info(`       结束: ${completionItem.range.end.line}:${completionItem.range.end.character}`);
        this.logger.info(`       类型: ${completionItem.range.isEmpty ? '插入' : '替换'}`);
      }
      
      // 🔧 返回InlineCompletionList以确保更好的控制
      const completionList = new vscode.InlineCompletionList([completionItem]);
      
      this.logger.info(`🚀 返回补全列表，包含 ${completionList.items.length} 个项目`);
      this.logger.info(`   🔍 最终模式: ${range.start.isEqual(range.end) ? '插入' : '替换'} (范围: ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character})`);
      
      // 🎯 记录补全项和 bindingId 的映射
      if (completion.bindingId) {
        const completionKey = this.generateCompletionKey(completionItem);
        this.completionBindings.set(completionKey, {
          bindingId: completion.bindingId,
          requestTime: Date.now()
        });
        this.logger.debug(`🎯 存储补全绑定: ${completionKey} -> ${completion.bindingId}`);
        
        // 清理过期的绑定
        this.cleanupExpiredBindings();
      }
      
      // 🔄 状态机：显示补全
      this.stateMachine?.showVisible();
      
      // 返回补全项数组
      return [completionItem];
      
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.debug('🛑 补全请求被取消');
        this.stateMachine?.backToIdle();
        return undefined;
      }
      
      this.logger.error('❌ 代码补全失败', error as Error);
      this.stateMachine?.backToIdle();
      return undefined;
    }
  }

  /**
   * 基础的补全触发检查（文档长度、字符串检测等）
   * 智能编辑检测在provideInlineCompletionItems中进行
   */
  private shouldTriggerCompletionBasic(document: vscode.TextDocument, position: vscode.Position): boolean {
    try {
      // 基础检查：文档长度
      if (document.getText().trim().length < this.MIN_INPUT_LENGTH) {
        this.logger.debug('📝 文档内容太少，跳过补全');
        return false;
      }

      // 基础检查：位置边界
      if (position.line < 0 || position.character < 0) {
        this.logger.debug('📍 位置无效，跳过补全');
        return false;
      }

      this.logger.debug(`🔍 基础检查通过 - 位置: ${position.line}:${position.character}`);
      return true;

    } catch (error) {
      this.logger.warn('⚠️ 基础检查时出错', error as Error);
      return false;
    }
  }

  /**
   * 设置文档变化监听器，用于智能编辑检测
   */
  private setupDocumentChangeListener(): void {
    // 清理现有监听器
    if (this.documentChangeListener) {
      this.documentChangeListener.dispose();
    }

    // 设置新的文档变化监听器
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
      // 只处理文件类型的文档，排除输出面板等
      if (event.document.uri.scheme !== 'file') {
        return;
      }
      
      // 智能编辑检测器分析文档变化
      const operation = smartEditDetector.analyzeDocumentChange(event.document, event);
      
      // 只有非IDLE操作才记录日志，减少噪音
      if (operation !== 'IDLE') {
        this.logger.debug(`🧠 检测到编辑操作: ${operation} (文件: ${event.document.fileName.split('/').pop()})`);
      }
      
      // 根据操作类型进行相应处理
      this.handleEditOperation(event.document, operation);
    });

    this.logger.debug('🔧 智能编辑检测监听器已设置');
  }

  /**
   * 处理不同的编辑操作类型
   */
  private handleEditOperation(document: vscode.TextDocument, operation: EditOperation): void {
    switch (operation) {
      case EditOperation.DELETING:
        this.logger.debug('🗑️ 删除操作中，降低同步频率');
        // 可以在这里实现延迟文件同步等逻辑
        break;
        
      case EditOperation.UNDOING:
        this.logger.debug('🔙 撤销操作检测，准备重新同步');
        // 撤销后可能需要重新同步文件状态
        break;
        
      case EditOperation.PASTING:
        this.logger.debug('📋 粘贴操作检测，准备处理大块变化');
        // 粘贴操作可能需要特殊的同步策略
        break;
        
      case EditOperation.TYPING:
        this.logger.debug('⌨️ 输入操作中，保持正常响应');
        break;
        
      case EditOperation.IDLE:
        this.logger.debug('😴 编辑空闲，适合触发补全');
        // 定期清理检测器状态
        smartEditDetector.cleanup();
        break;
    }
  }

  /**
   * 检查是否在字符串或注释中
   */
  private isInStringOrComment(textBeforeCursor: string): boolean {
    // 简单检查：如果前面有未闭合的引号，可能在字符串中
    const singleQuotes = (textBeforeCursor.match(/'/g) || []).length;
    const doubleQuotes = (textBeforeCursor.match(/"/g) || []).length;
    const backQuotes = (textBeforeCursor.match(/`/g) || []).length;
    
    // 检查是否在注释中
    if (textBeforeCursor.includes('//') || textBeforeCursor.includes('/*')) {
      return true;
    }
    
    // 奇数个引号表示在字符串中
    return (singleQuotes % 2 === 1) || (doubleQuotes % 2 === 1) || (backQuotes % 2 === 1);
  }

  /**
   * 使用智能diff算法优化补全文本
   */
  private optimizeCompletionTextWithDiff(apiResponse: string, document: vscode.TextDocument, position: vscode.Position): string {
    if (!apiResponse) {
      return apiResponse;
    }
    
    try {
      // 构建补全上下文
      const context = this.buildCompletionContext(document, position);
      
      // 使用智能diff算法提取精确的补全内容
      const diffResult = this.smartDiffer.extractCompletionDiff(context, apiResponse);
      
      // 记录详细的diff处理日志
      this.logger.info(`🔧 Diff算法结果:`);
      this.logger.info(`   📊 方法: ${diffResult.method}`);
      this.logger.info(`   🎯 置信度: ${diffResult.confidence.toFixed(3)}`);
      this.logger.info(`   ⏱️ 处理时间: ${diffResult.processingTimeMs.toFixed(2)}ms`);
      this.logger.info(`   📏 原始长度: ${apiResponse.length} → 优化长度: ${diffResult.insertText.length}`);
      
      if (diffResult.optimizations.length > 0) {
        this.logger.info(`   🔧 优化操作: ${diffResult.optimizations.join(', ')}`);
      }
      
      // 如果置信度过低，使用简化的回退策略
      if (diffResult.confidence < 0.3) {
        this.logger.warn(`⚠️ diff置信度过低 (${diffResult.confidence.toFixed(3)})，使用简化策略`);
        return this.simpleFallbackOptimization(apiResponse, document, position);
      }
      
      return diffResult.insertText;
      
    } catch (error) {
      this.logger.error('❌ 智能diff优化失败，使用简化策略', error as Error);
      return this.simpleFallbackOptimization(apiResponse, document, position);
    }
  }
  
  /**
   * 构建补全上下文
   */
  private buildCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContext {
    const currentLine = document.lineAt(position.line);
    const textBeforeCursor = currentLine.text.substring(0, position.character);
    const textAfterCursor = currentLine.text.substring(position.character);
    
    // 获取更多上下文（前后各10行）
    const startLine = Math.max(0, position.line - 10);
    const endLine = Math.min(document.lineCount - 1, position.line + 10);
    
    let fullBeforeCursor = '';
    let fullAfterCursor = '';
    
    // 收集光标前的上下文
    for (let i = startLine; i < position.line; i++) {
      fullBeforeCursor += document.lineAt(i).text + '\n';
    }
    fullBeforeCursor += textBeforeCursor;
    
    // 收集光标后的上下文
    fullAfterCursor = textAfterCursor;
    for (let i = position.line + 1; i <= endLine; i++) {
      fullAfterCursor += '\n' + document.lineAt(i).text;
    }
    
    return {
      beforeCursor: fullBeforeCursor,
      afterCursor: fullAfterCursor,
      currentLine: currentLine.text,
      position,
      language: document.languageId,
      indentation: this.detectIndentation(textBeforeCursor)
    };
  }
  
  /**
   * 基础文本清理 - 最简单的清理逻辑
   */
  private basicTextCleanup(text: string): string {
    if (!text) {
      return text;
    }
    
    // 只做最基本的清理
    let cleanText = text;
    
    // 移除过多的连续空行
    cleanText = cleanText.replace(/\n\n\n+/g, '\n\n');
    
    // 限制长度
    if (cleanText.length > 500) {
      cleanText = cleanText.substring(0, 500);
      this.logger.debug(`✂️ 基础清理：截断至500字符`);
    }
    
    return cleanText;
  }

  /**
   * 简单的文本清理 - 替代复杂的diff算法
   */
  private simpleTextCleanup(text: string, document: vscode.TextDocument, position: vscode.Position): string {
    if (!text || text.trim().length === 0) {
      return text;
    }
    
    try {
      const currentLine = document.lineAt(position.line);
      const textBeforeCursor = currentLine.text.substring(0, position.character);
      
      let cleanText = text;
      
      // 移除明显重复的前缀（最后一个单词）
      const wordsBeforeCursor = textBeforeCursor.trim().split(/\s+/);
      const lastWord = wordsBeforeCursor[wordsBeforeCursor.length - 1] || '';
      
      if (lastWord.length > 1 && cleanText.toLowerCase().startsWith(lastWord.toLowerCase())) {
        cleanText = cleanText.substring(lastWord.length);
        this.logger.debug(`🧹 移除重复前缀: "${lastWord}"`);
      }
      
      // 限制长度以避免过长的补全
      if (cleanText.length > 300) {
        // 在合理的位置截断（行末或语句末）
        const truncatePos = cleanText.substring(0, 300).lastIndexOf('\n');
        if (truncatePos > 100) {
          cleanText = cleanText.substring(0, truncatePos);
        } else {
          cleanText = cleanText.substring(0, 300);
        }
        this.logger.debug(`✂️ 截断过长文本至 ${cleanText.length} 字符`);
      }
      
      return cleanText;
      
    } catch (error) {
      this.logger.warn('⚠️ 文本清理失败，使用原始文本', error as Error);
      return text;
    }
  }

  /**
   * 简化的回退优化策略
   */
  private simpleFallbackOptimization(text: string, document: vscode.TextDocument, position: vscode.Position): string {
    const currentLine = document.lineAt(position.line);
    const textBeforeCursor = currentLine.text.substring(0, position.character);
    
    let result = text;
    
    // 基础的重复内容移除
    const wordsBeforeCursor = textBeforeCursor.trim().split(/\s+/);
    const lastWord = wordsBeforeCursor[wordsBeforeCursor.length - 1] || '';
    
    if (lastWord && result.toLowerCase().startsWith(lastWord.toLowerCase()) && lastWord.length > 1) {
      result = result.substring(lastWord.length);
      this.logger.debug(`🔧 简化策略：移除重复单词 "${lastWord}"`);
    }
    
    // 基础长度限制
    if (result.length > 500) {
      result = result.substring(0, 500);
      this.logger.debug(`🔧 简化策略：截断至500字符`);
    }
    
    return result;
  }
  
  /**
   * 检测当前行的缩进
   */
  private detectIndentation(lineText: string): string {
    const match = lineText.match(/^(\s*)/);
    return match ? match[1] : '';
  }

  /**
   * 检查是否是有意义的补全位置
   */
  private isMeaningfulCompletionPosition(textBeforeCursor: string, textAfterCursor: string): boolean {
    const trimmedBefore = textBeforeCursor.trim();
    const trimmedAfter = textAfterCursor.trim();

    this.logger.info(`   🔍 位置分析:`);
    this.logger.info(`      trimmedBefore: "${trimmedBefore}"`);
    this.logger.info(`      trimmedAfter: "${trimmedAfter}"`);

    // 空行或行末 - 好的补全位置
    if (trimmedBefore.length === 0 || trimmedAfter.length === 0) {
      this.logger.info(`   ✅ 空行或行末 - 允许补全`);
      return true;
    }

    // 在标点符号后 - 好的补全位置
    const meaningfulEndings = ['.', '(', '{', '[', '=', ':', ';', ',', ' ', '\t'];
    const lastChar = trimmedBefore.slice(-1);
    this.logger.info(`      最后字符: "${lastChar}"`);
    if (meaningfulEndings.includes(lastChar)) {
      this.logger.info(`   ✅ 在标点符号后 - 允许补全`);
      return true;
    }

    // 在关键字后 - 好的补全位置
    const keywords = ['function', 'class', 'const', 'let', 'var', 'if', 'for', 'while', 'return', 'import', 'export'];
    const words = trimmedBefore.split(/\s+/);
    const lastWord = words[words.length - 1];
    this.logger.info(`      最后单词: "${lastWord}"`);
    if (keywords.includes(lastWord)) {
      this.logger.info(`   ✅ 在关键字后 - 允许补全`);
      return true;
    }

    // 在字母数字中间 - 不好的补全位置
    if (/\w$/.test(trimmedBefore) && /^\w/.test(trimmedAfter)) {
      this.logger.info(`   ❌ 在字母数字中间 - 阻止补全`);
      return false;
    }

    this.logger.info(`   ✅ 默认允许补全`);
    return true;
  }
  
  private getContext(document: vscode.TextDocument, position: vscode.Position): string {
    // 获取光标前后的上下文
    const beforeRange = new vscode.Range(
      Math.max(0, position.line - 10),
      0,
      position.line,
      position.character
    );
    
    const afterRange = new vscode.Range(
      position.line,
      position.character,
      Math.min(document.lineCount - 1, position.line + 10),
      0
    );
    
    const beforeText = document.getText(beforeRange);
    const afterText = document.getText(afterRange);
    
    return beforeText + '|CURSOR|' + afterText;
  }
  
  private async parseMessageStream(
    messageStream: AsyncIterable<any>,
    token: vscode.CancellationToken
  ): Promise<CompletionResponse | null> {
    
    let completion: CompletionResponse = { text: '' };
    let receivedMessages = 0;
    let hasValidContent = false;
    
    let lastLogTime = Date.now();
    const LOG_INTERVAL = 1000; // 每秒最多记录一次进度
    
    try {
      for await (const message of messageStream) {
        if (token.isCancellationRequested) {
          this.logger.debug('🛑 用户取消补全解析');
          return null;
        }
        
        receivedMessages++;
        
        // 避免过多的日志输出
        const now = Date.now();
        const shouldLog = now - lastLogTime > LOG_INTERVAL;
        if (shouldLog) {
          lastLogTime = now;
        }
        
        // 处理 Connect RPC StreamCppResponse
        if (message instanceof StreamCppResponse) {
          await this.handleStreamCppResponse(message, completion);
          
          // 检查是否收到有效内容
          if (message.text && message.text.trim().length > 0) {
            hasValidContent = true;
          }
          
          // 检查流是否结束
          if (message.doneStream) {
            this.logger.info(`✅ StreamCpp 流式调用完成 (收到 ${receivedMessages} 条消息, 有效内容: ${hasValidContent})`);
            break;
          }
          
          // 检查编辑是否完成（可能有多个编辑周期）
          if (message.doneEdit) {
            if (shouldLog) {
              this.logger.debug('🎨 单个编辑周期完成');
            }
          }
          
          // 提供进度反馈
          if (message.text && shouldLog) {
            this.logger.debug(`📝 累计补全长度: ${completion.text.length} 字符`);
          }
        } else {
          // 处理传统 SSE 消息（向后兼容）
          await this.handleSSEMessage(message, completion);
          
          // 如果是流结束消息，停止解析
          if (message.type === 'done_stream') {
            this.logger.info('✅ 传统SSE流式调用完成');
            break;
          }
        }
      }
      
      // 增强诊断：分析为什么没有收到有效补全
      if (!hasValidContent && receivedMessages > 0) {
        this.logger.warn(`⚠️ 补全流诊断：收到 ${receivedMessages} 条消息但无有效text内容`);
        this.logger.warn(`   最终completion.text长度: ${completion.text.length}`);
        if (completion.range) {
          this.logger.warn(`   包含范围信息: 行${completion.range.startLine}-${completion.range.endLine}`);
        }
      }
      
      return completion;
      
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        this.logger.debug('🛑 流式解析被取消');
      } else {
        this.logger.error('❌ 流式解析错误', err);
      }
      return null;
    }
  }
  
  private parseSSEEvents(buffer: string): { parsed: SSEEvent[], remaining: string } {
    const events: SSEEvent[] = [];
    const lines = buffer.split('\n');
    let remaining = '';
    let currentEvent: Partial<SSEEvent> = {};
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line === '') {
        // 空行表示事件结束
        if (currentEvent.type) {
          events.push(currentEvent as SSEEvent);
        }
        currentEvent = {};
      } else if (line.startsWith('event: ')) {
        currentEvent.type = line.substring(7) as SSEEventType;
      } else if (line.startsWith('data: ')) {
        currentEvent.data = line.substring(6);
      } else if (i === lines.length - 1 && !line.includes('\n')) {
        // 最后一行可能不完整
        remaining = line;
      }
    }
    
    return { parsed: events, remaining };
  }
  
  /**
   * 处理 Connect RPC StreamCppResponse
   */
  private async handleStreamCppResponse(response: StreamCppResponse, completion: CompletionResponse): Promise<void> {
    // 处理文本补全内容
    if (response.text) {
      completion.text += response.text;
      
      // 只在有意义的文本内容时记录
      if (response.text.trim().length > 0) {
        this.logger.debug(`📝 接收到补全文本: "${response.text.substring(0, 50)}${response.text.length > 50 ? '...' : ''}"`);
      }
    } else {
      // 诊断为什么没有text字段
      this.logger.debug(`🔍 响应字段诊断: text=${response.text === undefined ? 'undefined' : `"${response.text}"`}`);
      if (response.modelInfo) {
        this.logger.debug(`   模型类型: ${response.modelInfo.isFusedCursorPredictionModel ? 'FusedCursorPrediction' : 'Standard'}`);
      }
      if (response.rangeToReplace) {
        this.logger.debug(`   有rangeToReplace，可能是范围替换模式`);
      }
    }
    
    // 处理建议开始行
    if (response.suggestionStartLine !== undefined) {
      this.logger.debug(`📍 建议开始行: ${response.suggestionStartLine}`);
    }
    
    // 处理置信度
    if (response.suggestionConfidence !== undefined) {
      this.logger.debug(`🎯 建议置信度: ${response.suggestionConfidence}`);
    }
    
    // 处理光标预测
    if (response.cursorPredictionTarget) {
      const expectedContent = response.cursorPredictionTarget.expectedContent || '';
      
      completion.cursorPosition = {
        line: response.cursorPredictionTarget.lineNumberOneIndexed - 1, // 转换为0索引
        column: expectedContent.length // 使用预期内容的长度作为列位置
      };
      
      this.logger.debug(`🎯 光标预测: 行 ${completion.cursorPosition.line}, 列 ${completion.cursorPosition.column}`);
      if (expectedContent) {
        this.logger.debug(`📝 预期内容: "${expectedContent}"`);
      }
      
      // 处理重新触发标志
      if (response.cursorPredictionTarget.shouldRetriggerCpp) {
        this.logger.debug('🔄 建议重新触发补全');
      }
    }
    
    // 处理范围替换（新的rangeToReplace字段）
    if (response.rangeToReplace) {
      // 注意：protobuf中的行号是1-based，需要转换为0-based
      const startLine = Math.max(0, (response.rangeToReplace.startLineNumber || 1) - 1);
      const endLine = Math.max(0, (response.rangeToReplace.endLineNumberInclusive || 1) - 1);
      
      completion.range = {
        startLine: startLine,
        endLine: endLine
      };
      this.logger.debug(`🔄 范围替换: protobuf(${response.rangeToReplace.startLineNumber}-${response.rangeToReplace.endLineNumberInclusive}) -> vscode(${startLine}-${endLine})`);
    }
    
    // 处理模型信息
    if (response.modelInfo) {
      this.logger.debug('🤖 模型信息:', {
        isFusedCursorPredictionModel: response.modelInfo.isFusedCursorPredictionModel,
        isMultidiffModel: response.modelInfo.isMultidiffModel
      });
    }
    
    // 处理各种调试信息
    if (response.debugModelOutput) {
      this.logger.debug(`🐛 模型输出: ${response.debugModelOutput}`);
    }
    if (response.debugModelInput) {
      this.logger.debug(`📝 模型输入: ${response.debugModelInput.substring(0, 200)}...`);
    }
    if (response.debugStreamTime) {
      this.logger.debug(`⏱️ 流时间: ${response.debugStreamTime}`);
    }
    if (response.debugTotalTime) {
      this.logger.debug(`🕰️ 总时间: ${response.debugTotalTime}`);
    }
    if (response.debugTtftTime) {
      this.logger.debug(`⚡ TTFT时间: ${response.debugTtftTime}`);
    }
    if (response.debugServerTiming) {
      this.logger.debug(`🚀 服务器时间: ${response.debugServerTiming}`);
    }
    
    // 处理编辑状态
    if (response.beginEdit) {
      this.logger.debug('🎨 开始编辑');
    }
    if (response.doneEdit) {
      this.logger.debug('✅ 编辑完成');
    }
    
    // 处理特殊格式化选项
    if (response.shouldRemoveLeadingEol) {
      this.logger.debug('📏 应移除前导换行符');
      
      // 实际移除前导换行符
      if (completion.text.startsWith('\n') || completion.text.startsWith('\r\n')) {
        completion.text = completion.text.replace(/^\r?\n/, '');
        this.logger.debug('✂️ 已移除前导换行符');
      }
    }
    
    // 处理绑定ID
    if (response.bindingId) {
      this.logger.debug(`🔗 绑定ID: ${response.bindingId}`);
      completion.bindingId = response.bindingId; // 存储到 completion 对象中
    }
    
    // 处理空响应情况，提供更详细的分析
    if (!response.text && response.doneStream) {
      if (!response.beginEdit) {
        this.logger.debug('📭 收到空补全响应 - 模型认为当前上下文不需要补全');
      } else {
        this.logger.debug('📝 收到空补全响应 - 编辑周期已开始但无文本内容');
      }
    }
  }
  
  /**
   * 处理传统 SSE 消息（向后兼容）
   */
  private async handleSSEMessage(message: any, completion: CompletionResponse): Promise<void> {
    switch (message.type) {
      case 'text':
        // 文本补全内容
        if (typeof message.data === 'string') {
          completion.text += message.data;
        }
        break;
        
      case 'range_replace':
        // 范围替换信息
        try {
          const rangeData = typeof message.data === 'object' ? message.data : JSON.parse(message.data || '{}');
          completion.range = {
            startLine: rangeData.startLine || rangeData.start_line,
            endLine: rangeData.endLineInclusive || rangeData.end_line_inclusive
          };
        } catch (e) {
          this.logger.warn('Failed to parse range_replace data', e as Error);
        }
        break;
        
      case 'cursor_prediction':
        // 光标预测位置
        try {
          const cursorData = typeof message.data === 'object' ? message.data : JSON.parse(message.data || '{}');
          completion.cursorPosition = {
            line: cursorData.line || cursorData.line_number_one_indexed - 1, // 转换为0索引
            column: cursorData.column || 0
          };
        } catch (e) {
          this.logger.warn('Failed to parse cursor_prediction data', e as Error);
        }
        break;
        
      case 'model_info':
        // 模型信息，记录到日志
        this.logger.debug('Received model info:', message.data);
        break;
        
      case 'protobuf_message':
        // Protobuf消息，处理结构化数据
        if (message.data && typeof message.data === 'object') {
          if (message.data.text) {
            completion.text += message.data.text;
          }
          if (message.data.suggestion_start_line !== undefined) {
            // 处理建议开始行
            this.logger.debug(`Suggestion starts at line: ${message.data.suggestion_start_line}`);
          }
          if (message.data.done_stream) {
            this.logger.debug('✅ Protobuf消息指示流结束');
          }
        }
        break;
        
      case 'done_edit':
        // 编辑完成
        this.logger.debug('Edit completed');
        break;
        
      case 'done_stream':
        // 流结束
        this.logger.debug('Stream completed');
        break;
        
      case 'error':
        // 错误消息
        this.logger.error(`Completion error: ${message.data || 'Unknown error'}`);
        break;
        
      case 'debug':
        // 调试信息
        this.logger.debug(`Completion debug: ${message.data || ''}`);
        break;
        
      case 'heartbeat':
        // 心跳消息，保持连接活跃
        this.logger.debug('Received heartbeat');
        break;
        
      default:
        // 未知消息类型
        this.logger.warn(`Unknown message type: ${message.type}`, message);
        break;
    }
  }

  /**
   * 🔧 VSCode 内联补全回调 - 当建议被显示时调用
   * 需要 inlineCompletionsAdditions API 提案
   */
  handleDidShowCompletionItem?(item: vscode.InlineCompletionItem): void {
    this.logger.info('👁️ VSCode 显示了内联补全建议');
    this.logger.info('   📝 显示的完整内容:');
    this.logger.info(item.insertText.toString());
    
    // 🔄 状态机：补全已显示
    this.stateMachine?.showVisible();
    
    // 记录显示事件，用于调试
    if (item.range) {
      this.logger.info(`   📍 显示范围: ${item.range.start.line}:${item.range.start.character} → ${item.range.end.line}:${item.range.end.character}`);
    }
  }

  /**
   * 🔧 VSCode 内联补全回调 - 当用户部分接受建议时调用
   * 需要 inlineCompletionsAdditions API 提案
   */
  handleDidPartiallyAcceptCompletionItem?(
    item: vscode.InlineCompletionItem, 
    info: any // PartialAcceptInfo from proposed API
  ): void {
    this.logger.info('📝 用户部分接受了内联补全建议');
    this.logger.info(`   📏 接受长度: ${info.acceptedLength} / ${item.insertText.toString().length}`);
    this.logger.info('   📝 部分接受的内容:');
    this.logger.info(item.insertText.toString().substring(0, info.acceptedLength));
    this.logger.info(`   🔄 触发类型: ${info.kind}`);
    
    // 🔄 状态机：开始编辑
    this.stateMachine?.startEditing();
    // 递进建议（受 feature flag 控制）
    try {
      const config = ConfigManager.getConfig();
      const features = (config as any).features || {};
      if (features.continuationGeneration === true) {
        // 简单策略：若已接受比例 > 0.6，则触发续写
        const accepted = info.acceptedLength || 0;
        const total = item.insertText.toString().length || 1;
        const ratio = accepted / total;
        if (ratio > 0.6) {
          this.logger.info(`🔄 触发续写: ratio=${ratio.toFixed(2)}`);
          void vscode.commands.executeCommand('cometix-tab.triggerContinuation', { ratio });
        }
      }
    } catch (e) {
      this.logger.warn('续写触发失败', e as Error);
    }
  }

  /**
   * 🔧 VSCode 内联补全回调 - 当用户接受建议时调用  
   * 需要 inlineCompletionsAdditions API 提案
   */
  handleDidAcceptCompletionItem?(item: vscode.InlineCompletionItem): void {
    this.logger.info('✅ 用户完全接受了内联补全建议');
    this.logger.info('   📝 完全接受的内容:');
    this.logger.info(item.insertText.toString());
    
    // 🎯 记录补全接受结果
    this.recordCompletionFate(item, 'accept');
  }

  /**
   * 🎯 生成补全项的唯一键
   */
  private generateCompletionKey(item: vscode.InlineCompletionItem): string {
    const text = typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
    const range = item.range;
    const rangeStr = range ? `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}` : 'norange';
    
    // 使用文本内容的前50个字符 + 范围信息作为键
    const textKey = text.substring(0, 50).replace(/\s+/g, ' ');
    return `${textKey}@${rangeStr}`;
  }

  /**
   * 🎯 清理过期的补全绑定
   */
  private cleanupExpiredBindings(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    for (const [key, binding] of this.completionBindings) {
      if (now - binding.requestTime > this.BINDING_TIMEOUT) {
        expired.push(key);
      }
    }
    
    for (const key of expired) {
      this.completionBindings.delete(key);
    }
    
    if (expired.length > 0) {
      this.logger.debug(`🧹 清理了 ${expired.length} 个过期的补全绑定`);
    }
  }

  /**
   * 分析被接受的补全以优化策略
   */
  private analyzeAcceptedCompletion(
    completion: any,
    document: vscode.TextDocument,
    position: vscode.Position
  ): void {
    try {
      const uri = document.uri.toString();
      const currentOperation = smartEditDetector.getCurrentOperation(document);
      const responseTime = Date.now() - completion.triggerTime;
      
      this.logger.info(`📊 补全接受分析:`);
      this.logger.info(`   📄 文件: ${uri.split('/').pop()}`);
      this.logger.info(`   🎯 位置: ${position.line}:${position.character}`);
      this.logger.info(`   🔄 编辑操作: ${currentOperation}`);
      this.logger.info(`   ⏱️ 响应时间: ${responseTime}ms`);
      this.logger.info(`   📝 补全长度: ${completion.text.length}`);
      
      // 提取成功模式
      const line = document.lineAt(position.line);
      const contextBefore = line.text.substring(0, position.character);
      const contextAfter = line.text.substring(position.character);
      
      this.logger.debug(`📝 成功上下文:`);
      this.logger.debug(`   前: "${contextBefore}"`);
      this.logger.debug(`   后: "${contextAfter}"`);
      
      // 将成功模式反馈给智能编辑检测器
      // 这些数据可用于改进触发策略
      
    } catch (error) {
      this.logger.error('补全接受分析失败', error as Error);
    }
  }

  /**
   * 分析被忽略的补全以改进策略
   */
  private analyzeDismissedCompletion(
    completion: any,
    document: vscode.TextDocument,
    position: vscode.Position
  ): void {
    try {
      const uri = document.uri.toString();
      const currentOperation = smartEditDetector.getCurrentOperation(document);
      const lifeTime = Date.now() - completion.triggerTime;
      
      this.logger.debug(`📊 补全忽略分析:`);
      this.logger.debug(`   📄 文件: ${uri.split('/').pop()}`);
      this.logger.debug(`   🎯 位置: ${position.line}:${position.character}`);
      this.logger.debug(`   🔄 编辑操作: ${currentOperation}`);
      this.logger.debug(`   ⏱️ 生存时间: ${lifeTime}ms`);
      this.logger.debug(`   📝 补全长度: ${completion.text.length}`);
      
      // 分析可能的忽略原因
      const line = document.lineAt(position.line);
      const contextBefore = line.text.substring(0, position.character);
      
      // 检查是否为不好的触发位置
      if (this.isInStringOrComment(contextBefore)) {
        this.logger.debug('   💡 原因推测: 在字符串或注释中触发');
      } else if (currentOperation === EditOperation.DELETING) {
        this.logger.debug('   💡 原因推测: 在删除操作中触发');
      } else if (lifeTime < 500) {
        this.logger.debug('   💡 原因推测: 触发后快速改变意图');
      } else {
        this.logger.debug('   💡 原因推测: 补全内容不符合预期');
      }
      
    } catch (error) {
      this.logger.error('补全忽略分析失败', error as Error);
    }
  }

  /**
   * 🎯 记录补全结果到 API
   */
  private async recordCompletionFate(item: vscode.InlineCompletionItem, fate: 'accept' | 'reject' | 'partial_accept'): Promise<void> {
    try {
      const completionKey = this.generateCompletionKey(item);
      const binding = this.completionBindings.get(completionKey);
      
      if (!binding) {
        this.logger.debug(`⚠️ 未找到补全绑定: ${completionKey}`);
        return;
      }
      
      this.logger.info(`🎯 记录补全结果: ${binding.bindingId} -> ${fate}`);
      
      const success = await this.apiClient.recordCppFate(binding.bindingId, fate);
      if (success) {
        this.logger.info('✅ 补全结果记录成功');
      } else {
        this.logger.warn('⚠️ 补全结果记录失败');
      }
      
      // 记录后清理绑定
      this.completionBindings.delete(completionKey);
      
    } catch (error) {
      this.logger.error('❌ 记录补全结果时发生错误', error as Error);
    }
  }

}

interface SSEEvent {
  type: SSEEventType;
  data?: string;
}