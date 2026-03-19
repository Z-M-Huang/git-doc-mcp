/**
 * Action: search-docs
 *
 * Searches documentation by keyword. Fetches the topic index, finds matching
 * entries, then fetches and returns the content of matching pages.
 *
 * @param {object} input
 * @param {string} input.query - Search keyword(s)
 * @param {number} [input.max_results] - Maximum results to return (default: 3)
 * @param {object} ctx
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function searchDocs(input, ctx) {
  var query = input.query;
  var maxResults = Math.max(1, Math.min(input.max_results || 3, 5));
  var fetch = ctx.fetch;
  var log = ctx.log;
  var getSecret = ctx.getSecret;

  var WIKI_BASE = 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp';
  var indexUrl = WIKI_BASE + '/Topic-Index.md';

  log('info', 'Searching docs for: ' + query);

  // Fetch the topic index
  var indexHeaders = {};
  var indexToken = getSecret('GITHUB_TOKEN', indexUrl);
  if (indexToken) {
    indexHeaders['Authorization'] = 'token ' + indexToken;
  }

  var indexResponse = await fetch(indexUrl, { headers: indexHeaders });
  if (!indexResponse.ok) {
    return {
      content: [{ type: 'text', text: 'Failed to fetch topic index: ' + indexResponse.status }],
      isError: true,
    };
  }

  var body = indexResponse.text;

  // Parse machine-readable index
  var startMarker = '<!-- MACHINE_INDEX_START';
  var endMarker = 'MACHINE_INDEX_END -->';
  var startIdx = body.indexOf(startMarker);
  var endIdx = body.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    return {
      content: [{ type: 'text', text: 'Topic index is missing machine-readable section.' }],
      isError: true,
    };
  }

  var jsonStart = body.indexOf('\n', startIdx) + 1;
  var jsonStr = body.slice(jsonStart, endIdx).trim();

  var topics;
  try {
    topics = JSON.parse(jsonStr);
  } catch (e) {
    return {
      content: [{ type: 'text', text: 'Failed to parse topic index.' }],
      isError: true,
    };
  }

  // Score each topic by keyword matches in title, description, and tags
  var queryLower = query.toLowerCase();
  var queryTerms = queryLower.split(/\s+/);

  var scored = topics.map(function (t) {
    var searchText = (t.title + ' ' + t.description + ' ' + t.tags.join(' ')).toLowerCase();
    var score = 0;
    for (var i = 0; i < queryTerms.length; i++) {
      if (searchText.indexOf(queryTerms[i]) !== -1) {
        score += 1;
      }
      // Bonus for exact title match
      if (t.title.toLowerCase().indexOf(queryTerms[i]) !== -1) {
        score += 2;
      }
    }
    return { topic: t, score: score };
  });

  // Filter and sort by score
  var matches = scored
    .filter(function (s) { return s.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, maxResults);

  if (matches.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No documentation found matching "' + query + '".\n\nUse `list_topics` to see all available topics.',
      }],
    };
  }

  log('info', 'Found ' + matches.length + ' matching topics, fetching content');

  // Fetch content for each matching topic
  var results = [];
  for (var i = 0; i < matches.length; i++) {
    var t = matches[i].topic;
    var pageUrl = WIKI_BASE + '/' + encodeURIComponent(t.slug) + '.md';

    var headers = {};
    var token = getSecret('GITHUB_TOKEN', pageUrl);
    if (token) {
      headers['Authorization'] = 'token ' + token;
    }

    var pageResponse = await fetch(pageUrl, { headers: headers });

    if (pageResponse.ok) {
      results.push({
        type: 'text',
        text: '---\n# ' + t.title + ' (slug: ' + t.slug + ')\n\n' + pageResponse.text,
      });
    } else {
      results.push({
        type: 'text',
        text: '---\n# ' + t.title + ' (slug: ' + t.slug + ')\n\n*Failed to load content: ' + pageResponse.status + '*',
      });
    }
  }

  // Prepend a summary
  results.unshift({
    type: 'text',
    text: 'Found ' + matches.length + ' result(s) for "' + query + '":',
  });

  // Append next steps
  results.push({
    type: 'text',
    text: '---\n**Next steps:**\n- Call `get_guide` with a specific slug for the full guide\n- Call `get_example` to see a complete working implementation\n- Call `get_action_api` if the answer involves writing action scripts',
  });

  return { content: results };
}
