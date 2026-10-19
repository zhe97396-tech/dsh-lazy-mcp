// One-off probe: does a configured MCP server actually expose *resources*
// (not just tools)? DSH mounts @deepseek-ai/dsh-mcp-resources, but that package
// only lights up its three shared tools when a @deepseek-ai/dsh-mcp-client row
// registers servers in the caller's scope. lazy-mcp does not register through
// that registry, so this probe answers: how much is actually unreachable?
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const targets = [
  { name: 'markitdown', command: 'python', args: ['-m', 'markitdown_mcp'] },
]

for (const t of targets) {
  const transport = new StdioClientTransport({ command: t.command, args: t.args, stderr: 'ignore' })
  const client = new Client({ name: 'cap-probe', version: '0.0.1' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const caps = client.getServerCapabilities() ?? {}
    console.log(`=== ${t.name}`)
    console.log(`  capabilities : ${JSON.stringify(caps)}`)
    console.log(`  serverInfo   : ${JSON.stringify(client.getServerVersion() ?? null)}`)
    console.log(`  tools        : ${caps.tools ? 'yes' : 'no'}`)
    console.log(`  resources    : ${caps.resources ? 'yes' : 'NO'}`)
    console.log(`  prompts      : ${caps.prompts ? 'yes' : 'no'}`)
    if (caps.resources) {
      const list = await client.listResources(undefined, { cacheMode: 'refresh' })
      console.log(`  resource list: ${JSON.stringify(list.resources?.map((r) => r.uri) ?? [])}`)
      const tpl = await client.listResourceTemplates(undefined, { cacheMode: 'refresh' })
      console.log(`  templates    : ${JSON.stringify(tpl.resourceTemplates?.map((r) => r.uriTemplate) ?? [])}`)
    }
    if (caps.prompts) {
      const p = await client.listPrompts(undefined, { cacheMode: 'refresh' })
      console.log(`  prompt list  : ${JSON.stringify(p.prompts?.map((r) => r.name) ?? [])}`)
    }
  } catch (err) {
    console.log(`=== ${t.name}: FAILED — ${err?.message ?? err}`)
  } finally {
    await client.close().catch(() => {})
  }
}
