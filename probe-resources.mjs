// One-off probe: what does the MCP `server-everything` fixture expose on the
// RESOURCE side, and what exactly do the SDK's list/read calls return?
//
// This answers two questions at once before any gateway code is written:
//   1. is there a local fixture with resources, so the new tools can be tested
//      against a real server rather than a stub?
//   2. what is the exact result shape (field names, blob vs text, pagination)?
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
  stderr: 'ignore',
})
const client = new Client({ name: 'resource-probe', version: '0.0.1' }, { capabilities: {} })

try {
  await client.connect(transport)
  const caps = client.getServerCapabilities() ?? {}
  console.log('capabilities:', JSON.stringify(caps))

  if (caps.resources) {
    const listed = await client.listResources(undefined, { cacheMode: 'refresh' })
    console.log('\nlistResources keys:', Object.keys(listed).join(', '))
    console.log('resource count:', listed.resources?.length ?? 0)
    console.log('first resource:', JSON.stringify(listed.resources?.[0] ?? null))
    console.log('all uris:', JSON.stringify((listed.resources ?? []).map((r) => r.uri)))

    const templates = await client.listResourceTemplates(undefined, { cacheMode: 'refresh' })
    console.log('\nlistResourceTemplates keys:', Object.keys(templates).join(', '))
    console.log('template count:', templates.resourceTemplates?.length ?? 0)
    console.log('first template:', JSON.stringify(templates.resourceTemplates?.[0] ?? null))

    const target = listed.resources?.[0]?.uri
    if (target !== undefined) {
      const read = await client.readResource({ uri: target }, { cacheMode: 'refresh' })
      console.log('\nreadResource keys:', Object.keys(read).join(', '))
      console.log('contents count:', read.contents?.length ?? 0)
      const first = read.contents?.[0]
      console.log('first content keys:', first === undefined ? '(none)' : Object.keys(first).join(', '))
      console.log('first content (text truncated):', JSON.stringify({
        uri: first?.uri,
        mimeType: first?.mimeType,
        text: typeof first?.text === 'string' ? `${first.text.slice(0, 120)}…` : undefined,
        blob: typeof first?.blob === 'string' ? `<${first.blob.length} base64 chars>` : undefined,
      }))
    }
  } else {
    console.log('\n(server advertises no resources capability)')
  }
} catch (error) {
  console.log('PROBE FAILED:', error?.message ?? error)
} finally {
  await client.close().catch(() => {})
}
