#!/usr/bin/env node
// REQ-087: finite Agent tools; REQ-088–REQ-092 command composition.
import { parseArgs } from 'node:util';
import { Auth } from './auth.js';
import { object, serverURL, strings, subscription, tags } from './contracts.js';
import { failure } from './errors.js';
import { sync } from './materials.js';
import { definitions, describe, validateInput, type Parameter, type ToolName } from './tools.js';
import { WorkspaceStore } from './workspace.js';

const help = `sprout 0.6.0 — personal Server Agent CLI (Node >=22.14, macOS/Linux)

  sprout describe --json
  sprout call <tool> --input <JSON object> --json
  sprout login --server URL --workspace ROOT [--json]
  sprout logout --server URL --workspace ROOT [--json]
  sprout tags --server URL --workspace ROOT [--json]
  sprout init --server URL --workspace PATH --tags TAG[,TAG] --materials RELATIVE_PATH [--rebuild] [--json]
  sprout status --workspace PATH [--json]
  sprout sync --workspace PATH [--json]
  sprout set-tags --workspace PATH --tags TAG[,TAG] [--backfill yes|no] [--json]
  sprout --help | --version

Agent supplies tags and materials from workspace rules. New tags require explicit backfill consent.
Never pass tokens as arguments. Credentials: private ~/.config/sprout-cli/workspaces/ID or SPROUT_CLI_CONFIG_DIR/workspaces/ID.
`;
export async function main(argv: string[], signal: AbortSignal): Promise<number> {
  let command = argv[0] ?? 'help'; let options: Record<string, unknown> = {};
  const machine = argv.includes('--json') || command === 'describe' || command === 'call';
  const output = (value: unknown) => console.log(machine ? JSON.stringify({ schema_version: 1, ok: true, command, data: value }) : typeof value === 'string' ? value : JSON.stringify(value));
  const report = (error: unknown, argumentsInvalid = false) => {
    const problem = failure(error, argumentsInvalid, signal.aborted);
    if (machine) console.log(JSON.stringify({ schema_version: 1, ok: false, command, error: problem }));
    else console.error(problem.message);
    return signal.aborted ? 130 : argumentsInvalid ? 2 : 1;
  };
  try {
    if (!argv.length || ['--help', '-h', '--version'].includes(command)) {
      if (argv.slice(1).some((argument) => argument !== '--json')) throw new Error('help/version accepts only --json');
      output(command === '--version' ? machine ? { version: '0.6.0' } : '0.6.0' : machine ? { help } : help); return 0;
    }
    if (command === 'describe') {
      if (argv.slice(1).some((arg) => arg !== '--json')) throw new Error('describe accepts only --json');
      output(describe()); return 0;
    }
    if (command === 'call') {
      command = argv[1] ?? '';
      const parsed = parseArgs({ args: argv.slice(2), strict: true, options: { input: { type: 'string' }, json: { type: 'boolean' } } });
      if (!parsed.values.input || parsed.values.input.length > 16384) throw new Error('call requires --input with a JSON object (max 16 KiB)');
      try { options = object(JSON.parse(parsed.values.input), 'tool input'); } catch { throw new Error('tool input must be a valid JSON object'); }
    } else {
      if (!Object.hasOwn(definitions, command)) throw new Error('unknown tool; use describe --json');
      if (argv.slice(1).some((arg) => ['--help', '-h'].includes(arg))) { output(machine ? { tool: describe().tools.find((tool) => tool.name === command) } : JSON.stringify(describe().tools.find((tool) => tool.name === command), null, 2)); return 0; }
      const definition = definitions[command as ToolName];
      const parameters = Object.entries(definition.properties).map(([key, property]) => [key, { type: (property as Parameter).type === 'boolean' ? 'boolean' : 'string' }] as const);
      const parsed = parseArgs({ args: argv.slice(1), strict: true, options: { ...Object.fromEntries(parameters), json: { type: 'boolean' } }, tokens: true });
      const seen = new Set<string>();
      for (const token of parsed.tokens) if (token.kind === 'option') { if (seen.has(token.name)) throw new Error(`duplicate --${token.name}`); seen.add(token.name); }
      options = { ...parsed.values }; delete options.json;
      if (typeof options.tags === 'string') options.tags = options.tags.split(',');
    }
    if (!Object.hasOwn(definitions, command)) throw new Error('unknown tool; use describe --json');
    validateInput(command as ToolName, options);
    if (options.server) options.server = serverURL(options.server);
    if (options.tags) options.tags = tags(options.tags);
  } catch (error) { return report(error, true); }
  try {
    const store = new WorkspaceStore(options.workspace as string);
    await store.run(async () => {
      const state = ['login', 'logout', 'tags', 'init'].includes(command) ? undefined : store.read();
      const auth = new Auth(options.server as string ?? state!.server, signal, store.identity());
      if (command === 'login') {
        await auth.run(() => auth.login((event) => {
          console.error(machine ? JSON.stringify(event) : `Open ${event.verification_uri}\nVerify code ${event.user_code} in your connected App, then approve.`);
        }));
        output(machine ? { server: auth.server, authenticated: true } : 'Logged in for this workspace.');
        return;
      }
      if (command === 'logout') {
        await auth.run(() => auth.logout());
        output(machine ? { server: auth.server, authenticated: false } : 'Logged out; this workspace Server grant revoked.');
        return;
      }
      const client = auth.business();
      if (command === 'tags') {
        const result = object(await client.request('/api/v1/tags'), 'tag response');
        output({ tags: strings(result.tags, 'tags') });
      }
      if (command === 'init') {
        await auth.access();
        const initialized = await store.init(client, options.tags as string[], options.materials as string, options.rebuild === true);
        output({ subscription_id: initialized.subscription_id, tags: initialized.tags, materials: initialized.materials });
      }
      if (command === 'status') output(subscription(await client.request(store.endpoint(state!))));
      if (command === 'sync') {
        const result = await sync(client, store, state!);
        output(machine ? result : `Sync complete (${result.pages_acknowledged} pages acknowledged).`);
      }
      if (command === 'set-tags') {
        await store.changeTags(client, state!, options.tags as string[], options.backfill as string | undefined);
        output(machine ? { subscription_id: state!.subscription_id, tags: state!.tags } : 'Subscription tags saved.');
      }
    });
    return 0;
  } catch (error) { return report(error); }
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
process.exitCode = await main(process.argv.slice(2), controller.signal);
