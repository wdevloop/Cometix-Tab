import { CompletionState, StateChangeListener } from '../types';
import { Logger } from '../utils/logger';

export interface CompletionHandler {
  id: string;
  position: { line: number; character: number };
  bindingId?: string;
  startTime: number;
  lastActivity: number;
  abortController?: AbortController;
}

export interface StateTransitionContext {
  handlerId?: string;
  position?: { line: number; character: number };
  bindingId?: string;
  reason?: string;
  error?: Error;
}

export class CompletionStateMachine {
  private state: CompletionState = CompletionState.IDLE;
  private listeners: StateChangeListener[] = [];
  private handlers = new Map<string, CompletionHandler>();
  private lastTransition: number = 0;
  private readonly COOLDOWN_PERIOD = 150; // ms
  private readonly HANDLER_TIMEOUT = 30000; // 30s
  private readonly MAX_CONCURRENT_HANDLERS = 3;
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
    
    // Cleanup stale handlers every 10 seconds
    setInterval(() => this.cleanupStaleHandlers(), 10000);
  }

  getState(): CompletionState {
    return this.state;
  }

  onChange(listener: StateChangeListener) {
    this.listeners.push(listener);
  }

  private setState(next: CompletionState, context?: StateTransitionContext) {
    if (this.state === next) return;
    
    const now = Date.now();
    if (now - this.lastTransition < this.COOLDOWN_PERIOD) {
      this.logger.debug(`🔄 State transition blocked by cooldown: ${this.state} -> ${next}`);
      return;
    }

    const prev = this.state;
    this.state = next;
    this.lastTransition = now;
    
    this.logger.debug(`🔄 State transition: ${prev} -> ${next}`, {
      handlerId: context?.handlerId,
      reason: context?.reason,
      activeHandlers: this.handlers.size
    });
    
    for (const l of this.listeners) l(prev, next);
  }

  // Handler management
  createHandler(position: { line: number; character: number }, abortController?: AbortController): string | null {
    // Check concurrent limit
    if (this.handlers.size >= this.MAX_CONCURRENT_HANDLERS) {
      this.logger.warn(`🚫 Max concurrent handlers reached (${this.MAX_CONCURRENT_HANDLERS})`);
      return null;
    }

    const id = `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const handler: CompletionHandler = {
      id,
      position,
      startTime: Date.now(),
      lastActivity: Date.now(),
      abortController
    };

    this.handlers.set(id, handler);
    this.logger.debug(`🆕 Created completion handler: ${id}`, { position, totalHandlers: this.handlers.size });
    
    return id;
  }

  findHandlerByPosition(position: { line: number; character: number }): CompletionHandler | null {
    for (const handler of this.handlers.values()) {
      if (handler.position.line === position.line && 
          Math.abs(handler.position.character - position.character) <= 5) {
        return handler;
      }
    }
    return null;
  }

  updateHandlerActivity(handlerId: string, bindingId?: string): void {
    const handler = this.handlers.get(handlerId);
    if (handler) {
      handler.lastActivity = Date.now();
      if (bindingId) {
        handler.bindingId = bindingId;
      }
    }
  }

  removeHandler(handlerId: string): void {
    const handler = this.handlers.get(handlerId);
    if (handler) {
      if (handler.abortController) {
        handler.abortController.abort();
      }
      this.handlers.delete(handlerId);
      this.logger.debug(`🗑️ Removed completion handler: ${handlerId}`, { 
        duration: Date.now() - handler.startTime,
        remainingHandlers: this.handlers.size 
      });
    }
  }

  private cleanupStaleHandlers(): void {
    const now = Date.now();
    const staleHandlers: string[] = [];

    for (const [id, handler] of this.handlers.entries()) {
      if (now - handler.lastActivity > this.HANDLER_TIMEOUT) {
        staleHandlers.push(id);
      }
    }

    if (staleHandlers.length > 0) {
      this.logger.debug(`🧹 Cleaning up ${staleHandlers.length} stale handlers`);
      staleHandlers.forEach(id => this.removeHandler(id));
    }
  }

  // State transitions with handler tracking
  beginGenerate(handlerId?: string, reason?: string) {
    this.setState(CompletionState.GENERATING, { handlerId, reason });
  }

  showVisible(handlerId?: string, bindingId?: string) {
    if (handlerId && bindingId) {
      this.updateHandlerActivity(handlerId, bindingId);
    }
    this.setState(CompletionState.VISIBLE, { handlerId, bindingId });
  }

  startEditing(handlerId?: string) {
    this.setState(CompletionState.EDITING, { handlerId });
  }

  backToIdle(handlerId?: string, reason?: string) {
    if (handlerId) {
      this.removeHandler(handlerId);
    }
    this.setState(CompletionState.IDLE, { handlerId, reason });
  }

  // Error recovery
  handleError(error: Error, handlerId?: string): void {
    this.logger.error(`💥 Completion error`, error, { handlerId });
    
    if (handlerId) {
      this.removeHandler(handlerId);
    }
    
    // Force back to idle on error
    this.state = CompletionState.IDLE;
    this.lastTransition = Date.now();
    
    for (const l of this.listeners) l(this.state, CompletionState.IDLE);
  }

  // Cancel all active handlers
  cancelAll(): void {
    const handlerIds = Array.from(this.handlers.keys());
    this.logger.debug(`🚫 Cancelling all ${handlerIds.length} active handlers`);
    
    handlerIds.forEach(id => this.removeHandler(id));
    this.backToIdle(undefined, 'cancel_all');
  }

  // Get active handlers info for debugging
  getActiveHandlers(): CompletionHandler[] {
    return Array.from(this.handlers.values());
  }

  // Get performance stats
  getStats() {
    const now = Date.now();
    const handlers = Array.from(this.handlers.values());
    
    return {
      currentState: this.state,
      activeHandlers: handlers.length,
      avgHandlerAge: handlers.length > 0 
        ? handlers.reduce((sum, h) => sum + (now - h.startTime), 0) / handlers.length 
        : 0,
      lastTransition: this.lastTransition,
      cooldownRemaining: Math.max(0, this.COOLDOWN_PERIOD - (now - this.lastTransition))
    };
  }
}


