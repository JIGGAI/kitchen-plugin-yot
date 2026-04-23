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
  privateId: text('private_id'),
  otherName: text('other_name'),
  fullName: text('full_name'),
  homePhone: text('home_phone'),
  mobilePhone: text('mobile_phone'),
  businessPhone: text('business_phone'),
  emailAddress: text('email_address'),
  birthday: text('birthday'),
  gender: text('gender'),
  active: integer('active', { mode: 'boolean' }),
  street: text('street'),
  suburb: text('suburb'),
  state: text('state'),
  postcode: text('postcode'),
  country: text('country'),
  sourceLocationId: text('source_location_id'),
  createdAtRemote: text('created_at_remote'),
});

export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  name: text('name'),
  emailAddress: text('email_address'),
  businessPhone: text('business_phone'),
  mobilePhone: text('mobile_phone'),
  canBookOnline: integer('can_book_online', { mode: 'boolean' }),
  active: integer('active', { mode: 'boolean' }),
  street: text('street'),
  suburb: text('suburb'),
  state: text('state'),
  postcode: text('postcode'),
  country: text('country'),
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

export const syncRuns = sqliteTable('sync_runs', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  resource: text('resource').notNull(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  rowsSeen: integer('rows_seen'),
  rowsWritten: integer('rows_written'),
  pageCount: integer('page_count'),
  notes: text('notes'),
  error: text('error'),
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
