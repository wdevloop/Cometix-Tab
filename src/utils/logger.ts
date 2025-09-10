import * as vscode from 'vscode';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private logLevel: LogLevel = LogLevel.INFO;  // 默认为 INFO 级别
  private isDisposed: boolean = false;
  private isMuted: boolean = false;
  
  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Cometix Tab');
    
    // 初始化时读取配置
    this.updateLogLevelFromConfig();
    
    // 监听配置变化
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cometixTab.logLevel')) {
        this.updateLogLevelFromConfig();
      }
    });
  }
  
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }
  
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  mute(): void {
    this.isMuted = true;
  }

  unmute(): void {
    this.isMuted = false;
  }

  /**
   * 从 VSCode 配置中更新日志级别
   */
  private updateLogLevelFromConfig(): void {
    if (this.isDisposed) { return; }
    const config = vscode.workspace.getConfiguration('cometixTab');
    const logLevelString = config.get<string>('logLevel', 'info');
    
    const levelMap: Record<string, LogLevel> = {
      'debug': LogLevel.DEBUG,
      'info': LogLevel.INFO,
      'warn': LogLevel.WARN,
      'error': LogLevel.ERROR
    };
    
    const newLevel = levelMap[logLevelString] ?? LogLevel.INFO;
    
    if (this.logLevel !== newLevel) {
      const oldLevelName = Object.keys(levelMap).find(key => levelMap[key] === this.logLevel) || 'unknown';
      const newLevelName = Object.keys(levelMap).find(key => levelMap[key] === newLevel) || 'unknown';
      
      this.logLevel = newLevel;
      this.log('INFO', `🔧 日志级别已更新: ${oldLevelName} → ${newLevelName}`);
    }
  }

  /**
   * 获取当前日志级别
   */
  getCurrentLogLevel(): LogLevel {
    return this.logLevel;
  }

  /**
   * 获取当前日志级别名称
   */
  getCurrentLogLevelName(): string {
    const levelMap: Record<LogLevel, string> = {
      [LogLevel.DEBUG]: 'debug',
      [LogLevel.INFO]: 'info',
      [LogLevel.WARN]: 'warn',
      [LogLevel.ERROR]: 'error'
    };
    return levelMap[this.logLevel] || 'unknown';
  }
  
  debug(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.log('DEBUG', message, ...args);
    }
  }
  
  info(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.INFO) {
      this.log('INFO', message, ...args);
    }
  }
  
  warn(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.WARN) {
      this.log('WARN', message, ...args);
    }
  }
  
  error(message: string, error?: Error, ...args: any[]): void {
    if (this.logLevel <= LogLevel.ERROR) {
      this.log('ERROR', message, error?.stack || error, ...args);
    }
  }
  
  private log(level: string, message: string, ...args: any[]): void {
    if (this.isDisposed || this.isMuted) { return; }
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    
    try {
      if (args.length > 0) {
        this.outputChannel.appendLine(`${logMessage} ${args.map(arg => 
          typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' ')}`);
      } else {
        this.outputChannel.appendLine(logMessage);
      }
    } catch {
      // Ignore logging errors during shutdown (e.g., channel closed)
    }
  }
  
  show(): void {
    if (this.isDisposed) { return; }
    try {
      this.outputChannel.show();
    } catch {
      // ignore
    }
  }
  
  dispose(): void {
    this.isDisposed = true;
    try {
      this.outputChannel.dispose();
    } catch {
      // ignore
    }
  }
}