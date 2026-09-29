import { DefaultAzureCredential } from '@azure/identity';

export const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT || 'https://search-bifrost-z43zcc.search.windows.net';
export const INDEX_NAME = process.env.SEARCH_INDEX || 'bifrost-content';

/** 中文内容用语言分析器，避免按字切分导致召回不准。 */
const ZH = 'zh-Hans.microsoft';

/** 索引定义对应 docs/design/10-data-design.md 的检索投影字段。 */
export const INDEX_DEFINITION = {
  name: INDEX_NAME,
  fields: [
    { name: 'entryId', type: 'Edm.String', key: true, filterable: true },
    { name: 'entryType', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'title', type: 'Edm.String', searchable: true, analyzerName: ZH, sortable: true },
    { name: 'summary', type: 'Edm.String', searchable: true, analyzerName: ZH },
    { name: 'bodyText', type: 'Edm.String', searchable: true, analyzerName: ZH },
    { name: 'phase', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'section', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'tags', type: 'Collection(Edm.String)', searchable: true, filterable: true, facetable: true },
    { name: 'seriesId', type: 'Edm.String', filterable: true },
    { name: 'kind', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'publishedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
    { name: 'updatedAt', type: 'Edm.DateTimeOffset', sortable: true },
    { name: 'likes', type: 'Edm.Int32', filterable: true, sortable: true },
    { name: 'views', type: 'Edm.Int32', filterable: true, sortable: true },
    { name: 'comments', type: 'Edm.Int32', filterable: true, sortable: true },
    { name: 'pinned', type: 'Edm.Boolean', filterable: true, sortable: true },
    { name: 'featured', type: 'Edm.Boolean', filterable: true, sortable: true },
    { name: 'hasMedia', type: 'Edm.Boolean', filterable: true },
    { name: 'hasVideo', type: 'Edm.Boolean', filterable: true },
    { name: 'wordCount', type: 'Edm.Int32', sortable: true },
    { name: 'path', type: 'Edm.String' },
    { name: 'slug', type: 'Edm.String' },
    { name: 'coverUrl', type: 'Edm.String' },
    { name: 'status', type: 'Edm.String', filterable: true },
  ],
};

/** SDK 的构造签名是 (endpoint, credential)，不是选项对象。 */
export function searchCredential() {
  return process.env.SEARCH_KEY
    ? { key: process.env.SEARCH_KEY }
    : new DefaultAzureCredential();
}
