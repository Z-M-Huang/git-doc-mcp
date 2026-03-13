/**
 * Action: search-code
 *
 * Searches for code patterns in a GitHub repository using GitHub Code Search API.
 *
 * @param {object} input - Tool input
 * @param {string} input.query - Search query
 * @param {string} [input.language] - Filter by programming language
 * @param {object} ctx - Execution context
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function searchCode(input, ctx) {
  const { query, language } = input;
  const { fetch, getSecret, log, manifest } = ctx;

  log('info', `Searching for: ${query}${language ? ` in ${language}` : ''}`);

  // Replace 'owner/repo' with your actual repository
  const owner = 'owner';
  const repo = 'repo';

  // Build search query
  let searchQuery = `${query} repo:${owner}/${repo}`;
  if (language) {
    searchQuery += ` language:${language}`;
  }

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}`;

  // Prepare headers
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
  };

  // Add auth if secret is available
  const token = getSecret('GITHUB_TOKEN', url);
  if (token) {
    headers['Authorization'] = `token ${token}`;
    log('debug', 'Using authentication');
  }

  // Search
  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 403) {
      return {
        content: [{
          type: 'text',
          text: 'GitHub API rate limit exceeded. Please provide a GITHUB_TOKEN for higher limits.',
        }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Search failed: ${response.status} ${response.statusText}` }],
      isError: true,
    };
  }

  const data = response.json();

  if (!data.items || data.items.length === 0) {
    return {
      content: [{ type: 'text', text: `No results found for: ${query}` }],
    };
  }

  // Format results
  const results = data.items.slice(0, 10).map((item) => {
    return {
      file: item.path,
      repository: item.repository.full_name,
      url: item.html_url,
    };
  });

  const text = results.map((r, i) => `${i + 1}. ${r.file}\n   ${r.url}`).join('\n\n');

  log('info', `Found ${data.total_count} results, showing ${results.length}`);

  return {
    content: [{
      type: 'text',
      text: `Found ${data.total_count} results:\n\n${text}`,
    }],
  };
}