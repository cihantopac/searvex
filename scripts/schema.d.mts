export declare const SCHEMAS: Array<{ name: string; type: string; title: string; description: string }>;
export declare function generateSchemas(options?: { strict?: boolean }): { version: string; schemas: Record<string, Record<string, unknown>> };
export declare function schemaFile(name: string): string;
export declare function serialise(schema: unknown): string;
