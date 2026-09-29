import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from './config.js';

let cached = null;

export function cosmosContainers() {
  if (cached) return cached;
  const current = config();
  if (!current.cosmosEndpoint) {
    throw new Error('COSMOS_ENDPOINT 未配置。');
  }

  const client = new CosmosClient({
    endpoint: current.cosmosEndpoint,
    aadCredentials: new DefaultAzureCredential(),
  });
  const database = client.database(current.cosmosDatabase);
  cached = {
    client,
    database,
    comments: database.container('comments'),
    signals: database.container('signals'),
    state: database.container('state'),
    rateLimits: database.container('rate-limits'),
  };
  return cached;
}
