import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const pluginConfig = sqliteTable('plugin_config', {
  teamId: text('team_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.key] }),
}));

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  phone: text('phone'),
  address: text('address'),
  tags: text('tags'),
  lastVisitAt: text('last_visit_at'),
  totalVisits: integer('total_visits'),
  totalSpend: real('total_spend'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const appointments = sqliteTable('appointments', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  clientId: text('client_id'),
  staffId: text('staff_id'),
  serviceId: text('service_id'),
  locationId: text('location_id'),
  startsAt: text('starts_at'),
  endsAt: text('ends_at'),
  status: text('status'),
  total: real('total'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const syncState = sqliteTable('sync_state', {
  teamId: text('team_id').notNull(),
  resource: text('resource').notNull(),
  lastSyncedAt: text('last_synced_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
  rowCount: integer('row_count'),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.resource] }),
}));

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
