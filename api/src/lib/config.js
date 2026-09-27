function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function config(overrides = {}) {
  return {
    nodeEnv: process.env.NODE_ENV || 'production',
    interactionsEnabled: process.env.INTERACTIONS_ENABLED !== 'false',
    cosmosEndpoint: process.env.COSMOS_ENDPOINT || '',
    cosmosDatabase: process.env.COSMOS_DATABASE || 'bifrost',
    blobAccountUrl: process.env.BLOB_ACCOUNT_URL || '',
    mediaContainer: process.env.MEDIA_CONTAINER || 'media',
    privateContainer: process.env.PRIVATE_CONTAINER || 'private',
    hashSalt: process.env.HASH_SALT || '',
    allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),
    entraTenantId: process.env.ENTRA_TENANT_ID || '',
    entraClientId: process.env.ENTRA_CLIENT_ID || '',
    entraApiAudience: process.env.ENTRA_API_AUDIENCE || '',
    adminObjectIds: parseList(process.env.ADMIN_OBJECT_IDS),
    adminDevBypass: process.env.ADMIN_DEV_BYPASS === 'true',
    subscriptionId: process.env.SUBSCRIPTION_ID || '',
    resourceGroup: process.env.RESOURCE_GROUP || '',
    syncAuthJobName: process.env.SYNC_AUTH_JOB_NAME || 'qzone-auth',
    syncJobName: process.env.SYNC_JOB_NAME || 'qzone-sync',
    ...overrides,
  };
}
