import { app } from '@azure/functions';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import { config } from '../lib/config.js';
import { handleError, json } from '../lib/http.js';
import { text } from '../lib/validation.js';

let cached = null;

function searchClient() {
  if (cached) return cached;
  const current = config();
  if (!current.searchEndpoint) return null;
  cached = new SearchClient(current.searchEndpoint, current.searchIndex, new DefaultAzureCredential());
  return cached;
}

/** 把用户输入拼进 OData 过滤表达式时要转义单引号。 */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** from 参数只接受 YYYY-MM-DD，转成 UTC 零点的 OData 日期字面量（不带引号）。 */
function dateLiteral(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  return `${raw}T00:00:00.000Z`;
}

/** 从命中高亮里挑一段摘要：正文优先，其次摘要与标题。 */
function snippetFrom(highlights) {
  if (!highlights) return '';
  for (const field of ['bodyText', 'summary', 'title']) {
    const fragments = highlights[field];
    if (Array.isArray(fragments) && fragments.length) {
      return fragments.join(' … ').slice(0, 220);
    }
  }
  return '';
}

const SELECT_FIELDS = [
  'entryId', 'entryType', 'title', 'summary', 'phase', 'section', 'tags',
  'seriesId', 'kind', 'publishedAt', 'path', 'coverUrl', 'wordCount',
  'pinned', 'featured', 'hasMedia', 'hasVideo', 'likes', 'views', 'comments',
];

app.http('search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'search',
  handler: async (request, context) => {
    try {
      const client = searchClient();
      if (!client) {
        return json(request, { enabled: false, items: [], facets: {} });
      }

      const query = text(request.query.get('q'), '搜索词', { max: 120 });
      const phase = text(request.query.get('phase'), '位面', { max: 20 });
      const section = text(request.query.get('section'), '分区', { max: 40 });
      const entryType = text(request.query.get('type'), '类型', { max: 20 });
      const from = dateLiteral(request.query.get('from'));
      const tags = String(request.query.get('tags') || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12);
      const limit = Math.min(60, Math.max(1, Number(request.query.get('limit')) || 30));

      const filters = ["status eq 'published'"];
      if (phase) filters.push(`phase eq ${quote(phase)}`);
      if (section) filters.push(`section eq ${quote(section)}`);
      if (entryType) filters.push(`entryType eq ${quote(entryType)}`);
      if (from) filters.push(`publishedAt ge ${from}`);
      for (const tag of tags) {
        filters.push(`tags/any(t: t eq ${quote(tag)})`);
      }

      const response = await client.search(query || '*', {
        filter: filters.join(' and '),
        facets: ['phase', 'section', 'tags,count:20', 'entryType'],
        top: limit,
        includeTotalCount: true,
        orderBy: query ? undefined : ['pinned desc', 'publishedAt desc'],
        select: SELECT_FIELDS,
        ...(query
          ? {
              highlightFields: 'title,summary,bodyText',
              highlightPreTag: '<mark>',
              highlightPostTag: '</mark>',
            }
          : {}),
      });

      const items = [];
      for await (const result of response.results) {
        items.push({
          score: result.score ?? null,
          snippet: snippetFrom(result.highlights || result.document?.['@search.highlights'] || null),
          ...result.document,
        });
      }
      const facets = (await response.facets) || {};

      return json(request, {
        enabled: true,
        total: Number(response.count) || items.length,
        items,
        facets,
      });
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
