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

export const stylists = sqliteTable('stylists', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  locationId: text('location_id'),
  privateId: text('private_id'),
  givenName: text('given_name'),
  surname: text('surname'),
  fullName: text('full_name'),
  initial: text('initial'),
  jobTitle: text('job_title'),
  jobDescription: text('job_description'),
  emailAddress: text('email_address'),
  mobilePhone: text('mobile_phone'),
  active: integer('active', { mode: 'boolean' }),
  sourceLocationId: text('source_location_id'),
  serviceCategoryNames: text('service_category_names'),
  serviceIds: text('service_ids'),
  serviceNames: text('service_names'),
  profileRaw: text('profile_raw'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

// NOTE: `appointments` carries both the legacy 0001 columns (staff_id,
// starts_at, ends_at, total) and the slice-B columns (stylist_id, start_at,
// end_at, gross/discount/net, created_at_remote, updated_at_remote).
// Legacy columns remain writable for back-compat; the slice-D/F ingestion
// (ticket 0119) will populate the newer shape.
export const appointments = sqliteTable('appointments', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  appointmentId: text('appointment_id'),
  internalId: text('internal_id'),
  clientId: text('client_id'),
  staffId: text('staff_id'),           // legacy
  stylistId: text('stylist_id'),
  serviceId: text('service_id'),
  serviceNameRaw: text('service_name_raw'),
  serviceNameNorm: text('service_name_norm'),
  locationId: text('location_id'),
  startsAt: text('starts_at'),         // legacy
  endsAt: text('ends_at'),             // legacy
  startAt: text('start_at'),
  endAt: text('end_at'),
  status: text('status'),
  statusCode: text('status_code'),
  statusDescription: text('status_description'),
  categoryId: text('category_id'),
  categoryName: text('category_name'),
  durationMinutes: integer('duration_minutes'),
  clientName: text('client_name'),
  clientPhone: text('client_phone'),
  clientNotes: text('client_notes'),
  descriptionHtml: text('description_html'),
  descriptionText: text('description_text'),
  referrer: text('referrer'),
  promotionCode: text('promotion_code'),
  arrivalNote: text('arrival_note'),
  reminderSent: integer('reminder_sent', { mode: 'boolean' }),
  cancelledFlag: integer('cancelled_flag', { mode: 'boolean' }),
  onlineBooking: integer('online_booking', { mode: 'boolean' }),
  newClient: integer('new_client', { mode: 'boolean' }),
  isClass: integer('is_class', { mode: 'boolean' }),
  processingLength: integer('processing_length'),
  total: real('total'),                // legacy
  grossAmount: real('gross_amount'),
  discountAmount: real('discount_amount'),
  netAmount: real('net_amount'),
  createdAtRemote: text('created_at_remote'),
  createdBy: text('created_by'),
  updatedAtRemote: text('updated_at_remote'),
  updatedBy: text('updated_by'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  locationId: text('location_id'),
  privateId: text('private_id'),
  name: text('name'),
  categoryId: text('category_id'),
  categoryName: text('category_name'),
  durationMinutes: integer('duration_minutes'),
  lengthDisplay: text('length_display'),
  price: real('price'),
  priceDisplay: text('price_display'),
  description: text('description'),
  active: integer('active', { mode: 'boolean' }),
  staffPriceCount: integer('staff_price_count'),
  staffPriceOverrides: text('staff_price_overrides'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const promotions = sqliteTable('promotions', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  code: text('code'),
  name: text('name'),
  startAt: text('start_at'),
  endAt: text('end_at'),
  discountType: text('discount_type'),
  discountValue: real('discount_value'),
  locationId: text('location_id'),
  active: integer('active', { mode: 'boolean' }),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const promotionUsage = sqliteTable('promotion_usage', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  promotionId: text('promotion_id').notNull(),
  locationId: text('location_id'),
  appointmentId: text('appointment_id'),
  clientId: text('client_id'),
  usedAt: text('used_at'),
  discountAmount: real('discount_amount'),
  raw: text('raw'),
  syncedAt: text('synced_at').notNull(),
});

export const revenueFacts = sqliteTable('revenue_facts', {
  teamId: text('team_id').notNull(),
  locationId: text('location_id').notNull(),
  date: text('date').notNull(),
  grossAmount: real('gross_amount'),
  discountAmount: real('discount_amount'),
  netAmount: real('net_amount'),
  appointmentCount: integer('appointment_count'),
  uniqueClientCount: integer('unique_client_count'),
  lastUpdatedAt: text('last_updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.locationId, t.date] }),
}));

export const staffCashoutFacts = sqliteTable('staff_cashout_facts', {
  teamId: text('team_id').notNull(),
  date: text('date').notNull(),
  locationName: text('location_name').notNull(),
  staffName: text('staff_name').notNull(),
  locationId: text('location_id'),
  staffId: text('staff_id'),
  serviceRevenue: real('service_revenue'),
  productRevenue: real('product_revenue'),
  tips: real('tips'),
  totalRevenue: real('total_revenue'),
  lastUpdatedAt: text('last_updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.date, t.locationName, t.staffName] }),
}));

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
export type Stylist = typeof stylists.$inferSelect;
export type NewStylist = typeof stylists.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;
export type PromotionUsage = typeof promotionUsage.$inferSelect;
export type NewPromotionUsage = typeof promotionUsage.$inferInsert;
export type RevenueFact = typeof revenueFacts.$inferSelect;
export type NewRevenueFact = typeof revenueFacts.$inferInsert;
export type StaffCashoutFact = typeof staffCashoutFacts.$inferSelect;
export type NewStaffCashoutFact = typeof staffCashoutFacts.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;

/**
 * Resource names for the `sync_state` table. Kept here as a constant so new
 * resources get a single place to register.
 */
export const SYNC_RESOURCES = [
  'clients',
  'locations',
  'stylists',
  'appointments',
  'services',
  'promotions',
  'promotion_usage',
  'revenue_facts',
  'staff_cashout_facts',
] as const;
export type SyncResource = typeof SYNC_RESOURCES[number];
