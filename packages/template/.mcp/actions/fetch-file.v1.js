/**
 * Action: fetch-file
 *
 * Fetches a file from a GitHub repository.
 *
 * @param {object} input - Tool input
 * @param {string} input.path - File path relative to repo root
 * @param {object} ctx - Execution context
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function fetchFile(input, ctx) {
  const { path } = input;
  const { fetch, getSecret, log, manifest } = ctx;

  log('info', `Fetching file: ${path}`);

  // Build GitHub API URL
  // Replace 'owner/repo' with your actual repository
  const owner = 'owner';
  const repo = 'repo';
  const branch = 'main';

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

  // Prepare headers
  const headers = {
    'Accept': 'application/vnd.github.v3.raw',
  };

  // Add auth if secret is available
  const token = getSecret('GITHUB_TOKEN', url);
  if (token) {
    headers['Authorization'] = `token ${token}`;
    log('debug', 'Using authentication');
  }

  // Fetch file
  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      return {
        content: [{ type: 'text', text: `File not found: ${path}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Failed to fetch file: ${response.status} ${response.statusText}` }],
      isError: true,
    };
  }

  const content = response.text;

  log('info', `Fetched ${content.length} bytes`);

  return {
    content: [{ type: 'text', text: content }],
  };
}