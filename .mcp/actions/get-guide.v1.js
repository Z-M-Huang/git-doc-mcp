/**
 * Action: get-guide
 *
 * Fetches a specific documentation page from the wiki by topic slug.
 *
 * @param {object} input
 * @param {string} input.topic - Topic slug (e.g., "Getting-Started", "Manifest-Reference")
 * @param {object} ctx
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function getGuide(input, ctx) {
  const { topic } = input;
  const { fetch, getSecret, log } = ctx;

  const WIKI_BASE = 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp';
  const url = `${WIKI_BASE}/${encodeURIComponent(topic)}.md`;

  log('info', `Fetching guide: ${topic}`);

  // Add auth if available (for private wikis)
  const headers = {};
  const token = getSecret('GITHUB_TOKEN', url);
  if (token) {
    headers['Authorization'] = `token ${token}`;
    log('debug', 'Using authentication');
  }

  const response = await fetch(url, { headers: headers });

  if (!response.ok) {
    if (response.status === 404) {
      return {
        content: [{
          type: 'text',
          text: `Guide not found: "${topic}"\n\nUse \`list_topics\` to see available documentation topics.`,
        }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Failed to fetch guide "${topic}": ${response.status} ${response.statusText}`,
      }],
      isError: true,
    };
  }

  const content = response.text;

  log('info', `Fetched guide "${topic}" (${content.length} bytes)`);

  return {
    content: [{ type: 'text', text: content }],
  };
}
