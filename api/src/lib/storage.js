import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { config } from './config.js';

let cached = null;

export function blobService() {
  if (cached) return cached;
  const current = config();
  if (!current.blobAccountUrl) {
    throw new Error('BLOB_ACCOUNT_URL 未配置。');
  }
  const service = new BlobServiceClient(current.blobAccountUrl, new DefaultAzureCredential());
  cached = {
    service,
    media: service.getContainerClient(current.mediaContainer),
    private: service.getContainerClient(current.privateContainer),
  };
  return cached;
}

export async function privateReadSasUrl(blobName, minutes = 10) {
  const current = config();
  const { service } = blobService();
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);
  const delegation = await service.getUserDelegationKey(startsOn, expiresOn);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: current.privateContainer,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    delegation,
    service.accountName,
  ).toString();
  return `${current.blobAccountUrl.replace(/\/+$/, '')}/${current.privateContainer}/${blobName}?${sas}`;
}

export async function readPrivateJson(blobName) {
  const blob = blobService().private.getBlockBlobClient(blobName);
  const response = await blob.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 原件与导入报告都落在私有容器；上传不经过公开访问面。 */
export async function uploadPrivateBlob(blobName, buffer, contentType = 'application/octet-stream') {
  const blob = blobService().private.getBlockBlobClient(blobName);
  await blob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blobName;
}
