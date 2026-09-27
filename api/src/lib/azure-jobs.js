import { DefaultAzureCredential } from '@azure/identity';
import { config } from './config.js';

async function armRequest(url, method = 'GET') {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken('https://management.azure.com/.default');
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message = body?.error?.message || `Azure 管理接口请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return body;
}

function jobUrl(jobName) {
  const current = config();
  if (!current.subscriptionId || !current.resourceGroup) {
    throw new Error('SUBSCRIPTION_ID 或 RESOURCE_GROUP 未配置。');
  }
  return `https://management.azure.com/subscriptions/${encodeURIComponent(current.subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(current.resourceGroup)}`
    + `/providers/Microsoft.App/jobs/${encodeURIComponent(jobName)}`;
}

export async function startContainerJob(jobName) {
  return armRequest(`${jobUrl(jobName)}/start?api-version=2024-03-01`, 'POST');
}

export async function jobExecution(jobName, executionName) {
  return armRequest(`${jobUrl(jobName)}/executions/${encodeURIComponent(executionName)}?api-version=2024-03-01`);
}
