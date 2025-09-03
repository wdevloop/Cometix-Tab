import { Logger } from './logger';
import { ContextItem } from './context-scorer';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccess: number;
  tags?: string[];
}

export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  missRate: number;
  avgTTL: number;
  oldestEntry: number;
  newestEntry: number;
  memoryUsage: number;
}

export interface CacheOptions {
  defaultTTL?: number;
  maxSize?: number;
  cleanupInterval?: number;
  enableStats?: boolean;
  enableCompression?: boolean;
}

/**
 * TTL缓存管理器
 * 智能缓存上下文信息，提高补全响应速度
 */
export class ContextCacheManager {
  private cache = new Map<string, CacheEntry<any>>();
  private logger: Logger;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    cleanups: 0
  };
  
  private readonly defaultTTL: number;
  private readonly maxSize: number;
  private readonly cleanupInterval: number;
  private readonly enableStats: boolean;
  private readonly enableCompression: boolean;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: CacheOptions = {}) {
    this.logger = Logger.getInstance();
    this.defaultTTL = options.defaultTTL || 5 * 60 * 1000; // 5 minutes
    this.maxSize = options.maxSize || 1000;
    this.cleanupInterval = options.cleanupInterval || 60 * 1000; // 1 minute
    this.enableStats = options.enableStats !== false;
    this.enableCompression = options.enableCompression || false;

    this.startCleanupTimer();
    this.logger.debug(`🗄️ 上下文缓存管理器初始化: TTL=${this.defaultTTL}ms, MaxSize=${this.maxSize}`);
  }

  /**
   * 设置缓存项
   */
  set<T>(key: string, data: T, ttl?: number, tags?: string[]): void {
    const now = Date.now();
    const effectiveTTL = ttl || this.defaultTTL;
    
    // 检查缓存大小限制
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      data: this.enableCompression ? this.compress(data) as any : data,
      timestamp: now,
      ttl: effectiveTTL,
      accessCount: 0,
      lastAccess: now,
      tags
    };

    this.cache.set(key, entry);
    
    if (this.enableStats) {
      this.logger.debug(`🗄️ 缓存设置: ${key}, TTL=${effectiveTTL}ms, 总项目=${this.cache.size}`);
    }
  }

  /**
   * 获取缓存项
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    
    // 检查是否过期
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      if (this.enableStats) {
        this.logger.debug(`🗄️ 缓存过期: ${key}`);
      }
      return null;
    }

    // 更新访问统计
    entry.accessCount++;
    entry.lastAccess = now;
    this.stats.hits++;

    const data = this.enableCompression ? this.decompress(entry.data) : entry.data;
    
    if (this.enableStats) {
      this.logger.debug(`🗄️ 缓存命中: ${key}, 访问次数=${entry.accessCount}`);
    }
    
    return data;
  }

  /**
   * 检查缓存项是否存在且未过期
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    const result = this.cache.delete(key);
    if (result && this.enableStats) {
      this.logger.debug(`🗄️ 缓存删除: ${key}`);
    }
    return result;
  }

  /**
   * 根据标签删除缓存项
   */
  deleteByTag(tag: string): number {
    let deleted = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags && entry.tags.includes(tag)) {
        this.cache.delete(key);
        deleted++;
      }
    }

    if (deleted > 0 && this.enableStats) {
      this.logger.debug(`🗄️ 按标签删除缓存: ${tag}, 删除了${deleted}个项目`);
    }

    return deleted;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
    this.stats.cleanups = 0;
    
    if (this.enableStats) {
      this.logger.debug(`🗄️ 缓存清空: 删除了${size}个项目`);
    }
  }

  /**
   * 更新缓存项的TTL
   */
  updateTTL(key: string, newTTL: number): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    entry.ttl = newTTL;
    entry.timestamp = Date.now(); // 重置时间戳
    
    if (this.enableStats) {
      this.logger.debug(`🗄️ TTL更新: ${key}, 新TTL=${newTTL}ms`);
    }
    
    return true;
  }

  /**
   * 获取多个缓存项
   */
  getMultiple<T>(keys: string[]): { [key: string]: T | null } {
    const result: { [key: string]: T | null } = {};
    
    for (const key of keys) {
      result[key] = this.get<T>(key);
    }
    
    return result;
  }

  /**
   * 设置多个缓存项
   */
  setMultiple<T>(items: { key: string; data: T; ttl?: number; tags?: string[] }[]): void {
    for (const item of items) {
      this.set(item.key, item.data, item.ttl, item.tags);
    }
  }

  /**
   * 获取缓存键列表
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取所有有效的缓存项
   */
  getAllValid<T>(): { [key: string]: T } {
    const result: { [key: string]: T } = {};
    const now = Date.now();
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp <= entry.ttl) {
        result[key] = this.enableCompression ? this.decompress(entry.data) : entry.data;
      }
    }
    
    return result;
  }

  /**
   * LRU淘汰策略
   */
  private evictLRU(): void {
    let oldestKey = '';
    let oldestAccess = Date.now();
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      
      if (this.enableStats) {
        this.logger.debug(`🗄️ LRU淘汰: ${oldestKey}`);
      }
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  /**
   * 清理过期项
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.cache.delete(key);
    }
    
    this.stats.cleanups++;
    
    if (expiredKeys.length > 0 && this.enableStats) {
      this.logger.debug(`🗄️ 定期清理: 删除了${expiredKeys.length}个过期项目`);
    }
  }

  /**
   * 压缩数据（简单的JSON字符串压缩）
   */
  private compress<T>(data: T): string {
    return JSON.stringify(data);
  }

  /**
   * 解压缩数据
   */
  private decompress<T>(compressed: any): T {
    if (typeof compressed === 'string') {
      try {
        return JSON.parse(compressed);
      } catch {
        return compressed as T;
      }
    }
    return compressed;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const now = Date.now();
    let totalSize = 0;
    let totalTTL = 0;
    let oldestEntry = now;
    let newestEntry = 0;
    
    for (const entry of this.cache.values()) {
      // 估算内存使用
      totalSize += JSON.stringify(entry.data).length;
      totalTTL += entry.ttl;
      
      if (entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
      if (entry.timestamp > newestEntry) {
        newestEntry = entry.timestamp;
      }
    }
    
    const totalRequests = this.stats.hits + this.stats.misses;
    
    return {
      totalEntries: this.cache.size,
      totalSize,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0,
      missRate: totalRequests > 0 ? this.stats.misses / totalRequests : 0,
      avgTTL: this.cache.size > 0 ? totalTTL / this.cache.size : 0,
      oldestEntry: oldestEntry === now ? 0 : oldestEntry,
      newestEntry,
      memoryUsage: totalSize
    };
  }

  /**
   * 获取详细统计信息
   */
  getDetailedStats() {
    const cacheStats = this.getStats();
    
    return {
      ...cacheStats,
      internalStats: {
        hits: this.stats.hits,
        misses: this.stats.misses,
        evictions: this.stats.evictions,
        cleanups: this.stats.cleanups
      },
      configuration: {
        defaultTTL: this.defaultTTL,
        maxSize: this.maxSize,
        cleanupInterval: this.cleanupInterval,
        enableStats: this.enableStats,
        enableCompression: this.enableCompression
      }
    };
  }

  /**
   * 预热缓存
   */
  async warmup(items: { key: string; data: any; ttl?: number }[]): Promise<void> {
    this.logger.info(`🗄️ 缓存预热开始: ${items.length}个项目`);
    
    for (const item of items) {
      this.set(item.key, item.data, item.ttl);
    }
    
    this.logger.info(`🗄️ 缓存预热完成: 加载了${items.length}个项目`);
  }

  /**
   * 缓存健康检查
   */
  healthCheck(): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];
    const stats = this.getStats();
    
    // 检查命中率
    if (stats.hitRate < 0.3) {
      issues.push(`缓存命中率过低: ${(stats.hitRate * 100).toFixed(1)}%`);
    }
    
    // 检查内存使用
    if (stats.memoryUsage > 50 * 1024 * 1024) { // 50MB
      issues.push(`内存使用过高: ${(stats.memoryUsage / 1024 / 1024).toFixed(1)}MB`);
    }
    
    // 检查缓存大小
    if (stats.totalEntries > this.maxSize * 0.9) {
      issues.push(`缓存接近满载: ${stats.totalEntries}/${this.maxSize}`);
    }
    
    return {
      healthy: issues.length === 0,
      issues
    };
  }

  /**
   * 销毁缓存管理器
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.clear();
    this.logger.debug('🗄️ 上下文缓存管理器已销毁');
  }
}

/**
 * 专门用于上下文项的缓存管理器
 */
