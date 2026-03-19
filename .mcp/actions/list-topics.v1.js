/**
 * Action: list-topics
 *
 * Fetches the Topic-Index page from the wiki and returns available
 * documentation topics. Optionally filters by tag.
 *
 * @param {object} input
 * @param {string} [input.tag] - Filter topics by tag (e.g., "reference", "quickstart")
 * @param {object} ctx
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function listTopics(input, ctx) {
  const { tag } = input;
  const { fetch, getSecret, log } = ctx;

  const WIKI_BASE = 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp';
  const indexUrl = `${WIKI_BASE}/Topic-Index.md`;

  log('info', `Fetching topic index${tag ? ` (filter: ${tag})` : ''}`);

  var headers = {};
  var token = getSecret('GITHUB_TOKEN', indexUrl);
  if (token) {
    headers['Authorization'] = 'token ' + token;
    log('debug', 'Using authentication');
  }

  const response = await fetch(indexUrl, { headers: headers });

  if (!response.ok) {
    return {
      content: [{ type: 'text', text: `Failed to fetch topic index: ${response.status} ${response.statusText}` }],
      isError: true,
    };
  }

  const body = response.text;

  // Extract machine-readable JSON index between markers
  const startMarker = '<!-- MACHINE_INDEX_START';
  const endMarker = 'MACHINE_INDEX_END -->';
  const startIdx = body.indexOf(startMarker);
  const endIdx = body.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    return {
      content: [{ type: 'text', text: 'Topic index is missing machine-readable section.' }],
      isError: true,
    };
  }

  // Extract JSON between the markers
  const jsonStart = body.indexOf('\n', startIdx) + 1;
  const jsonStr = body.slice(jsonStart, endIdx).trim();

  let topics;
  try {
    topics = JSON.parse(jsonStr);
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Failed to parse topic index: ${e.message}` }],
      isError: true,
    };
  }

  // Filter by tag if provided
  if (tag) {
    const normalizedTag = tag.toLowerCase().trim();
    topics = topics.filter(function (t) {
      return t.tags.some(function (topicTag) {
        return topicTag.toLowerCase().trim() === normalizedTag;
      });
    });
  }

  if (topics.length === 0) {
    const msg = tag
      ? `No topics found with tag "${tag}". Try: quickstart, reference, security, examples, actions, tools, prompts, resources, secrets, cli`
      : 'No topics found in the index.';
    return {
      content: [{ type: 'text', text: msg }],
    };
  }

  // Format output
  const lines = topics.map(function (t) {
    return `## ${t.title}\n- **Slug**: \`${t.slug}\`\n- **Tags**: ${t.tags.join(', ')}\n- **Description**: ${t.description}`;
  });

  const header = tag
    ? `Found ${topics.length} topic(s) matching tag "${tag}":`
    : `Available documentation topics (${topics.length}):`;

  log('info', `Returning ${topics.length} topics`);

  return {
    content: [{
      type: 'text',
      text: `${header}\n\n${lines.join('\n\n')}\n\n---\n**Next steps:**\n- Call \`get_guide\` with any slug above to read the full guide\n- Call \`search_docs\` with keywords to find something specific\n- Call \`get_example\` for complete working examples`,
    }],
  };
}
