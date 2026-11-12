const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number(process.env.XHS_FEISHU_PORT || 37821);
const htmlPath = path.join(__dirname, 'xiaohongshu-feishu-desktop-mockup.html');
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) request.destroy(new Error('请求体过大'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('请求格式错误')); }
    });
    request.on('error', reject);
  });
}

async function validateFeishu(request, response) {
  try {
    const { authCode, appToken, tableId } = await readJson(request);
    if (![authCode, appToken, tableId].every(value => typeof value === 'string' && value.trim())) {
      return sendJson(response, 400, { code: -1, msg: '缺少授权码、app_token 或 table_id' });
    }

    const endpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken.trim())}/tables/${encodeURIComponent(tableId.trim())}/fields?page_size=100`;
    const upstream = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${authCode.trim()}` },
      signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { code: -1, msg: `飞书返回了非 JSON 响应（HTTP ${upstream.status}）` }; }
    return sendJson(response, upstream.ok ? 200 : upstream.status, payload);
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '连接飞书超时' : error.message;
    return sendJson(response, 502, { code: -1, msg: message });
  }
}

async function fetchFeishuJson(endpoint, options = {}) {
  const { timeoutMs = 20000, ...fetchOptions } = options;
  const upstream = await fetch(endpoint, {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await upstream.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { code: -1, msg: `飞书返回了非 JSON 响应（HTTP ${upstream.status}）` }; }
  return { upstream, payload };
}

async function listFeishuRecords(token, appToken, tableId, viewId = '') {
  const items = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    if (viewId) query.set('view_id', viewId);
    const endpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query}`;
    const result = await fetchFeishuJson(endpoint, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30000 });
    if (!result.upstream.ok || result.payload.code !== 0) throw new Error(result.payload.msg || `读取飞书记录失败（HTTP ${result.upstream.status}）`);
    items.push(...(result.payload.data?.items || []));
    pageToken = result.payload.data?.has_more ? String(result.payload.data?.page_token || '') : '';
  } while (pageToken && items.length < 5000);
  return items;
}

async function uploadImageMedia({ token, appToken, filePath }) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('不是有效文件');
  if (stat.size > 20 * 1024 * 1024) throw new Error('单张图片超过 20MB');
  const fileName = path.basename(filePath);
  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_image');
  form.append('parent_node', appToken);
  form.append('size', String(stat.size));
  form.append('extra', JSON.stringify({ drive_route_token: appToken }));
  form.append('file', new Blob([buffer]), fileName);
  const endpoint = 'https://base-api.feishu.cn/open-apis/drive/v1/medias/upload_all';
  const result = await fetchFeishuJson(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    timeoutMs: 60000,
  });
  if (!result.upstream.ok || result.payload.code !== 0) {
    const errorCode = result.payload.code != null ? `飞书错误码 ${result.payload.code}` : `HTTP ${result.upstream.status}`;
    throw new Error(`上传图片失败（${errorCode}）：${result.payload.msg || '未知错误'}`);
  }
  const fileToken = result.payload.data?.file_token;
  if (!fileToken) throw new Error('飞书未返回图片 file_token');
  return { file_token: fileToken };
}

async function uploadFeishuImages(request, response) {
  try {
    const { authCode, appToken, tableId, viewId = '', fieldName, append = false, rows } = await readJson(request);
    if (![authCode, appToken, tableId, fieldName].every(value => typeof value === 'string' && value.trim())) {
      return sendJson(response, 400, { code: -1, msg: '缺少飞书连接信息或附件字段' });
    }
    if (!Array.isArray(rows) || !rows.length || rows.length > 500) {
      return sendJson(response, 400, { code: -1, msg: '上传计划必须包含 1 至 500 行' });
    }
    const totalFiles = rows.reduce((sum, row) => sum + (Array.isArray(row?.files) ? row.files.length : 0), 0);
    if (!totalFiles || totalFiles > 1000) {
      return sendJson(response, 400, { code: -1, msg: '单次上传图片数量必须为 1 至 1000 张' });
    }

    const token = authCode.trim();
    const app = appToken.trim();
    const table = tableId.trim();
    const headers = { Authorization: `Bearer ${token}` };
    const fieldsEndpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(app)}/tables/${encodeURIComponent(table)}/fields?page_size=100`;
    const fieldsResult = await fetchFeishuJson(fieldsEndpoint, { headers });
    if (!fieldsResult.upstream.ok || fieldsResult.payload.code !== 0) {
      return sendJson(response, fieldsResult.upstream.ok ? 400 : fieldsResult.upstream.status, fieldsResult.payload);
    }
    const field = (fieldsResult.payload.data?.items || []).find(item => item.field_name === fieldName.trim());
    if (!field) return sendJson(response, 400, { code: -1, msg: `飞书表格中没有字段：${fieldName.trim()}` });
    if (field.type !== 17) return sendJson(response, 400, { code: -1, msg: `字段“${fieldName.trim()}”不是附件字段` });

    const records = await listFeishuRecords(token, app, table, String(viewId || ''));
    const succeeded = [];
    const failed = [];
    for (const row of rows) {
      const rowNumber = Number(row?.rowNumber);
      const record = Number.isInteger(rowNumber) && rowNumber > 0 ? records[rowNumber - 1] : null;
      const files = (Array.isArray(row?.files) ? row.files : []).map(file => String(file?.path || file)).filter(Boolean);
      if (!record) {
        failed.push({ rowNumber, message: '目标行不存在' });
        continue;
      }
      if (!files.length) continue;
      try {
        const uploaded = [];
        for (const filePath of files) {
          if (!imageExtensions.has(path.extname(filePath).toLowerCase())) throw new Error(`不支持的图片格式：${path.basename(filePath)}`);
          uploaded.push(await uploadImageMedia({ token, appToken: app, filePath }));
        }
        const existing = append && Array.isArray(record.fields?.[fieldName])
          ? record.fields[fieldName].filter(item => item?.file_token).map(item => ({ file_token: item.file_token }))
          : [];
        const updateEndpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(app)}/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(record.record_id)}`;
        const updateResult = await fetchFeishuJson(updateEndpoint, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { [fieldName]: [...existing, ...uploaded] } }),
          timeoutMs: 30000,
        });
        if (!updateResult.upstream.ok || updateResult.payload.code !== 0) {
          const errorCode = updateResult.payload.code != null ? `飞书错误码 ${updateResult.payload.code}` : `HTTP ${updateResult.upstream.status}`;
          throw new Error(`写入附件字段失败（${errorCode}）：${updateResult.payload.msg || '未知错误'}`);
        }
        succeeded.push({ rowNumber, count: uploaded.length });
      } catch (error) {
        failed.push({ rowNumber, message: error.message });
      }
    }
    return sendJson(response, failed.length && !succeeded.length ? 502 : 200, {
      code: failed.length && !succeeded.length ? -1 : 0,
      msg: failed.length ? '部分图片上传失败' : 'success',
      data: { succeeded, failed, uploadedCount: succeeded.reduce((sum, item) => sum + item.count, 0) },
    });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '上传图片超时' : error.message;
    return sendJson(response, 502, { code: -1, msg: message });
  }
}

const xiaohongshuMobileHeaders = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; 23113RKC6C) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

function parseXiaohongshuState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('页面中没有找到笔记数据');
  const dataStart = start + marker.length;
  const dataEnd = html.indexOf('</script>', dataStart);
  if (dataEnd < 0) throw new Error('笔记数据格式不完整');
  const source = html.slice(dataStart, dataEnd).replace(/:undefined([,}])/g, ':null$1');
  return JSON.parse(source);
}

function findNoteData(state) {
  const direct = state?.noteData?.data?.noteData;
  if (direct?.title || direct?.noteId) return direct;
  const queue = [state];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value.tagList) && (value.title || value.noteId || value.desc)) return value;
    queue.push(...Object.values(value));
  }
  return null;
}

async function collectXiaohongshuNote(sourceUrl) {
  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch { throw new Error('小红书链接格式错误'); }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== 'xhslink.cn' && hostname !== 'www.xhslink.cn' && hostname !== 'xiaohongshu.com' && hostname !== 'www.xiaohongshu.com') {
    throw new Error('不是受支持的小红书链接');
  }
  const upstream = await fetch(parsedUrl, {
    redirect: 'follow',
    headers: xiaohongshuMobileHeaders,
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok) throw new Error(`打开笔记失败（HTTP ${upstream.status}）`);
  const html = await upstream.text();
  const state = parseXiaohongshuState(html);
  const note = findNoteData(state);
  if (!note) throw new Error('没有读取到笔记内容');
  const tags = [...new Set((Array.isArray(note.tagList) ? note.tagList : [])
    .map(tag => typeof tag === 'string' ? tag : tag?.name)
    .map(tag => String(tag || '').replace(/^#+/, '').trim())
    .filter(Boolean))].slice(0, 10);
  return {
    sourceUrl,
    finalUrl: upstream.url,
    noteId: String(note.noteId || note.id || ''),
    title: String(note.title || '').trim(),
    tags,
  };
}

async function collectXiaohongshu(request, response) {
  try {
    const { urls } = await readJson(request);
    if (!Array.isArray(urls) || urls.length === 0) {
      return sendJson(response, 400, { code: -1, msg: '没有可采集的小红书链接' });
    }
    if (urls.length > 20) {
      return sendJson(response, 400, { code: -1, msg: '单次最多采集 20 条链接' });
    }
    const settled = await Promise.allSettled(urls.map(url => collectXiaohongshuNote(String(url))));
    const items = [];
    const failures = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') items.push(result.value);
      else failures.push({ sourceUrl: String(urls[index]), message: result.reason?.message || '采集失败' });
    });
    if (!items.length) {
      return sendJson(response, 502, { code: -1, msg: failures.map(item => item.message).join('；') || '未能采集到笔记' });
    }
    return sendJson(response, 200, { code: 0, msg: 'success', data: { items, failures } });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '采集小红书笔记超时' : error.message;
    return sendJson(response, 502, { code: -1, msg: message });
  }
}

async function uploadFeishu(request, response) {
  try {
    const { authCode, appToken, tableId, records } = await readJson(request);
    if (![authCode, appToken, tableId].every(value => typeof value === 'string' && value.trim())) {
      return sendJson(response, 400, { code: -1, msg: '缺少授权码、app_token 或 table_id' });
    }
    if (!Array.isArray(records) || records.length === 0) {
      return sendJson(response, 400, { code: -1, msg: '没有可上传的采集结果' });
    }
    if (records.length > 500) {
      return sendJson(response, 400, { code: -1, msg: '单次最多上传 500 条记录' });
    }

    const token = authCode.trim();
    const app = encodeURIComponent(appToken.trim());
    const table = encodeURIComponent(tableId.trim());
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const fieldsEndpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${app}/tables/${table}/fields?page_size=100`;
    const fieldsResult = await fetchFeishuJson(fieldsEndpoint, { headers });
    if (!fieldsResult.upstream.ok || fieldsResult.payload.code !== 0) {
      return sendJson(response, fieldsResult.upstream.ok ? 400 : fieldsResult.upstream.status, fieldsResult.payload);
    }

    const fieldTypes = new Map((fieldsResult.payload.data?.items || []).map(field => [field.field_name, field.type]));
    const requestedFields = [...new Set(records.flatMap(record => Object.keys(record || {})))];
    const missingFields = requestedFields.filter(field => !fieldTypes.has(field));
    const writableFields = requestedFields.filter(field => fieldTypes.has(field));
    if (!writableFields.length) {
      return sendJson(response, 400, { code: -1, msg: '采集结果中的字段在飞书表格中均不存在，无法新增记录' });
    }

    const normalizedRecords = records.map(record => {
      const fields = {};
      for (const [name, rawValue] of Object.entries(record || {})) {
        if (!fieldTypes.has(name) || rawValue === '' || rawValue == null) continue;
        const type = fieldTypes.get(name);
        if (type === 5) fields[name] = Number(rawValue);
        else if (type === 4) fields[name] = Array.isArray(rawValue) ? rawValue : String(rawValue).split(',').map(value => value.trim()).filter(Boolean);
        else fields[name] = String(rawValue);
      }
      return { fields };
    });

    const uploadEndpoint = `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_create`;
    const uploadResult = await fetchFeishuJson(uploadEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: normalizedRecords }),
    });
    if (uploadResult.payload.code === 0) {
      uploadResult.payload.data = uploadResult.payload.data || {};
      uploadResult.payload.data.skipped_fields = missingFields;
    }
    return sendJson(response, uploadResult.upstream.ok ? 200 : uploadResult.upstream.status, uploadResult.payload);
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '上传飞书超时' : error.message;
    return sendJson(response, 502, { code: -1, msg: message });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  if (request.method === 'POST' && url.pathname === '/api/feishu/validate') {
    return validateFeishu(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/feishu/upload') {
    return uploadFeishu(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/feishu/upload-images') {
    return uploadFeishuImages(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/xiaohongshu/collect') {
    return collectXiaohongshu(request, response);
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/xiaohongshu-feishu-desktop-mockup.html')) {
    fs.readFile(htmlPath, (error, content) => {
      if (error) return sendJson(response, 500, { code: -1, msg: '无法读取原型页面' });
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    });
    return;
  }
  sendJson(response, 404, { code: -1, msg: 'Not found' });
});

function startServer(listenPort = port, listenHost = host) {
  return new Promise((resolve, reject) => {
    const handleError = error => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      const address = server.address();
      console.log(`小红书采集应用已启动：http://${listenHost}:${address.port}`);
      resolve(server);
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(listenPort, listenHost);
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { startServer, uploadImageMedia };
