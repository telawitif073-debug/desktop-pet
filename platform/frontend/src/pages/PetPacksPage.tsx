import { useEffect, useMemo, useState } from 'react';
import { Avatar, Button, Card, Descriptions, Divider, Drawer, Empty, Form, Input, List, Rate, Segmented, Skeleton, Space, Tag, Typography, message } from 'antd';
import { CheckOutlined, CloseOutlined, DownloadOutlined, SearchOutlined, StarFilled, UserOutlined } from '@ant-design/icons';
import { approveAsset, assetUrl, downloadPetPack, getPetPack, listPetPacks, listReviews, rejectAsset, submitReview } from '../api';
import type { ListPetPacksQuery, PetPackDetail, PetPackSort, PetPackStatus, PetPackSummary, Review, User } from '../types';
// 列表筛选与格式化口径复用共享模块（pet/ui），与桌面内嵌工坊同源，避免两端漂移
import { filterPetPacks, formatPackBytes, petPackStatusLabel } from '@pet/ui';
import { formatDate, getErrorMessage } from '../utils';

const { Text, Paragraph } = Typography;

const SORT_OPTIONS: { label: string; value: PetPackSort }[] = [
  { label: '最新发布', value: 'createdAt' },
  { label: '下载最多', value: 'downloads' },
  { label: '评分最高', value: 'rating' },
];

const BODY_KIND_OPTIONS: { label: string; value: string }[] = [
  { label: '全部形态', value: '' },
  { label: '模型', value: 'body-model' },
  { label: '帧动画', value: 'body-animation' },
  { label: '静态图', value: 'body-still' },
];

const STATUS_OPTIONS: { label: string; value: '' | PetPackStatus }[] = [
  { label: '全部', value: '' },
  { label: '待审核', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '已驳回', value: 'rejected' },
];

const STATUS_COLOR: Record<PetPackStatus, string> = { approved: 'green', rejected: 'red', pending: 'gold' };

/** 服务端派生的本体形态（pet/domain/resource.ts 的 PetResourceRole）→ 中文标签 */
const BODY_KIND_LABELS: Record<string, string> = {
  'body-model': '模型',
  'body-animation': '帧动画',
  'body-still': '静态图',
};

