import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { LocksEvent, LocksJobSkippedEvent } from './locks-events.interface.js';
import { channels, jobSkippedChannel } from './locks.channels.js';

/**
 * The lock events of this application, for metrics and alerts. Each event is also
 * published on its `node:diagnostics_channel` channel (`nestjs:locks:<type>`), where
 * instrumentation can subscribe without depending on Nest.
 */
@Injectable()
export class LocksEvents implements OnApplicationShutdown {
  private readonly subject = new Subject<LocksEvent>();
  readonly events$: Observable<LocksEvent> = this.subject.asObservable();

  private readonly skips = new Subject<LocksJobSkippedEvent>();
  /**
   * Each call to an `@OnOneInstance()` or `@WithoutOverlapping()` job that didn't run, and why:
   * to count them by job and reason. Apart from `events$`: every instance but the owner skips
   * each tick, so these are routine, not alerts.
   */
  readonly jobSkips$: Observable<LocksJobSkippedEvent> = this.skips.asObservable();

  /** Called by the package. */
  emit(event: LocksEvent): void {
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  /** Called by the package. */
  emitJobSkipped(event: LocksJobSkippedEvent): void {
    if (jobSkippedChannel.hasSubscribers) {
      jobSkippedChannel.publish(event);
    }
    this.skips.next(event);
  }

  // After onModuleDestroy, where elections step down and jobs skip, and may still emit.
  onApplicationShutdown() {
    this.subject.complete();
    this.skips.complete();
  }
}
