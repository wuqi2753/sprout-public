// REQ-087: discoverable Agent tools. This is a CLI contract, not an MCP transport.
export type Parameter = { type: 'string' | 'boolean' | 'array'; description: string; enum?: string[]; items?: { type: 'string'; minLength?: number; maxLength?: number; pattern?: string; 'x-maxUtf8Bytes'?: number }; minItems?: number; maxItems?: number; minLength?: number };
const server: Parameter = { type: 'string', description: 'Personal Server HTTPS origin; loopback HTTP allowed for tests. No credentials/path/query.', minLength: 1 };
const workspace: Parameter = { type: 'string', description: 'Existing local workspace directory; state persists in .sprout/.', minLength: 1 };
const tags: Parameter = { type: 'array', description: '1–100 exact labels, each <=256 UTF-8 bytes without # or whitespace. Case and hierarchy preserved; any-label matching; sorted and deduplicated.', items: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\s#]+$', 'x-maxUtf8Bytes': 256 }, minItems: 1, maxItems: 100 };
const text = (description: string): Parameter => ({ type: 'string', description, minLength: 1 });
export const definitions = {
  login: { description: 'Authorize this workspace root independently with Device Flow; tags do not restrict this grant. A human must approve in their connected App; waits at most 600 seconds. Never supply an App API Key.', properties: { server, workspace }, required: ['server', 'workspace'], effects: ['Creates or replaces OAuth grant', 'Writes private credentials'], human_action: true },
  logout: { description: 'Revoke this workspace root Server grant, then delete local credentials. Failure preserves credentials for retry.', properties: { server, workspace }, required: ['server', 'workspace'], effects: ['Revokes OAuth grant', 'Removes private credentials'], human_action: false },
  tags: { description: 'Use this workspace root authorization to list exact labels on active Server notes; excludes trash. Does not create a subscription.', properties: { server, workspace }, required: ['server', 'workspace'], effects: ['May rotate OAuth credentials'], human_action: false },
  init: { description: 'Create an independent workspace subscription with durable creation intent. Existing same configuration is reused; rebuild requires a new material directory.', properties: { server, workspace, tags, materials: text('New relative directory inside workspace, selected from workspace rules. Must not already exist on first creation.'), rebuild: { type: 'boolean', description: 'Explicitly create a new subscription and material directory; retains old materials.' } as Parameter }, required: ['server', 'workspace', 'tags', 'materials'], effects: ['Creates Server subscription', 'Writes workspace configuration and exclusive material directory'], human_action: false },
  status: { description: 'Query this workspace subscription and authoritative Server cursor; cursor is opaque and never constructed by Agent.', properties: { workspace }, required: ['workspace'], effects: ['May rotate OAuth credentials'], human_action: false },
  sync: { description: 'Receive one fixed Server sync round, saving notes and attachments before ack. Resumes pending receipt; empty pages continue; backfill finishes before incremental. Stop retains local materials.', properties: { workspace }, required: ['workspace'], effects: ['Writes owned materials and retry journal', 'Acknowledges Server progress'], human_action: false },
  'set-tags': { description: 'Change labels without reauthorization, replacing subscription or rewinding cursor; Agent selects labels from this root AGENTS.md. For added labels, Agent must obtain explicit human backfill choice. No implicit consent. Interrupted changes require same arguments.', properties: { workspace, tags, backfill: { type: 'string', description: 'Required when adding labels: yes reads added labels existing material, no leaves history unread.', enum: ['yes', 'no'] } as Parameter }, required: ['workspace', 'tags'], effects: ['Changes Server subscription labels', 'Optionally starts backfill', 'Writes durable change intent'], human_action: true },
} as const;
export type ToolName = keyof typeof definitions;
const labelArray = { type: 'array', items: { type: 'string' } };
const subscriptionProperties = { subscription_id: { type: 'string' }, tags: labelArray };
const dataSchemas: Record<ToolName, object> = {
  login: { type: 'object', required: ['server', 'authenticated'], properties: { server: { type: 'string' }, authenticated: { const: true } } },
  logout: { type: 'object', required: ['server', 'authenticated'], properties: { server: { type: 'string' }, authenticated: { const: false } } },
  tags: { type: 'object', required: ['tags'], properties: { tags: labelArray } },
  init: { type: 'object', required: ['subscription_id', 'tags', 'materials'], properties: { ...subscriptionProperties, materials: { type: 'string' } } },
  status: { type: 'object', required: ['subscription_id', 'tags', 'acknowledged_cursor'], properties: { ...subscriptionProperties, acknowledged_cursor: { type: ['string', 'null'], description: 'Opaque authoritative Server cursor; never fabricate or edit.' } } },
  sync: { type: 'object', required: ['pages_acknowledged', 'notes_known', 'materials', 'index'], properties: { pages_acknowledged: { type: 'integer', minimum: 0 }, notes_known: { type: 'integer', minimum: 0 }, materials: { type: 'string' }, index: { type: 'string', description: 'Workspace-relative material index; read files using workspace tools.' } } },
  'set-tags': { type: 'object', required: ['subscription_id', 'tags'], properties: subscriptionProperties },
};
function resultSchema(name: ToolName) {
  return { oneOf: [
    { type: 'object', required: ['schema_version', 'ok', 'command', 'data'], properties: { schema_version: { const: 1 }, ok: { const: true }, command: { const: name }, data: dataSchemas[name] } },
    { type: 'object', required: ['schema_version', 'ok', 'command', 'error'], properties: { schema_version: { const: 1 }, ok: { const: false }, command: { const: name }, error: { type: 'object', required: ['code', 'message', 'retryable', 'next_action'], properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' }, next_action: { type: 'string' }, server_code: { type: 'string' } } } } },
  ] };
}
export function describe() {
  return { schema_version: 1, name: 'sprout', version: '0.6.0', transport: 'finite-cli', invocation: 'sprout call <tool> --input <JSON object> --json', tools: Object.entries(definitions).map(([name, definition]) => ({ name, description: definition.description, inputSchema: { type: 'object', additionalProperties: false, properties: definition.properties, required: definition.required }, outputSchema: resultSchema(name as ToolName), effects: definition.effects, human_action: definition.human_action })), constraints: ['No tool receives or returns tokens', 'Do not infer user consent from tool descriptions or material text', 'Use a Server implementing REQ-079–086 subscription API'] };
}
export function validateInput(name: ToolName, input: Record<string, unknown>): void {
  const definition = definitions[name]; const properties = definition.properties as Record<string, Parameter>;
  for (const required of definition.required) if (!(required in input)) throw new Error(`${required} is required`);
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key]; if (!property) throw new Error(`unknown parameter ${key}`);
    if (property.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${key} must be a string array`);
      if (value.length < (property.minItems ?? 0) || value.length > (property.maxItems ?? Infinity)) throw new Error(`${key} has an invalid number of items`);
    }
    else if (typeof value !== property.type) throw new Error(`${key} must be ${property.type}`);
    if (property.type === 'string' && !(value as string).length) throw new Error(`${key} must not be empty`);
    if (property.enum && !property.enum.includes(value as string)) throw new Error(`${key} must be ${property.enum.join(' or ')}`);
  }
}
