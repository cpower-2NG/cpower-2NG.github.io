function required(name) {
  const value = process.env[name] || '';
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

export function envConfig() {
  return {
    mode: process.env.QZONE_MODE === 'auth' ? 'auth' : 'sync',
    cosmosEndpoint: required('COSMOS_ENDPOINT'),
    cosmosDatabase: process.env.COSMOS_DATABASE || 'bifrost',
    blobAccountUrl: required('BLOB_ACCOUNT_URL').replace(/\/+$/, ''),
    mediaContainer: process.env.MEDIA_CONTAINER || 'media',
    privateContainer: process.env.PRIVATE_CONTAINER || 'private',
    keyVaultUri: required('KEY_VAULT_URI').replace(/\/+$/, ''),
    githubPrivateKeySecret: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME || 'github-app-private-key',
    githubAppId: required('GITHUB_APP_ID'),
    githubInstallationId: required('GITHUB_APP_INSTALLATION_ID'),
    githubRepository: required('GITHUB_REPOSITORY'),
    githubBranch: process.env.GITHUB_BRANCH || 'main',
    contentPrefix: process.env.CONTENT_COMMIT_PREFIX || 'content-src/imported/qq',
    statePartition: process.env.QZONE_STATE_PARTITION || 'sync',
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
  };
}