export default function PetPacksPage({ user }: { user: User | null }) {
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState<PetPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [bodyKind, setBodyKind] = useState('');
  const [sort, setSort] = useState<PetPackSort>('createdAt');
  const [status, setStatus] = useState<'' | PetPackStatus>('');
  const [messageApi, contextHolder] = message.useMessage();

  // 详情抽屉：点卡片按需拉取详情（列表接口不含载体 URL / 清单）
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<PetPackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState('');
  const [moderating, setModerating] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewForm] = Form.useForm<{ rating: number; comment: string }>();

  useEffect(() => {
    setLoading(true);
    setError('');
    // 管理员可按审核状态筛选（后端仅在 isAdmin 且带 status 时才过滤）；普通用户只能看已通过
    const query: ListPetPacksQuery = { limit: 60 };
    if (isAdmin && status) query.status = status;
    listPetPacks(query)
      .then((page) => setItems(page.items))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [isAdmin, status]);

  // 关键词 / 形态 / 排序口径统一交给 pet/ui 的纯函数（与商店列表一致）
  const filtered = useMemo(() => filterPetPacks(items, { search, bodyKind, sort }), [items, search, bodyKind, sort]);

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setDetail(null);
    setReviews([]);
    setDetailLoading(true);
    reviewForm.resetFields();
    try {
      const [nextDetail, nextReviews] = await Promise.all([getPetPack(id), listReviews('pet', id).catch(() => [] as Review[])]);
      setDetail(nextDetail);
      setReviews(nextReviews);
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const download = async (id: string) => {
    setDownloadingId(id);
    try {
      const result = await downloadPetPack(id);
      const fileUrl = assetUrl(result.url);
      if (!fileUrl) throw new Error('资源文件地址为空');
      window.open(fileUrl, '_blank');
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, downloads: result.downloads } : it)));
      setDetail((prev) => (prev && prev.id === id ? { ...prev, downloads: result.downloads } : prev));
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setDownloadingId('');
    }
  };

  // 管理员审核（载体为 pet_pack）
  const moderate = async (action: 'approve' | 'reject') => {
    if (!detail) return;
    const nextStatus: PetPackStatus = action === 'approve' ? 'approved' : 'rejected';
    setModerating(true);
    try {
      await (action === 'approve' ? approveAsset('pet', detail.id) : rejectAsset('pet', detail.id));
      setDetail({ ...detail, status: nextStatus });
      setItems((prev) => prev.map((it) => (it.id === detail.id ? { ...it, status: nextStatus } : it)));
      messageApi.success(action === 'approve' ? '宠物包已通过审核' : '宠物包已驳回');
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setModerating(false);
    }
  };

  const submitReviewForm = async (values: { rating: number; comment: string }) => {
    if (!detail) return;
    setReviewSubmitting(true);
    try {
      const next = await submitReview('pet', detail.id, values.rating, values.comment);
      setReviews((prev) => [next, ...prev.filter((item) => item.user?.username !== next.user?.username)]);
      // 服务端已按评价重算均分：重取详情拿最新评分并同步到列表
      const fresh = await getPetPack(detail.id);
      setDetail(fresh);
      setItems((prev) => prev.map((it) => (it.id === fresh.id ? { ...it, rating: fresh.rating } : it)));
      reviewForm.resetFields();
      messageApi.success('感谢你的评价');
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setReviewSubmitting(false);
    }
  };

  const renderCard = (pack: PetPackSummary) => (
    <Card
      key={pack.id}
      hoverable
      className="asset-card"
      onClick={() => void openDetail(pack.id)}
      cover={
        <div className="asset-cover">
          {pack.previewUrl ? <img src={assetUrl(pack.previewUrl)} alt="" /> : <div className="cover-letter">{pack.name.slice(0, 1)}</div>}
        </div>
      }
    >
      <div className="asset-card-title">
        <Typography.Title level={5} ellipsis={{ rows: 1 }}>{pack.name}</Typography.Title>
        <Tag bordered={false} color={STATUS_COLOR[pack.status]}>{petPackStatusLabel(pack.status)}</Tag>
      </div>
      <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">{pack.description || '暂无描述'}</Typography.Paragraph>
      <Space size={[4, 4]} wrap>
        {(pack.bodyKinds ?? []).map((kind) => <Tag key={kind} color="geekblue">{BODY_KIND_LABELS[kind] ?? kind}</Tag>)}
      </Space>
      <div className="asset-meta"><span><StarFilled className="star" /> {pack.rating?.toFixed(1) || '0.0'}</span><span><DownloadOutlined /> {pack.downloads}</span><span>v{pack.version}</span></div>
    </Card>
  );

  // 清单快照字段由服务端派生，形态与共享 manifest 契约不完全一致：按记录安全取值展示
  const manifest = detail?.manifest ? (detail.manifest as unknown as Record<string, unknown>) : null;
  const manifestEntry = (manifest?.entry as { path?: string } | null | undefined)?.path;
  const manifestEntryCount = typeof manifest?.entryCount === 'number' ? manifest.entryCount : null;

  return <div className="content-wrap">
    {contextHolder}
    <div className="page-heading">
      <div>
        <span className="eyebrow">PET PACKS</span>
        <Typography.Title>宠物包</Typography.Title>
        <Paragraph>从商店挑选喜欢的宠物形象，一键安装到你的桌面助手。</Paragraph>
      </div>
    </div>

    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
      <Space wrap>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称 / 描述 / 标签"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onPressEnter={() => setSearch(keyword.trim())}
          style={{ width: 280 }}
        />
        <Segmented options={BODY_KIND_OPTIONS} value={bodyKind} onChange={(value) => setBodyKind(value as string)} />
      </Space>
      <Space wrap>
        {isAdmin && <Segmented options={STATUS_OPTIONS} value={status} onChange={(value) => setStatus(value as '' | PetPackStatus)} />}
        <Segmented options={SORT_OPTIONS} value={sort} onChange={(value) => setSort(value as PetPackSort)} />
      </Space>
    </div>

    {error ? <Empty description={error} /> : loading ? <div className="asset-grid">{Array.from({ length: 6 }).map((_, index) => <Card key={index}><Skeleton active /></Card>)}</div> : filtered.length ? <div className="asset-grid">{filtered.map(renderCard)}</div> : <Empty className="empty-space" description="还没有找到匹配的宠物包" />}

    <Drawer title={detail?.name ?? '宠物包详情'} open={detailOpen} onClose={() => setDetailOpen(false)} width={560}>
      {detailLoading ? <Skeleton active /> : detail ? <>
        <div className="detail-image">{detail.previewUrl ? <img src={assetUrl(detail.previewUrl)} alt={detail.name} /> : <span>{detail.name.slice(0, 1)}</span>}</div>
        <Descriptions column={1} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label="状态"><Tag color={STATUS_COLOR[detail.status]}>{petPackStatusLabel(detail.status)}</Tag></Descriptions.Item>
          <Descriptions.Item label="版本">v{detail.version}</Descriptions.Item>
          <Descriptions.Item label="包体体积">{formatPackBytes(detail.packBytes)}</Descriptions.Item>
          <Descriptions.Item label="本体形态">{(detail.bodyKinds ?? []).map((kind) => BODY_KIND_LABELS[kind] ?? kind).join(' / ') || '—'}</Descriptions.Item>
          <Descriptions.Item label="清单版本">{detail.packSchemaVersion}</Descriptions.Item>
          <Descriptions.Item label="清单条目">{manifestEntryCount === null ? '—' : `${manifestEntryCount} 项`}</Descriptions.Item>
          <Descriptions.Item label="本体入口">{manifestEntry || '—'}</Descriptions.Item>
          <Descriptions.Item label="内容指纹"><Text copyable style={{ fontSize: 12 }}>{detail.packSha256}</Text></Descriptions.Item>
        </Descriptions>
        <Paragraph type="secondary">{detail.description || '作者还没有添加描述。'}</Paragraph>
        <Space wrap>
          <Button type="primary" icon={<DownloadOutlined />} disabled={detail.status !== 'approved'} loading={downloadingId === detail.id} onClick={() => void download(detail.id)}>下载宠物包</Button>
          {isAdmin && detail.status !== 'approved' && <Button icon={<CheckOutlined />} loading={moderating} onClick={() => void moderate('approve')}>通过</Button>}
          {isAdmin && detail.status !== 'rejected' && <Button danger icon={<CloseOutlined />} loading={moderating} onClick={() => void moderate('reject')}>驳回</Button>}
          <Text type="secondary" style={{ fontSize: 12 }}>下载 {detail.downloads} 次</Text>
        </Space>
        <Divider />
        <Typography.Title level={5}>载体地址</Typography.Title>
        <Paragraph><Text copyable style={{ fontSize: 12 }}>{detail.packUrl}</Text></Paragraph>
        <Typography.Title level={5}>包清单</Typography.Title>
        {manifest ? <pre style={{ maxHeight: 220, overflow: 'auto', background: '#f6f8f7', borderRadius: 8, padding: 12, fontSize: 12 }}>{JSON.stringify(manifest, null, 2)}</pre> : <Text type="secondary">发布时未留存清单快照。</Text>}
        <Divider />
        <Typography.Title level={5}>用户评价 <Typography.Text type="secondary">{reviews.length}</Typography.Text></Typography.Title>
        <Form form={reviewForm} layout="vertical" onFinish={submitReviewForm}>
          <Form.Item name="rating" label="评分" rules={[{ required: true, message: '请选择评分' }]}><Rate /></Form.Item>
          <Form.Item name="comment" label="评论" rules={[{ required: true, min: 2, message: '请写下至少两字的评论' }]}><Input.TextArea rows={3} placeholder="分享你的使用感受" /></Form.Item>
          <Button htmlType="submit" loading={reviewSubmitting}>发布评价</Button>
        </Form>
        {reviews.length ? <List
          style={{ marginTop: 12 }}
          dataSource={reviews}
          renderItem={(review) => <List.Item>
            <List.Item.Meta
              avatar={<Avatar icon={<UserOutlined />} />}
              title={<Space><Text strong>{review.user?.username || '用户'}</Text><Text type="secondary" style={{ fontSize: 12 }}>{formatDate(review.createdAt)}</Text></Space>}
              description={<><Rate disabled value={review.rating || 0} /><Paragraph style={{ margin: 0 }}>{review.comment || '只留下了评分。'}</Paragraph></>}
            />
          </List.Item>}
        /> : <Empty style={{ marginTop: 12 }} description="还没有评价，来写第一条吧" />}
      </> : <Empty description="宠物包不存在" />}
    </Drawer>
  </div>;
}
