import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Descriptions, Divider, Drawer, Empty, Input, Segmented, Skeleton, Space, Tag, Typography, message } from 'antd';
import { DownloadOutlined, SearchOutlined, StarFilled } from '@ant-design/icons';
import { assetUrl, downloadPetPack, getPetPack, listPetPacks } from '../api';
import type { PetPackDetail, PetPackSort, PetPackStatus, PetPackSummary } from '../types';
// 列表筛选与格式化口径复用共享模块（pet/ui），与桌面内嵌工坊同源，避免两端漂移
import { filterPetPacks, formatPackBytes, petPackStatusLabel } from '@pet/ui';
import { getErrorMessage } from '../utils';

const { Text, Paragraph } = Typography;

const SORT_OPTIONS: { label: string; value: PetPackSort }[] = [
  { label: '最新发布', value: 'createdAt' },
  { label: '下载最多', value: 'downloads' },
  { label: '评分最高', value: 'rating' },
];

const STATUS_COLOR: Record<PetPackStatus, string> = { approved: 'green', rejected: 'red', pending: 'gold' };

const BODY_KIND_LABELS: Record<string, string> = {
  image: '静态图',
  frames: '帧序列',
  live2d: 'Live2D',
  model3d: '3D 模型',
};

export default function PetPacksPage() {
  const [items, setItems] = useState<PetPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PetPackSort>('createdAt');
  const [messageApi, contextHolder] = message.useMessage();

  // 详情抽屉：点卡片按需拉取详情（列表接口不含载体 URL）
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<PetPackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    listPetPacks({ limit: 60 })
      .then((page) => setItems(page.items))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  // 关键词 / 排序口径统一交给 pet/ui 的纯函数（与商店列表一致）
  const filtered = useMemo(() => filterPetPacks(items, { search, sort }), [items, search, sort]);

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await getPetPack(id));
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
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setDownloadingId('');
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
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索名称 / 描述 / 标签"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        onPressEnter={() => setSearch(keyword.trim())}
        style={{ maxWidth: 360 }}
      />
      <Segmented options={SORT_OPTIONS} value={sort} onChange={(value) => setSort(value as PetPackSort)} />
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
          <Descriptions.Item label="内容指纹"><Text copyable style={{ fontSize: 12 }}>{detail.packSha256}</Text></Descriptions.Item>
        </Descriptions>
        <Paragraph type="secondary">{detail.description || '作者还没有添加描述。'}</Paragraph>
        <Space>
          <Button type="primary" icon={<DownloadOutlined />} disabled={detail.status !== 'approved'} loading={downloadingId === detail.id} onClick={() => void download(detail.id)}>下载宠物包</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>下载 {detail.downloads} 次</Text>
        </Space>
        <Divider />
        <Typography.Title level={5}>载体地址</Typography.Title>
        <Paragraph><Text copyable style={{ fontSize: 12 }}>{detail.packUrl}</Text></Paragraph>
      </> : <Empty description="宠物包不存在" />}
    </Drawer>
  </div>;
}
