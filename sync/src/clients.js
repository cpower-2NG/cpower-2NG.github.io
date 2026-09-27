import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { BlobServiceClient } from '@azure/storage-blob';
import { envConfig } from './config.js';

let cached = null;

export function clients() {
  if (cached) return cached;
  const config = envConfig();
  const credential = new DefaultAzureCredential();
  const cosmos = new CosmosClient({
    endpoint: config.cosmosEndpoint,
    aadCredentials: credential,
  }).database(config.cosmosDatabase);
  const blobs = new BlobServiceClient(config.blobAccountUrl, credential);
  cached = {
    config,
    credential,
    cosmos,
    state: cosmos.container('state'),
    activity: cosmos.container('activity'),
    secrets: new SecretClient(config.keyVaultUri, credential),
    media: blobs.getContainerClient(config.mediaContainer),
    private: blobs.getContainerClient(config.privateContainer),
  };
  return cached;
}
