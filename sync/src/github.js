import { createHash, createPrivateKey } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { clients } from './clients.js';

function gitBlobSha(text) {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}

async function appToken() {
  const { config, secrets } = clients();
  const secret = await secrets.getSecret(config.githubPrivateKeySecret);
  const pem = String(secret.value || '').replaceAll('\\n', '\n');
  if (!pem.includes('BEGIN')) {
    throw new Error('GitHub App 私钥尚未写入 Key Vault。');
  }
  const pkcs8 = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' });
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .setIssuer(config.githubAppId)
    .sign(key);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(config.githubInstallationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.token) {
    throw new Error(payload.message || '无法创建 GitHub App 安装令牌。');
  }
  return payload.token;
}

async function githubApi(token, route, options = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || `GitHub API 请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function treePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .join('/');
}

/**
 * 通用多文件提交：files = [{ path, content }]（content 为 utf8 字符串）。
 * 一次 commit 完成全部新增/修改与 removePaths 删除，fast-forward 到分支。
 */
export async function commitFiles(files, { removePaths = [], message } = {}) {
  if (!files.length && !removePaths.length) {
    return { changed: false, files: 0 };
  }

  const { config } = clients();
  const token = await appToken();
  const repo = config.githubRepository;
  const branch = config.githubBranch;
  const refName = `heads/${branch}`;
  const ref = await githubApi(token, `/repos/${repo}/git/ref/${refName}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await githubApi(token, `/repos/${repo}/git/commits/${baseCommitSha}`);
  const baseTree = await githubApi(token, `/repos/${repo}/git/trees/${baseCommit.tree.sha}?recursive=1`);
  const existing = new Map((baseTree.tree || []).map((entry) => [entry.path, entry]));
  const newEntries = [];

  for (const file of files) {
    const path = treePath(file.path);
    const content = file.content;
    const expectedSha = gitBlobSha(content);
    if (existing.get(path)?.sha === expectedSha) continue;
    const blob = await githubApi(token, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: {
        content: Buffer.from(content, 'utf8').toString('base64'),
        encoding: 'base64',
      },
    });
    newEntries.push({
      path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }

  for (const path of removePaths) {
    if (existing.has(treePath(path))) {
      newEntries.push({ path: treePath(path), mode: '100644', type: 'blob', sha: null });
    }
  }

  if (!newEntries.length) {
    return { changed: false, files: 0 };
  }

  const tree = await githubApi(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: baseCommit.tree.sha,
      tree: newEntries,
    },
  });
  const commit = await githubApi(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: {
      message: message || `sync: publish ${newEntries.length} file update(s)`,
      tree: tree.sha,
      parents: [baseCommitSha],
    },
  });
  await githubApi(token, `/repos/${repo}/git/refs/${refName}`, {
    method: 'PATCH',
    body: {
      sha: commit.sha,
      force: false,
    },
  });
  return {
    changed: true,
    commit: commit.sha,
    files: newEntries.length,
  };
}

/** 分支头当前全部 blob 路径，用于发布前对比出应删除的旧产物。 */
export async function listBlobPaths() {
  const { config } = clients();
  const token = await appToken();
  const repo = config.githubRepository;
  const ref = await githubApi(token, `/repos/${repo}/git/ref/heads/${config.githubBranch}`);
  const commit = await githubApi(token, `/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await githubApi(token, `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  return (tree.tree || [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path);
}

export async function commitRecords(records, { removePaths = [] } = {}) {
  const { config } = clients();
  return commitFiles(
    records.map((record) => ({
      path: `${config.contentPrefix}/${record.id}.json`,
      content: `${JSON.stringify(record, null, 2)}\n`,
    })),
    { removePaths, message: `sync(qzone): publish ${records.length} content update(s)` },
  );
}

export async function listContentRecords() {
  const { config } = clients();
  const token = await appToken();
  const repo = config.githubRepository;
  const ref = await githubApi(token, `/repos/${repo}/git/ref/heads/${config.githubBranch}`);
  const commit = await githubApi(token, `/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await githubApi(token, `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const entries = (tree.tree || []).filter(
    (entry) => entry.type === 'blob'
      && entry.path.startsWith(`${config.contentPrefix}/`)
      && entry.path.endsWith('.json'),
  );
  const records = [];
  for (const entry of entries) {
    const blob = await githubApi(token, `/repos/${repo}/git/blobs/${entry.sha}`);
    const content = Buffer.from(blob.content, blob.encoding || 'base64').toString('utf8');
    try {
      records.push({ path: entry.path, record: JSON.parse(content) });
    } catch {
      // A malformed record must not block synchronization of healthy records.
    }
  }
  return records;
}

export async function publishDryRunReport(report) {
  const { private: container } = clients();
  const name = `sync-reports/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await container.getBlockBlobClient(name).uploadData(
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
    },
  );
  return name;
}

export async function publishQuarantineRecords(records) {
  const { private: container } = clients();
  const name = `quarantine/${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.json`;
  await container.getBlockBlobClient(name).uploadData(
    Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8'),
    {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
    },
  );
  return name;
}
