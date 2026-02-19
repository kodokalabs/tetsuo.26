// ============================================================
// EventBus — Typed pub/sub for agent events
// ============================================================

import { EventEmitter } from 'events';
import type { AgentEvent } from './types.js';

type EventHandler = (event: AgentEvent) => void | Promise<void>;

class AgentEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: AgentEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event); // wildcard listeners
  }

  on(type: AgentEvent['type'] | '*', handler: EventHandler): void {
    this.emitter.on(type, handler);
  }

  off(type: AgentEvent['type'] | '*', handler: EventHandler): void {
    this.emitter.off(type, handler);
  }

  once(type: AgentEvent['type'], handler: EventHandler): void {
    this.emitter.once(type, handler);
  }
}

/** Singleton event bus used across all modules */
export const eventBus = new AgentEventBus();