export class ContextItemCacheManager extends ContextCacheManager {
  constructor() {
    super({
      defaultTTL: 5 * 60 * 1000, // 5分钟
      maxSize: 500,
      cleanupInterval: 30 * 1000, // 30秒
      enableStats: true,
      enableCompression: true
    });
  }

  /**
   * 缓存上下文项
   */
  cacheContextItems(filePath: string, items: ContextItem[]): void {
    const key = `context:${filePath}`;
    const tags = ['context', 'file-context'];
    this.set(key, items, undefined, tags);
  }

  /**
   * 获取缓存的上下文项
   */
  getCachedContextItems(filePath: string): ContextItem[] | null {
    const key = `context:${filePath}`;
    return this.get<ContextItem[]>(key);
  }

  /**
   * 缓存文件内容
   */
  cacheFileContent(filePath: string, content: string, ttl?: number): void {
    const key = `file:${filePath}`;
    const tags = ['file-content'];
    this.set(key, content, ttl || 10 * 60 * 1000, tags); // 10分钟
  }

  /**
   * 获取缓存的文件内容
   */
  getCachedFileContent(filePath: string): string | null {
    const key = `file:${filePath}`;
    return this.get<string>(key);
  }

  /**
   * 当文件被修改时清理相关缓存
   */
  invalidateFileCache(filePath: string): void {
    this.delete(`context:${filePath}`);
    this.delete(`file:${filePath}`);
    
    // 清理可能受影响的相关文件缓存
    this.deleteByTag('context');
  }

  /**
   * 批量缓存多文件上下文
   */
  cacheMultiFileContext(
    contextKey: string, 
    contextItems: { [filePath: string]: ContextItem[] }
  ): void {
    const key = `multi-context:${contextKey}`;
    const tags = ['multi-context', 'context'];
    this.set(key, contextItems, 3 * 60 * 1000, tags); // 3分钟
  }

  /**
   * 获取批量上下文缓存
   */
  getCachedMultiFileContext(contextKey: string): { [filePath: string]: ContextItem[] } | null {
    const key = `multi-context:${contextKey}`;
    return this.get<{ [filePath: string]: ContextItem[] }>(key);
  }
}