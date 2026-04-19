// Minimal KitchenPluginContext type so this plugin compiles standalone.
// ClawKitchen passes this object when invoking handleRequest().
export interface KitchenPluginContext {
  db: unknown;
  teamDir: string;
  encrypt(data: unknown): string;
  decrypt(blob: string): unknown;
  registerCron(opts: { schedule: string; handler: string }): void;
  getConfig(key: string): string | null;
  setConfig(key: string, value: string): void;
}
