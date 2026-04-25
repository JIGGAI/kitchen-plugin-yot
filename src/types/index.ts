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
  emailAddress: string | null;
  mobilePhone: string | null;
  active: boolean | null;
  sourceLocationId: string | null;
  syncedAt: string;
}

export interface StylistDetailRecord extends StylistRecord {
  raw: unknown | null;
}

export interface AppointmentRecord {
  id: string;
  clientId: string | null;
  staffId: string | null;
  serviceId: string | null;
  locationId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string | null;
  total: number | null;
  syncedAt: string;
}

export interface ServiceRecord {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  name: string | null;
  durationMinutes: number | null;
  price: number | null;
  active: boolean | null;
  syncedAt: string;
}

export interface ServiceDetailRecord extends ServiceRecord {
  localId: string | null;
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
