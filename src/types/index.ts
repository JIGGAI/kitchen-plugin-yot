// Public shapes exposed by the plugin's HTTP surface.
// These are dashboard-facing and intentionally flatter than raw YOT payloads.

export interface YotConfig {
  apiKey: string;
  baseUrl?: string;  // defaults to https://api2.youreontime.com
}

export interface ClientRecord {
  id: string;
  privateId: string | null;
  firstName: string | null;
  otherName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  homePhone: string | null;
  mobilePhone: string | null;
  businessPhone: string | null;
  birthday: string | null;
  gender: string | null;
  active: boolean | null;
  street: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  sourceLocationId: string | null;
  tags: string[];
  lastVisitAt: string | null;
  totalVisits: number | null;
  totalSpend: number | null;
  syncedAt: string;
}

export interface ClientDetailRecord extends ClientRecord {
  address: string | null;
  createdAtRemote: string | null;
  relationships?: RelationshipSummary | null;
  raw: unknown | null;
}

export interface LocationRecord {
  id: string;
  name: string | null;
  emailAddress: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  canBookOnline: boolean | null;
  active: boolean | null;
  street: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  syncedAt: string;
}

export interface LocationDetailRecord extends LocationRecord {
  relationships?: RelationshipSummary | null;
  raw: unknown | null;
}

export interface StylistRecord {
  id: string;
  stylistId: string | null;
  locationId: string | null;
  privateId: string | null;
  givenName: string | null;
  surname: string | null;
  fullName: string | null;
  initial: string | null;
  jobTitle: string | null;
  jobDescription: string | null;
  emailAddress: string | null;
  mobilePhone: string | null;
  active: boolean | null;
  sourceLocationId: string | null;
  serviceCategoryNames: string[];
  serviceIds: string[];
  serviceNames: string[];
  syncedAt: string;
}

export interface StylistDetailRecord extends StylistRecord {
  relationships?: RelationshipSummary | null;
  profileRaw: unknown | null;
  raw: unknown | null;
}

export interface RelationshipEntityLink {
  id: string;
  label: string;
  appointmentCount: number;
  lastAppointmentAt: string | null;
}

export interface RevenueSummary {
  available: boolean;
  source: 'revenue_facts' | 'appointments' | 'none';
  grossAmount: number | null;
  discountAmount: number | null;
  netAmount: number | null;
  appointmentCount: number;
  lastUpdatedAt: string | null;
  note?: string | null;
}

export interface RevenueTotalsRecord {
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  appointmentCount: number;
  uniqueClientCount: number;
  rowCount: number;
  locationCount: number;
  lastUpdatedAt: string | null;
}

export interface RevenuePeriodRecord {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  label: string;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  appointmentCount: number;
  uniqueClientCount: number;
  locationCount: number;
  dayCount: number;
  lastUpdatedAt: string | null;
}

export interface RevenueLocationRollupRecord {
  locationId: string;
  locationName: string | null;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  appointmentCount: number;
  uniqueClientCount: number;
  dayCount: number;
  lastUpdatedAt: string | null;
}

export interface RevenueQueryResponse {
  grain: 'day' | 'week' | 'month';
  locationId: string | null;
  startDate: string | null;
  endDate: string | null;
  availableRange: {
    minDate: string | null;
    maxDate: string | null;
  };
  totals: RevenueTotalsRecord;
  byPeriod: RevenuePeriodRecord[];
  byLocation: RevenueLocationRollupRecord[];
}

export interface RelationshipSummary {
  appointmentCount: number;
  uniqueClientCount: number;
  uniqueStylistCount: number;
  uniqueLocationCount: number;
  lastAppointmentAt: string | null;
  recentAppointmentCount: number;
  clients: RelationshipEntityLink[];
  stylists: RelationshipEntityLink[];
  locations: RelationshipEntityLink[];
  revenue?: RevenueSummary | null;
}

export interface AppointmentRecord {
  id: string;
  appointmentId: string | null;
  internalId: string | null;
  locationId: string | null;
  locationName: string | null;
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  staffId: string | null;
  stylistId: string | null;
  stylistName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  serviceNameRaw: string | null;
  serviceCategoryName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  durationMinutes: number | null;
  status: string | null;
  statusCode: string | null;
  statusDescription: string | null;
  categoryId: string | null;
  categoryName: string | null;
  descriptionText: string | null;
  clientNotes: string | null;
  total: number | null;
  createdAtRemote: string | null;
  updatedAtRemote: string | null;
  syncedAt: string;
}

export interface AppointmentDetailRecord extends AppointmentRecord {
  serviceNameNorm: string | null;
  descriptionHtml: string | null;
  referrer: string | null;
  promotionCode: string | null;
  arrivalNote: string | null;
  reminderSent: boolean | null;
  cancelledFlag: boolean | null;
  onlineBooking: boolean | null;
  newClient: boolean | null;
  isClass: boolean | null;
  processingLength: number | null;
  grossAmount: number | null;
  discountAmount: number | null;
  netAmount: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  raw: unknown | null;
}

export interface ServiceRecord {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  name: string | null;
  categoryId: string | null;
  categoryName: string | null;
  durationMinutes: number | null;
  lengthDisplay: string | null;
  price: number | null;
  priceDisplay: string | null;
  active: boolean | null;
  staffPriceCount: number | null;
  syncedAt: string;
}

export interface ServiceDetailRecord extends ServiceRecord {
  localId: string | null;
  description: string | null;
  staffPriceOverrides: unknown | null;
  raw: unknown | null;
}

export interface SyncStateRecord {
  resource: string;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowCount: number | null;
}

export interface SyncRunRecord {
  id: string;
  resource: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  rowsSeen: number | null;
  rowsWritten: number | null;
  pageCount: number | null;
  notes: string | null;
  error: string | null;
}

export interface ExportManifestRecord {
  teamId: string;
  exportedAt: string;
  directory: string;
  files: Array<{
    name: string;
    rows: number;
  }>;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}
