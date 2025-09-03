import * as vscode from 'vscode';
import * as path from 'path';
import type { FileInfo, CompletionRequest } from '../types';
import { CryptoUtils } from '../utils/crypto';
import { Logger } from '../utils/logger';
import { CursorApiClient } from './api-client';
import { smartEditDetector } from '../utils/smart-edit-detector';

export class FileManager {
  private logger: Logger;
  private apiClient: CursorApiClient;
  private syncedFiles = new Map<string, FileInfo>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  // 🚀 性能优化：添加上下文缓存
  private contextCache = new Map<string, { files: FileInfo[]; timestamp: number }>();
  private readonly CONTEXT_CACHE_TTL = 5000; // 5秒缓存
  
  constructor(apiClient: CursorApiClient, debounceMs: number = 300) {
    this.logger = Logger.getInstance();
    this.apiClient = apiClient;
    this.debounceMs = debounceMs;
  }
  
  updateConfig(debounceMs: number): void {
    this.debounceMs = debounceMs;
  }
  
  async syncDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }
    
    const filePath = vscode.workspace.asRelativePath(document.uri);
    const content = document.getText();
    const sha256 = CryptoUtils.calculateSHA256(content);
    
    const fileInfo: FileInfo = {
      path: filePath,
      content,
      sha256
    };
    
    // 检查文件是否已经同步过且内容相同
    const existing = this.syncedFiles.get(filePath);
    if (existing && existing.sha256 === sha256) {
      this.logger.debug(`File unchanged, skipping sync: ${filePath}`);
      return;
    }
    
    // 🔧 使用智能编辑检测器获取同步建议
    const syncCheck = smartEditDetector.shouldSyncFile(document);
    
    this.logger.debug(`🧠 智能同步检查: ${syncCheck.reason}`);
    
    if (!syncCheck.shouldSync) {
      this.logger.debug('🚫 智能检测器建议跳过同步');
      return;
    }
    
    // 根据编辑状态动态调整防抖时间
    const operation = smartEditDetector.getCurrentOperation(document);
    let dynamicDebounceMs = this.debounceMs;
    
    switch (operation) {
      case 'DELETING':
        dynamicDebounceMs = Math.max(this.debounceMs * 2, 800); // 删除时延长防抖
        break;
      case 'TYPING':
        dynamicDebounceMs = Math.max(this.debounceMs * 1.5, 600); // 输入时适当延长
        break;
      case 'UNDOING':
      case 'PASTING':
        dynamicDebounceMs = Math.min(this.debounceMs * 0.5, 200); // 撤销和粘贴后快速同步
        break;
      default:
        dynamicDebounceMs = this.debounceMs;
    }
    
    this.logger.debug(`🕒 动态防抖时间: ${dynamicDebounceMs}ms (编辑状态: ${operation})`);
    
    // 防抖处理
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      await this.performSync(fileInfo, syncCheck.useIncrementalSync);
    }, dynamicDebounceMs);
    
    this.debounceTimers.set(filePath, timer);
  }
  
  private async performSync(fileInfo: FileInfo, preferIncrementalSync: boolean = true): Promise<void> {
    try {
      const existing = this.syncedFiles.get(fileInfo.path);
      let success = false;
      
      // 🔧 智能文件上传：首次尝试上传，失败则回退到纯内容模式
      if (!existing) {
        try {
          // 首次上传
          this.logger.info(`📤 尝试上传文件到服务器: ${fileInfo.path}`);
          success = await this.apiClient.uploadFile(fileInfo);
        } catch (uploadError) {
          this.logger.warn(`⚠️ 文件上传失败，将使用纯内容模式: ${uploadError}`);
          success = false; // 标记失败，后续使用纯内容模式
        }
      } else {
        try {
          // 根据智能检测器建议选择同步策略
          if (preferIncrementalSync) {
            this.logger.debug('🔧 使用智能建议的增量同步');
            fileInfo.modelVersion = existing.modelVersion;
            success = await this.apiClient.syncFile(fileInfo);
          } else {
            this.logger.debug('🔧 使用智能建议的完整上传');
            success = await this.apiClient.uploadFile(fileInfo);
          }
        } catch (syncError) {
          this.logger.warn(`⚠️ 智能同步失败，回退到默认策略: ${syncError}`);
          // 回退到增量同步
          try {
            fileInfo.modelVersion = existing.modelVersion;
            success = await this.apiClient.syncFile(fileInfo);
          } catch (fallbackError) {
            this.logger.warn(`⚠️ 回退同步也失败，将使用纯内容模式: ${fallbackError}`);
            success = false;
          }
        }
      }
      
      if (success) {
        this.syncedFiles.set(fileInfo.path, {
          ...fileInfo,
          modelVersion: (fileInfo.modelVersion || 0) + 1
        });
        this.logger.info(`✅ 文件同步成功: ${fileInfo.path} (将使用文件同步模式)`);
      } else {
        // 同步失败，记录本地状态但标记为纯内容模式
        this.syncedFiles.set(fileInfo.path, {
          ...fileInfo,
          modelVersion: 0 // 标记为纯内容模式
        });
        this.logger.info(`💾 文件缓存本地: ${fileInfo.path} (将使用纯内容模式)`);
      }
    } catch (error) {
      this.logger.error(`Failed to sync file: ${fileInfo.path}`, error as Error);
    }
  }
  
  getFileInfo(filePath: string): FileInfo | undefined {
    return this.syncedFiles.get(filePath);
  }
  
  async getCurrentFileInfo(document: vscode.TextDocument): Promise<FileInfo> {
    const filePath = vscode.workspace.asRelativePath(document.uri);
    const content = document.getText();
    const sha256 = CryptoUtils.calculateSHA256(content);
    
    const existing = this.syncedFiles.get(filePath);
    
    return {
      path: filePath,
      content,
      sha256,
      modelVersion: existing?.modelVersion
    };
  }
  
  startWatching(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    
    // 监听文档变化
    disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        this.syncDocument(e.document);
      })
    );
    
    // 监听文档打开
    disposables.push(
      vscode.workspace.onDidOpenTextDocument(document => {
        this.syncDocument(document);
      })
    );
    
    // 初始同步当前打开的文档
    vscode.window.visibleTextEditors.forEach(editor => {
      this.syncDocument(editor.document);
    });
    
    this.logger.info('File watching started');
    return disposables;
  }
  
  /**
   * 获取多文件上下文 - 为代码补全提供相关文件内容
   * 这是提升代码补全质量的关键功能
   */
  async getMultiFileContext(currentDocument: vscode.TextDocument, maxFiles: number = 10): Promise<FileInfo[]> {
    try {
      const currentPath = vscode.workspace.asRelativePath(currentDocument.uri);
      
      // 🚀 性能优化：检查缓存
      const cacheKey = `${currentPath}:${maxFiles}`;
      const cached = this.contextCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.CONTEXT_CACHE_TTL) {
        this.logger.info(`⚡ 使用缓存的多文件上下文: ${cached.files.length} 个文件`);
        return cached.files;
      }
      
      this.logger.info(`🔍 获取多文件上下文，当前文件: ${currentDocument.fileName}`);
      
      const contextFiles: FileInfo[] = [];
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentDocument.uri);
      
      if (!workspaceFolder) {
        this.logger.warn('无法确定工作区文件夹，使用当前文件作为唯一上下文');
        return [await this.getCurrentFileInfo(currentDocument)];
      }

      // 1. 添加当前文件
      contextFiles.push(await this.getCurrentFileInfo(currentDocument));

      // 🚀 基于 LSP 的智能上下文收集策略
      // 2. 使用 LSP 获取相关文件（最准确的方法）
      const lspRelatedFiles = await this.findLSPRelatedFiles(currentDocument, maxFiles - 1);
      contextFiles.push(...lspRelatedFiles);
      this.logger.info(`🔍 LSP 找到 ${lspRelatedFiles.length} 个相关文件`);

      // 3. 回退策略：如果 LSP 没有返回足够的文件，使用基础方法补充
      if (contextFiles.length < maxFiles) {
        const remainingSlots = maxFiles - contextFiles.length;
        this.logger.info(`📈 需要更多文件，剩余槽位: ${remainingSlots}`);
        
        // 获取同目录下的相关文件
        const currentDir = path.dirname(currentDocument.uri.fsPath);
        const sameDirectoryFiles = await this.findRelevantFilesInDirectory(currentDir, currentPath, Math.min(3, remainingSlots));
        contextFiles.push(...sameDirectoryFiles);
        this.logger.info(`📁 同目录找到 ${sameDirectoryFiles.length} 个文件`);

        // 获取重要的配置文件
        if (contextFiles.length < maxFiles) {
          const configFiles = await this.findConfigFiles(workspaceFolder.uri.fsPath, currentPath);
          const addedConfigFiles = configFiles.slice(0, maxFiles - contextFiles.length);
          contextFiles.push(...addedConfigFiles);
          this.logger.info(`⚙️ 配置文件找到 ${addedConfigFiles.length} 个文件`);
        }
      }

      // 🔧 确保至少有一些其他文件（除了当前文件）
      if (contextFiles.length <= 1) {
        this.logger.warn(`⚠️ 上下文文件太少 (${contextFiles.length})，尝试宽松搜索...`);
        const looseSearch = await this.findRelevantFilesLoose(workspaceFolder.uri.fsPath, currentPath, 3);
        contextFiles.push(...looseSearch);
        this.logger.info(`🔍 宽松搜索添加 ${looseSearch.length} 个文件`);
      }

      // 5. 去重并限制数量
      const uniqueFiles = this.deduplicateFiles(contextFiles);
      const limitedFiles = uniqueFiles.slice(0, maxFiles);

      this.logger.info(`✅ 收集到 ${limitedFiles.length} 个上下文文件:`);
      limitedFiles.forEach(file => {
        this.logger.info(`   📄 ${file.path} (${file.content.length} 字符)`);
      });

      // 🚀 性能优化：缓存结果
      this.contextCache.set(cacheKey, {
        files: limitedFiles,
        timestamp: Date.now()
      });

      return limitedFiles;
      
    } catch (error) {
      this.logger.error('获取多文件上下文失败', error as Error);
      // 失败时至少返回当前文件
      return [await this.getCurrentFileInfo(currentDocument)];
    }
  }

  /**
   * 在指定目录中查找相关文件
   */
  private async findRelevantFilesInDirectory(dirPath: string, currentPath: string, maxFiles: number): Promise<FileInfo[]> {
    try {
      const files: FileInfo[] = [];
      const uri = vscode.Uri.file(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);

      for (const [name, type] of entries) {
        if (files.length >= maxFiles) break;
        if (type !== vscode.FileType.File) continue;
        
        const filePath = path.join(dirPath, name);
        const relativePath = vscode.workspace.asRelativePath(filePath);
        
        // 跳过当前文件
        if (relativePath === currentPath) continue;
        
        // 只处理代码文件
        if (this.isCodeFile(name)) {
          const fileInfo = await this.readFileAsFileInfo(filePath, relativePath);
          if (fileInfo) {
            files.push(fileInfo);
          }
        }
      }

      return files;
    } catch (error) {
      this.logger.debug(`读取目录失败: ${dirPath}`, error as Error);
      return [];
    }
  }

  /**
   * 查找项目配置文件
   */
  private async findConfigFiles(workspaceRoot: string, currentPath: string): Promise<FileInfo[]> {
    const configFileNames = [
      'package.json', 'tsconfig.json', 'jsconfig.json', 
      '.eslintrc.js', '.eslintrc.json', 'prettier.config.js',
      'vite.config.ts', 'webpack.config.js', 'next.config.js'
    ];

    const files: FileInfo[] = [];
    
    for (const fileName of configFileNames) {
      const filePath = path.join(workspaceRoot, fileName);
      const relativePath = vscode.workspace.asRelativePath(filePath);
      
      if (relativePath === currentPath) continue;
      
      const fileInfo = await this.readFileAsFileInfo(filePath, relativePath);
      if (fileInfo) {
        files.push(fileInfo);
      }
    }

    return files;
  }

  /**
   * 使用 LSP 获取相关文件（最准确的方法）
   */
  private async findLSPRelatedFiles(document: vscode.TextDocument, maxFiles: number): Promise<FileInfo[]> {
    try {
      const files: FileInfo[] = [];
      const currentUri = document.uri;
      
      this.logger.info(`🔍 使用 LSP 查找相关文件，最大数量: ${maxFiles}`);

      // 1. 获取当前文件的所有引用
      const references = await this.getLSPReferences(currentUri);
      
      // 2. 获取当前文件导入的文件
      const imports = await this.getLSPImports(currentUri);
      
      // 3. 合并并去重
      const allRelatedUris = [...new Set([...references, ...imports])];
      
      this.logger.info(`📊 LSP 发现 ${allRelatedUris.length} 个相关文件`);

      // 4. 转换为 FileInfo 并限制数量
      for (const uri of allRelatedUris.slice(0, maxFiles)) {
        if (uri.toString() === currentUri.toString()) continue; // 跳过当前文件
        
        const relativePath = vscode.workspace.asRelativePath(uri);
        const fileInfo = await this.readFileAsFileInfo(uri.fsPath, relativePath);
        if (fileInfo) {
          files.push(fileInfo);
          this.logger.debug(`🔗 LSP 添加相关文件: ${relativePath}`);
        }
      }

      this.logger.info(`✅ LSP 成功收集 ${files.length} 个相关文件`);
      return files;
    } catch (error) {
      this.logger.debug('LSP 获取相关文件失败，使用回退策略', error as Error);
      return [];
    }
  }

  /**
   * 获取 LSP 引用信息
   */
  private async getLSPReferences(uri: vscode.Uri): Promise<vscode.Uri[]> {
    try {
      // 获取文件中的所有符号
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
      );

      const referencedFiles: vscode.Uri[] = [];

      if (symbols && symbols.length > 0) {
        // 对主要符号查找引用
        const mainSymbols = symbols.slice(0, 3); // 限制查找的符号数量
        
        for (const symbol of mainSymbols) {
          try {
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeReferenceProvider', 
              uri, 
              symbol.range.start
            );

            if (references) {
              references.forEach(ref => {
                if (ref.uri.toString() !== uri.toString()) {
                  referencedFiles.push(ref.uri);
                }
              });
            }
          } catch (error) {
            // 忽略单个符号的错误
          }
        }
      }

      return [...new Set(referencedFiles.map(u => u.toString()))].map(s => vscode.Uri.parse(s));
    } catch (error) {
      this.logger.debug('获取 LSP 引用失败', error as Error);
      return [];
    }
  }

  /**
   * 获取 LSP 导入信息
   */
  private async getLSPImports(uri: vscode.Uri): Promise<vscode.Uri[]> {
    try {
      // 使用 Go to Definition 获取导入的文件
      const document = await vscode.workspace.openTextDocument(uri);
      const content = document.getText();
      const imports: vscode.Uri[] = [];

      // 查找 import 语句并获取定义位置
      const importRegex = /import.*?from\s+['"]([^'"]+)['"]/g;
      let match;

      while ((match = importRegex.exec(content)) !== null && imports.length < 5) {
        const importPath = match[1];
        if (importPath.startsWith('.')) { // 只处理相对导入
          try {
            const line = document.positionAt(match.index).line;
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeDefinitionProvider',
              uri,
              new vscode.Position(line, match.index + match[0].indexOf(importPath))
            );

            if (definitions && definitions.length > 0) {
              definitions.forEach(def => {
                if (def.uri.toString() !== uri.toString()) {
                  imports.push(def.uri);
                }
              });
            }
          } catch (error) {
            // 忽略单个导入的错误
          }
        }
      }

      return [...new Set(imports.map(u => u.toString()))].map(s => vscode.Uri.parse(s));
    } catch (error) {
      this.logger.debug('获取 LSP 导入失败', error as Error);
      return [];
    }
  }


  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取文件并转换为 FileInfo
   */
  private async readFileAsFileInfo(filePath: string, relativePath: string): Promise<FileInfo | null> {
    try {
      // 先检查是否已经同步过
      const existing = this.syncedFiles.get(relativePath);
      if (existing) {
        return existing;
      }

      const uri = vscode.Uri.file(filePath);
      const data = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(data).toString('utf8');
      
      // 限制文件大小，避免过大的文件影响性能
      if (content.length > 50000) {
        this.logger.debug(`文件过大，跳过: ${relativePath} (${content.length} 字符)`);
        return null;
      }
      
      const sha256 = CryptoUtils.calculateSHA256(content);
      
      const fileInfo: FileInfo = {
        path: relativePath,
        content,
        sha256
      };

      return fileInfo;
    } catch (error) {
      this.logger.debug(`读取文件失败: ${relativePath}`, error as Error);
      return null;
    }
  }

  /**
   * 判断是否为代码文件
   */
  private isCodeFile(fileName: string): boolean {
    const codeExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
      '.py', '.java', '.cpp', '.c', '.h', '.hpp',
      '.go', '.rs', '.php', '.rb', '.swift', '.kt',
      '.scala', '.cs', '.dart', '.html', '.css', '.scss',
      '.less', '.json', '.yaml', '.yml', '.toml', '.xml'
    ];
    
    const ext = path.extname(fileName).toLowerCase();
    return codeExtensions.includes(ext);
  }

  /**
   * 去重文件列表
   */
  /**
   * 宽松搜索相关文件（最后的回退策略）
   */
  private async findRelevantFilesLoose(workspacePath: string, currentPath: string, maxFiles: number): Promise<FileInfo[]> {
    try {
      const files: FileInfo[] = [];
      const currentExt = path.extname(currentPath);
      
      // 搜索相同扩展名的文件
      const pattern = `**/*${currentExt}`;
      const foundUris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxFiles + 5);
      
      this.logger.info(`🔍 宽松搜索模式: 在工作区找到 ${foundUris.length} 个 ${currentExt} 文件`);
      
      for (const uri of foundUris.slice(0, maxFiles)) {
        const relativePath = vscode.workspace.asRelativePath(uri);
        if (relativePath === currentPath) continue; // 跳过当前文件
        
        const fileInfo = await this.readFileAsFileInfo(uri.fsPath, relativePath);
        if (fileInfo && fileInfo.content.length > 50) { // 至少50个字符的文件
          files.push(fileInfo);
          if (files.length >= maxFiles) break;
        }
      }
      
      this.logger.info(`✅ 宽松搜索找到 ${files.length} 个有效文件`);
      return files;
    } catch (error) {
      this.logger.debug('宽松搜索失败', error as Error);
      return [];
    }
  }

  private deduplicateFiles(files: FileInfo[]): FileInfo[] {
    const seen = new Set<string>();
    const result: FileInfo[] = [];
    
    for (const file of files) {
      if (!seen.has(file.path)) {
        seen.add(file.path);
        result.push(file);
      }
    }
    
    return result;
  }

  dispose(): void {
    // 清理所有定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.syncedFiles.clear();
    this.logger.info('File manager disposed');
  }
}