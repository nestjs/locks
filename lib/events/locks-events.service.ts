import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { LocksEvent } from './locks-events.interface.js';
import { channels } from './locks.channels.js';

/**
 * The lock events of this application, for metrics and alerts. Each event is also
 * published on its `node:diagnostics_channel` channel (`nestjs:locks:<type>`), where
 * instrumentation can subscribe without depending on Nest.
 */
@Injectable()
export class LocksEvents implements OnApplicationShutdown {
  private readonly subject = new Subject<LocksEvent>();
  readonly events$: Observable<LocksEvent> = this.subject.asObservable();

  /** Called by the package. */
  emit(event: LocksEvent): void {
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  // After onModuleDestroy, where elections step down and may still emit.
  onApplicationShutdown() {
    this.subject.complete();
  }
}
