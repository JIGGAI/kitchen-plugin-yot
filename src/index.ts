/**
 * kitchen-plugin-yot — entry point.
 * Exports what ClawKitchen needs + the public types for downstream consumers.
 */

export { handleRequest } from './api/handler';
export { initializeDatabase } from './db';
export * as schema from './db/schema';
export type {
  YotConfig,
  ClientRecord,
  LocationRecord,
  AppointmentRecord,
  SyncStateRecord,
  SyncRunRecord,
  ApiError,
  PaginatedResponse,
} from './types';

export const pluginMeta = {
  id: 'yot',
  name: "You're On Time CRM",
  version: '0.1.0',
  teamTypes: ['marketing-team', 'ops-team'],
};
