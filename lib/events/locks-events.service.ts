import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Channel } from 'node:diagnostics_channel';
import { Subject, type Observable } from 'rxjs';
import type { LocksEvent, LocksJobSkippedEvent } from './locks-events.interface.js';
import { channels, jobSkippedChannel } from './locks.channels.js';

/**
 * The lock events of this application, for metrics and alerts. Each event is also
 * published on its `node:diagnostics_channel` channel (`nestjs:locks:<type>`), where
 * instrumentation can subscribe without depending on Nest.
 *
 * Subscribers must not throw: rxjs rethrows a subscriber's error asynchronously, and Node a
 * channel subscriber's on the next tick, both as an `uncaughtException`.
 */
@Injectable()
export class LocksEvents implements OnApplicationShutdown {
  private readonly logger = new Logger('Locks');
  private closed = false;

  private readonly subject = new Subject<LocksEvent>();
  readonly events$: Observable<LocksEvent> = this.subject.asObservable();

  private readonly skips = new Subject<LocksJobSkippedEvent>();
  /**
   * Each call to an `@OnOneInstance()` or `@WithoutOverlapping()` job that didn't run, and why:
   * to count them by job and reason. Apart from `events$`: every instance but the owner skips
   * each tick, so these are routine, not alerts, and a subscriber that throws fails within one
   * tick.
   */
  readonly jobSkips$: Observable<LocksJobSkippedEvent> = this.skips.asObservable();

  /** Called by the package. */
  emit(event: LocksEvent): void {
    this.publish(channels[event.type], this.subject, event);
  }

  /** Called by the package. */
  emitJobSkipped(event: LocksJobSkippedEvent): void {
    this.publish(jobSkippedChannel, this.skips, event);
  }

  // After onModuleDestroy, where elections step down and jobs skip, and may still emit.
  onApplicationShutdown() {
    this.closed = true;
    this.subject.complete();
    this.skips.complete();
  }

  /**
   * On the channel, then the stream; neither once shut down, so the two carry the same events.
   * A subscriber's error never reaches the code that emitted: rxjs throws it here only with
   * `useDeprecatedSynchronousErrorHandling`, where it's logged instead.
   */
  private publish<T extends { type: string }>(target: Channel, subject: Subject<T>, event: T): void {
    if (this.closed) {
      return;
    }
    if (target.hasSubscribers) {
      target.publish(event);
    }
    try {
      subject.next(event);
    } catch (error) {
      this.logger.error(`A subscriber to the "${event.type}" events threw`, (error as Error)?.stack ?? String(error));
    }
  }
}
