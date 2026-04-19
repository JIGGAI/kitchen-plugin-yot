// Public shapes exposed by the plugin's HTTP surface.
// These are dashboard-facing and intentionally flatter than raw YOT payloads.

export interface YotConfig {
  apiKey: string;
  baseUrl?: string;  // defaults to https://api2.youreontime.com
}

export interface ClientRecord {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  lastVisitAt: string | null;
  totalVisits: number | null;
  totalSpend: number | null;
  syncedAt: string;
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

export interface SyncStateRecord {
  resource: string;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowCount: number | null;
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
