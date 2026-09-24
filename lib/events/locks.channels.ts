import { channel, type Channel } from 'node:diagnostics_channel';
import type { LocksEvent } from './locks-events.interface.js';

/** The `nestjs:locks:<type>` diagnostics channels, one per event type. */
export const channels: Record<LocksEvent['type'], Channel> = {
  'lock-lost': channel('nestjs:locks:lock-lost'),
  'leadership-acquired': channel('nestjs:locks:leadership-acquired'),
  'leadership-lost': channel('nestjs:locks:leadership-lost'),
};
