import { clients } from './clients.js';

export async function readState(id, partitionKey = clients().config.statePartition) {
  try {
    return (await clients().state.item(id, partitionKey).read()).resource;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

export async function writeState(id, value, partitionKey = clients().config.statePartition) {
  const document = {
    ...value,
    id,
    partitionKey,
    updatedAt: new Date().toISOString(),
  };
  await clients().state.items.upsert(document);
  return document;
}

export async function setStatus(state, message = '') {
  return writeState('sync-status', {
    type: 'sync-status',
    state,
    message,
    updatedAt: new Date().toISOString(),
  });
}

export async function setQzoneStatus(state, message = '', extra = {}) {
  return writeState('qzone-status', {
    type: 'qzone-status',
    state,
    message,
    checkedAt: new Date().toISOString(),
    ...extra,
  });
}
