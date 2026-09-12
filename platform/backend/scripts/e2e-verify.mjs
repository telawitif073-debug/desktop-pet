/**
 * 平台端到端验证脚本
 * 覆盖：注册 → 登录 → 上传 → 创建资源 → 管理员审核 → 浏览 → 下载 → 评分
 * 用法：node scripts/e2e-verify.mjs
 */
const BASE = process.env.PLATFORM_URL || 'http://localhost:3001/api';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  return { status: res.status, data, res };
}

function items(data) {
  return Array.isArray(data) ? data : data?.items ?? [];
}

async function main() {
  console.log(`E2E verify against ${BASE}\n`);

  // 1. 健康检查：公开列表
  {
    const { status, data } = await api('GET', '/pets');
    check('GET /pets 200', status === 200);
    check('列表返回分页结构', Array.isArray(data?.items) && data.page === 1 && data.limit >= 1);
  }

  // 2. 注册新用户
  const rnd = Date.now();
  let demoToken;
  {
    const { status, data } = await api('POST', '/auth/register', {
      body: {
        email: `user${rnd}@test.local`,
        username: `tester${rnd}`,
        password: 'test123456',
      },
    });
    check('注册成功 201', status === 201 || status === 200, `got ${status}`);
    check('返回 accessToken', !!data?.accessToken);
    demoToken = data?.accessToken;
  }

  // 3. 登录 admin
  let adminToken;
  {
    const { status, data } = await api('POST', '/auth/login', {
      body: { identifier: 'admin', password: 'admin123' },
    });
    check('admin 登录成功', (status === 200 || status === 201) && !!data?.accessToken, `got ${status}`);
    check('admin 角色正确', data?.user?.role === 'admin');
    adminToken = data?.accessToken;
  }

  // 4. 上传文件
  let uploadedUrl;
  {
    const form = new FormData();
    const blob = new Blob([`e2e upload ${rnd}`], { type: 'text/plain' });
    form.append('file', blob, `e2e-${rnd}.txt`);
    const { status, data } = await api('POST', '/uploads', { token: demoToken, form });
    check('上传成功', status === 201 && data?.success === true, `got ${status} ${JSON.stringify(data)}`);
    uploadedUrl = data?.url;
  }

  // 5. 创建宠物资源（待审核）
  let petId;
  {
    const { status, data } = await api('POST', '/pets', {
      token: demoToken,
      body: {
        name: `E2E测试宠物${rnd}`,
        description: '端到端验证用资源',
        category: '动画',
        tags: ['e2e'],
        fileUrl: uploadedUrl,
      },
    });
    check('创建资源成功（默认 pending）', status === 201 && data?.status === 'pending', `got ${status} ${JSON.stringify(data)}`);
    petId = data?.id;
  }

  // 6. 公开列表不显示 pending
  {
    const { data } = await api('GET', '/pets');
    check('pending 不出现在公开列表', !items(data).some((p) => p.id === petId));
    const pending = await api('GET', '/pets?status=pending', { token: adminToken });
    check('管理员可查看待审核列表', pending.status === 200 && items(pending.data).some((p) => p.id === petId));
  }

  // 7. 管理员审核通过
  {
    const { status, data } = await api('POST', `/admin/approve/pet/${petId}`, { token: adminToken });
    check('审核通过', (status === 200 || status === 201) && data?.status === 'approved', `got ${status}`);
  }

  // 8. 公开列表出现
  {
    const { data } = await api('GET', '/pets');
    check('approved 出现在公开列表', items(data).some((p) => p.id === petId));
  }

  // 9. 搜索、分页和排序
  {
    const search = await api('GET', `/pets?search=${encodeURIComponent(`E2E测试宠物${rnd}`)}&page=1&limit=1&sort=downloads`);
    const searchItems = items(search.data);
    check('搜索命中资源', search.status === 200 && searchItems.some((p) => p.id === petId));
    check('分页参数生效', search.data?.page === 1 && search.data?.limit === 1 && search.data?.total >= 1);
    const sorted = await api('GET', '/pets?sort=downloads&page=1&limit=20');
    const sortedItems = items(sorted.data);
    check('按下载量排序', sorted.status === 200 && sortedItems.every((p, i) => i === 0 || sortedItems[i - 1].downloads >= p.downloads));
  }

  // 10. 下载
  {
    const dl = await api('POST', `/pets/${petId}/download`, { token: demoToken });
    check('下载 200', dl.status === 201 || dl.status === 200, `got ${dl.status}`);
    check('返回文件 URL', typeof dl.data?.url === 'string' && dl.data.url.length > 0);
    const { data } = await api('GET', `/pets/${petId}`);
    check('下载计数 +1', data?.downloads === 1, `downloads=${data?.downloads}`);
  }

  // 11. 评分和评论
  {
    const { status } = await api('POST', `/pets/${petId}/review`, {
      token: demoToken,
      body: { rating: 5, comment: '很好' },
    });
    check('评分成功', status === 201 || status === 200, `got ${status}`);
    const { data } = await api('GET', `/pets/${petId}`);
    check('平均分更新', data?.rating === 5, `rating=${data?.rating}`);
    const reviews = await api('GET', `/reviews?assetType=pet&assetId=${petId}`);
    check('评论可查询', reviews.status === 200 && reviews.data?.some((review) => review.comment === '很好'));
  }

  // 12. 智能体列表 + 资源下载
  {
    const { status, data } = await api('GET', '/agents');
    const agentItems = items(data);
    check('GET /agents 200', status === 200 && Array.isArray(agentItems));
    const seedAgent = agentItems.find((a) => a.name === '示例闲聊智能体');
    if (seedAgent) {
      const { status: ds } = await api('POST', `/agents/${seedAgent.id}/download`);
      check('种子智能体下载 200', ds === 201 || ds === 200, `got ${ds}`);
    }
  }

  // 13. 权限校验：未登录不能创建
  {
    const { status } = await api('POST', '/pets', { body: { name: 'x', fileUrl: '/uploads/a.txt' } });
    check('未登录创建被拒绝 401', status === 401, `got ${status}`);
  }

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E failed:', e);
  process.exit(1);
});
