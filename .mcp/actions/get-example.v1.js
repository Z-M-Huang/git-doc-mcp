/**
 * Action: get-example
 *
 * Fetches a specific code example from the Examples wiki page.
 * Examples are delimited by level-2 headings with an "example:" prefix.
 *
 * @param {object} input
 * @param {string} input.name - Example name (e.g., "github-repo-tools", "documentation-server")
 * @param {object} ctx
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function getExample(input, ctx) {
  var name = input.name;
  var fetch = ctx.fetch;
  var log = ctx.log;
  var getSecret = ctx.getSecret;

  var WIKI_BASE = 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp';
  var url = WIKI_BASE + '/Examples.md';

  log('info', 'Fetching example: ' + name);

  var headers = {};
  var token = getSecret('GITHUB_TOKEN', url);
  if (token) {
    headers['Authorization'] = 'token ' + token;
  }

  var response = await fetch(url, { headers: headers });

  if (!response.ok) {
    return {
      content: [{ type: 'text', text: 'Failed to fetch examples page: ' + response.status }],
      isError: true,
    };
  }

  var body = response.text;

  // Split by level-2 headings that start with "## Example: "
  var sections = body.split(/(?=^## Example: )/m);
  var nameLower = name.toLowerCase().trim();

  // Find matching section
  var match = null;
  var availableNames = [];

  for (var i = 0; i < sections.length; i++) {
    var section = sections[i].trim();
    if (!section.startsWith('## Example: ')) continue;

    // Extract example name from heading: "## Example: GitHub Repo Tools" -> "github-repo-tools"
    var headingEnd = section.indexOf('\n');
    var heading = section.slice('## Example: '.length, headingEnd === -1 ? undefined : headingEnd).trim();
    var slug = heading.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    availableNames.push(slug);

    if (slug === nameLower || heading.toLowerCase() === nameLower) {
      match = section;
    }
  }

  if (!match) {
    var available = availableNames.length > 0
      ? '\n\nAvailable examples:\n' + availableNames.map(function (n) { return '- `' + n + '`'; }).join('\n')
      : '\n\nNo examples found on the page.';

    return {
      content: [{
        type: 'text',
        text: 'Example not found: "' + name + '"' + available,
      }],
      isError: true,
    };
  }

  log('info', 'Found example "' + name + '" (' + match.length + ' bytes)');

  var nextSteps = '\n\n---\n**Next steps:**\n- Call `get_guide` with "Manifest-Reference" for full schema details\n- Call `get_action_api` for the complete ctx scripting reference\n- Call `get_example` with a different name for another example';
  return {
    content: [{ type: 'text', text: match + nextSteps }],
  };
}
