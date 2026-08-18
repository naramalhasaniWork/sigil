#!/usr/bin/env node
/**
 * Mints an MCP token for one person.
 *
 *   node scripts/mcp-token.mjs jonas
 *
 * Prints the line to add to SIGIL_MCP_TOKENS and the token to hand over. The
 * token is random and is never stored here — if it is lost, mint another and
 * replace the entry. Revoking someone is deleting their entry and redeploying.
 */
import { randomBytes } from 'node:crypto';

const user = (process.argv[2] ?? '').trim();
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(user)) {
  console.error('Usage: node scripts/mcp-token.mjs <name>');
  console.error('  <name> is the storage owner: letters, digits, - and _ only.');
  process.exit(1);
}

// 32 bytes base64url. Comfortably past guessing, and no characters that need
// escaping in an environment variable or a JSON config file.
const token = `tok_${randomBytes(32).toString('base64url')}`;

console.log(`\n  Person:  ${user}`);
console.log(`  Token:   ${token}\n`);
console.log('  Append to SIGIL_MCP_TOKENS (comma-separated, no spaces needed):\n');
console.log(`    ${user}=${token}\n`);
console.log('  They add this to their MCP client config:\n');
console.log(JSON.stringify({
  mcpServers: {
    sigil: {
      type: 'http',
      url: 'https://<your-sigil-host>/api/mcp',
      headers: { Authorization: `Bearer ${token}` },
    },
  },
}, null, 2));
console.log('\n  Their arrangements are private to them. Sharing the token shares the songs.\n');
