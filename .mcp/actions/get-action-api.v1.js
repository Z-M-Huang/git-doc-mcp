/**
 * Action: get-action-api
 *
 * Fetches the action scripting API reference from the wiki.
 * Optionally extracts a specific section (fetch, secrets, logging, response).
 *
 * @param {object} input
 * @param {string} [input.section] - Specific section to extract (e.g., "fetch", "secrets", "logging")
 * @param {object} ctx
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export default async function getActionApi(input, ctx) {
  var section = input.section;
  var fetch = ctx.fetch;
  var log = ctx.log;
  var getSecret = ctx.getSecret;

  var WIKI_BASE = 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp';
  var url = WIKI_BASE + '/Writing-Actions.md';

  log('info', 'Fetching action API reference' + (section ? ' (section: ' + section + ')' : ''));

  var headers = {};
  var token = getSecret('GITHUB_TOKEN', url);
  if (token) {
    headers['Authorization'] = 'token ' + token;
  }

  var response = await fetch(url, { headers: headers });

  if (!response.ok) {
    return {
      content: [{ type: 'text', text: 'Failed to fetch action API reference: ' + response.status }],
      isError: true,
    };
  }

  var body = response.text;

  // If no section requested, return full page
  if (!section) {
    log('info', 'Returning full API reference (' + body.length + ' bytes)');
    return {
      content: [{ type: 'text', text: body }],
    };
  }

  // Extract section by matching level-2 heading
  var sectionLower = section.toLowerCase().trim();
  var parts = body.split(/(?=^## )/m);
  var match = null;
  var availableSections = [];

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part.startsWith('## ')) continue;

    var headingEnd = part.indexOf('\n');
    var heading = part.slice(3, headingEnd === -1 ? undefined : headingEnd).trim();
    var headingLower = heading.toLowerCase();

    availableSections.push(heading);

    if (headingLower === sectionLower || headingLower.indexOf(sectionLower) !== -1) {
      match = part;
      break;
    }
  }

  if (!match) {
    var available = availableSections.length > 0
      ? '\n\nAvailable sections:\n' + availableSections.map(function (s) { return '- ' + s; }).join('\n')
      : '';

    return {
      content: [{
        type: 'text',
        text: 'Section not found: "' + section + '"' + available + '\n\nOmit the section parameter to get the full reference.',
      }],
      isError: true,
    };
  }

  log('info', 'Returning section "' + section + '" (' + match.length + ' bytes)');

  return {
    content: [{ type: 'text', text: match }],
  };
}
